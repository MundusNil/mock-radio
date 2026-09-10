import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULER_CONFIG } from '../config';
import type { Track } from '../types';
import { createScheduler } from './scheduler';

const T = (id: string, styles: string[], durationMs = 240_000): Track => ({
  id,
  path: `${id}.mp3`,
  title: id,
  artist: null,
  durationMs,
  styles,
  enabled: true,
  addedAt: 0,
});

/** 确定性 RNG：永远返回同一个值 */
const fixed = (v: number) => () => v;

describe('scheduler · 选曲', () => {
  it('从曲库中选出一首歌', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe']), T('b', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.5),
    });
    const decision = s.pickNext(0);
    expect(['a', 'b']).toContain(decision.track.id);
  });

  it('跳过已禁用的曲目', () => {
    const disabled = { ...T('off', ['cafe']), enabled: false };
    const s = createScheduler({
      tracks: [disabled, T('on', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.99),
    });
    expect(s.pickNext(0).track.id).toBe('on');
  });

  it('无风格标签与不同文件夹的曲目都在同一选曲池（默认等权）', () => {
    const tracks = [T('root', []), T('nested', ['ENDER LILIES']), T('other', ['VA-11 HALL-A'])];
    const pick = (rng: number) =>
      createScheduler({
        tracks,
        config: DEFAULT_SCHEDULER_CONFIG,
        rng: fixed(rng),
      }).pickNext(0).track.id;
    expect(new Set([pick(0), pick(0.4), pick(0.9)])).toEqual(new Set(['root', 'nested', 'other']));
  });
});

describe('scheduler · peekNext', () => {
  it('peekNext 钉住下一首，pickNext 取出同一首', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe']), T('b', ['cafe']), T('c', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0),
    });
    const peeked = s.peekNext(0);
    expect(s.pickNext(0).track.id).toBe(peeked.track.id);
  });

  it('peekNext 不消耗点歌队列', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe']), T('b', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.5),
    });
    s.queueTrack('b');
    expect(s.peekNext(0).track.id).toBe('b');
    expect(s.peekNext(0).track.id).toBe('b');
    expect(s.pickNext(0).track.id).toBe('b');
  });
});

describe('scheduler · 时段权重（FR-020）', () => {
  const boostConfig = {
    ...DEFAULT_SCHEDULER_CONFIG,
    timeOfDayBoost: { lateNight: { 'night-quiet': 1000 } },
  };

  it('深夜提升安静曲风的选中概率', () => {
    const s = createScheduler({
      tracks: [T('day', ['cafe']), T('night', ['night-quiet'])],
      config: boostConfig,
      rng: fixed(0.5),
    });
    const lateNight = new Date(2026, 7, 19, 23, 0).getTime();
    expect(s.pickNext(lateNight).track.id).toBe('night');
  });

  it('白天不应用深夜加成', () => {
    const s = createScheduler({
      tracks: [T('day', ['cafe']), T('night', ['night-quiet'])],
      config: boostConfig,
      rng: fixed(0.5),
    });
    const afternoon = new Date(2026, 7, 19, 14, 0).getTime();
    expect(s.pickNext(afternoon).track.id).toBe('day');
  });
});

describe('scheduler · 近期播放惩罚（FR-019）', () => {
  it('播过后又播了多首歌的曲目被压低概率', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe']), T('j', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.6),
    });
    // a 于 1 小时前播过，其后电台又播了 8 首（halfLife=8 → a 惩罚 0.5）
    s.reportStarted('a', 0);
    for (let i = 1; i <= 8; i++) {
      s.reportStarted(`ghost-${i}`, i * 60_000);
    }
    // rng 0.6：无惩罚会落在 a 的区间，有惩罚则落在 j
    expect(s.pickNext(60 * 60_000).track.id).toBe('j');
  });

  it('刚播过之后还没有新歌的曲目不受惩罚（仅滑窗硬排除）', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe']), T('j', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.4),
    });
    s.reportStarted('a', 0);
    expect(s.pickNext(60 * 60_000).track.id).toBe('a');
  });
});

describe('scheduler · 防重复（FR-018）', () => {
  it('30 分钟滑窗内不重选同一首', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe']), T('b', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.5),
    });
    const first = s.pickNext(0);
    s.reportStarted(first.track.id, 0);
    const second = s.pickNext(60_000);
    expect(second.track.id).not.toBe(first.track.id);
  });

  it('滑窗过期后可正常重选，不标记放宽', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.5),
    });
    s.reportStarted('a', 0);
    // 31 分钟后：滑窗外，唯一曲目可重选，且不是被迫放宽
    const decision = s.pickNext(31 * 60_000);
    expect(decision.track.id).toBe('a');
    expect(decision.relaxedNoRepeat).toBe(false);
  });

  it('曲库不足时被迫重选滑窗内的歌，并标记放宽（FR-018 例外条款）', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.5),
    });
    s.reportStarted('a', 0);
    // 10 分钟后仍在滑窗内，但曲库只有这一首
    const decision = s.pickNext(10 * 60_000);
    expect(decision.track.id).toBe('a');
    expect(decision.relaxedNoRepeat).toBe(true);
  });
});

describe('scheduler · 点歌队列（P2，FR-064）', () => {
  it('受理的点歌优先于随机选曲，且不参与权重', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe']), T('b', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.5),
    });
    s.queueTrack('b');
    expect(s.pickNext(0).track.id).toBe('b');
  });

  it('队列消耗后恢复随机选曲', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe']), T('b', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.5),
    });
    s.queueTrack('b');
    s.pickNext(0); // 消耗 b
    const next = s.pickNext(1_000);
    expect(next.track.id).toBe('a'); // 恢复随机（滑窗外）
  });

  it('队列按到达顺序先进先出', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe']), T('b', ['cafe']), T('c', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.5),
    });
    s.queueTrack('c');
    s.queueTrack('a');
    expect(s.pickNext(0).track.id).toBe('c');
    expect(s.pickNext(1_000).track.id).toBe('a');
  });
});

describe('scheduler · 故障拉黑（ER-004：单曲损坏跳下一首）', () => {
  it('拉黑后不再选该曲，直到曲库无其他可选', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe']), T('b', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.5),
    });
    s.blacklistTrack('a');
    expect(s.pickNext(0).track.id).toBe('b');
    // 拉黑后即使滑窗内也绕过（损坏曲不参与任何选择）
    expect(s.pickNext(1_000).track.id).toBe('b');
  });

  it('曲库全被拉黑时抛错（由组装层判定 ER-005 信号丢失）', () => {
    const s = createScheduler({
      tracks: [T('a', ['cafe'])],
      config: DEFAULT_SCHEDULER_CONFIG,
      rng: fixed(0.5),
    });
    s.blacklistTrack('a');
    expect(() => s.pickNext(0)).toThrow();
  });
});
