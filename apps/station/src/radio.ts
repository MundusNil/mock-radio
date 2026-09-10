/**
 * 电台组装：把 core 接到真实世界（HTTP / WS / 文件）。
 * 节目引擎出意图 → 段落生产产出语音 → 这里广播与入库。
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ServerType } from '@hono/node-server';
import type { Clock, Store } from '@mock-radio/adapters';
import type {
  EngineConfig,
  EngineEvent,
  LlmClient,
  MemoryConfig,
  SchedulerConfig,
  SegmentKind,
  Track,
  TtsClient,
} from '@mock-radio/core';
import {
  createEngine,
  createProgrammeMemory,
  createScheduler,
  createSegmentProducer,
} from '@mock-radio/core';
import type { ServerEvent, StationState } from '@mock-radio/shared';
import { type Context, Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import type { DuckingConfig } from './config';
import type { KeyDef } from './keys';
import { applyKeys, keyStatus } from './keys';
import type { VoiceConfigShape } from './voice';
import { applyVoiceSettings, CADENCE_PRESETS, readVoiceSettings } from './voice';

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

/** 语音段落保留上限（P3 进 SQLite 前先用内存；防无界增长） */
const AIRED_SEGMENT_LIMIT = 50;

interface VoiceSegment {
  id: string;
  kind: SegmentKind;
  text: string;
  audioPath: string;
  durationMs: number;
  startedAt: number;
  /** 点歌受理：request_ack 播出后要插入调度器的曲目（P2） */
  songTrackId: string | null;
  /** reply 段消耗的留言 id：播出后从库里删除（重启不重播，FR-051） */
  replyToIds?: string[];
}

/** 维护者审查台页面（apps/admin/index.html） */
const adminHtmlPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'apps',
  'admin',
  'index.html',
);

export interface RadioDeps {
  stationName: string;
  hostName: string;
  persona: string;
  engineConfig: EngineConfig;
  schedulerConfig: SchedulerConfig;
  ducking: DuckingConfig;
  /** 切歌交叠淡变时长（ms）；从配置来，前端据此做平滑过渡 */
  crossfadeMs: number;
  tracks: Track[];
  libraryRoot: string;
  clock: Clock;
  /** 工厂：密钥写入 .env 后原地重建客户端（下次生成即新值，无需重启） */
  llmFactory: () => LlmClient;
  ttsFactory: () => TtsClient;
  store: Store;
  /** 原始留言保留天数（FR-092：7 天） */
  retentionDays: number;
  /** L1 记忆检索配置（P3） */
  memoryConfig: MemoryConfig;
  /** 一段口播的字数硬上限（防长篇独白拖垮节目节奏） */
  maxSegmentChars: number;
  /** 按段落类型覆盖字数上限（对齐 FR-032/033） */
  maxSegmentCharsByKind?: Partial<Record<SegmentKind, number>>;
  /** 仓库根 .env 绝对路径（设置面板写密钥用） */
  envPath: string;
  /** 面板可配置的密钥白名单（来自 station.config.json 声明的 env 名） */
  keyDefs: KeyDef[];
  /** config/station.config.json 绝对路径（语音设置写回用，铁律 4） */
  configPath: string;
  /** 内存 runtime 配置（与 engineConfig 同一对象引用；语音设置热更新写这里） */
  runtimeConfig: VoiceConfigShape;
}

export interface Radio {
  app: Hono;
  start(): void;
  stop(): void;
  attachWs(server: ServerType): void;
}

