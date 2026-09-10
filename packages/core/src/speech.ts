/**
 * 语音表现层（韵律标注）。
 *
 * 主播「怎么说」和「说什么」一样重要：一段口播不是一整块文本，而是一串句子，
 * 每句有自己的语速、情绪和说完之后的停顿。这些东西由 LLM 在写稿时一起给出，
 * 交给 TTS 供应商消费（D8：供应商可以换，韵律标注不换）。
 *
 * 纯逻辑零 IO：这里只做清洗、夹取与分组，不认识任何供应商的字段名。
 */

/** 一句话的韵律标注（LLM 产出，TTS 消费） */
export interface SpeechLine {
  text: string;
  /** 语速倍率，通常 0.8~1.2；缺省则用配置里的基准语速 */
  speed?: number;
  /** 情绪标签，见 SPEECH_EMOTIONS；缺省则交给 TTS 自动判断 */
  emotion?: string;
  /** 说完这句后的停顿秒数（0~2）；最后一句的停顿会被清零 */
  pauseAfterSec?: number;
}

/** 情绪白名单（MiniMax T2A 取值；其它供应商忽略不支持的项） */
export const SPEECH_EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
] as const;

export type SpeechEmotion = (typeof SPEECH_EMOTIONS)[number];

/** 模型常常写出 neutral / auto / none 之类，统一归一到白名单 */
const EMOTION_ALIAS: Record<string, SpeechEmotion | undefined> = {
  neutral: 'calm',
  calm: 'calm',
  auto: undefined,
  none: undefined,
  normal: 'calm',
  default: undefined,
};

/** 语速合理区间（供应商普遍支持 0.5~2，这里再收紧一点防止过火） */
export const SPEED_RANGE = { min: 0.5, max: 2.0 } as const;
/**
 * 语速量化步长：模型的 0.95 和 1.0 听得出来吗？听不出来，但会让每句话都单独合成一次。
 * 量化后相邻同语速的句子能合并成一次请求，接缝更少、也更省钱。
 */
export const SPEED_STEP = 0.1;
/** 句间停顿上限（秒）：再长就不是停顿，是冷场 */
export const MAX_PAUSE_SEC = 2.0;

/** 一段同韵律的连续文本：一次 TTS 请求合成，减少拼接痕迹 */
export interface SpeechPart {
  speed?: number;
  emotion?: SpeechEmotion;
  /** 组内每一行仍保留自己的停顿（组尾停顿留给下一组接上） */
  lines: SpeechLine[];
}

export interface NormalizeOptions {
  /** 整段口播的字数硬上限（防止长篇独白拖垮节目节奏）；超出则整句丢弃 */
  maxChars?: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 去掉模型可能自己写出来的停顿标记（停顿只走 pauseAfterSec 字段） */
function stripMarkup(text: string): string {
  return text
    .replace(/<#[\d.]*#>/g, '')
    .replace(/[()（）]?\s*(laughs|chuckle|sighs|breath|coughs|gasps|exhale|inhale)[()（）]?/gi, '')
    .trim();
}

function normalizeEmotion(raw: unknown): SpeechEmotion | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase();
  if (key === '') return undefined;
  if ((SPEECH_EMOTIONS as readonly string[]).includes(key)) return key as SpeechEmotion;
  return EMOTION_ALIAS[key];
}

function normalizeSpeed(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const clamped = clamp(n, SPEED_RANGE.min, SPEED_RANGE.max);
  // 加一点 epsilon：0.95 / 0.1 在浮点里是 9.4999…，不补会掉到 0.9
  const stepped = Math.round(clamped / SPEED_STEP + 1e-9) * SPEED_STEP;
  return round2(stepped);
}

function normalizePause(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return round2(clamp(n, 0, MAX_PAUSE_SEC));
}

/** 口播硬上限：按句切开，超出的整句丢掉；第一句就超长才硬切。 */
export function clipSpokenText(text: string, maxChars: number): string {
  const cleaned = stripMarkup(text).trim();
  if (cleaned.length <= maxChars) return cleaned;
  const parts = cleaned.split(/(?<=[。！？!?])/);
  let out = '';
  for (const part of parts) {
    if (part.length === 0) continue;
    if (out.length + part.length > maxChars) break;
    out += part;
  }
  if (out.length > 0) return out.trim();
  return cleaned.slice(0, maxChars);
}

/** 口播约 4 字/秒。剩余时间不够时按钟收字数，最短 24 字以免只剩半句。 */
const CHARS_PER_SEC = 4;
const MIN_CLOCK_CHARS = 24;

export function maxCharsForRemaining(remainingMs: number, kindCap: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return kindCap;
  const fromClock = Math.floor((remainingMs / 1000) * CHARS_PER_SEC);
  const bounded = Math.max(MIN_CLOCK_CHARS, fromClock);
  if (!Number.isFinite(kindCap)) return bounded;
  return Math.min(kindCap, bounded);
}

/**
 * 把 LLM 给的原始行清洗成可信的韵律行：
 * 去空行与标记、夹取语速与停顿、情绪归一到白名单、最后一句不留停顿、总字数截断。
 */
export function normalizeSpeechLines(
  raw: readonly SpeechLine[],
  options: NormalizeOptions = {},
): SpeechLine[] {
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  const out: SpeechLine[] = [];
  let used = 0;

  for (const line of raw) {
    const text = stripMarkup(typeof line?.text === 'string' ? line.text : '');
    if (text === '') continue;
    if (used + text.length > maxChars) break; // 硬上限：整句丢弃，不切半句
    used += text.length;
    out.push({
      text,
      ...(normalizeSpeed(line.speed) !== undefined ? { speed: normalizeSpeed(line.speed) } : {}),
      ...(normalizeEmotion(line.emotion) !== undefined
        ? { emotion: normalizeEmotion(line.emotion) }
        : {}),
      ...(normalizePause(line.pauseAfterSec) !== undefined
        ? { pauseAfterSec: normalizePause(line.pauseAfterSec) }
        : {}),
    });
  }

  const last = out[out.length - 1];
  if (last && last.pauseAfterSec !== undefined) {
    delete last.pauseAfterSec;
  }
  return out;
}

/** 韵律指纹：只有 speed 与 emotion 都相同才算同一口气 */
function prosodyKey(line: SpeechLine): string {
  return `${line.speed ?? ''}/${line.emotion ?? ''}`;
}

/** 把相邻同韵律的行合并成一个分片：情绪没变就别让 TTS 重新起嗓 */
export function groupSpeechParts(lines: readonly SpeechLine[]): SpeechPart[] {
  const parts: SpeechPart[] = [];
  for (const line of lines) {
    const prev = parts[parts.length - 1];
    if (prev && prosodyKey(prev.lines[0] as SpeechLine) === prosodyKey(line)) {
      prev.lines.push(line);
    } else {
      parts.push({
        ...(line.speed !== undefined ? { speed: line.speed } : {}),
        ...(line.emotion !== undefined ? { emotion: line.emotion as SpeechEmotion } : {}),
        lines: [line],
      });
    }
  }
  return parts;
}

/** 分片的纯文本（不含停顿标记）：记忆提取、日志、edge-tts 用 */
export function joinPartText(part: SpeechPart): string {
  return part.lines.map((l) => l.text).join('');
}

export function joinLinesText(lines: readonly SpeechLine[]): string {
  return lines.map((l) => l.text).join('');
}
