/**
 * 曲库资源管理器端点：真实临时目录 + mock 时长。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '@mock-radio/adapters';
import type { LlmClient, TtsClient } from '@mock-radio/core';
import {
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_SCHEDULER_CONFIG,
} from '@mock-radio/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StationRuntimeConfig } from './config';
import { scanLibrary } from './library';
import type { Radio } from './radio';
import { createRadio } from './radio';

vi.mock('@mock-radio/adapters', async (importOriginal) => ({
  ...(await importOriginal()),
  probeDurationMs: async () => 180_000,
}));

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

interface Listing {
  ok?: true;
  dir: string;
  parent: string | null;
  poolSize: number;
  dirs: string[];
  files: Array<{ id: string; name: string; path: string; enabled: boolean }>;
  error?: string;
}

let dir: string;
let lib: string;
let radio: Radio;

function touch(root: string, rel: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'x');
}

async function get(path: string): Promise<Response> {
  return radio.app.fetch(new Request(`http://localhost${path}`));
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return radio.app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function json(res: Promise<Response> | Response): Promise<Listing> {
  const r = await res;
  return r.json() as Promise<Listing>;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'radio-library-'));
  lib = join(dir, 'library');
  mkdirSync(lib);
  touch(lib, 'root-song.mp3');
  touch(lib, 'game/ost.mp3');
  const configPath = join(dir, 'station.config.json');
  writeFileSync(configPath, JSON.stringify({ engine: { voiceEnabled: false } }, null, 2), 'utf-8');
  const config: StationRuntimeConfig = {
    station: { name: '测试电台', host: '梦可', port: 0 },
    engine: { ...DEFAULT_ENGINE_CONFIG, voiceEnabled: false },
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
      deskLocalSearch: false,
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
    library: { root: lib },
    memory: DEFAULT_MEMORY_CONFIG,
  };
  const tracks = await scanLibrary(lib);
  const store = createStore(':memory:');
  store.upsertTracks(tracks);
  radio = createRadio({
    stationName: config.station.name,
    hostName: config.station.host,
    persona: 'p',
    engineConfig: config.engine,
    schedulerConfig: config.scheduler,
    ducking: config.audio.ducking,
    crossfadeMs: config.audio.crossfadeMs,
    tracks,
    libraryRoot: lib,
    clock: { now: () => 1_700_000_000_000 },
    llmFactory: silentLlm,
    ttsFactory: silentTts,
    store,
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

describe('GET/POST /api/admin/library', () => {
  it('列出根目录文件夹与音频，poolSize 是全部启用曲', async () => {
    const res = await get('/api/admin/library');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.dir).toBe('');
    expect(body.parent).toBeNull();
    expect(body.dirs).toEqual(['game']);
    expect(body.files.map((f) => f.name)).toEqual(['root-song.mp3']);
    expect(body.poolSize).toBe(2);
  });

  it('进入子目录，parent 是根', async () => {
    const body = await json(get('/api/admin/library?dir=game'));
    expect(body.dir).toBe('game');
    expect(body.parent).toBe('');
    expect(body.dirs).toEqual([]);
    expect(body.files.map((f) => f.name)).toEqual(['ost.mp3']);
  });

  it('拒绝路径穿越', async () => {
    expect((await get('/api/admin/library?dir=../x')).status).toBe(400);
    expect((await send('POST', '/api/admin/library/delete', { path: '../x' })).status).toBe(400);
    expect(
      (await send('POST', '/api/admin/library/move', { from: '../x', toDir: '' })).status,
    ).toBe(400);
    const abs = await send('POST', '/api/admin/library/delete', { path: 'C:\\Windows' });
    expect(abs.status).toBe(400);
  });

  it('mkdir、上传、重名 409、取消启用改 poolSize', async () => {
    const made = await send('POST', '/api/admin/library/mkdir', { dir: '', name: 'ost' });
    expect(made.status).toBe(200);
    expect((await json(made)).dirs).toEqual(['game', 'ost']);

    const dupDir = await send('POST', '/api/admin/library/mkdir', { dir: '', name: 'ost' });
    expect(dupDir.status).toBe(409);

    const form = new FormData();
    form.set('dir', '');
    form.set('file', new File(['x'], 'new-song.mp3', { type: 'audio/mpeg' }));
    const uploaded = await radio.app.fetch(
      new Request('http://localhost/api/admin/library/upload', { method: 'POST', body: form }),
    );
    expect(uploaded.status).toBe(200);
    const afterUpload = await json(uploaded);
    expect(afterUpload.files.map((f) => f.name)).toContain('new-song.mp3');
    expect(afterUpload.poolSize).toBe(3);

    const form2 = new FormData();
    form2.set('dir', '');
    form2.set('file', new File(['x'], 'new-song.mp3', { type: 'audio/mpeg' }));
    const dupFile = await radio.app.fetch(
      new Request('http://localhost/api/admin/library/upload', { method: 'POST', body: form2 }),
    );
    expect(dupFile.status).toBe(409);

    const song = afterUpload.files.find((f) => f.name === 'new-song.mp3');
    expect(song).toBeTruthy();
    const toggled = await send('POST', '/api/admin/library/tracks/enabled', {
      id: song?.id,
      enabled: false,
    });
    expect(toggled.status).toBe(200);
    expect((await json(toggled)).poolSize).toBe(2);
  });

  it('文件夹不能移动；歌曲可以；正在播放的不能删', async () => {
    const folderMove = await send('POST', '/api/admin/library/move', {
      from: 'ost',
      toDir: 'game',
    });
    expect(folderMove.status).toBe(400);

    radio.start();
    const state = (await (await get('/api/state')).json()) as { trackId: string | null };
    expect(state.trackId).toBeTruthy();

    const root = await json(get('/api/admin/library'));
    const song = root.files.find((f) => f.id !== state.trackId);
    expect(song).toBeTruthy();
    const moved = await send('POST', '/api/admin/library/move', {
      from: song?.path,
      toDir: 'game',
    });
    expect(moved.status).toBe(200);
    const game = await json(get('/api/admin/library?dir=game'));
    expect(game.files.map((f) => f.name)).toContain(song?.name);

    const livePath =
      root.files.find((f) => f.id === state.trackId)?.path ??
      game.files.find((f) => f.id === state.trackId)?.path;
    expect(livePath).toBeTruthy();
    const blocked = await send('POST', '/api/admin/library/delete', { path: livePath });
    expect(blocked.status).toBe(409);
    radio.stop();

    const other = game.files.find((f) => f.id !== state.trackId);
    expect(other).toBeTruthy();
    const deleted = await send('POST', '/api/admin/library/delete', { path: other?.path });
    expect(deleted.status).toBe(200);
    expect((await json(deleted)).files.map((f) => f.name)).not.toContain(other?.name);
  });
});
