/**
 * 段落生产：plan-segment → 上下文 → LLM → TTS → 可播出段落。
 * 失败返回 null（沉默保底）；节目引擎仍只负责何时开口。
 *
 * 案头在曲目开播时预取（占用音乐时间），开口 generateSegment 不再联网。
 */
import { buildSegmentPrompt } from './context';
import type { DeskNotes } from './desk';
import { planDeskQueries } from './desk';
import type { LlmClient } from './llm';
import type { MemoryRecordL1 } from './memory';
import { matchSongRequest } from './request';
import {
  clipSpokenText,
  joinLinesText,
  maxCharsForRemaining,
  normalizeSpeechLines,
} from './speech';
import { getDayPartContext } from './time';
import type { TtsClient } from './tts';
import type { SegmentKind, Track } from './types';

export interface SegmentPlan {
  id: string;
  kind: SegmentKind;
  replyTo?: Array<{ id: string; body: string }>;
  ackTitle?: string;
}

export interface ProducedSegment {
  id: string;
  kind: SegmentKind;
  text: string;
  audioPath: string;
  durationMs: number;
  cached: boolean;
  songTrackId: string | null;
}

export interface StationView {
  now: number;
  currentTrack: Track | null;
  recentTracks: Array<{ title: string; artist: string | null; styles: string[] }>;
  recentAired?: Array<{ kind: SegmentKind; text: string }>;
  trackRemainingMs?: number | null;
  trackDurationMs?: number | null;
  nextTrackDurationMs?: number | null;
}

export interface SegmentProducerOptions {
  llm: LlmClient;
  tts: TtsClient;
  persona: string;
  stationName: string;
  hostName: string;
  retrieveMemories: (now: number) => MemoryRecordL1[];
  tracks: Track[];
  view: () => StationView;
  /** 整段口播的字数硬上限（防长篇独白拖垮节奏） */
  maxSegmentChars?: number;
  /** 按段落类型覆盖字数上限（对齐 FR-032/033） */
  maxSegmentCharsByKind?: Partial<Record<SegmentKind, number>>;
  /** 生成失败回调（组装层打日志）；produce 仍返回 null（ER-001~003） */
  onError?: (err: unknown) => void;
}

export interface SegmentProducer {
  produce(plan: SegmentPlan, signal?: AbortSignal): Promise<ProducedSegment | null>;
  /** 曲目开播时预取案头；无听众/无 researchDesk 时组装层不要调用 */
  prefetch(track: Track): void;
}

const DESK_WAIT_MS = 2_500;
const DESK_KINDS = new Set<SegmentKind>(['interlude', 'topic', 'reply']);

function delay(ms: number, signal?: AbortSignal): Promise<'timeout'> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => resolve('timeout'), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createSegmentProducer(options: SegmentProducerOptions): SegmentProducer {
  const cache = new Map<string, DeskNotes>();
  const inflight = new Map<string, Promise<DeskNotes>>();

  function prefetch(track: Track): void {
    if (!options.llm.researchDesk) return;
    if (cache.has(track.id) || inflight.has(track.id)) return;
    const queries = planDeskQueries(track);
    const pending = options.llm
      .researchDesk({
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        styles: track.styles,
        queries,
      })
      .then((notes) => {
        if (notes.notes.length > 0) cache.set(track.id, notes);
        return notes;
      })
      .catch((err: unknown) => {
        options.onError?.(err);
        return { trackId: track.id, queries, notes: [] };
      })
      .finally(() => {
        inflight.delete(track.id);
      });
    inflight.set(track.id, pending);
  }

  async function notesFor(
    track: Track | null,
    kind: SegmentKind,
    signal?: AbortSignal,
  ): Promise<DeskNotes | null> {
    if (!track || !DESK_KINDS.has(kind) || !options.llm.researchDesk) return null;
    prefetch(track);
    const hit = cache.get(track.id);
    if (hit) return hit;
    const pending = inflight.get(track.id);
    if (!pending) return null;
    const raced = await Promise.race([pending, delay(DESK_WAIT_MS, signal)]);
    if (raced === 'timeout') return cache.get(track.id) ?? null;
    return raced;
  }

  async function produce(plan: SegmentPlan, signal?: AbortSignal): Promise<ProducedSegment | null> {
    try {
      if (signal?.aborted) return null;
      const view = options.view();
      const memories = options.retrieveMemories(view.now);
      const deskNotes = await notesFor(view.currentTrack, plan.kind, signal);
      if (signal?.aborted) return null;
      const prompt = buildSegmentPrompt({
        kind: plan.kind,
        persona: options.persona,
        stationName: options.stationName,
        hostName: options.hostName,
        dayPart: getDayPartContext(new Date(view.now)),
        currentTrack: view.currentTrack,
        recentTracks: view.recentTracks,
        replyTo: plan.replyTo,
        ackTitle: plan.ackTitle,
        memories: memories.map((m) => ({
          kind: m.kind,
          text: m.text,
          importance: m.importance,
        })),
        recentAired: view.recentAired,
        trackRemainingMs: view.trackRemainingMs,
        trackDurationMs: view.trackDurationMs,
        nextTrackDurationMs: view.nextTrackDurationMs,
        deskNotes,
      });
      const draft = await options.llm.generateSegment(prompt, signal);
      if (signal?.aborted) return null;
      let songTrackId: string | null = null;
      if (plan.kind === 'reply' && draft.songRequest?.query) {
        songTrackId = matchSongRequest(options.tracks, draft.songRequest.query)?.id ?? null;
      }
      const kindCap =
        options.maxSegmentCharsByKind?.[plan.kind] ??
        options.maxSegmentChars ??
        Number.POSITIVE_INFINITY;
      const maxChars =
        view.trackRemainingMs != null
          ? maxCharsForRemaining(view.trackRemainingMs, kindCap)
          : kindCap;
      const lines = normalizeSpeechLines(draft.lines ?? [], { maxChars });
      const text = lines.length > 0 ? joinLinesText(lines) : clipSpokenText(draft.text, maxChars);
      const speech = await options.tts.synthesize(lines.length > 0 ? lines : text, signal);
      if (signal?.aborted) return null;
      return {
        id: plan.id,
        kind: plan.kind,
        text,
        audioPath: speech.filePath,
        durationMs: speech.durationMs,
        cached: speech.cached,
        songTrackId,
      };
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) return null;
      options.onError?.(err);
      return null;
    }
  }

  return { produce, prefetch };
}
