import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import {
  createDeskAgentLlm,
  createLocalDeskSearcher,
  createStore,
  createTts,
  systemClock,
} from '@mock-radio/adapters';
import { getDayPartContext } from '@mock-radio/core';
import { loadStationConfig } from './config';
import { loadEnvFile } from './env';
import { keyDefsFor } from './keys';
import { scanLibrary } from './library';
import { findRepoRoot } from './paths';
import { createRadio } from './radio';

async function main(): Promise<void> {
  loadEnvFile();
  const repoRoot = findRepoRoot();
  const config = loadStationConfig();
  const libraryRoot = resolve(repoRoot, config.library.root);
  const dbPath = resolve(repoRoot, 'data', 'station.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = createStore(dbPath);
  console.log('[station] 扫描曲库…');
  const scanned = await scanLibrary(libraryRoot);
  store.upsertTracks(scanned);
  store.deleteTracksNotIn(scanned.map((t) => t.path));
  const tracks = store.listTracks();

  if (tracks.length === 0) {
    console.error(
      '[station] 曲库为空：把音频文件放进 config/library/ 后再启动（子文件夹随意嵌套；ER-005：无音乐即无电台）。',
    );
    process.exit(1);
  }

  const styleSummary = [...new Set(tracks.flatMap((t) => t.styles))]
    .map((s) => `${s}(${tracks.filter((t) => t.styles.includes(s)).length})`)
    .join(' ');

  // 密钥工厂：每次调用都从 process.env 现取——设置面板写入 .env 后重建即生效
  // 案头检索：默认走本地管道（SearXNG+抓页，普通 token）；关 = 回方舟 web_search（贵 token）。
  // SearXNG 没起时 searcher 抛错 → search 节点首轮上抛 → producer onError 空案头，可接受降级。
  // SERP 350ms 最小间隔：多轨并发预取时防连发打同一实例触发引擎限流/BAN。
  const deskSearcher = config.llm.deskLocalSearch
    ? createLocalDeskSearcher({
        searxngUrl: config.llm.searxngUrl ?? 'http://127.0.0.1:8888',
        serpMinGapMs: 350,
      })
    : undefined;
  const llmFactory = () =>
    createDeskAgentLlm(
      {
        baseUrl: config.llm.baseUrl,
        apiKey: process.env[config.llm.apiKeyEnv] ?? '',
        model: config.llm.model,
        temperature: config.llm.temperature,
        webSearch: config.llm.webSearch,
        timeoutMs: config.llm.timeoutMs,
        maxTokens: config.llm.maxTokens,
        deskTimeoutMs: config.llm.deskTimeoutMs,
      },
      deskSearcher,
    );
  const ttsFactory = () =>
    createTts({
      provider: config.tts.provider,
      postProcess: config.tts.postProcess,
      cacheDir: resolve(repoRoot, config.tts.cacheDir),
      speechRate: config.tts.speechRate,
      edge: config.tts.edge,
      minimax: config.tts.minimax,
      resolveEnv: (name) => process.env[name],
    });
  if (!(process.env[config.llm.apiKeyEnv] ?? '')) {
    console.error(
      `[station] 缺少 LLM API key（环境变量 ${config.llm.apiKeyEnv}）：可在页面右上角设置面板配置，或写入 .env 后重启。串场管线将保持静默（沉默保底）。`,
    );
  }
  const persona = readFileSync(resolve(repoRoot, 'config', 'persona.md'), 'utf-8');

  const radio = createRadio({
    stationName: config.station.name,
    hostName: config.station.host,
    persona,
    engineConfig: config.engine,
    schedulerConfig: config.scheduler,
    ducking: config.audio.ducking,
    crossfadeMs: config.audio.crossfadeMs,
    tracks,
    libraryRoot,
    clock: systemClock,
    llmFactory,
    ttsFactory,
    store,
    retentionDays: config.messages.retentionDays,
    memoryConfig: config.memory,
    maxSegmentChars: config.llm.maxSegmentChars,
    maxSegmentCharsByKind: config.llm.maxSegmentCharsByKind,
    envPath: resolve(repoRoot, '.env'),
    keyDefs: keyDefsFor(config),
    configPath: resolve(repoRoot, 'config', 'station.config.json'),
    runtimeConfig: config,
  });

  const server = serve({ fetch: radio.app.fetch, port: config.station.port }, (info) => {
    const now = getDayPartContext(new Date());
    console.log(`[station] ${config.station.name} 守护进程已启动：http://localhost:${info.port}`);
    console.log(`[station] 曲库 ${tracks.length} 首：${styleSummary}`);
    console.log(`[station] 此刻是${now.weekdayZh}${now.label}，${now.moodHint}。`);
  });

  radio.attachWs(server);
  radio.start();
}

main().catch((err) => {
  console.error('[station] 启动失败：', err);
  process.exit(1);
});
