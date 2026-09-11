import { describe, expect, it } from 'vitest';
import type { LlmClient } from './llm';
import { createSegmentProducer } from './producer';
import type { TtsClient } from './tts';
import type { Track } from './types';

const PERSONA = '# 梦可\n温柔、安静、细腻、克制。';

const track: Track = {
  id: 't-moon',
  path: 'cafe/moon.mp3',
  title: '月光小径',
  artist: null,
  durationMs: 240_000,
  styles: ['cafe'],
  enabled: true,
  addedAt: 0,
};

const llmOk = (text = '今晚风很轻。'): LlmClient => ({
  generateSegment: async () => ({ text, songRequest: null }),
  extractMemories: async () => [],
});

const ttsOk: TtsClient = {
  synthesize: async () => ({ filePath: '/tmp/seg.mp3', durationMs: 4200, cached: false }),
};

const producerOf = (
  overrides: {
    llm?: LlmClient;
    tts?: TtsClient;
    tracks?: Track[];
    onError?: (err: unknown) => void;
  } = {},
) =>
  createSegmentProducer({
    llm: overrides.llm ?? llmOk(),
    tts: overrides.tts ?? ttsOk,
    persona: PERSONA,
    stationName: '梦可电台',
    hostName: '梦可',
    retrieveMemories: () => [],
    tracks: overrides.tracks ?? [track],
    view: () => ({
      now: Date.UTC(2026, 7, 19, 12, 0, 0),
      currentTrack: track,
      recentTracks: [],
    }),
    onError: overrides.onError,
  });

describe('段落生产 · 就绪', () => {
  it('LLM 与 TTS 成功时产出可播出的段落', async () => {
    const producer = producerOf();

    const produced = await producer.produce({ id: 'seg-1', kind: 'interlude' });

    expect(produced).toEqual({
      id: 'seg-1',
      kind: 'interlude',
      text: '今晚风很轻。',
      audioPath: '/tmp/seg.mp3',
      durationMs: 4200,
      cached: false,
      songTrackId: null,
    });
  });

  it('把最近已播口播交给提示词作禁止续写护栏，常规串场曲名只作搜索来源', async () => {
    let user = '';
    const producer = createSegmentProducer({
      llm: {
        generateSegment: async (prompt) => {
          user = prompt.user;
          return { text: '风很轻。', songRequest: null };
        },
        extractMemories: async () => [],
      },
      tts: ttsOk,
      persona: PERSONA,
      stationName: '梦可电台',
      hostName: '梦可',
      retrieveMemories: () => [],
      tracks: [track],
      view: () => ({
        now: Date.UTC(2026, 7, 19, 12, 0, 0),
        currentTrack: track,
        recentTracks: [],
        recentAired: [
          {
            kind: 'interlude',
            text: '风里飘来点姜糖的甜。是对面糖水铺刚开锅吧。',
          },
        ],
      }),
    });
    await producer.produce({ id: 'seg-guard', kind: 'interlude' });
    expect(user).toContain('不要续写其中的情节、角色或场景');
    expect(user).toContain('糖水铺');
    expect(user).toContain('《月光小径》');
    expect(user).toContain('歌名别当报幕念出来');
  });
});

describe('段落生产 · 沉默保底', () => {
  it('LLM 失败时放弃该段落，不抛错，并把原因交给 onError', async () => {
    const seen: unknown[] = [];
    const producer = producerOf({
      llm: {
        generateSegment: async () => {
          throw new Error('LLM HTTP 429: SetLimitExceeded');
        },
        extractMemories: async () => [],
      },
      onError: (err) => {
        seen.push(err);
      },
    });
    await expect(producer.produce({ id: 'seg-fail', kind: 'interlude' })).resolves.toBeNull();
    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toContain('SetLimitExceeded');
  });

  it('TTS 失败时放弃该段落，不抛错', async () => {
    const producer = producerOf({
      tts: {
        synthesize: async () => {
          throw new Error('tts spawn failed');
        },
      },
    });

    await expect(producer.produce({ id: 'seg-tts', kind: 'station_id' })).resolves.toBeNull();
  });
});

