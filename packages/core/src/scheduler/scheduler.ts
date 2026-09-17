/**
 * 曲库调度器（技术设计 §4.2）：确定性选曲，LLM 不参与（D2）。
 * 深模块：pickNext / reportStarted 两个方法背后藏着
 * 加权随机、时段修正（FR-020）、近期播放惩罚（FR-019）、
 * 30 分钟滑窗防重复（FR-018）与曲库不足放宽。
 * 零 IO：随机数与时钟全部注入。
 */
import type { SchedulerConfig } from '../config';
import { getDayPartContext } from '../time';
import type { Track } from '../types';

export interface SchedulerDecision {
  track: Track;
  /** 本次选曲被迫违反 30 分钟滑窗（曲库不足，FR-018 例外条款） */
  relaxedNoRepeat: boolean;
}

export interface SchedulerOptions {
  tracks: Track[];
  config: SchedulerConfig;
  /** [0, 1) 均匀随机；组装层注入（默认 Math.random） */
  rng: () => number;
}

export interface Scheduler {
  pickNext(now: number): SchedulerDecision;
  /** 锁住下一首（只取时长给导播钟；不把歌名交给文案模型） */
  peekNext(now: number): SchedulerDecision;
  reportStarted(trackId: string, at: number): void;
  /** 点歌队列（P2，FR-064）：受理的点歌优先播出；没有「点歌模式」概念（FR-066） */
  queueTrack(trackId: string): void;
  /** 故障拉黑（ER-004）：单曲损坏后本次运行内不再选它；重启自然恢复 */
  blacklistTrack(trackId: string): void;
  /** 选曲池成员变化后调用：已 peek 且已不在池里的下一首作废（当前曲仍播完） */
  refreshHeld(): void;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { tracks, config } = options;
  const rng = options.rng ?? Math.random;

  /** trackId → 最后一次起播时间（滑窗判断） */
  const lastStartedAt = new Map<string, number>();
  /** 有序播放日志（recency 软惩罚计数用），仅保留近 2 小时 */
  const playLog: Array<{ trackId: string; at: number }> = [];
  /** 点歌队列（P2）：先进先出，播完即消费 */
  const requestQueue: string[] = [];
  /** 故障拉黑集（ER-004）：本次运行内不再选 */
  const blacklisted = new Set<string>();

  function pruneLog(now: number): void {
    const cutoff = now - 2 * 60 * 60 * 1000;
    while (playLog.length > 0 && (playLog[0]?.at ?? Number.POSITIVE_INFINITY) < cutoff) {
      playLog.shift();
    }
  }

  function styleWeight(track: Track, now: number): number {
    const { dayPart } = getDayPartContext(new Date(now));
    const boost = config.timeOfDayBoost[dayPart] ?? {};
    let best = 0;
    for (const style of track.styles) {
      const base = config.styleBaseWeights[style] ?? 1;
      best = Math.max(best, base * (boost[style] ?? 1));
    }
    // 无已知风格的曲目给中性权重，不会被饿死
    return best > 0 ? best : 1;
  }

  function recencyPenalty(track: Track): number {
    const last = lastStartedAt.get(track.id);
    if (last === undefined) return 1;
    // 距该曲上次播放以来，电台又播了几首（滑窗硬排除之外的软惩罚）
    const playsSince = playLog.filter((p) => p.at > last).length;
    const halfLife = Math.max(1, config.recencyPenaltyHalfLifePlays);
    return 2 ** (-playsSince / halfLife);
  }

  /** 已 peek 但尚未 pick 的随机池结果；点歌队列不走这里 */
  let held: SchedulerDecision | null = null;

  function enabledTracks(): Track[] {
    return tracks.filter((t) => t.enabled && !blacklisted.has(t.id));
  }

  function drawPool(now: number): SchedulerDecision {
    pruneLog(now);
    const enabled = enabledTracks();
    if (enabled.length === 0) {
      throw new Error('曲库为空或全部禁用/拉黑：无法选曲（ER-005 由组装层兜底）');
    }
    const inWindow = new Set(
      [...lastStartedAt.entries()]
        .filter(([, at]) => now - at < config.noRepeatWindowMs)
        .map(([id]) => id),
    );
    const fresh = enabled.filter((t) => !inWindow.has(t.id));
    const pool = fresh.length > 0 ? fresh : enabled;
    const relaxed = fresh.length === 0;

    const weights = pool.map((t) => styleWeight(t, now) * recencyPenalty(t));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i] ?? 0;
      const t = pool[i];
      if (t && r <= 0) {
        return { track: t, relaxedNoRepeat: relaxed };
      }
    }
    const fallback = pool[pool.length - 1];
    if (fallback) {
      return { track: fallback, relaxedNoRepeat: relaxed };
    }
    throw new Error('选曲池为空：不可达（enabled 非空已保证）');
  }

  function peekQueued(): Track | null {
    const enabled = enabledTracks();
    for (const id of requestQueue) {
      const track = enabled.find((t) => t.id === id);
      if (track) return track;
    }
    return null;
  }

  function peekNext(now: number): SchedulerDecision {
    pruneLog(now);
    const queued = peekQueued();
    if (queued) return { track: queued, relaxedNoRepeat: false };
    if (held === null) held = drawPool(now);
    return held;
  }

  function pickNext(now: number): SchedulerDecision {
    pruneLog(now);
    const enabled = enabledTracks();
    if (enabled.length === 0) {
      throw new Error('曲库为空或全部禁用/拉黑：无法选曲（ER-005 由组装层兜底）');
    }
    const requested = requestQueue.shift();
    if (requested) {
      held = null;
      const track = enabled.find((t) => t.id === requested);
      if (track) return { track, relaxedNoRepeat: false };
    }
    if (held) {
      const next = held;
      held = null;
      return next;
    }
    return drawPool(now);
  }

  function reportStarted(trackId: string, at: number): void {
    lastStartedAt.set(trackId, at);
    playLog.push({ trackId, at });
    pruneLog(at);
  }

  function queueTrack(trackId: string): void {
    requestQueue.push(trackId);
  }

  function blacklistTrack(trackId: string): void {
    blacklisted.add(trackId);
    if (held?.track.id === trackId) held = null;
  }

  function refreshHeld(): void {
    const current = held;
    if (current && !enabledTracks().some((t) => t.id === current.track.id)) {
      held = null;
    }
  }

  return { pickNext, peekNext, reportStarted, queueTrack, blacklistTrack, refreshHeld };
}
