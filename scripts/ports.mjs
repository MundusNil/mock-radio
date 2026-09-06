/**
 * 电台占用的端口：守护进程 + 收听面板。
 * start / stop 共用，避免上次残留把 Vite 堆栈砸到脸上。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolveRoot();

function resolveRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export function radioPorts() {
  let station = 9730;
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'config', 'station.config.json'), 'utf8'));
    if (Number.isInteger(raw.station?.port)) station = raw.station.port;
  } catch {
    /* keep default */
  }
  let web = 9731;
  try {
    const vite = readFileSync(join(ROOT, 'apps', 'web', 'vite.config.ts'), 'utf8');
    const m = vite.match(/port:\s*(\d+)/);
    if (m) web = Number(m[1]);
  } catch {
    /* keep default */
  }
  return [station, web];
}

export function parseNetstatPids(stdout, port) {
  const pids = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!/LISTENING|侦听/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[1] ?? '';
    const pid = Number(parts[parts.length - 1]);
    if (!pid || pid <= 4) continue;
    if (local.endsWith(`:${port}`)) pids.add(pid);
  }
  return [...pids];
}

export function pidsOnPort(port) {
  if (process.platform === 'win32') {
    // 全量扫描再按端口过滤：比 -p tcp 稳，不受监听栈（IPv4/IPv6）变化影响
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
    return parseNetstatPids(r.stdout ?? '', port).filter((pid) => pid !== process.pid);
  }
  const r = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const pids = new Set();
  for (const tok of String(r.stdout ?? '')
    .trim()
    .split(/\s+/)) {
    const pid = Number(tok);
    if (pid && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

function killPid(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 结束占用电台端口的进程。返回实际动过的 { port, pids }。 */
export function freeRadioPorts() {
  const ports = radioPorts();
  const freed = [];
  for (const port of ports) {
    const pids = pidsOnPort(port);
    if (pids.length === 0) continue;
    for (const pid of pids) killPid(pid);
    freed.push({ port, pids });
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (ports.every((p) => pidsOnPort(p).length === 0)) break;
    sleepMs(100);
  }
  return freed;
}