describe('段落生产 · 逐句韵律', () => {
  it('把韵律行交给 TTS，完整文本用于入库与记忆', async () => {
    const seen: unknown[] = [];
    const producer = producerOf({
      llm: {
        generateSegment: async () => ({
          text: '刚下班吧。先别急着找遥控器。',
          lines: [
            { text: '刚下班吧。', speed: 1.1, emotion: 'happy', pauseAfterSec: 0.6 },
            { text: '先别急着找遥控器。', speed: 1.1, emotion: 'happy' },
          ],
          songRequest: null,
        }),
        extractMemories: async () => [],
      },
      tts: {
        synthesize: async (input) => {
          seen.push(input);
          return { filePath: '/tmp/seg.mp3', durationMs: 9000, cached: false };
        },
      },
    });

    const produced = await producer.produce({ id: 'seg-prosody', kind: 'interlude' });

    expect(seen[0]).toEqual([
      { text: '刚下班吧。', speed: 1.1, emotion: 'happy', pauseAfterSec: 0.6 },
      { text: '先别急着找遥控器。', speed: 1.1, emotion: 'happy' },
    ]);
    expect(produced?.text).toBe('刚下班吧。先别急着找遥控器。');
    expect(produced?.durationMs).toBe(9000);
  });

  it('模型没给韵律行时退回整段文本', async () => {
    const seen: unknown[] = [];
    const producer = producerOf({
      tts: {
        synthesize: async (input) => {
          seen.push(input);
          return { filePath: '/tmp/seg.mp3', durationMs: 3000, cached: false };
        },
      },
    });

    await producer.produce({ id: 'seg-plain', kind: 'interlude' });

    expect(seen[0]).toBe('今晚风很轻。');
  });

  it('超过字数硬上限时整句丢弃，不切半句', async () => {
    const producer = createSegmentProducer({
      llm: {
        generateSegment: async () => ({
          text: '一二三四五。六七八九十。十一十二十三。',
          lines: [{ text: '一二三四五。' }, { text: '六七八九十。' }, { text: '十一十二十三。' }],
          songRequest: null,
        }),
        extractMemories: async () => [],
      },
      tts: ttsOk,
      persona: PERSONA,
      stationName: '梦可电台',
      hostName: '梦可',
      retrieveMemories: () => [],
      tracks: [track],
      maxSegmentChars: 12,
      view: () => ({
        now: Date.UTC(2026, 7, 19, 12, 0, 0),
        currentTrack: track,
        recentTracks: [],
      }),
    });

    const produced = await producer.produce({ id: 'seg-cap', kind: 'topic' });

    expect(produced?.text).toBe('一二三四五。六七八九十。');
  });

  it('没有韵律行时仍按字数硬上限整句丢弃', async () => {
    const producer = createSegmentProducer({
      llm: {
        generateSegment: async () => ({
          text: '一二三四五。六七八九十。十一十二十三。',
          songRequest: null,
        }),
        extractMemories: async () => [],
      },
      tts: ttsOk,
      persona: PERSONA,
      stationName: '梦可电台',
      hostName: '梦可',
      retrieveMemories: () => [],
      tracks: [track],
      maxSegmentChars: 12,
      view: () => ({
        now: Date.UTC(2026, 7, 19, 12, 0, 0),
        currentTrack: track,
        recentTracks: [],
      }),
    });

    const produced = await producer.produce({ id: 'seg-plain-cap', kind: 'interlude' });
    expect(produced?.text).toBe('一二三四五。六七八九十。');
  });

  it('按段落类型覆盖字数上限', async () => {
    const producer = createSegmentProducer({
      llm: {
        generateSegment: async () => ({
          text: '一二三四五。六七八九十。',
          songRequest: null,
        }),
        extractMemories: async () => [],
      },
      tts: ttsOk,
      persona: PERSONA,
      stationName: '梦可电台',
      hostName: '梦可',
      retrieveMemories: () => [],
      tracks: [track],
      maxSegmentChars: 100,
      maxSegmentCharsByKind: { station_id: 5 },
      view: () => ({
        now: Date.UTC(2026, 7, 19, 12, 0, 0),
        currentTrack: track,
        recentTracks: [],
      }),
    });

    const produced = await producer.produce({ id: 'seg-kind-cap', kind: 'station_id' });
    expect(produced?.text).toBe('一二三四五');
  });
});

