/**
 * TTS 适配器（D8：候选池随时换）。
 * 两种实现共用一条流水线：哈希缓存 → 产出原始音频 → 可选 ffmpeg loudnorm 响度归一（FR-045）→ probe 时长。
 * - edge-tts：python -m edge_tts 子进程合成（免费，D8 默认）。
 * - minimax：MiniMax 同步 T2A HTTP 接口（付费，音质更可控，用户可选）。
 * 任一外部依赖失败都抛错，由组装层（radio.ts）按沉默保底（ER 哲学）静默丢弃该段落。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SpeechLine, SpeechPart, SynthesizedSpeech, TtsClient } from '@mock-radio/core';
import { groupSpeechParts, joinLinesText, normalizeSpeechLines } from '@mock-radio/core';
import { ffmpegPath } from './ffmpeg-bin';
import { probeDurationMs } from './ffprobe';

const PROC_TIMEOUT_MS = 30_000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

function mergeAbort(timeoutMs: number, extra?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return extra ? AbortSignal.any([timeout, extra]) : timeout;
}

function runProc(
  cmd: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const proc = spawn(cmd, args, cwd ? { cwd } : {});
  let stderr = '';
  let settled = false;
  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    fn();
  };
  const onAbort = () => {
    proc.kill();
    finish(() => reject(new DOMException('The operation was aborted.', 'AbortError')));
  };
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const timer = setTimeout(() => {
    proc.kill();
    finish(() => reject(new Error(`${cmd} 超时（${timeoutMs}ms）`)));
  }, timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  proc.on('error', (err) => {
    finish(() => reject(err));
  });
  proc.on('close', (code) => {
    if (code === 0) {
      finish(() => resolve());
    } else {
      finish(() => reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 300)}`)));
    }
  });
  return promise;
}

/** 缓存文件名（哈希前 16 位）；把 provider/音色/韵律都并进 key，避免跨供应商碰撞 */
function cacheHash(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** 入口文本 → 分片：字符串视为一句，韵律行先规范化再合并相邻同语气的句子 */
function toSpeechParts(input: string | SpeechLine[]): SpeechPart[] {
  if (typeof input === 'string') return [{ lines: [{ text: input }] }];
  return groupSpeechParts(normalizeSpeechLines(input));
}

/**
 * 多个分片拼成一条音轨：同参数 mp3 直接 concat copy，不重编码（保音质）。
 * 用 cwd + 裸文件名绕开 Windows 路径里的反斜杠与空格在 concat 列表里的转义问题。
 */
async function concatParts(rawPaths: string[], outPath: string, timeoutMs: number): Promise<void> {
  const cacheDir = join(rawPaths[0] ?? outPath, '..');
  const listPath = join(cacheDir, `${basename(outPath, '.mp3')}.concat.txt`);
  await writeFile(
    listPath,
    `${rawPaths.map((p) => `file '${basename(p)}'`).join('\n')}\n`,
    'utf-8',
  );
  try {
    await runProc(
      ffmpegPath(),
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        basename(listPath),
        '-c',
        'copy',
        basename(outPath),
      ],
      timeoutMs,
      cacheDir,
    );
  } finally {
    await rm(listPath, { force: true });
  }
}

/**
 * 共享流水线：缓存命中直接返回；否则由 produceParts 按序写出若干原始分片，
 * 拼成一条音轨后再做一次 loudnorm 归一（整段音量一致），最后落定 finalPath 并 probe 时长。
 * edge 与 minimax 只差「分片怎么拿到」，其余步骤完全共用。
 */
