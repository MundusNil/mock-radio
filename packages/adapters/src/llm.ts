/** OpenAI 兼容 LLM 客户端（D7：DeepSeek / Qwen / GLM / Kimi 通吃，换供应商=改配置） */
import type {
  DeskNotes,
  DeskResearchBrief,
  LlmClient,
  MemoryExtraction,
  SegmentDraft,
  SegmentPrompt,
  SpeechLine,
} from '@mock-radio/core';
import {
  buildDeskResearchPrompt,
  joinLinesText,
  MEMORY_EXTRACTION_SYSTEM,
  normalizeSpeechLines,
  parseDeskNotes,
  parseMemoryExtraction,
} from '@mock-radio/core';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  /** 案头检索超时。占曲目时间，默认 90s；开口仍走 timeoutMs。 */
  deskTimeoutMs?: number;
  /** 网络失败时的重试次数 */
  retries?: number;
  /** 开启模型内置联网搜索（方舟 web_search）。只用于 researchDesk；generateSegment / extractMemories 强制关闭。 */
  webSearch?: boolean;
  /** 单次生成的最大 token 数（长篇口播需要放宽） */
  maxTokens?: number;
}

/** P2 点歌意图 + 逐句韵律的结构化输出契约（LLM 按此格式返回 JSON） */
interface SegmentDraftJson {
  text?: string;
  lines?: Array<{
    text?: string;
    speed?: number;
    emotion?: string;
    /** 说完这句后的停顿秒数（模型常用 pause；pauseAfterSec 兼容） */
    pause?: number;
    pauseAfterSec?: number;
  }>;
  songRequest?: { query?: string } | null;
}

/**
 * 解析逐句韵律：模型给 [{text,emotion,pause}]，语速由系统固定（config）不再解析，
 * 干净的交给 core 规范化。全部行都没有文本时返回 undefined（调用方回退到整段文本）。
 */
function toSpeechLines(raw: unknown): SpeechLine[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const lines: SpeechLine[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      lines.push({ text: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.text !== 'string' || o.text.trim() === '') continue;
    const pause = typeof o.pause === 'number' ? o.pause : o.pauseAfterSec;
    lines.push({
      text: o.text,
      ...(typeof o.speed === 'number' ? { speed: o.speed } : {}),
      ...(typeof o.emotion === 'string' ? { emotion: o.emotion } : {}),
      ...(typeof pause === 'number' ? { pauseAfterSec: pause } : {}),
    });
  }
  if (lines.length === 0) return undefined;
  return normalizeSpeechLines(lines);
}

/**
 * 解析 LLM 输出：模型若仍包一层 JSON 就拆 text / songRequest，
 * 否则整段当口播（songRequest 缺省）。
 */
function parseDraft(raw: string): SegmentDraft {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as SegmentDraftJson;
    const lines = toSpeechLines(parsed.lines);
    const songRequest =
      typeof parsed.songRequest?.query === 'string' && parsed.songRequest.query.trim() !== ''
        ? { query: parsed.songRequest.query.trim() }
        : null;
    if (lines && lines.length > 0) {
      return {
        text: joinLinesText(lines),
        lines,
        songRequest,
      };
    }
    if (typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
      return {
        text: parsed.text.trim(),
        songRequest,
      };
    }
  } catch {
    // 不是 JSON：按纯文本处理
  }
  return { text: trimmed, songRequest: null };
}

export function createOpenAiCompatibleLlm(options: OpenAiCompatibleOptions): LlmClient {
  const {
    baseUrl,
    apiKey,
    model,
    temperature = 0.8,
    timeoutMs = 30_000,
    deskTimeoutMs = 90_000,
    retries = 1,
    webSearch = false,
    // 口播按纯文本解码；记忆提取仍走 JSON
    maxTokens = 2500,
  } = options;

  async function chatOnce(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    opts: {
      webSearch?: boolean;
      jsonObject?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
      disableThinking?: boolean;
    } = {},
  ): Promise<string> {
    const useSearch = opts.webSearch ?? webSearch;
    const jsonObject = opts.jsonObject === true;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(jsonObject ? { response_format: { type: 'json_object' } } : {}),
        ...(useSearch ? { web_search: { enable: true } } : {}),
        ...(opts.disableThinking ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('LLM 空响应');
    return text;
  }

  return {
    async generateSegment(prompt: SegmentPrompt, extra?: AbortSignal): Promise<SegmentDraft> {
      const messages = [
        { role: 'system' as const, content: prompt.system },
        { role: 'user' as const, content: prompt.user },
      ];
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const text = await chatOnce(messages, { webSearch: false, signal: extra });
          return parseDraft(text);
        } catch (err) {
          lastError = err;
          if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
            break;
          // 只有网络/5xx 类错误值得重试；4xx 不重试
          if (err instanceof Error && /HTTP 4\d\d/.test(err.message)) break;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('LLM 调用失败');
    },

    async extractMemories(segmentText: string): Promise<MemoryExtraction[]> {
      const messages = [
        { role: 'system' as const, content: MEMORY_EXTRACTION_SYSTEM },
        { role: 'user' as const, content: segmentText.slice(0, 2000) },
      ];
      try {
        const text = await chatOnce(messages, { webSearch: false, jsonObject: true });
        return parseMemoryExtraction(text);
      } catch {
        // 提取失败不阻塞节目（策展失败 = 本次不记，安全）
        return [];
      }
    },

    async researchDesk(brief: DeskResearchBrief, extra?: AbortSignal): Promise<DeskNotes> {
      if (!webSearch) {
        return { trackId: brief.trackId, queries: brief.queries, notes: [] };
      }
      const prompt = buildDeskResearchPrompt(brief);
      const text = await chatOnce(
        [
          { role: 'system' as const, content: prompt.system },
          { role: 'user' as const, content: prompt.user },
        ],
        { webSearch: true, signal: extra, timeoutMs: deskTimeoutMs, disableThinking: true },
      );
      return parseDeskNotes(text, brief.trackId, brief.queries);
    },
  };
}
