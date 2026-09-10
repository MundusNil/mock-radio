import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_CONFIG } from '../config';
import type { Track } from '../types';
import { createEngine } from './engine';

const T = (id: string, durationMs = 900_000): Track => ({
  id,
  path: `${id}.mp3`,
  title: id,
  artist: null,
  durationMs,
  styles: ['cafe'],
  enabled: true,
  addedAt: 0,
});

const fixed = (v: number) => () => v;

/** 节奏测试配置：固定 5 分钟间隔、禁 topic、空房间也开口（纯节奏先行） */
const cfg = {
  ...DEFAULT_ENGINE_CONFIG,
  talkIntervalMs: [300_000, 300_000] as [number, number],
  topicChance: 0,
  speakWhenAlone: true,
};

describe('engine · 时间线（D5：音乐时间线永远走）', () => {
  it('无曲目时 tick 静默', () => {
    const e = createEngine({ config: cfg, rng: fixed(0) });
    expect(e.tick(0)).toEqual([]);
  });

  it('曲目播完发出 track-ended，且只发一次', () => {
    const e = createEngine({ config: cfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 60_000), 0);
    expect(e.tick(30_000)).toEqual([]);
    expect(e.tick(60_000)).toEqual([{ type: 'track-ended', trackId: 'a' }]);
    expect(e.tick(61_000)).toEqual([]);
  });
});

/** 固定序列 RNG：依次返回给定值，耗尽后重复最后一个 */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
};

describe('engine · 自然节点窗口（前奏与尾奏保护）', () => {
  it('曲目开头 20 秒内不播出，进入中段后才播', () => {
    const early = { ...cfg, talkIntervalMs: [0, 0] as [number, number] };
    const e = createEngine({ config: early, rng: fixed(0) });
    e.onTrackStarted(T('a', 600_000), 0);
    const [plan] = e.tick(0);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan event');
    e.onSegmentReady(plan.id, 15_000);
    expect(e.tick(5_000)).toEqual([]); // 前奏保护
    expect(e.tick(20_000)).toHaveLength(1); // 进入中段，播出
  });

  it('尾奏保护：曲目结尾 10 秒内不播，等到边界随 track-ended 一起播', () => {
    const ending = { ...cfg, talkIntervalMs: [0, 0] as [number, number] };
    const e = createEngine({ config: ending, rng: fixed(0) });
    e.onTrackStarted(T('a', 60_000), 0);
    const [plan] = e.tick(0);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan event');
    e.onSegmentReady(plan.id, 15_000);
    expect(e.tick(55_000)).toEqual([]); // 55s > 60-10，尾奏保护
    const events = e.tick(60_000);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'track-ended', trackId: 'a' });
    expect(events[1]).toMatchObject({ type: 'play-segment', segmentId: plan.id });
  });
});

