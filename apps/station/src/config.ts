/** 配置加载：station.config.json → 类型化配置（默认值兜底；调电台=改配置，D 决策） */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineConfig, MemoryConfig, SchedulerConfig, SegmentKind } from '@mock-radio/core';
import {
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_SCHEDULER_CONFIG,
} from '@mock-radio/core';
import { findRepoRoot } from './paths';

interface RawJson {
  station?: { name?: string; host?: string; port?: number };
  engine?: Partial<EngineConfig> & { nodeWindow?: Partial<EngineConfig['nodeWindow']> };
  scheduler?: Partial<SchedulerConfig>;
  memory?: Partial<MemoryConfig>;
  audio?: { ducking?: Partial<DuckingConfig>; crossfadeMs?: number; speechVolume?: number };
  llm?: Partial<LlmConfig>;
  tts?: {
    provider?: 'edge-tts' | 'minimax';
    postProcess?: string;
    cacheDir?: string;
    speechRate?: number;
    edge?: Partial<EdgeTtsProviderConfig>;
    minimax?: Partial<MiniMaxTtsProviderConfig>;
  };
  messages?: { retentionDays?: number };
  library?: { root?: string };
}

export interface DuckingConfig {
  speechGain: number;
  attackTauMs: number;
  releaseDelayMs: number;
  releaseTauMs: number;
}

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  temperature: number;
  /** 模型内置联网搜索（豆包/方舟支持；DeepSeek 不支持） */
  webSearch: boolean;
  /** 单次请求超时（ms）；推理+搜索模型需要更长 */
  timeoutMs: number;
  /** 单次生成的 token 上限（长篇口播要放宽，否则会被截断成半句话） */
  maxTokens: number;
  /** 一段口播的字数硬上限：长度自由，但不能变成独白 */
  maxSegmentChars: number;
  /** 按段落类型覆盖字数上限（对齐 FR-032/033） */
  maxSegmentCharsByKind?: Partial<Record<SegmentKind, number>>;
}

/** edge-tts 子配置（免费，D8 默认）；语速走 tts.speechRate 统一基准 */
export interface EdgeTtsProviderConfig {
  voice: string;
}

/** minimax 子配置（付费可选，音质更可控）；语速走 tts.speechRate 统一基准 */
export interface MiniMaxTtsProviderConfig {
  /** 系统音色 ID，如 Chinese (Mandarin)_Warm_Girl（温暖少女） */
  voice: string;
  /** 模型，默认 speech-2.8-hd */
  model: string;
  /** MiniMax 合成音量 (0,10]，默认 1.5。Warm_Girl 源电平偏轻，面板 speechVolume 已到 1 */
  vol: number;
  /** 存放 API key 的环境变量名 */
  apiKeyEnv: string;
  /** 存放 GroupId 的环境变量名 */
  groupIdEnv: string;
}

export interface TtsConfig {
  provider: 'edge-tts' | 'minimax';
  /** 'loudnorm' 或 'none' */
  postProcess: string;
  cacheDir: string;
  /** 语速基准 0.5~1.5（1 = 原速）；edge 换算成 ±%，minimax 直接作 speed */
  speechRate: number;
  edge: EdgeTtsProviderConfig;
  minimax: MiniMaxTtsProviderConfig;
}

export interface StationRuntimeConfig {
  station: { name: string; host: string; port: number };
  engine: EngineConfig;
  scheduler: SchedulerConfig;
  audio: { ducking: DuckingConfig; crossfadeMs: number; speechVolume: number };
  llm: LlmConfig;
  tts: TtsConfig;
  messages: { retentionDays: number };
  library: { root: string };
  memory: MemoryConfig;
}

const DEFAULT_DUCKING: DuckingConfig = {
  speechGain: 0.45,
  attackTauMs: 250,
  releaseDelayMs: 1200,
  releaseTauMs: 600,
};

/** 语速基准默认值（0.9 ≈ 舒缓；FR-045「语速舒缓」） */
const DEFAULT_SPEECH_RATE = 0.9;

