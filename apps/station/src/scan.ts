/**
 * 曲库扫描命令：pnpm scan
 * config/library 下任意嵌套音频 → SQLite（幂等 upsert + 清理已删文件）。
 * 启动时也会自动扫；第一层文件夹名仍是可选风格标签（D3）。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createStore } from '@mock-radio/adapters';
import { loadStationConfig } from './config';
import { loadEnvFile } from './env';
import { scanLibrary } from './library';
import { findRepoRoot } from './paths';

async function main(): Promise<void> {
  loadEnvFile();
  const repoRoot = findRepoRoot();
  const config = loadStationConfig();
  const libraryRoot = resolve(repoRoot, config.library.root);
  const dbPath = resolve(repoRoot, 'data', 'station.db');
  mkdirSync(dirname(dbPath), { recursive: true });

  const scanned = await scanLibrary(libraryRoot);
  const store = createStore(dbPath);
  store.upsertTracks(scanned);
  // 清理已不存在的曲目（文件被删/移动后同步，避免残留记录被恢复）
  store.deleteTracksNotIn(scanned.map((t) => t.path));
  const tracks = store.listTracks();

  console.log(`[scan] 曲库 ${tracks.length} 首已入库：${dbPath}`);
  const byStyle = new Map<string, number>();
  for (const t of tracks) {
    for (const s of t.styles) byStyle.set(s, (byStyle.get(s) ?? 0) + 1);
  }
  for (const [style, count] of byStyle) {
    console.log(`[scan]   ${style}: ${count}`);
  }
}

main().catch((err) => {
  console.error('[scan] 失败：', err);
  process.exit(1);
});