describe('段落生产 · 剩余预算', () => {
  it('本曲剩余不够时按钟收字，不把整段独白交给 TTS', async () => {
    let spoken = '';
    const producer = createSegmentProducer({
      llm: llmOk('一二三四五六七八九十。然后这一句太长会被整句丢掉。'),
      tts: {
        synthesize: async (input) => {
          spoken = typeof input === 'string' ? input : input.map((l) => l.text).join('');
          return { filePath: '/tmp/seg.mp3', durationMs: 2000, cached: false };
        },
      },
      persona: PERSONA,
      stationName: '梦可电台',
      hostName: '梦可',
      retrieveMemories: () => [],
      tracks: [track],
      maxSegmentChars: 180,
      view: () => ({
        now: Date.UTC(2026, 7, 19, 12, 0, 0),
        currentTrack: track,
        recentTracks: [],
        trackRemainingMs: 5_000,
      }),
    });

    const produced = await producer.produce({ id: 'seg-clock', kind: 'interlude' });
    expect(produced?.text).toBe('一二三四五六七八九十。');
    expect(spoken).toBe('一二三四五六七八九十。');
  });

  it('外部 abort 时立刻放弃，不调用 TTS', async () => {
    const ac = new AbortController();
    let ttsCalls = 0;
    const producer = producerOf({
      llm: {
        generateSegment: async () => {
          ac.abort();
          return { text: '今晚风很轻。', songRequest: null };
        },
        extractMemories: async () => [],
      },
      tts: {
        synthesize: async () => {
          ttsCalls += 1;
          return { filePath: '/tmp/seg.mp3', durationMs: 4200, cached: false };
        },
      },
    });

    const produced = await producer.produce({ id: 'seg-abort', kind: 'interlude' }, ac.signal);
    expect(produced).toBeNull();
    expect(ttsCalls).toBe(0);
  });
});

describe('段落生产 · 点歌匹配', () => {
  it('reply 命中曲库标题时带上 songTrackId', async () => {
    const producer = producerOf({
      llm: {
        generateSegment: async () => ({
          text: '好，等这首完了就放。',
          songRequest: { query: '月光小径' },
        }),
        extractMemories: async () => [],
      },
    });

    const produced = await producer.produce({
      id: 'seg-reply',
      kind: 'reply',
      replyTo: [{ id: 'm1', body: '能放月光小径吗' }],
    });

    expect(produced?.songTrackId).toBe('t-moon');
    expect(produced?.text).toBe('好，等这首完了就放。');
  });

  it('曲库未命中时 songTrackId 为空（婉拒由文案带出）', async () => {
    const producer = producerOf({
      llm: {
        generateSegment: async () => ({
          text: '这首库里没有，今晚换一种味道。',
          songRequest: { query: '不存在的歌' },
        }),
        extractMemories: async () => [],
      },
    });

    const produced = await producer.produce({
      id: 'seg-miss',
      kind: 'reply',
      replyTo: [{ id: 'm2', body: '放不存在的歌' }],
    });

    expect(produced?.songTrackId).toBeNull();
    expect(produced?.text).toContain('库里没有');
  });
});