/** 主播音量默认值（1 = 不额外衰减；前端语音轨增益的乘数） */
const DEFAULT_SPEECH_VOLUME = 1;

/** MiniMax 合成音量默认值。Warm_Girl 比温柔女性轻一档，1.5 是适度抬升 */
const DEFAULT_MINIMAX_VOL = 1.5;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function clampRate(v: number): number {
  return Math.min(1.5, Math.max(0.5, v));
}

/** MiniMax vol：(0,10] */
function clampVol(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_MINIMAX_VOL;
  return Math.min(10, Math.max(0.1, v));
}

/** 切歌交叠淡变时长（ms）；0 = 硬切。听感顺滑区间约 150~400 */
const DEFAULT_CROSSFADE_MS = 250;

export function loadStationConfig(
  path = join(findRepoRoot(), 'config', 'station.config.json'),
): StationRuntimeConfig {
  const raw: RawJson = JSON.parse(readFileSync(path, 'utf-8'));
  const engine: EngineConfig = {
    ...DEFAULT_ENGINE_CONFIG,
    ...raw.engine,
    nodeWindow: { ...DEFAULT_ENGINE_CONFIG.nodeWindow, ...raw.engine?.nodeWindow },
  };
  const scheduler: SchedulerConfig = {
    ...DEFAULT_SCHEDULER_CONFIG,
    ...raw.scheduler,
    styleBaseWeights: {
      ...DEFAULT_SCHEDULER_CONFIG.styleBaseWeights,
      ...raw.scheduler?.styleBaseWeights,
    },
    timeOfDayBoost: {
      ...DEFAULT_SCHEDULER_CONFIG.timeOfDayBoost,
      ...raw.scheduler?.timeOfDayBoost,
    },
  };
  return {
    station: {
      name: raw.station?.name ?? '梦可电台',
      host: raw.station?.host ?? '梦可',
      port: raw.station?.port ?? 9730,
    },
    engine,
    scheduler,
    audio: {
      ducking: { ...DEFAULT_DUCKING, ...raw.audio?.ducking },
      crossfadeMs: raw.audio?.crossfadeMs ?? DEFAULT_CROSSFADE_MS,
      speechVolume: clamp01(raw.audio?.speechVolume ?? DEFAULT_SPEECH_VOLUME),
    },
    llm: {
      provider: 'ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-2-1-pro-260628',
      apiKeyEnv: 'ARK_API_KEY',
      temperature: 0.8,
      webSearch: true,
      timeoutMs: 120_000,
      maxTokens: 2500,
      maxSegmentChars: 180,
      maxSegmentCharsByKind: {
        station_id: 40,
        interlude: 180,
        topic: 400,
        reply: 180,
        request_ack: 80,
      },
      ...raw.llm,
    },
    tts: {
      ...raw.tts,
      provider: raw.tts?.provider ?? 'edge-tts',
      postProcess: raw.tts?.postProcess ?? 'loudnorm',
      cacheDir: raw.tts?.cacheDir ?? '.cache/tts',
      speechRate: clampRate(raw.tts?.speechRate ?? DEFAULT_SPEECH_RATE),
      edge: {
        voice: 'zh-CN-XiaoxuanNeural',
        ...raw.tts?.edge,
      },
      minimax: {
        voice: 'Chinese (Mandarin)_Warm_Girl',
        model: 'speech-2.8-hd',
        apiKeyEnv: 'MINIMAX_API_KEY',
        groupIdEnv: 'MINIMAX_GROUP_ID',
        ...raw.tts?.minimax,
        vol: clampVol(Number(raw.tts?.minimax?.vol ?? DEFAULT_MINIMAX_VOL)),
      },
    },
    messages: { retentionDays: 7, ...raw.messages },
    library: { root: 'config/library', ...raw.library },
    memory: { ...DEFAULT_MEMORY_CONFIG, ...raw.memory },
  };
}
