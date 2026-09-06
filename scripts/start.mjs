/**
 * 一键启动：环境体检 → 曲库体检 → 电台就绪后再拉收音机面板。
 * 守护进程启动时递归扫描 config/library（任意嵌套）。
 *
 * 用户只需两条命令：pnpm install && pnpm start
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeRadioPorts, radioPorts } from './ports.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_EXT = /\.(flac|mp3|wav|ogg|m4a|aac|opus)$/i;
// pnpm stop 杀进程前立的哨兵：Windows 强杀退出码固定 1，靠它区分「被停」和「真崩」
const STOP_FLAG = join(ROOT, 'data', '.stop-requested');

const CYAN = '\u001b[36m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const OFF = '\u001b[0m';
const cy = (s) => CYAN + s + OFF;
const gr = (s) => GREEN + s + OFF;
const ye = (s) => YELLOW + s + OFF;
const rd = (s) => RED + s + OFF;
const OK = gr('[OK]');

const warnings = [];
const blockers = [];

function resolveBin(pkg, entry) {
  const pnpmRoot = join(ROOT, 'node_modules', '.pnpm');
  if (!existsSync(pnpmRoot)) return undefined;
  const prefix = `${pkg.replace('/', '+')}@`;
  for (const dir of readdirSync(pnpmRoot)) {
    if (!dir.startsWith(prefix)) continue;
    const p = join(pnpmRoot, dir, 'node_modules', pkg, entry);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: String(r.stdout ?? '') + String(r.stderr ?? '') };
}

function listDir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

console.log(cy('\n[1/3] 环境体检'));

const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) console.log(`  ${OK} Node ${process.versions.node}`);
else blockers.push(`Node 版本过低（当前 ${process.versions.node}），需要 >= 22`);

const localFfmpeg = join(ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe');
const localFfprobe = join(ROOT, 'tools', 'ffmpeg', 'ffprobe.exe');
const hasLocalFf = existsSync(localFfmpeg) && existsSync(localFfprobe);
const onPath = run(process.platform === 'win32' ? 'where' : 'which', ['ffprobe']).ok;
if (hasLocalFf) console.log(`  ${OK} ffmpeg（tools/ffmpeg/）`);
else if (onPath) console.log(`  ${OK} ffmpeg（系统 PATH）`);
else
  blockers.push(
    '缺少 ffprobe/ffmpeg：跑 pnpm setup:ffmpeg 自动安装，或把两个 exe 放进 tools/ffmpeg/ / 装到系统 PATH',
  );

// 密钥不再是启动门槛：没配则梦可静默（音乐照常），启动后在面板右上角「设置 → API 管理」填写即热生效。
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  const envTxt = readFileSync(envPath, 'utf8');
  if (/=(your[-_]|sk-your|changeme|<)/im.test(envTxt))
    warnings.push('.env 里的 API key 还是占位符，梦可会保持沉默（音乐照常播放）');
  else console.log(`  ${OK} 密钥已配置（.env）`);
} else {
  console.log(`  ${OK} 未配置密钥（可启动后在面板「设置」里填，音乐照常）`);
}

console.log(cy('\n[2/3] 曲库'));

const libRoot = join(ROOT, 'config', 'library');
const audioCount = countAudio(libRoot);
if (audioCount === 0)
  blockers.push('曲库是空的。把音乐放进 config/library/ 即可，子文件夹随便嵌套。');
else console.log(`  ${OK} 找到 ${audioCount} 个音频文件（启动时入库）`);

if (blockers.length > 0) {
  console.log(`\n${rd('无法启动：')}`);
  for (const b of blockers) console.log(`  ${rd('[X]')} ${b}`);
  process.exit(1);
}

function countAudio(dir) {
  let n = 0;
  for (const name of listDir(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) n += countAudio(full);
    else if (st.isFile() && AUDIO_EXT.test(name)) n += 1;
  }
  return n;
}

if (process.argv.includes('--check')) {
  if (warnings.length === 0) console.log(`\n${gr('体检通过，可以启动。')}\n`);
  else {
    console.log(ye('\n需要你处理：'));
    for (const w of warnings) console.log(`  ${ye('[!]')} ${w}`);
    console.log('');
  }
  process.exit(0);
}

console.log(cy('\n[3/3] 启动'));

const leftover = freeRadioPorts();
if (leftover.length > 0) {
  console.log(
    `  ${ye('[!]')} 已结束上次残留：${leftover.map((f) => `${f.port}(PID ${f.pids.join(',')})`).join('、')}`,
  );
}

const node = process.execPath;
const tsx = resolveBin('tsx', join('dist', 'cli.mjs'));
const vite = resolveBin('vite', join('bin', 'vite.js'));
if (!tsx || !vite) {
  console.log(rd('缺少 tsx 或 vite，请先运行 pnpm install'));
  process.exit(1);
}

const [stationPort, webPort] = radioPorts();
try {
  rmSync(STOP_FLAG, { force: true }); // 清掉上一轮可能残留的哨兵
} catch {
  /* ignore */
}

const station = spawn(node, [tsx, 'src/index.ts'], {
  cwd: join(ROOT, 'apps', 'station'),
  stdio: 'inherit',
});
console.log(`  等待电台 :${stationPort} …`);
let web = null;
const shutdown = () => {
  station.kill();
  web?.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
station.on('exit', (code) => {
  web?.kill();
  if (existsSync(STOP_FLAG)) {
    try {
      rmSync(STOP_FLAG, { force: true });
    } catch {
      /* ignore */
    }
    console.log(`\n${gr('[OK]')} 电台已被停止（pnpm stop）\n`);
    process.exit(0);
  }
  console.log(rd(`电台进程退出（${code}）`));
  process.exit(code ?? 1);
});

async function waitForHealth(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) return true;
    } catch {
      /* 扫库中，还没听端口 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

if (!(await waitForHealth(stationPort))) {
  console.log(rd(`电台未在时限内就绪（:${stationPort}）`));
  station.kill();
  process.exit(1);
}

web = spawn(node, [vite], { cwd: join(ROOT, 'apps', 'web'), stdio: 'inherit' });

console.log(`\n${gr('电台已启动')}`);
console.log(`  ${cy('收听面板')}   http://localhost:${webPort}   <- 打开它开始收听`);
console.log(`  ${cy('接口自检')}   http://localhost:${stationPort}/api/health`);
console.log(`  ${cy('后台')}       http://localhost:${stationPort}/admin`);
if (warnings.length > 0) {
  console.log(ye('\n提示：'));
  for (const w of warnings) console.log(`  ${ye('[!]')} ${w}`);
}
console.log(`\n${ye('梦可只在有人听时开口 —— 打开上面的面板，她才会开始说话。')}`);
console.log('Ctrl+C 或另开终端 pnpm stop\n');
