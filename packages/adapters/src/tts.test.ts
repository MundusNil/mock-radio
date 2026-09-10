import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ffmpegPath } from './ffmpeg-bin';
import { createMiniMaxTts, createTts, renderPartText } from './tts';

// ffprobe 需要真实音频文件，单元测试用假数据跑不通；mock 掉，只验证 TTS 逻辑。
vi.mock('./ffprobe', () => ({
  probeDurationMs: vi.fn(async () => 1234),
}));

/** 把一段文本变成 hex（模拟 MiniMax output_format=hex 的返回） */
function toHex(s: string): string {
  return Buffer.from(s, 'utf-8').toString('hex');
}

type FetchCall = { url: string; headers: Record<string, string>; body: unknown };

/** MiniMax t2a_v2 请求体形状（只声明本测试要断言的字段） */
type MiniMaxRequestBody = {
  model: string;
  text: string;
  stream: boolean;
  output_format: string;
  voice_setting: { voice_id: string; speed: number; vol?: number; emotion?: string };
  audio_setting: { format: string };
};

/** 拼接需要真实 mp3：现生成一段 0.3s 静音，没有 ffmpeg 的机器上跳过相关用例 */
let silentAudioHex: string | null = null;
function realMp3Hex(): string | null {
  if (silentAudioHex) return silentAudioHex;
  const dir = mkdtempSync(join(tmpdir(), 'ambient-mp3-'));
  const file = join(dir, 'silence.mp3');
  try {
    execFileSync(
      ffmpegPath(),
      ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '0.3', '-b:a', '128k', file],
      { stdio: 'ignore' },
    );
    silentAudioHex = readFileSync(file).toString('hex');
  } catch {
    silentAudioHex = null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return silentAudioHex;
}

