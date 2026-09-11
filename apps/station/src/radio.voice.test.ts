/**
 * 语音设置端点集成测试：GET/POST /api/admin/voice 真实走一遍
 * （临时 SQLite + 临时 station.config.json，不碰运行中的电台）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '@mock-radio/adapters';
import type { LlmClient, Track, TtsClient } from '@mock-radio/core';
import {
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_SCHEDULER_CONFIG,
} from '@mock-radio/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StationRuntimeConfig } from './config';
import type { Radio } from './radio';
import { createRadio } from './radio';

const TRACKS: Track[] = [
  {
    id: 't1',
    path: 't1.mp3',
    title: '测试曲',
    artist: null,
    durationMs: 60_000,
    styles: ['cafe'],
    enabled: true,
    addedAt: 0,
  },
];

const silentLlm = (): LlmClient => ({
  generateSegment: async () => {
    throw new Error('测试不应调用 LLM');
  },
  extractMemories: async () => [],
});
const silentTts = (): TtsClient => ({
  synthesize: async () => {
    throw new Error('测试不应调用 TTS');
  },
});

let dir: string;
let config: StationRuntimeConfig;
let configPath: string;
let radio: Radio;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'radio-voice-'));
  configPath = join(dir, 'station.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ engine: { voiceEnabled: true, talkIntervalMs: [300000, 480000] } }, null, 2),
    'utf-8',
  );
  config = {
    station: { name: '测试电台', host: '梦可', port: 0 },
    engine: { ...DEFAULT_ENGINE_CONFIG },
    scheduler: DEFAULT_SCHEDULER_CONFIG,
    audio: {
      ducking: { speechGain: 0.45, attackTauMs: 250, releaseDelayMs: 1200, releaseTauMs: 600 },
      crossfadeMs: 250,
      speechVolume: 1,
    },
    llm: {
      provider: 'ark',
      baseUrl: '',
      model: 'm',
      apiKeyEnv: 'X',
      temperature: 0.8,
      webSearch: false,
      deskAgent: false,
      timeoutMs: 1000,
      maxTokens: 100,
      maxSegmentChars: 100,
    },
    tts: {
      provider: 'edge-tts',
      postProcess: 'none',
      cacheDir: dir,
      speechRate: 0.9,
      edge: { voice: 'v' },
      minimax: { voice: 'v', model: 'm', vol: 1.5, apiKeyEnv: 'A', groupIdEnv: 'G' },
    },
    messages: { retentionDays: 7 },
    library: { root: dir },
    memory: DEFAULT_MEMORY_CONFIG,
  };
  radio = createRadio({
    stationName: config.station.name,
    hostName: config.station.host,
    persona: 'p',
    engineConfig: config.engine,
    schedulerConfig: config.scheduler,
    ducking: config.audio.ducking,
    crossfadeMs: config.audio.crossfadeMs,
    tracks: TRACKS,
    libraryRoot: dir,
    clock: { now: () => Date.now() },
    llmFactory: silentLlm,
    ttsFactory: silentTts,
    store: createStore(':memory:'),
    retentionDays: 7,
    memoryConfig: config.memory,
    maxSegmentChars: 100,
    envPath: join(dir, '.env'),
    keyDefs: [],
    configPath,
    runtimeConfig: config,
  });
});

afterAll(() => {
  radio.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string): Promise<Response> {
  return radio.app.fetch(new Request(`http://localhost${path}`));
}

async function post(path: string, body: unknown): Promise<Response> {
  return radio.app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('GET/POST /api/admin/voice', () => {
  it('GET 回当前设置 + 三档预设', async () => {
    const res = await get('/api/admin/voice');
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      settings: { enabled: boolean; cadence: string };
      cadences: Array<{ id: string }>;
    };
    expect(data.settings.enabled).toBe(true);
    expect(data.settings.cadence).toBe('gentle');
    expect(data.cadences.map((c) => c.id)).toEqual(['sparse', 'gentle', 'close']);
  });

  it('POST 关闭语音：200 + 落盘 + 内存配置同步', async () => {
    const res = await post('/api/admin/voice', { settings: { enabled: false } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: true; settings: { enabled: boolean } };
    expect(data.settings.enabled).toBe(false);
    expect(config.engine.voiceEnabled).toBe(false);
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      engine: { voiceEnabled: boolean };
    };
    expect(raw.engine.voiceEnabled).toBe(false);
  });

  it('POST 非法档位：400 且不落盘', async () => {
    const before = readFileSync(configPath, 'utf-8');
    const res = await post('/api/admin/voice', { settings: { cadence: 'loquacious' } });
    expect(res.status).toBe(400);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('POST 切档 + 语速：talkIntervalMs 与 speechRate 落盘', async () => {
    const res = await post('/api/admin/voice', {
      settings: { cadence: 'sparse', speechRate: 1.05 },
    });
    expect(res.status).toBe(200);
    expect(config.engine.talkIntervalMs).toEqual([720_000, 1_200_000]);
    expect(config.tts.speechRate).toBe(1.05);
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      engine: { talkIntervalMs: number[] };
      tts: { speechRate: number };
    };
    expect(raw.engine.talkIntervalMs).toEqual([720_000, 1_200_000]);
    expect(raw.tts.speechRate).toBe(1.05);
  });

  it('/api/config 暴露语音开关与音量', async () => {
    const res = await get('/api/config');
    const data = (await res.json()) as { voice: { enabled: boolean; speechVolume: number } };
    expect(data.voice.enabled).toBe(false);
    expect(data.voice.speechVolume).toBe(1);
  });
});
