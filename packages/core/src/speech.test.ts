import { describe, expect, it } from 'vitest';
import {
  clipSpokenText,
  groupSpeechParts,
  joinLinesText,
  maxCharsForRemaining,
  normalizeSpeechLines,
  type SpeechLine,
} from './speech';

const lines = (): SpeechLine[] => [
  { text: '刚下班吧，先别急着找遥控器。', speed: 0.95, emotion: 'calm', pauseAfterSec: 0.6 },
  { text: '今天这杯咖啡我喝了四十分钟。', speed: 1, emotion: 'calm', pauseAfterSec: 0.3 },
  { text: '然后它就凉了。', speed: 0.9, emotion: 'sad' },
];

describe('normalizeSpeechLines', () => {
  it('去空行、去停顿标记，保留合法的语速/情绪/停顿', () => {
    const out = normalizeSpeechLines([
      { text: '  ' },
      { text: '你好<#0.5#>世界', speed: 1.1, emotion: 'happy', pauseAfterSec: 0.4 },
      { text: '嗯。' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.text).toBe('你好世界');
    expect(out[0]?.speed).toBe(1.1);
    expect(out[0]?.emotion).toBe('happy');
    expect(out[0]?.pauseAfterSec).toBe(0.4);
  });

  it('最后一句不留停顿（避免段尾多一段静音）', () => {
    const out = normalizeSpeechLines([
      { text: '第一句。', pauseAfterSec: 0.8 },
      { text: '最后一句。', pauseAfterSec: 1.2 },
    ]);
    expect(out[1]?.pauseAfterSec).toBeUndefined();
  });

  it('语速量化到 0.1 步长（0.95 与 1.0 听不出差别，但能合并成一次合成）', () => {
    const out = normalizeSpeechLines([
      { text: 'a', speed: 0.95 },
      { text: 'b', speed: 0.94 },
      { text: 'c' },
    ]);
    expect(out[0]?.speed).toBe(1);
    expect(out[1]?.speed).toBe(0.9);
    expect(out[2]?.speed).toBeUndefined();
  });

  it('语速与停顿超出范围时夹取到边界', () => {
    const out = normalizeSpeechLines([
      { text: '太快。', speed: 9, pauseAfterSec: 30 },
      { text: '太慢。', speed: 0.01, pauseAfterSec: -5 },
      { text: '收尾。' },
    ]);
    expect(out[0]?.speed).toBe(2);
    expect(out[0]?.pauseAfterSec).toBe(2);
    expect(out[1]?.speed).toBe(0.5);
    expect(out[1]?.pauseAfterSec).toBe(0);
  });

  it('非法情绪归一到白名单，认不出的丢弃', () => {
    const out = normalizeSpeechLines([
      { text: 'a', emotion: 'neutral' },
      { text: 'b', emotion: 'auto' },
      { text: 'c', emotion: 'zzz' },
    ]);
    expect(out[0]?.emotion).toBe('calm');
    expect(out[1]?.emotion).toBeUndefined();
    expect(out[2]?.emotion).toBeUndefined();
  });

  it('超出总字数上限时整句丢弃，不切半句', () => {
    const out = normalizeSpeechLines(
      [{ text: '一二三四五。' }, { text: '六七八九十。' }, { text: '十一十二十三。' }],
      { maxChars: 12 },
    );
    expect(joinLinesText(out)).toBe('一二三四五。六七八九十。');
  });
});

describe('clipSpokenText · 按句收口', () => {
  it('按句丢弃超出上限的尾巴，不切半句', () => {
    expect(clipSpokenText('一二三四五。六七八九十。十一十二十三。', 12)).toBe(
      '一二三四五。六七八九十。',
    );
  });

  it('第一句就超长才硬切', () => {
    expect(clipSpokenText('一二三四五六七八九十', 5)).toBe('一二三四五');
  });
});

describe('maxCharsForRemaining', () => {
  it('剩余时间不够时按 4 字/秒收，但不短于 24 字', () => {
    expect(maxCharsForRemaining(8_000, 180)).toBe(32);
    expect(maxCharsForRemaining(4_000, 180)).toBe(24);
    expect(maxCharsForRemaining(60_000, 180)).toBe(180);
  });
});

describe('groupSpeechParts', () => {
  it('相邻同韵律合并成一个分片（一次 TTS 请求）', () => {
    const parts = groupSpeechParts(normalizeSpeechLines(lines()));
    expect(parts).toHaveLength(2);
    expect(parts[0]?.lines).toHaveLength(2);
    expect(parts[0]?.emotion).toBe('calm');
    expect(parts[0]?.speed).toBe(1);
    expect(parts[1]?.lines[0]?.text).toBe('然后它就凉了。');
    expect(parts[1]?.emotion).toBe('sad');
  });

  it('语速不同也要分开，即使情绪一样', () => {
    const parts = groupSpeechParts(
      normalizeSpeechLines([
        { text: '慢一点。', speed: 0.9, emotion: 'calm' },
        { text: '快一点。', speed: 1.1, emotion: 'calm' },
      ]),
    );
    expect(parts).toHaveLength(2);
  });

  it('组内保留每行自己的停顿，组尾停顿留给下一组', () => {
    const parts = groupSpeechParts(normalizeSpeechLines(lines()));
    expect(parts[0]?.lines.map((l) => l.pauseAfterSec)).toEqual([0.6, 0.3]);
    expect(parts[1]?.lines[0]?.pauseAfterSec).toBeUndefined();
  });

  it('分组不改变文本总量', () => {
    const normalized = normalizeSpeechLines(lines());
    const parts = groupSpeechParts(normalized);
    expect(parts.flatMap((p) => p.lines.map((l) => l.text))).toEqual(normalized.map((l) => l.text));
  });
});