async function runCachedPipeline(params: {
  cacheDir: string;
  hash: string;
  loudnorm: boolean;
  timeoutMs: number;
  /** 按序产出分片原始音频（通常 1 片；韵律变化时会是几片） */
  produceParts: (pathsFor: (count: number) => string[]) => Promise<string[]>;
}): Promise<SynthesizedSpeech> {
  const { cacheDir, hash, loudnorm, timeoutMs, produceParts } = params;
  await mkdir(cacheDir, { recursive: true });
  const finalPath = join(cacheDir, `${hash}.mp3`);

  if (existsSync(finalPath)) {
    return {
      filePath: finalPath,
      durationMs: await probeDurationMs(finalPath),
      cached: true,
    };
  }

  const rawPaths = await produceParts((count) =>
    Array.from({ length: count }, (_, i) => join(cacheDir, `${hash}.p${i}.raw.mp3`)),
  );
  if (rawPaths.length === 0) throw new Error('TTS 未产出任何音频分片');

  const joinedPath = join(cacheDir, `${hash}.joint.mp3`);
  if (rawPaths.length === 1) {
    await rename(rawPaths[0] as string, joinedPath);
  } else {
    await concatParts(rawPaths, joinedPath, timeoutMs);
    await Promise.all(rawPaths.map((p) => rm(p, { force: true })));
  }

  if (loudnorm) {
    const normPath = join(cacheDir, `${hash}.norm.mp3`);
    await runProc(
      ffmpegPath(),
      ['-y', '-i', joinedPath, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-q:a', '2', normPath],
      timeoutMs,
    );
    await rm(joinedPath, { force: true });
    await rename(normPath, finalPath);
  } else {
    await rename(joinedPath, finalPath);
  }

  return {
    filePath: finalPath,
    durationMs: await probeDurationMs(finalPath),
    cached: false,
  };
}

// ---------------------------------------------------------------------------
// edge-tts（免费，D8 默认）
// ---------------------------------------------------------------------------

export interface EdgeTtsOptions {
  voice: string;
  /** edge-tts rate 格式，如 "-10%" */
  rate: string;
  cacheDir: string;
  /** ffmpeg loudnorm 归一（FR-045 音量稳定） */
  loudnorm?: boolean;
  timeoutMs?: number;
}

export function createEdgeTts(options: EdgeTtsOptions): TtsClient {
  const { voice, rate, cacheDir, loudnorm = true, timeoutMs = PROC_TIMEOUT_MS } = options;

  return {
    synthesize(input: string | SpeechLine[], signal?: AbortSignal): Promise<SynthesizedSpeech> {
      throwIfAborted(signal);
      // edge-tts 不支持逐句情绪/停顿：降级为整段文本，韵律标注忽略（不报错）
      const text = typeof input === 'string' ? input : joinLinesText(normalizeSpeechLines(input));
      const hash = cacheHash([`edge:${voice}`, rate, text]);
      return runCachedPipeline({
        cacheDir,
        hash,
        loudnorm,
        timeoutMs,
        produceParts: async (pathsFor) => {
          throwIfAborted(signal);
          const [rawPath] = pathsFor(1);
          if (!rawPath) throw new Error('edge-tts 未拿到输出路径');
          await runProc(
            'python',
            [
              '-m',
              'edge_tts',
              '--voice',
              voice,
              `--rate=${rate}`,
              '--text',
              text,
              '--write-media',
              rawPath,
            ],
            timeoutMs,
            undefined,
            signal,
          );
          return [rawPath];
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// minimax（付费可选，音质更可控）
// ---------------------------------------------------------------------------

export interface MiniMaxTtsOptions {
  /** MiniMax API key（Bearer 鉴权） */
  apiKey: string;
  /** MiniMax GroupId（放进 query 参数 GroupId） */
  groupId: string;
  /** 系统音色 ID，如 Chinese_wenrounvxing（温柔女性） */
  voice: string;
  model?: string;
  /** 语速 0.5~2.0，默认 1 */
  speed?: number;
  /** 音量 (0,10]，默认 1 */
  vol?: number;
  /** 音调 -12~12，默认 0 */
  pitch?: number;
  cacheDir: string;
  loudnorm?: boolean;
  /** 备用接口地址（如 https://api-bj.minimaxi.com/v1/t2a_v2） */
  baseUrl?: string;
  timeoutMs?: number;
  /** 注入 fetch 便于单测（默认全局 fetch） */
  fetchImpl?: typeof fetch;
}

/** 分片并发上限：长口播可能有 5~6 片，全串行会吃掉段落超时预算 */
const PART_CONCURRENCY = 3;

/** 限并发地跑完所有分片（失败即整段放弃，由组装层沉默保底） */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await fn(items[index] as T, index);
      }
    }),
  );
}

/**
 * 渲染一次请求要念的文本：句间停顿写成 MiniMax 的 `<#秒数#>` 标记。
 * 只在「句与句之间」插——标记必须落在两段可发音文本中间，句尾和开头都不合法；
 * 分片边界上的那一次停顿因此会被丢掉（换情绪本身就是一个气口，不算损失）。
 * 导出仅为单测可见（adapters/index 不对外暴露）。
 */
export function renderPartText(part: SpeechPart): string {
  return part.lines
    .map((line, i) =>
      i < part.lines.length - 1 && line.pauseAfterSec
        ? `${line.text}<#${line.pauseAfterSec}#>`
        : line.text,
    )
    .join('');
}

export function createMiniMaxTts(options: MiniMaxTtsOptions): TtsClient {
  const {
    apiKey,
    groupId,
    voice,
    model = 'speech-2.8-hd',
    speed = 1,
    vol = 1,
    pitch = 0,
    cacheDir,
    loudnorm = true,
    baseUrl = 'https://api.minimaxi.com/v1/t2a_v2',
    timeoutMs = PROC_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  /** 单片合成：语速固定为配置基准、情绪逐片不同，输出格式与鉴权不变 */
  async function requestPart(
    part: { text: string; speed: number; emotion?: string },
    rawPath: string,
    extra?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(extra);
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}GroupId=${encodeURIComponent(groupId)}`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        text: part.text,
        stream: false,
        output_format: 'hex',
        voice_setting: {
          voice_id: voice,
          speed: part.speed,
          vol,
          pitch,
          ...(part.emotion ? { emotion: part.emotion } : {}),
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128_000,
          format: 'mp3',
          channel: 1,
        },
      }),
      signal: mergeAbort(timeoutMs, extra),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MiniMax TTS HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      base_resp?: { status_code?: number; status_msg?: string };
      data?: { audio?: string } | null;
    };
    if (data.base_resp?.status_code !== 0) {
      throw new Error(`MiniMax TTS 失败：${data.base_resp?.status_msg ?? '未知错误'}`);
    }
    const audioHex = data.data?.audio;
    if (!audioHex) throw new Error('MiniMax TTS 返回空音频');
    // 文档明确 output_format=hex 时 data.audio 为 hex 编码（非 base64）
    await writeFile(rawPath, Buffer.from(audioHex, 'hex'));
  }

  return {
    async synthesize(
      input: string | SpeechLine[],
      signal?: AbortSignal,
    ): Promise<SynthesizedSpeech> {
      throwIfAborted(signal);
      // 相邻同语气的句子合并成一次请求：接缝更少，也更省
      const parts = toSpeechParts(input);
      const rendered = parts.map((p) => ({
        text: renderPartText(p),
        speed,
        emotion: p.emotion,
      }));
      const hash = cacheHash([`minimax:${model}:${voice}:vol=${vol}`, JSON.stringify(rendered)]);
      return runCachedPipeline({
        cacheDir,
        hash,
        loudnorm,
        timeoutMs,
        produceParts: async (pathsFor) => {
          throwIfAborted(signal);
          const paths = pathsFor(rendered.length);
          await mapLimit(rendered, PART_CONCURRENCY, async (part, i) => {
            const out = paths[i];
            if (!out) throw new Error('MiniMax 分片参数缺失');
            await requestPart(part, out, signal);
          });
          return paths;
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 工厂：按 provider 选择实现（组装层接线用）
// ---------------------------------------------------------------------------

/** 语速基准（0.5~1.5）→ edge-tts rate 字符串（0.9 → "-10%"，1.15 → "+15%"） */
export function edgeRateFromSpeechRate(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return pct === 0 ? '+0%' : pct > 0 ? `+${pct}%` : `${pct}%`;
}

export type TtsProviderName = 'edge-tts' | 'minimax';

export interface CreateTtsParams {
  provider: TtsProviderName;
  postProcess: string;
  /** 已解析为绝对路径的缓存目录 */
  cacheDir: string;
  /** 语速基准（provider 中立；设置面板「语速」即此项） */
  speechRate: number;
  edge: { voice: string };
  minimax: {
    voice: string;
    apiKeyEnv: string;
    groupIdEnv: string;
    model: string;
    /** MiniMax 合成音量 (0,10]；缺省 1 */
    vol?: number;
  };
  /** 从环境变量取值（注入以便测试；运行时传 process.env 的取值函数） */
  resolveEnv: (name: string) => string | undefined;
  /** 注入 fetch 便于单测（仅 minimax 分支使用；默认全局 fetch） */
  fetchImpl?: typeof fetch;
}

export function createTts(params: CreateTtsParams): TtsClient {
  const loudnorm = params.postProcess === 'loudnorm';

  if (params.provider === 'minimax') {
    const { voice, apiKeyEnv, groupIdEnv, model, vol } = params.minimax;
    const apiKey = params.resolveEnv(apiKeyEnv) ?? '';
    const groupId = params.resolveEnv(groupIdEnv) ?? '';
    if (!apiKey || !groupId) {
      console.warn(
        `[tts] 未配置 MiniMax 凭据（环境变量 ${apiKeyEnv} / ${groupIdEnv}）：梦可将保持沉默（音乐照常）。`,
      );
    }
    return createMiniMaxTts({
      apiKey,
      groupId,
      voice,
      model,
      speed: params.speechRate,
      vol,
      cacheDir: params.cacheDir,
      loudnorm,
      fetchImpl: params.fetchImpl,
    });
  }

  return createEdgeTts({
    voice: params.edge.voice,
    rate: edgeRateFromSpeechRate(params.speechRate),
    cacheDir: params.cacheDir,
    loudnorm,
  });
}