describe('段落生产 · 案头', () => {
  it('prefetch 笔记写入开口，同一曲不重搜', async () => {
    let researchCalls = 0;
    let user = '';
    const producer = createSegmentProducer({
      llm: {
        generateSegment: async (prompt) => {
          user = prompt.user;
          return { text: '标题画面挂一整晚就是为了听这个循环。', songRequest: null };
        },
        extractMemories: async () => [],
        researchDesk: async (brief) => {
          researchCalls += 1;
          return {
            trackId: brief.trackId,
            queries: brief.queries,
            notes: [{ lane: 'community', text: 'Steam 有人挂标题画面一整晚' }],
          };
        },
      },
      tts: ttsOk,
      persona: PERSONA,
      stationName: '梦可电台',
      hostName: '梦可',
      retrieveMemories: () => [],
      tracks: [track],
      view: () => ({
        now: Date.UTC(2026, 7, 19, 12, 0, 0),
        currentTrack: track,
        recentTracks: [],
      }),
    });
    producer.prefetch(track);
    const first = await producer.produce({ id: 'seg-desk-1', kind: 'interlude' });
    expect(first?.text).toContain('标题画面');
    expect(user).toContain('Steam 有人挂标题画面一整晚');
    expect(user).not.toContain('开口这一次不要搜');
    await producer.produce({ id: 'seg-desk-2', kind: 'interlude' });
    expect(researchCalls).toBe(1);
  });

  it('案头失败当空笔记，开口仍走', async () => {
    let user = '';
    const producer = createSegmentProducer({
      llm: {
        generateSegment: async (prompt) => {
          user = prompt.user;
          return { text: '鼓点一直压着，不催。', songRequest: null };
        },
        extractMemories: async () => [],
        researchDesk: async () => {
          throw new Error('LLM HTTP 502');
        },
      },
      tts: ttsOk,
      persona: PERSONA,
      stationName: '梦可电台',
      hostName: '梦可',
      retrieveMemories: () => [],
      tracks: [track],
      view: () => ({
        now: Date.UTC(2026, 7, 19, 12, 0, 0),
        currentTrack: track,
        recentTracks: [],
      }),
      onError: () => undefined,
    });
    const produced = await producer.produce({ id: 'seg-desk-miss', kind: 'interlude' });
    expect(produced?.text).toContain('鼓点一直压着');
    expect(user).toContain('案头这次没摸到能站住的条目');
  });

  it('搜完确实 0 条 → 负缓存，同进程不再重烧', async () => {
    let researchCalls = 0;
    const producer = createSegmentProducer({
      llm: {
        generateSegment: async () => ({ text: '鼓点一直压着，不催。', songRequest: null }),
        extractMemories: async () => [],
        researchDesk: async (brief) => {
          researchCalls += 1;
          return { trackId: brief.trackId, queries: brief.queries, notes: [] };
        },
      },
      tts: ttsOk,
      persona: PERSONA,
      stationName: '梦可电台',
      hostName: '梦可',
      retrieveMemories: () => [],
      tracks: [track],
      view: () => ({
        now: Date.UTC(2026, 7, 19, 12, 0, 0),
        currentTrack: track,
        recentTracks: [],
      }),
    });
    await producer.produce({ id: 'seg-empty-1', kind: 'interlude' });
    expect(researchCalls).toBe(1);
    await producer.produce({ id: 'seg-empty-2', kind: 'interlude' });
    expect(researchCalls).toBe(1);
  });

  it('案头抛错（容器挂）不算 0 条：负缓存不记它，下次仍重试', async () => {
    let researchCalls = 0;
    const producer = createSegmentProducer({
      llm: {
        generateSegment: async () => ({ text: '鼓点一直压着，不催。', songRequest: null }),
        extractMemories: async () => [],
        researchDesk: async () => {
          researchCalls += 1;
          throw new Error('SearXNG 无响应');
        },
      },
      tts: ttsOk,
      persona: PERSONA,
      stationName: '梦可电台',
      hostName: '梦可',
      retrieveMemories: () => [],
      tracks: [track],
      view: () => ({
        now: Date.UTC(2026, 7, 19, 12, 0, 0),
        currentTrack: track,
        recentTracks: [],
      }),
      onError: () => undefined,
    });
    await producer.produce({ id: 'seg-err-1', kind: 'interlude' });
    await producer.produce({ id: 'seg-err-2', kind: 'interlude' });
    expect(researchCalls).toBe(2);
  });
});
