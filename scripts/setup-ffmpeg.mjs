/**
 * 一键补齐 FFmpeg：下载官方静态构建，把 ffmpeg/ffprobe 放进 tools/ffmpeg/。
 * 已有可用的 ffmpeg（tools/ffmpeg/ 或系统 PATH）则直接跳过。
 * 用法：pnpm setup:ffmpeg
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'tools', 'ffmpeg');
const EXE = process.platform === 'win32';
const BIN = EXE ? '.exe' : '';

const CYAN = '\u001b[36m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const OFF = '\u001b[0m';
const cy = (s) => CYAN + s + OFF;
const gr = (s) => GREEN + s + OFF;
const ye = (s) => YELLOW + s + OFF;
const rd = (s) => RED + s + OFF;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: String(r.stdout ?? '') + String(r.stderr ?? '') };
}

function have(name) {
  return run(EXE ? 'where' : 'which', [name]).ok;
}

const localFf = join(DEST, `ffmpeg${BIN}`);
const localProbe = join(DEST, `ffprobe${BIN}`);
if (existsSync(localFf) && existsSync(localProbe)) {
  console.log(`${gr('[OK]')} tools/ffmpeg/ 已就绪，无需下载`);
  process.exit(0);
}
if (have('ffmpeg') && have('ffprobe')) {
  console.log(`${gr('[OK]')} 系统 PATH 已有 ffmpeg/ffprobe，无需下载`);
  console.log(ye('  （想装进仓库也行：先删掉 PATH 上的再跑本脚本）'));
  process.exit(0);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = await import('node:fs/promises').then((fs) => fs.open(dest, 'w'));
  let got = 0;
  let lastLog = 0;
  for await (const chunk of Readable.fromWeb(res.body)) {
    await out.write(chunk);
    got += chunk.length;
    if (got - lastLog >= 8 * 1024 * 1024) {
      lastLog = got;
      const mb = (got / 1024 / 1024).toFixed(0);
      const pct = total
        ? ` / ${(total / 1024 / 1024).toFixed(0)}MB (${((got / total) * 100).toFixed(0)}%)`
        : 'MB';
      process.stdout.write(`\r  ${cy('下载中')} ${mb}${pct}`);
    }
  }
  await out.close();
  process.stdout.write('\r');
  return got;
}

function extractZip(zip, dir) {
  // Win10 1803+ 自带 bsdtar，能直接解 zip；失败再退回 PowerShell
  if (run('tar', ['-xf', zip, '-C', dir]).ok) return true;
  return run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`,
  ]).ok;
}

async function windows() {
  const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
  const tmp = join(ROOT, '.tmp-ffmpeg');
  const zip = join(tmp, 'ffmpeg.zip');
  mkdirSync(tmp, { recursive: true });
  try {
    console.log(cy(`  来源：${url}`));
    await download(url, zip);
    const unz = join(tmp, 'unz');
    mkdirSync(unz, { recursive: true });
    console.log(cy('  解压中 …'));
    if (!extractZip(zip, unz)) throw new Error('解压失败（tar 与 PowerShell 均不可用）');
    // zip 内层是 ffmpeg-<ver>-essentials_build/bin/*.exe
    const binDir = findBinDir(unz);
    if (!binDir) throw new Error('压缩包结构不符合预期：找不到含 ffmpeg.exe 的 bin 目录');
    mkdirSync(DEST, { recursive: true });
    for (const f of ['ffmpeg.exe', 'ffprobe.exe']) {
      copyFileSync(join(binDir, f), join(DEST, f));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function findBinDir(root) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    if (existsSync(join(d, `ffmpeg${BIN}`))) return d;
    for (const e of readdirSafe(d)) if (e.isDirectory()) stack.push(join(d, e.name));
  }
  return undefined;
}

function readdirSafe(d) {
  try {
    return readdirSync(d, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function linux() {
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!arch) throw new Error(`不支持的架构 ${process.arch}，请手动安装 ffmpeg`);
  const url = `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arch}-static.tar.xz`;
  const tmp = join(ROOT, '.tmp-ffmpeg');
  mkdirSync(tmp, { recursive: true });
  try {
    console.log(cy(`  来源：${url}`));
    const tar = join(tmp, 'ffmpeg.tar.xz');
    await download(url, tar);
    console.log(cy('  解压中 …'));
    if (!run('tar', ['-xf', tar, '-C', tmp]).ok) throw new Error('tar 解压失败');
    const binDir = findBinDir(tmp);
    if (!binDir) throw new Error('压缩包结构不符合预期');
    mkdirSync(DEST, { recursive: true });
    for (const f of ['ffmpeg', 'ffprobe']) copyFileSync(join(binDir, f), join(DEST, f));
    run('chmod', ['+x', join(DEST, `ffmpeg${BIN}`), join(DEST, `ffprobe${BIN}`)]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function macos() {
  if (!have('brew')) throw new Error('未找到 brew。请安装 Homebrew 后运行：brew install ffmpeg');
  console.log(cy('  brew install ffmpeg …'));
  const r = spawnSync('brew', ['install', 'ffmpeg'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('brew install ffmpeg 失败');
}

console.log(cy('\n安装 FFmpeg'));
try {
  if (EXE) await windows();
  else if (process.platform === 'darwin') await macos();
  else await linux();
} catch (e) {
  console.log(rd(`\n[失败] ${e.message}`));
  console.log(ye('手动兜底：下载官方构建，把 ffmpeg / ffprobe 放进 tools/ffmpeg/ 或系统 PATH。'));
  process.exit(1);
}

// 验证
const probe = run(join(DEST, `ffprobe${BIN}`), ['-version']);
if (!probe.ok) {
  console.log(rd('\n[失败] 安装后 ffprobe 无法运行，请检查杀毒软件是否拦截'));
  process.exit(1);
}
console.log(`${gr('[OK]')} ffmpeg/ffprobe 已就位：tools/ffmpeg/`);
console.log(`     ${probe.out.split(/\r?\n/)[0]}`);
console.log(`\n现在可以 ${cy('pnpm start')} 了\n`);
