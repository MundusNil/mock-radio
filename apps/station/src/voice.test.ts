import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyVoiceSettings,
  cadenceById,
  cadenceOfInterval,
  readVoiceSettings,
  type VoiceConfigShape,
  validateVoicePatch,
} from './voice';

function makeConfig(overrides?: Partial<VoiceConfigShape>): VoiceConfigShape {
  return {
    engine: { voiceEnabled: true, talkIntervalMs: [300_000, 480_000] },
    audio: { speechVolume: 1 },
    tts: { speechRate: 0.9 },
    ...overrides,
  };
}

const dirs: string[] = [];
function configFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'voice-test-'));
  dirs.push(dir);
  const path = join(dir, 'station.config.json');
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('cadence 档位', () => {
  it('三档预设齐备，浅语 = FR-031 默认 8~12 次/小时', () => {
    expect(cadenceById('sparse')?.label).toBe('留白');
    expect(cadenceById('gentle')?.intervalMs).toEqual([300_000, 480_000]);
    expect(cadenceById('close')?.label).toBe('絮语');
  });

  it('由 talkIntervalMs 反查最接近档位', () => {
    expect(cadenceOfInterval([300_000, 480_000])).toBe('gentle');
    expect(cadenceOfInterval([700_000, 1_100_000])).toBe('sparse');
    expect(cadenceOfInterval([180_000, 240_000])).toBe('close');
  });
});

describe('validateVoicePatch', () => {
  it('合法补丁归一化通过', () => {
    expect(
      validateVoicePatch({
        enabled: false,
        speechRate: 1.234,
        speechVolume: 0.8,
        cadence: 'sparse',
      }),
    ).toEqual({
      enabled: false,
      speechRate: 1.23,
      speechVolume: 0.8,
      cadence: 'sparse',
    });
  });

  it('越界/未知/空补丁抛错', () => {
    expect(() => validateVoicePatch({ speechRate: 2 })).toThrow(/0\.5~1\.5/);
    expect(() => validateVoicePatch({ speechVolume: -0.1 })).toThrow(/0~1/);
    expect(() => validateVoicePatch({ cadence: 'chatty' })).toThrow(/未知发言频率档位/);
    expect(() => validateVoicePatch({})).toThrow(/没有可应用/);
    expect(() => validateVoicePatch({ enabled: 'yes' as unknown as boolean })).toThrow(/布尔值/);
    expect(() => validateVoicePatch({ minimaxVol: 0 })).toThrow(/\(0,10]/);
    expect(() => validateVoicePatch({ minimaxVoice: '  ' })).toThrow(/非空/);
  });
});

describe('applyVoiceSettings · 写回 station.config.json + 热更新内存配置', () => {
  it('关闭语音：engine.voiceEnabled 落盘，runtime 同步', () => {
    const path = configFile('{\n  "engine": {\n    "voiceEnabled": true\n  }\n}\n');
    const config = makeConfig();
    const res = applyVoiceSettings(path, config, { enabled: false });
    expect(res.enabled).toBe(false);
    expect(config.engine.voiceEnabled).toBe(false);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { engine: { voiceEnabled: boolean } };
    expect(raw.engine.voiceEnabled).toBe(false);
  });

  it('切档 + 语速 + 音量：三处配置各归各位', () => {
    const path = configFile('{}');
    const config = makeConfig();
    const res = applyVoiceSettings(path, config, {
      cadence: 'close',
      speechRate: 1.1,
      speechVolume: 0.6,
    });
    expect(res).toEqual({ enabled: true, speechRate: 1.1, speechVolume: 0.6, cadence: 'close' });
    expect(config.engine.talkIntervalMs).toEqual([180_000, 240_000]);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      engine: { talkIntervalMs: number[] };
      tts: { speechRate: number };
      audio: { speechVolume: number };
    };
    expect(raw.engine.talkIntervalMs).toEqual([180_000, 240_000]);
    expect(raw.tts.speechRate).toBe(1.1);
    expect(raw.audio.speechVolume).toBe(0.6);
  });

  it('非法补丁：不落盘不改动', () => {
    const path = configFile('{"engine":{"voiceEnabled":true}}');
    const config = makeConfig();
    expect(() => applyVoiceSettings(path, config, { speechRate: 99 })).toThrow();
    expect(readFileSync(path, 'utf-8')).toBe('{"engine":{"voiceEnabled":true}}');
    expect(config.engine.voiceEnabled).toBe(true);
  });

  it('readVoiceSettings 回显当前配置', () => {
    const config = makeConfig({
      engine: { voiceEnabled: false, talkIntervalMs: [720_000, 1_200_000] },
    });
    expect(readVoiceSettings(config)).toEqual({
      enabled: false,
      speechRate: 0.9,
      speechVolume: 1,
      cadence: 'sparse',
    });
  });

  it('minimax 音色与 vol 写盘并热更新内存', () => {
    const path = configFile(
      JSON.stringify({ tts: { minimax: { voice: 'old', model: 'speech-2.8-hd', vol: 1 } } }),
    );
    const config = makeConfig({
      tts: { speechRate: 0.9, minimax: { voice: 'old', vol: 1 } },
    });
    const res = applyVoiceSettings(path, config, {
      minimaxVoice: 'Chinese (Mandarin)_Warm_Girl',
      minimaxVol: 1.5,
    });
    expect(res.minimaxVoice).toBe('Chinese (Mandarin)_Warm_Girl');
    expect(res.minimaxVol).toBe(1.5);
    expect(config.tts.minimax?.voice).toBe('Chinese (Mandarin)_Warm_Girl');
    expect(config.tts.minimax?.vol).toBe(1.5);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      tts: { minimax: { voice: string; vol: number; model: string } };
    };
    expect(raw.tts.minimax.voice).toBe('Chinese (Mandarin)_Warm_Girl');
    expect(raw.tts.minimax.vol).toBe(1.5);
    expect(raw.tts.minimax.model).toBe('speech-2.8-hd');
  });

  it('只改语速时也会把盘上的音色灌进内存', () => {
    const path = configFile(
      JSON.stringify({
        tts: { speechRate: 0.9, minimax: { voice: 'Chinese (Mandarin)_Warm_Girl', vol: 1.5 } },
      }),
    );
    const config = makeConfig({
      tts: { speechRate: 0.9, minimax: { voice: 'old', vol: 1 } },
    });
    applyVoiceSettings(path, config, { speechRate: 0.95 });
    expect(config.tts.minimax?.voice).toBe('Chinese (Mandarin)_Warm_Girl');
    expect(config.tts.minimax?.vol).toBe(1.5);
    expect(config.tts.speechRate).toBe(0.95);
  });
});
