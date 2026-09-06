/**
 * 一键停台：关掉占用 9730 / 9731（或配置里的端口）的进程。
 * 用法：pnpm stop
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeRadioPorts, radioPorts } from './ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STOP_FLAG = join(ROOT, 'data', '.stop-requested');

const CYAN = '\u001b[36m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const OFF = '\u001b[0m';
const cy = (s) => CYAN + s + OFF;
const gr = (s) => GREEN + s + OFF;
const ye = (s) => YELLOW + s + OFF;

const ports = radioPorts();
console.log(cy(`\n停止电台（端口 ${ports.join(' / ')}）`));

// 哨兵：Windows 强杀退出码固定 1，挂着 pnpm start 的终端无法区分「被 stop」和「真崩」。
// 杀之前立哨，start.mjs 的 exit 回调见到哨兵就按正常停止收尾。
try {
  mkdirSync(dirname(STOP_FLAG), { recursive: true });
  writeFileSync(STOP_FLAG, String(Date.now()));
} catch {
  /* 哨兵只是提示，写失败不影响停台 */
}
const freed = freeRadioPorts();
if (freed.length === 0) {
  try {
    rmSync(STOP_FLAG, { force: true });
  } catch {
    /* ignore */
  }
  console.log(`  ${gr('[OK]')} 没有在跑的电台进程\n`);
  process.exit(0);
}

for (const { port, pids } of freed) {
  console.log(`  ${ye('[!]')} 端口 ${port} ← 结束 PID ${pids.join(', ')}`);
}
console.log(`  ${gr('[OK]')} 已停止\n`);
