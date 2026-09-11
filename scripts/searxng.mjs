// 案头本地检索的运行时前提：SearXNG 容器。
//   node scripts/searxng.mjs up      起（幂等：已在跑则复用）
//   node scripts/searxng.mjs down    停
//   node scripts/searxng.mjs status  探活（JSON API 真打一次）
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const settings = resolve(here, '..', 'infra', 'searxng', 'settings.yml');
const NAME = 'searxng';
const PORT = '127.0.0.1:8888';

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

const cmd = process.argv[2] ?? 'status';
if (cmd === 'up') {
  const running = docker(['ps', '-q', '--filter', `name=^${NAME}$`]);
  if (running.stdout.trim()) {
    console.log(`[searxng] 已在跑（${PORT}）`);
    process.exit(0);
  }
  const r = docker([
    'run',
    '-d',
    '--rm',
    '--name',
    NAME,
    '-p',
    `${PORT}:8080`,
    '-v',
    `${settings}:/etc/searxng/settings.yml:ro`,
    'searxng/searxng:latest',
  ]);
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  // 等 JSON API 可用（首次拉镜像可能几分钟）
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://${PORT}/search?format=json&q=ping`)
      .then((res) => res.ok)
      .catch(() => false);
    if (ok) {
      console.log(`[searxng] 就绪 http://${PORT}`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  console.error('[searxng] 120s 内未就绪，看 docker logs searxng');
  process.exit(1);
} else if (cmd === 'down') {
  docker(['rm', '-f', NAME]);
  console.log('[searxng] 已停');
} else {
  const ok = await fetch(`http://${PORT}/search?format=json&q=ping`)
    .then((res) => res.json())
    .then((j) => Array.isArray(j.results))
    .catch(() => false);
  console.log(
    ok ? `[searxng] 在线 http://${PORT}` : `[searxng] 不可用——node scripts/searxng.mjs up`,
  );
  process.exit(ok ? 0 : 1);
}