function makeFetch(overrides: {
  status?: number;
  statusCode?: number;
  statusMsg?: string;
  audio?: string | null;
  dataNull?: boolean;
}): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, headers, body });
    const status = overrides.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return '';
      },
      async json() {
        if (overrides.dataNull) {
          return {
            base_resp: { status_code: overrides.statusCode ?? 0, status_msg: overrides.statusMsg },
            data: null,
          };
        }
        return {
          base_resp: { status_code: overrides.statusCode ?? 0, status_msg: overrides.statusMsg },
          data: { audio: overrides.audio ?? null },
        };
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CACHE = mkdtempSync(join(tmpdir(), 'ambient-tts-'));

afterEach(() => {
  rmSync(CACHE, { recursive: true, force: true });
});

describe('createMiniMaxTts', () => {
  it('用 hex 音频写盘，并返回时长与缓存未命中', async () => {
    const sample = '周五的傍晚，天色暗得刚刚好。';
    const hex = toHex(sample);
    const { fetchImpl } = makeFetch({ audio: hex });
    const tts = createMiniMaxTts({
      apiKey: 'k',
      groupId: 'g',
      voice: 'female-tianmei',
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    });

    const speech = await tts.synthesize(sample);

    expect(speech.cached).toBe(false);
    expect(speech.durationMs).toBeGreaterThan(0);
    expect(readFileSync(speech.filePath, 'utf-8')).toBe(sample);
  });

  it('请求带上 GroupId(query)、Bearer 鉴权与正确请求体', async () => {
    const { fetchImpl, calls } = makeFetch({ audio: toHex('hi') });
    const tts = createMiniMaxTts({
      apiKey: 'MY_KEY',
      groupId: 'MY_GROUP',
      voice: 'female-tianmei',
      model: 'speech-2.8-hd',
      speed: 1.1,
      vol: 1.5,
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    });

    await tts.synthesize('hi');

    expect(calls).toHaveLength(1);
    const [call0] = calls;
    if (!call0) throw new Error('未捕获到 MiniMax 请求');
    const { authorization, 'content-type': contentType } = call0.headers;
    expect(call0.url).toContain('GroupId=');
    expect(call0.url).toContain(encodeURIComponent('MY_GROUP'));
    expect(authorization).toBe('Bearer MY_KEY');
    expect(contentType).toBe('application/json');
    const body = call0.body as MiniMaxRequestBody;
    expect(body.model).toBe('speech-2.8-hd');
    expect(body.stream).toBe(false);
    expect(body.output_format).toBe('hex');
    expect(body.voice_setting.voice_id).toBe('female-tianmei');
    expect(body.voice_setting.speed).toBe(1.1);
    expect(body.voice_setting.vol).toBe(1.5);
    expect(body.audio_setting.format).toBe('mp3');
  });

  it('命中缓存时不再请求远程接口', async () => {
    const hex = toHex('缓存测试');
    const { fetchImpl, calls } = makeFetch({ audio: hex });
    const tts = createMiniMaxTts({
      apiKey: 'k',
      groupId: 'g',
      voice: 'female-tianmei',
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    });

    const first = await tts.synthesize('缓存测试');
    const second = await tts.synthesize('缓存测试');

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('HTTP 非 2xx 抛错', async () => {
    const { fetchImpl } = makeFetch({ status: 401, statusMsg: 'unauthorized' });
    const tts = createMiniMaxTts({
      apiKey: 'k',
      groupId: 'g',
      voice: 'female-tianmei',
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    });
    await expect(tts.synthesize('x')).rejects.toThrow(/401/);
  });

  it('base_resp.status_code 非 0 抛错', async () => {
    const { fetchImpl } = makeFetch({ statusCode: 1001, statusMsg: 'bad voice' });
    const tts = createMiniMaxTts({
      apiKey: 'k',
      groupId: 'g',
      voice: 'female-tianmei',
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    });
    await expect(tts.synthesize('x')).rejects.toThrow(/bad voice/);
  });

  it('返回空音频抛错', async () => {
    const { fetchImpl } = makeFetch({ audio: null });
    const tts = createMiniMaxTts({
      apiKey: 'k',
      groupId: 'g',
      voice: 'female-tianmei',
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    });
    await expect(tts.synthesize('x')).rejects.toThrow(/空音频/);
  });

  it('data 为 null 时也抛错', async () => {
    const { fetchImpl } = makeFetch({ dataNull: true });
    const tts = createMiniMaxTts({
      apiKey: 'k',
      groupId: 'g',
      voice: 'female-tianmei',
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    });
    await expect(tts.synthesize('x')).rejects.toThrow();
  });
});

describe('renderPartText', () => {
  it('句间停顿写成 <#秒#> 标记', () => {
    const text = renderPartText({
      lines: [
        { text: '第一句。', pauseAfterSec: 0.6 },
        { text: '第二句。', pauseAfterSec: 0.4 },
        { text: '第三句。' },
      ],
    });
    expect(text).toBe('第一句。<#0.6#>第二句。<#0.4#>第三句。');
  });

  it('段尾不留停顿标记（MiniMax 要求标记夹在两段可发音文本之间）', () => {
    const text = renderPartText({
      lines: [
        { text: '前一句。', pauseAfterSec: 0.5 },
        { text: '最后一句。', pauseAfterSec: 0.8 },
      ],
    });
    expect(text).toBe('前一句。<#0.5#>最后一句。');
  });
});

describe('createMiniMaxTts · 逐句韵律', () => {
  const audio = realMp3Hex();

  it.skipIf(!audio)('情绪逐片下发、语速固定为基准，相邻同情绪合并成一次请求', async () => {
    const { fetchImpl, calls } = makeFetch({ audio: audio as string });
    const tts = createMiniMaxTts({
      apiKey: 'k',
      groupId: 'g',
      voice: 'female-tianmei',
      speed: 0.9,
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    });

    await tts.synthesize([
      { text: '刚下班吧。', speed: 1.1, emotion: 'happy', pauseAfterSec: 0.6 },
      { text: '先别急着找遥控器。', speed: 1.1, emotion: 'happy' },
      { text: '然后它就凉了。', emotion: 'sad' },
    ]);

    expect(calls).toHaveLength(2);
    const first = calls[0]?.body as MiniMaxRequestBody;
    expect(first.text).toBe('刚下班吧。<#0.6#>先别急着找遥控器。');
    expect(first.voice_setting.speed).toBe(0.9);
    expect(first.voice_setting.emotion).toBe('happy');
    const second = calls[1]?.body as MiniMaxRequestBody;
    expect(second.text).toBe('然后它就凉了。');
    // 语速固定为配置基准 0.9，模型逐句给的 speed 被忽略
    expect(second.voice_setting.speed).toBe(0.9);
    expect(second.voice_setting.emotion).toBe('sad');
  });

  it.skipIf(!audio)('整段一种语气时只发一次请求（接缝最少）', async () => {
    const { fetchImpl, calls } = makeFetch({ audio: audio as string });
    const tts = createMiniMaxTts({
      apiKey: 'k',
      groupId: 'g',
      voice: 'female-tianmei',
      speed: 0.9,
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    });

    await tts.synthesize([
      { text: '第一句。', pauseAfterSec: 0.4 },
      { text: '第二句。', pauseAfterSec: 0.3 },
      { text: '第三句。' },
    ]);

    expect(calls).toHaveLength(1);
    const only = calls[0]?.body as MiniMaxRequestBody;
    expect(only.text).toBe('第一句。<#0.4#>第二句。<#0.3#>第三句。');
    expect(only.voice_setting.emotion).toBeUndefined();
  });

  it.skipIf(!audio)('分片拼接后只留下成品文件，中间产物清理干净', async () => {
    const { fetchImpl } = makeFetch({ audio: audio as string });
    const tts = createMiniMaxTts({
      apiKey: 'k',
      groupId: 'g',
      voice: 'female-tianmei',
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    });

    const speech = await tts.synthesize([
      { text: '一句。', emotion: 'happy' },
      { text: '另一句。', emotion: 'sad' },
    ]);

    expect(speech.cached).toBe(false);
    const leftovers = readdirSync(CACHE).filter((f) => !f.endsWith('.mp3'));
    expect(leftovers).toEqual([]);
    expect(readdirSync(CACHE)).toContain(
      `${(speech.filePath.split(/[\\/]/).pop() ?? '').replace('.mp3', '')}.mp3`,
    );
  });

  it.skipIf(!audio)('韵律相同但文本相同才命中缓存', async () => {
    const { fetchImpl, calls } = makeFetch({ audio: audio as string });
    const opts = {
      apiKey: 'k',
      groupId: 'g',
      voice: 'female-tianmei',
      cacheDir: CACHE,
      loudnorm: false,
      fetchImpl,
    };
    const tts = createMiniMaxTts(opts);
    const lines = [{ text: '同一句。', emotion: 'happy' }];
    await tts.synthesize(lines);
    await tts.synthesize(lines);
    // 换个情绪 = 另一个音频，不该命中缓存
    await tts.synthesize([{ text: '同一句。', emotion: 'sad' }]);

    expect(calls).toHaveLength(2);
  });
});

describe('createTts 工厂', () => {
  const baseEnv: Record<string, string> = {
    MINIMAX_API_KEY: 'env-key',
    MINIMAX_GROUP_ID: 'env-group',
  };
  const resolveEnv = (n: string) => baseEnv[n];

  it('minimax provider 时从环境变量取 key / groupId 并调用 MiniMax', async () => {
    const hex = toHex('工厂测试');
    const { fetchImpl, calls } = makeFetch({ audio: hex });
    const tts = createTts({
      provider: 'minimax',
      postProcess: 'none',
      cacheDir: CACHE,
      edge: { voice: 'zh-CN-XiaoxuanNeural' },
      speechRate: 1,
      minimax: {
        voice: 'female-tianmei',
        model: 'speech-2.8-hd',
        apiKeyEnv: 'MINIMAX_API_KEY',
        groupIdEnv: 'MINIMAX_GROUP_ID',
      },
      resolveEnv,
      fetchImpl,
    });

    const speech = await tts.synthesize('工厂测试');
    expect(calls).toHaveLength(1);
    const [call0] = calls;
    if (!call0) throw new Error('未捕获到 MiniMax 请求');
    expect(call0.headers.authorization).toBe('Bearer env-key');
    expect(speech.durationMs).toBeGreaterThan(0);
  });

  it('edge-tts provider 时走 edge 分支（不调远程 fetch）', async () => {
    // edge 走 python 子进程，无网络；这里只验证工厂返回了可用的客户端且 synthesize 存在。
    const tts = createTts({
      provider: 'edge-tts',
      postProcess: 'loudnorm',
      cacheDir: CACHE,
      edge: { voice: 'zh-CN-XiaoxuanNeural' },
      speechRate: 0.9,
      minimax: {
        voice: 'female-tianmei',
        model: 'speech-2.8-hd',
        apiKeyEnv: 'MINIMAX_API_KEY',
        groupIdEnv: 'MINIMAX_GROUP_ID',
      },
      resolveEnv,
    });
    expect(typeof tts.synthesize).toBe('function');
  });
});