describe('engine · 听众感知（D5：空房间沉默）', () => {
  const alone = { ...cfg, talkIntervalMs: [0, 0] as [number, number], speakWhenAlone: false };

  it('无人在场时到期也不开口', () => {
    const e = createEngine({ config: alone, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    expect(e.tick(300_000)).toEqual([]);
  });

  it('听众进入后，下一个自然节点优先播台呼（FR-004/005）', () => {
    const e = createEngine({ config: alone, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    e.onListenersChanged(1);
    const events = e.tick(30_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'plan-segment', kind: 'station_id' });
  });
});

describe('engine · 故障哲学（ER-001~003）', () => {
  it('生成失败的段落被静默丢弃，节奏照常', () => {
    const e = createEngine({ config: cfg, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    const [plan] = e.tick(300_000);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan event');
    e.onSegmentFailed(plan.id);
    expect(e.tick(310_000)).toEqual([]); // 沉默，不播技术错误
    const again = e.tick(600_000);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ type: 'plan-segment' });
  });

  it('组装层无响应超过 pendingTimeout：静默丢弃挂起段落，节目不卡死', () => {
    const e = createEngine({ config: cfg, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    const [plan] = e.tick(300_000);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan event');
    expect(e.tick(419_000)).toEqual([]);
    expect(e.tick(421_000)).toEqual([{ type: 'segment-dropped', id: plan.id, reason: 'timeout' }]);
    expect(e.tick(600_000)).toHaveLength(1);
  });
});

describe('engine · 最小间隔与 topic 升级', () => {
  it('段落播完后 90 秒内不开新段（minTalkGap）', () => {
    const tight = { ...cfg, talkIntervalMs: [0, 0] as [number, number] };
    const e = createEngine({ config: tight, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    const [plan] = e.tick(0);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan event');
    e.onSegmentReady(plan.id, 15_000);
    e.tick(20_000); // 播出，voice 到 35s
    expect(e.tick(36_000)).toEqual([]); // 35s + 90s 内
    expect(e.tick(125_001)).toHaveLength(1); // gap 已过
  });

  it('冷却期满后有机会升级为 topic，冷却内不升级（FR-033）', () => {
    const topicCfg = {
      ...DEFAULT_ENGINE_CONFIG,
      talkIntervalMs: [300_000, 300_000] as [number, number],
      topicChance: 1, // 必升级
      speakWhenAlone: true,
    };
    // rng 序列：首曲 interval 采样 → topic 判定 → 节奏重采样
    const e = createEngine({ config: topicCfg, rng: seq(0, 0, 0) });
    e.onTrackStarted(T('a'), 0);
    const [first] = e.tick(300_000);
    expect(first).toMatchObject({ type: 'plan-segment', kind: 'topic' });
    if (first?.type !== 'plan-segment') throw new Error('expect plan');
    e.onSegmentReady(first.id, 15_000);
    e.tick(301_000);
    // 冷却未满（40 分钟），第二次仍是 interlude
    expect(e.tick(600_000)[0]).toMatchObject({ type: 'plan-segment', kind: 'interlude' });
  });
});

describe('engine · 串场节奏（FR-031）', () => {
  it('next_talk_due 未到期不规划；到期后规划 interlude（FR-032）', () => {
    const e = createEngine({ config: cfg, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    expect(e.tick(299_000)).toEqual([]);
    const events = e.tick(300_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'plan-segment', kind: 'interlude' });
  });

  it('段落就绪后在自然节点播出；VOICE 期间静默（FR-043 时段音乐降、不叠新段）', () => {
    const e = createEngine({ config: cfg, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    const [plan] = e.tick(300_000);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan event');
    e.onSegmentReady(plan.id, 15_000);

    const play = e.tick(301_000);
    expect(play).toEqual([
      { type: 'play-segment', segmentId: plan.id, startedAt: 301_000, durationMs: 15_000 },
    ]);

    // VOICE 期间（301s ~ 316s）无任何事件
    expect(e.tick(305_000)).toEqual([]);
    // 段落结束：回到 MUSIC，无事件
    expect(e.tick(316_000)).toEqual([]);
  });

  it('段落播完后，下一次串场在间隔之后（节奏重采样）', () => {
    const e = createEngine({ config: cfg, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    const [plan] = e.tick(300_000);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan event');
    e.onSegmentReady(plan.id, 15_000);
    e.tick(301_000); // play
    // due=600s；剩余 300s 仍够预算，到期才规划（不再按曲目 60% 预取）
    expect(e.tick(599_000)).toEqual([]);
    const again = e.tick(600_000);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ type: 'plan-segment', kind: 'interlude' });
  });
});

describe('engine · 留言 SLA（P2，FR-055/056）', () => {
  const msgCfg = {
    ...DEFAULT_ENGINE_CONFIG,
    talkIntervalMs: [300_000, 300_000] as [number, number],
    topicChance: 0,
    speakWhenAlone: true,
  };

  it('留言到达后若已在自然节点则立即规划 reply（FR-055/056）', () => {
    const e = createEngine({ config: msgCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 900_000), 0);
    e.onMessage({ id: 'm1', body: '今晚的歌好听', receivedAt: 100_000 });
    const events = e.tick(100_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'plan-segment', kind: 'reply' });
  });

  it('前奏保护期内收到留言，等到自然节点再回应', () => {
    const e = createEngine({ config: msgCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 900_000), 0);
    e.onMessage({ id: 'm1', body: '在吗', receivedAt: 5_000 });
    expect(e.tick(19_999)).toEqual([]);
    const events = e.tick(20_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'plan-segment', kind: 'reply' });
  });

  it('reply 段落携带留言内容（replyTo 合并多条，FR-054）', () => {
    const e = createEngine({ config: msgCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 900_000), 0);
    e.onMessage({ id: 'm1', body: '第一条', receivedAt: 100_000 });
    e.onMessage({ id: 'm2', body: '第二条', receivedAt: 101_000 });
    const events = e.tick(101_000);
    expect(events[0]).toMatchObject({
      type: 'plan-segment',
      kind: 'reply',
      replyTo: [
        { id: 'm1', body: '第一条' },
        { id: 'm2', body: '第二条' },
      ],
    });
  });

  it('reply 生成失败后留言保留在队列，SLA 到期自动重试', () => {
    const e = createEngine({ config: msgCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 900_000), 0);
    e.onMessage({ id: 'm1', body: '第一条', receivedAt: 100_000 });
    const [plan] = e.tick(100_000);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan');
    e.onSegmentFailed(plan.id);
    const retry = e.tick(101_000);
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({
      type: 'plan-segment',
      kind: 'reply',
      replyTo: [{ id: 'm1', body: '第一条' }],
    });
  });

  it('force 到期后放宽节点尽快回应（尾奏保护让位，前奏保护保留）', () => {
    const forceCfg = {
      ...DEFAULT_ENGINE_CONFIG,
      talkIntervalMs: [900_000, 900_000] as [number, number],
      topicChance: 0,
      speakWhenAlone: true,
    };
    const e = createEngine({ config: forceCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 600_000), 0);
    e.onMessage({ id: 'm1', body: '在吗', receivedAt: 595_000 });
    expect(e.tick(595_000)).toEqual([]);
    const events = e.tick(615_000);
    expect(events.some((ev) => ev.type === 'plan-segment' && ev.kind === 'reply')).toBe(true);
  });

  it('pending 存在时不重复规划（防止同批留言双发）', () => {
    const e = createEngine({ config: msgCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 900_000), 0);
    e.onMessage({ id: 'm1', body: '在吗', receivedAt: 100_000 });
    e.tick(100_000);
    expect(e.tick(200_000)).toEqual([]);
  });
});

describe('engine · 点歌受理（P2，FR-064/066）', () => {
  const ackCfg = {
    ...DEFAULT_ENGINE_CONFIG,
    talkIntervalMs: [300_000, 300_000] as [number, number],
    topicChance: 0,
    speakWhenAlone: true,
  };

  it('onRequestAck 后在自然节点优先规划 request_ack（预告先于播歌）', () => {
    const e = createEngine({ config: ackCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 900_000), 0);
    e.onRequestAck('月光小径');
    const events = e.tick(30_000); // 曲目进行 30s ≥ 20s，自然节点
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'plan-segment',
      kind: 'request_ack',
      ackTitle: '月光小径',
    });
  });

  it('request_ack 播出后 ack 状态清除（不会重复预告）', () => {
    const e = createEngine({ config: ackCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 900_000), 0);
    e.onRequestAck('月光小径');
    const [plan] = e.tick(30_000);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan');
    e.onSegmentReady(plan.id, 8_000);
    const play = e.tick(31_000);
    expect(play).toHaveLength(1);
    // ack 已消费：下一 tick 不再规划 request_ack
    expect(e.tick(32_000)).toEqual([]);
  });
});

describe('engine · 留言 SLA 不受 minTalkGap 约束（P2 回归）', () => {
  it('刚播完段落（gap 期内）收到留言，SLA 到期后仍能回应', () => {
    const gapCfg = {
      ...DEFAULT_ENGINE_CONFIG,
      talkIntervalMs: [300_000, 300_000] as [number, number],
      topicChance: 0,
      speakWhenAlone: true,
      minTalkGapMs: 90_000,
    };
    const e = createEngine({ config: gapCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 900_000), 0);
    // 先播一段 interlude（300s plan → 301s play → 316s 结束）
    const [plan] = e.tick(300_000);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan');
    e.onSegmentReady(plan.id, 15_000);
    e.tick(301_000);
    e.onMessage({ id: 'm1', body: '在吗', receivedAt: 320_000 });
    const events = e.tick(320_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'plan-segment', kind: 'reply' });
  });
});

describe('engine · 剩余时间预算（来不及则放弃）', () => {
  const prefetchCfg = {
    ...DEFAULT_ENGINE_CONFIG,
    talkIntervalMs: [80_000, 80_000] as [number, number],
    topicChance: 0,
    speakWhenAlone: true,
    minTalkGapMs: 0,
  };

  it('到期落在本曲内时，剩余降到预算才预取', () => {
    const e = createEngine({ config: prefetchCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 100_000), 0);
    expect(e.tick(54_000)).toEqual([]);
    const events = e.tick(55_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'plan-segment', kind: 'interlude' });
  });

  it('开口到期已越过本曲时，剩余不够也不预取', () => {
    const e = createEngine({ config: cfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 200_000), 0);
    expect(e.tick(155_000)).toEqual([]);
    expect(e.tick(200_000)).toEqual([{ type: 'track-ended', trackId: 'a' }]);
  });

  it('曲目结束时未就绪的段落被丢弃并通知组装层 abort', () => {
    const e = createEngine({ config: prefetchCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 100_000), 0);
    const [plan] = e.tick(55_000);
    expect(plan).toMatchObject({ type: 'plan-segment' });
    expect(e.tick(100_000)).toEqual([
      { type: 'track-ended', trackId: 'a' },
      {
        type: 'segment-dropped',
        id: plan?.type === 'plan-segment' ? plan.id : '',
        reason: 'track-ended',
      },
    ]);
    e.onTrackStarted(T('b', 100_000), 100_000);
    const again = e.tick(135_000);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ type: 'plan-segment', kind: 'interlude' });
    if (again[0]?.type === 'plan-segment' && plan?.type === 'plan-segment') {
      expect(again[0].id).not.toBe(plan.id);
    }
  });

  it('被丢弃的段落迟到就绪返回 false，组装层不误报播出', () => {
    const e = createEngine({ config: prefetchCfg, rng: fixed(0) });
    e.onTrackStarted(T('a', 100_000), 0);
    const [plan] = e.tick(55_000);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan');
    expect(e.tick(100_000)).toEqual([
      { type: 'track-ended', trackId: 'a' },
      { type: 'segment-dropped', id: plan.id, reason: 'track-ended' },
    ]);
    expect(e.onSegmentReady(plan.id, 15_000)).toBe(false);
    expect(e.onSegmentReady('seg-unknown', 15_000)).toBe(false);
  });
});

describe('engine · 语音功能开关（FR-042：关闭 = 零规划零费用，只放音乐）', () => {
  const off = { ...cfg, voiceEnabled: false };

  it('关闭时到期不规划、留言不进队列、台呼不触发', () => {
    const e = createEngine({ config: off, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    e.onListenersChanged(1); // 会置位 stationIdDue
    expect(e.tick(30_000)).toEqual([]); // 台呼节点：静默
    e.onMessage({ id: 'm1', body: '在吗', receivedAt: 40_000 });
    expect(e.tick(40_000)).toEqual([]); // 留言不进队列
    expect(e.tick(300_000)).toEqual([]); // 主动串场到期：静默
  });

  it('关闭时曲目时间线照常推进（D5：音乐永远是主体）', () => {
    const e = createEngine({ config: off, rng: fixed(0) });
    e.onTrackStarted(T('a', 60_000), 0);
    expect(e.tick(60_000)).toEqual([{ type: 'track-ended', trackId: 'a' }]);
  });

  it('setVoiceEnabled(false) 热关闭：丢弃在途段落，立即静默', () => {
    const e = createEngine({ config: cfg, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    const [plan] = e.tick(300_000);
    if (plan?.type !== 'plan-segment') throw new Error('expect plan');
    e.setVoiceEnabled(false);
    // 迟到的就绪不再被接受（段落已丢弃）
    expect(e.onSegmentReady(plan.id, 15_000)).toBe(false);
    expect(e.tick(301_000)).toEqual([]);
    expect(e.tick(600_000)).toEqual([]);
  });

  it('setVoiceEnabled(true) 热开启：恢复规划', () => {
    const e = createEngine({ config: off, rng: fixed(0) });
    e.onTrackStarted(T('a'), 0);
    expect(e.tick(300_000)).toEqual([]);
    e.setVoiceEnabled(true);
    const events = e.tick(301_000);
    expect(events[0]).toMatchObject({ type: 'plan-segment', kind: 'interlude' });
  });
});