export function createRadio(deps: RadioDeps): Radio {
  const { tracks, libraryRoot, clock } = deps;
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  /** 当前生效的客户端（POST /api/admin/keys 后由工厂重建覆盖） */
  let currentLlm = deps.llmFactory();
  let currentTts = deps.ttsFactory();
  // producer 持有下面两个稳定代理：密钥热重建只换 current*，不用重建 producer
  const llm: LlmClient = {
    generateSegment: (prompt, signal) => currentLlm.generateSegment(prompt, signal),
    extractMemories: (text) => currentLlm.extractMemories(text),
    researchDesk: (brief, signal) => {
      if (!currentLlm.researchDesk) {
        return Promise.resolve({ trackId: brief.trackId, queries: brief.queries, notes: [] });
      }
      return currentLlm.researchDesk(brief, signal).then((notes) => {
        console.log(`[radio] 案头 ${brief.title}：${notes.notes.length} 条`);
        return notes;
      });
    },
  };
  const tts: TtsClient = {
    synthesize: (input, signal) => currentTts.synthesize(input, signal),
  };

  const engine = createEngine({ config: deps.engineConfig, rng: Math.random });
  const scheduler = createScheduler({
    tracks,
    config: deps.schedulerConfig,
    rng: Math.random,
  });
  const programmeMemory = createProgrammeMemory({
    config: deps.memoryConfig,
    list: () => deps.store.listMemories(),
    touch: (id, at) => deps.store.touchMemory(id, at),
    insert: (rows) => deps.store.insertMemories(rows),
    nextId: () => randomUUID(),
  });

  /** 生成中/已生成待播的段落（id → 内容） */
  const voiceSegments = new Map<string, VoiceSegment>();
  /** 已播出的段落（供 /audio/segment/:id 回放引用，按 startedAt 淘汰） */
  const airedSegments: VoiceSegment[] = [];
  /** 在途 LLM/TTS：曲目结束或超时丢段时 abort */
  const inflight = new Map<string, AbortController>();

  const producer = createSegmentProducer({
    llm,
    tts,
    persona: deps.persona,
    stationName: deps.stationName,
    hostName: deps.hostName,
    retrieveMemories: (now) => programmeMemory.retrieve(now),
    tracks,
    maxSegmentChars: deps.maxSegmentChars,
    maxSegmentCharsByKind: deps.maxSegmentCharsByKind,
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[radio] 段落生成失败（沉默保底，ER-001~003）：${msg}`);
    },
    view: () => {
      const now = clock.now();
      const snap = engine.getSnapshot(now);
      const recentAired =
        airedSegments.length > 0
          ? airedSegments
              .filter((s) => s.text.trim().length > 0)
              .slice(-2)
              .map((s) => ({ kind: s.kind, text: s.text }))
          : deps.store
              .listSegments()
              .filter((s) => s.status === 'aired' && s.text.trim().length > 0)
              .sort((a, b) => (a.airedAt ?? 0) - (b.airedAt ?? 0))
              .slice(-2)
              .map((s) => ({ kind: s.kind, text: s.text }));
      const current = snap.trackId ? (trackById.get(snap.trackId) ?? null) : null;
      let nextTrackDurationMs: number | null = null;
      try {
        nextTrackDurationMs = scheduler.peekNext(now).track.durationMs;
      } catch {
        nextTrackDurationMs = null;
      }
      return {
        now,
        currentTrack: current,
        recentTracks: snap.recentTracks,
        recentAired,
        trackRemainingMs: current ? Math.max(0, snap.trackDurationMs - snap.positionMs) : null,
        trackDurationMs: current ? snap.trackDurationMs : null,
        nextTrackDurationMs,
      };
    },
  });
  function maybePrefetch(track: Track | null | undefined): void {
    if (!track) return;
    if (!deps.runtimeConfig.engine.voiceEnabled) return;
    if (engine.getSnapshot(clock.now()).listeners <= 0) return;
    producer.prefetch(track);
  }

  const wss = new WebSocketServer({ noServer: true });

  /** 当前曲目的 play 记录 id（track-ended 时收尾） */
  let currentPlayId: string | null = null;

  function broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  function getState(): StationState {
    const now = clock.now();
    const snap = engine.getSnapshot(now);
    return {
      trackId: snap.trackId,
      title: snap.trackTitle,
      startedAt: snap.trackStartedAt,
      durationMs: snap.trackDurationMs,
      positionMs: snap.positionMs,
      hostTalking: snap.hostTalking,
      hostSegmentId: snap.hostSegmentId,
      serverTime: now,
    };
  }

  function startTrack(at: number): void {
    const decision = scheduler.pickNext(at);
    scheduler.reportStarted(decision.track.id, at);
    engine.onTrackStarted(decision.track, at);
    try {
      scheduler.peekNext(at);
    } catch {
      /* 曲库空时 peek 失败不影响本曲 */
    }
    consecutiveFailures = 0; // 成功播出一首，失败计数清零（「连续」语义）
    if (currentPlayId !== null) {
      deps.store.endPlay(currentPlayId, at);
    }
    currentPlayId = deps.store.startPlay(decision.track.id, at);
    if (decision.relaxedNoRepeat) {
      console.warn(
        `[scheduler] 曲库不足，放宽 30 分钟防重复（FR-018 例外）：${decision.track.title}`,
      );
    }
    console.log(
      `[radio] ▶ ${decision.track.title}（${decision.track.styles.join('/')}，${Math.round(decision.track.durationMs / 1000)}s）`,
    );
    maybePrefetch(decision.track);
    broadcast({
      type: 'track',
      trackId: decision.track.id,
      title: decision.track.title,
      startedAt: at,
      durationMs: decision.track.durationMs,
    });
  }

  async function produceAndReady(plan: {
    id: string;
    kind: SegmentKind;
    replyTo?: Array<{ id: string; body: string }>;
    ackTitle?: string;
  }): Promise<void> {
    const ac = new AbortController();
    inflight.set(plan.id, ac);
    try {
      const produced = await producer.produce(plan, ac.signal);
      if (ac.signal.aborted) return;
      if (!produced) {
        engine.onSegmentFailed(plan.id);
        return;
      }
      if (!engine.onSegmentReady(produced.id, produced.durationMs)) {
        console.warn(
          `[radio] ⏭️ ${produced.kind}错过播出时机已放弃（沉默保底，非播出）：${produced.text}`,
        );
        return;
      }
      if (produced.songTrackId) {
        const hit = trackById.get(produced.songTrackId);
        if (hit) {
          engine.onRequestAck(hit.title);
          scheduler.queueTrack(hit.id);
          console.log(
            `[radio] 🎵 点歌受理：《${hit.title}》（${hit.styles.join('/')}）→ 预告后插播`,
          );
        }
      }
      voiceSegments.set(plan.id, {
        id: produced.id,
        kind: produced.kind,
        text: produced.text,
        audioPath: produced.audioPath,
        durationMs: produced.durationMs,
        startedAt: 0,
        songTrackId: produced.songTrackId,
        replyToIds: plan.replyTo?.map((m) => m.id),
      });
      console.log(
        `[radio] 💬 ${produced.kind}（${(produced.durationMs / 1000).toFixed(1)}s${produced.cached ? '，缓存命中' : ''}）：${produced.text}`,
      );
    } finally {
      inflight.delete(plan.id);
    }
  }

  /** L1 记忆策展（P3）：播出后提取值得保留的节目事实。失败静默。 */
  async function extractAndStoreMemories(seg: VoiceSegment): Promise<void> {
    try {
      const extracted = await llm.extractMemories(seg.text);
      programmeMemory.ingest(extracted, clock.now());
      if (extracted.length === 0) return;
      console.log(
        `[radio] 🧠 记忆 ${extracted.length} 条：${extracted.map((m) => `[${m.kind}] ${m.text}`).join('；')}`,
      );
    } catch (err) {
      console.warn(
        `[radio] 记忆提取失败（忽略，不影响节目）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function handleEvents(events: EngineEvent[], now: number): void {
    for (const event of events) {
      switch (event.type) {
        case 'track-ended': {
          startTrack(now);
          break;
        }
        case 'plan-segment': {
          void produceAndReady({
            id: event.id,
            kind: event.kind,
            replyTo: event.replyTo,
            ackTitle: event.ackTitle,
          });
          break;
        }
        case 'segment-dropped': {
          inflight.get(event.id)?.abort();
          inflight.delete(event.id);
          break;
        }
        case 'play-segment': {
          const seg = voiceSegments.get(event.segmentId);
          if (!seg) break;
          const aired: VoiceSegment = { ...seg, startedAt: event.startedAt };
          airedSegments.push(aired);
          if (airedSegments.length > AIRED_SEGMENT_LIMIT) {
            airedSegments.shift();
          }
          // 回复播出后：消耗的留言从库里删除（FR-051，重启不重播）
          if (aired.replyToIds && aired.replyToIds.length > 0) {
            deps.store.deleteMessages(aired.replyToIds);
          }
          // 节目记录（P3 记忆的基础数据；原始文案仅存库，不外泄）
          try {
            deps.store.insertSegment({
              id: aired.id,
              kind: aired.kind,
              text: aired.text,
              audioPath: aired.audioPath,
              durationMs: aired.durationMs,
              plannedAt: 0,
              airedAt: aired.startedAt,
              status: 'aired',
            });
          } catch (err) {
            // 记录失败不影响播出（ER 哲学：绝不因内部故障打断节目）
            console.warn(
              `[radio] 段记录入库失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
            );
          }
          // L1 记忆策展（P3）：播出后异步提取值得保留的节目事实（失败静默，不阻塞节目）
          void extractAndStoreMemories(aired);
          broadcast({
            type: 'voice',
            segmentId: event.segmentId,
            startedAt: event.startedAt,
            durationMs: event.durationMs,
          });
          break;
        }
      }
    }
  }

  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/state', (c) => c.json(getState()));

  /** 前端需要的公开信息（电台名、ducking 曲线参数——曲线在配置里，不在代码里） */
  app.get('/api/config', (c) =>
    c.json({
      station: { name: deps.stationName, host: deps.hostName },
      audio: { ducking: deps.ducking, crossfadeMs: deps.crossfadeMs },
      voice: {
        enabled: deps.runtimeConfig.engine.voiceEnabled,
        speechVolume: deps.runtimeConfig.audio.speechVolume ?? 1,
      },
    }),
  );

  app.get('/api/admin/memories', (c) => c.json(deps.store.listMemories()));

  app.delete('/api/admin/memories/:id', (c) => {
    deps.store.deleteMemory(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/admin/messages', (c) => c.json(deps.store.listActiveMessages(clock.now())));

  // ---- 设置面板：密钥配置（写 .env + 热生效；单机版无鉴权，同 admin 边界） ----

  /** 只回「是否已配置」，真实值永不出服务器 */
  app.get('/api/admin/keys', (c) => c.json({ keys: keyStatus(deps.keyDefs) }));

  /** 应用密钥：写入 .env → 同步 process.env → 重建客户端 → 回新状态 */
  app.post('/api/admin/keys', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    if (typeof body !== 'object' || body === null || !('updates' in body)) {
      return c.json({ error: '缺少 updates 对象' }, 400);
    }
    const raw = body.updates;
    if (typeof raw !== 'object' || raw === null) {
      return c.json({ error: '缺少 updates 对象' }, 400);
    }
    const updates: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value !== 'string') {
        return c.json({ error: `${name} 的值必须是字符串` }, 400);
      }
      updates[name] = value;
    }
    try {
      const result = applyKeys(deps.envPath, deps.keyDefs, updates);
      currentLlm = deps.llmFactory();
      currentTts = deps.ttsFactory();
      console.log(`[radio] 🔑 密钥已更新并写入 .env：${Object.keys(updates).join(', ')}`);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ---- 设置面板：语音设置（写 station.config.json + 热生效；铁律 4）----

  /** 当前语音设置 + 频率档位预设（面板渲染用） */
  app.get('/api/admin/voice', (c) =>
    c.json({ settings: readVoiceSettings(deps.runtimeConfig), cadences: CADENCE_PRESETS }),
  );

  /** 应用语音设置：写盘 → 更新内存配置 → 引擎热开关 → 重建 TTS（语速/音色/合成音量） */
  app.post('/api/admin/voice', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    if (typeof body !== 'object' || body === null || !('settings' in body)) {
      return c.json({ error: '缺少 settings 对象' }, 400);
    }
    const patch = body.settings;
    if (typeof patch !== 'object' || patch === null) {
      return c.json({ error: 'settings 必须是对象' }, 400);
    }
    try {
      const settings = applyVoiceSettings(
        deps.configPath,
        deps.runtimeConfig,
        patch as Record<string, unknown>,
      );
      // 引擎热开关：关闭时丢弃在途段落立即静默；开启时恢复规划
      engine.setVoiceEnabled(settings.enabled);
      if (!settings.enabled) {
        for (const ac of inflight.values()) ac.abort();
        inflight.clear();
      }
      // 语速变了：重建 TTS 客户端（下次合成即新值）
      currentTts = deps.ttsFactory();
      console.log(
        `[radio] 🎙️ 语音设置已更新并写入配置：enabled=${settings.enabled} 语速=${settings.speechRate} 音量=${settings.speechVolume} 频率=${settings.cadence}${settings.minimaxVoice ? ` 音色=${settings.minimaxVoice}` : ''}${settings.minimaxVol != null ? ` vol=${settings.minimaxVol}` : ''}`,
      );
      broadcast({
        type: 'voice-settings',
        enabled: settings.enabled,
        speechVolume: settings.speechVolume,
      });
      return c.json({ ok: true, settings });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** 维护者审查台页面（P3，FR-100） */
  app.get('/admin', (c) =>
    c.html(readFileSync(adminHtmlPath, 'utf-8'), 200, {
      'Content-Type': 'text/html; charset=utf-8',
    }),
  );

  async function streamFile(c: Context, absPath: string, contentType: string): Promise<Response> {
    const info = await stat(absPath).catch(() => null);
    if (!info?.isFile()) return c.json({ error: 'file missing' }, 410);
    const stream = Readable.toWeb(createReadStream(absPath)) as ReadableStream<Uint8Array>;
    return c.body(stream, 200, {
      'Content-Type': contentType,
      'Content-Length': String(info.size),
      'Cache-Control': 'no-cache',
    });
  }

  app.get('/audio/track/:id', async (c) => {
    const track = trackById.get(c.req.param('id'));
    if (!track) return c.json({ error: 'track not found' }, 404);
    const absPath = join(libraryRoot, track.path);
    const ext = track.path.slice(track.path.lastIndexOf('.'));
    return streamFile(c, absPath, CONTENT_TYPES[ext] ?? 'application/octet-stream');
  });

  app.get('/audio/segment/:id', async (c) => {
    const seg =
      voiceSegments.get(c.req.param('id')) ?? airedSegments.find((s) => s.id === c.req.param('id'));
    if (!seg) return c.json({ error: 'segment not found' }, 404);
    return streamFile(c, seg.audioPath, 'audio/mpeg');
  });

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    // 电台开机即开播（D5：音乐时间线永远走，调频进来时音乐已经在放）
    // 重启恢复：上次没播完的曲目从剩余位置接着播（电台重启不失忆）
    const now = clock.now();
    const unfinished = deps.store.getLastUnfinishedPlay();
    const resumeTrack = unfinished ? trackById.get(unfinished.trackId) : undefined;
    if (unfinished && resumeTrack && now < unfinished.startedAt + resumeTrack.durationMs) {
      // 恢复调度器防重复记忆：最近 30 分钟播放史
      for (const play of deps.store.listRecentPlays(now - deps.schedulerConfig.noRepeatWindowMs)) {
        scheduler.reportStarted(play.trackId, play.startedAt);
      }
      engine.onTrackStarted(resumeTrack, unfinished.startedAt);
      currentPlayId = unfinished.id;
      console.log(
        `[radio] ↻ 恢复上次节目：${resumeTrack.title}（${Math.round((now - unfinished.startedAt) / 1000)}s 处）`,
      );
      broadcast({
        type: 'track',
        trackId: resumeTrack.id,
        title: resumeTrack.title,
        startedAt: unfinished.startedAt,
        durationMs: resumeTrack.durationMs,
      });
      maybePrefetch(resumeTrack);
    } else {
      // 上次播完或已过时：正常开播
      if (unfinished && resumeTrack) {
        deps.store.endPlay(unfinished.id, now);
      }
      startTrack(now);
    }
    for (const msg of deps.store.listActiveMessages(now)) {
      engine.onMessage({ id: msg.id, body: msg.body, receivedAt: msg.receivedAt });
    }
    tickTimer = setInterval(() => {
      const tickNow = clock.now();
      const events = engine.tick(tickNow);
      if (events.length > 0) handleEvents(events, tickNow);
    }, 1000);
    // 每日清理过期留言（FR-092）
    cleanupTimer = setInterval(
      () => {
        const removed = deps.store.deleteExpiredMessages(clock.now());
        if (removed > 0) console.log(`[radio] 🧹 清理过期留言 ${removed} 条`);
      },
      24 * 60 * 60 * 1000,
    );
  }

  function stop(): void {
    if (tickTimer !== null) clearInterval(tickTimer);
    if (cleanupTimer !== null) clearInterval(cleanupTimer);
  }

  /** ER-004/005：连续失败计数，≥3 进信号丢失状态 */
  let consecutiveFailures = 0;

  /** 单曲损坏：拉黑 + 强制换下一首（ER-004） */
  async function onTrackFailed(trackId: string): Promise<void> {
    const track = trackById.get(trackId);
    if (!track) return;
    // 区分「文件真丢了」与「解码暂时失败」：文件还在 → 不拉黑（可能是瞬时解码压力），仅换歌
    const absPath = join(libraryRoot, track.path);
    const fileExists = await stat(absPath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!fileExists) {
      scheduler.blacklistTrack(trackId);
      console.warn(`[radio] ⚠️ 曲目文件缺失（${track.title}）已拉黑，尝试下一首（ER-004）`);
    } else {
      console.warn(`[radio] ⚠️ 曲目解码失败（${track.title}）文件仍在，换下一首重试（不拉黑）`);
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= 3) {
      console.error('[radio] 📡 连续 3 首失败：信号丢失（ER-005）');
      broadcast({ type: 'off-air', reason: 'library' });
      return;
    }
    // 强制换曲：选新曲并直接接管时间线（engine 无感知的覆盖，plays 由 startTrack 收尾）
    try {
      const now = clock.now();
      const decision = scheduler.pickNext(now);
      scheduler.reportStarted(decision.track.id, now);
      if (currentPlayId !== null) {
        deps.store.endPlay(currentPlayId, now);
      }
      currentPlayId = deps.store.startPlay(decision.track.id, now);
      engine.onTrackStarted(decision.track, now);
      broadcast({
        type: 'track',
        trackId: decision.track.id,
        title: decision.track.title,
        startedAt: now,
        durationMs: decision.track.durationMs,
      });
      maybePrefetch(decision.track);
    } catch {
      // 曲库耗尽：信号丢失（ER-005）
      console.error('[radio] 📡 曲库无可播放曲目：信号丢失（ER-005）');
      broadcast({ type: 'off-air', reason: 'library' });
    }
  }

  /** 上行留言处理（P2）：入库（7 天保留）→ 引擎 SLA 队列 → 回执 */
  function handleClientMessage(ws: WebSocket, raw: string): void {
    try {
      const parsed = JSON.parse(raw) as { type?: string; body?: string; trackId?: string };
      if (parsed.type === 'track-failed' && typeof parsed.trackId === 'string') {
        void onTrackFailed(parsed.trackId);
        return;
      }
      if (parsed.type !== 'message' || typeof parsed.body !== 'string' || !parsed.body.trim()) {
        return;
      }
      const now = clock.now();
      const id = randomUUID();
      const retention = deps.retentionDays * 86_400_000;
      deps.store.insertMessage({
        id,
        body: parsed.body.trim(),
        receivedAt: now,
        expiresAt: now + retention,
      });
      engine.onMessage({ id, body: parsed.body.trim(), receivedAt: now });
      ws.send(JSON.stringify({ type: 'received', id }));
      console.log(`[radio] 💌 留言（${id.slice(0, 8)}）：${parsed.body.trim()}`);
    } catch {
      // 无效消息忽略，事件流不断
    }
  }

  function attachWs(server: ServerType): void {
    server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
    wss.on('connection', (ws) => {
      // WS 连接数即在场人数（技术设计 §4.7）
      engine.onListenersChanged(wss.clients.size);
      if (wss.clients.size > 0) {
        const snap = engine.getSnapshot(clock.now());
        if (snap.trackId) maybePrefetch(trackById.get(snap.trackId));
      }
      // 调频进入：立即补发当前状态
      ws.send(JSON.stringify({ type: 'sync', state: getState() }));
      ws.on('message', (raw) => {
        handleClientMessage(ws, raw.toString());
      });
      ws.on('close', () => {
        engine.onListenersChanged(wss.clients.size);
      });
    });
  }

  return { app, start, stop, attachWs };
}
