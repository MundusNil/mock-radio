#!/usr/bin/env node
/**
 * Agent 隔离裁判：core 零 IO、测试不碰真库/真密钥、docs/ 保持 gitignore。
 *
 * 不 reset、不改工作区。Windows / Ubuntu 同一入口。
 *
 * 退出码：
 *   0  ISOLATION_OK
 *   1  用法错误
 *   2  ISOLATION_VIOLATION
 *
 * 用法：
 *   node scripts/agent/check-isolation.mjs
 *   node scripts/agent/check-isolation.mjs --repo .
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_VIOLATION = 2;

const FORBIDDEN_MODULES = new Set([
  'better-sqlite3',
  'child_process',
  'crypto',
  'dgram',
  'dns',
  'fs',
  'http',
  'https',
  'net',
  'node-fetch',
  'os',
  'path',
  'sqlite3',
  'tls',
  'undici',
  'worker_threads',
  'ws',
]);

const FROM_SPEC = /\bfrom\s+['"]([^'"]+)['"]/;
const BARE_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/;
const DATE_NOW = /\bDate\.now\s*\(/;
const NEW_DATE_EMPTY = /\bnew\s+Date\s*\(\s*\)/;
const PROCESS_ENV = /\bprocess\.env\b/;
const FETCH_CALL = /\bfetch\s*\(/;
const REAL_DB = /data[/\\]station\.db/;
const ARK_KEY = /\bark-[0-9a-f-]{20,}/i;

function posix(path) {
  return path.replaceAll('\\', '/');
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function importSpecifiers(source) {
  const found = [];
  for (const line of source.split(/\r?\n/)) {
    const from = line.match(FROM_SPEC);
    if (from?.[1]) found.push(from[1]);
    const bare = line.match(BARE_IMPORT);
    if (bare?.[1]) found.push(bare[1]);
  }
  return found;
}

function moduleForbidden(spec) {
  if (spec.startsWith('node:')) return true;
  const bare = spec.split('/')[0] ?? spec;
  return FORBIDDEN_MODULES.has(bare);
}

function parseArgs(argv) {
  const args = { repo: '.' };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '--repo') {
      const value = argv[++i];
      if (!value) throw new Error('missing value for --repo');
      args.repo = value;
    } else if (token === '-h' || token === '--help') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function checkCoreFile(repo, file) {
  const rel = posix(relative(repo, file));
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const hits = [];
  for (const spec of importSpecifiers(code)) {
    if (
      moduleForbidden(spec) ||
      spec.startsWith('@mock-radio/adapters') ||
      spec.startsWith('apps/')
    ) {
      hits.push(`${rel}: import ${spec}`);
    }
  }
  if (DATE_NOW.test(code)) hits.push(`${rel}: Date.now()`);
  if (NEW_DATE_EMPTY.test(code)) hits.push(`${rel}: new Date()`);
  if (PROCESS_ENV.test(code)) hits.push(`${rel}: process.env`);
  if (FETCH_CALL.test(code)) hits.push(`${rel}: fetch(`);
  return hits;
}

function checkTestFile(repo, file) {
  const rel = posix(relative(repo, file));
  const raw = readFileSync(file, 'utf8');
  const hits = [];
  if (REAL_DB.test(raw)) hits.push(`${rel}: 引用 data/station.db`);
  if (ARK_KEY.test(raw)) hits.push(`${rel}: 疑似真实 ark key`);
  return hits;
}

function checkGitignore(repo) {
  const path = join(repo, '.gitignore');
  if (!existsSync(path)) return ['.gitignore: 缺失'];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  if (lines.some((line) => /^\s*docs\/\s*$/.test(line))) return [];
  return ['.gitignore: 缺少 docs/ 行（本机文档不得入库）'];
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`ISOLATION_ERROR ${err instanceof Error ? err.message : err}\n`);
    return EXIT_USAGE;
  }
  if (args.help) {
    process.stdout.write(
      'node scripts/agent/check-isolation.mjs [--repo .]\nexit 0 ISOLATION_OK / 2 ISOLATION_VIOLATION\n',
    );
    return EXIT_OK;
  }

  const repo = resolve(args.repo);
  const hits = [];

  const coreRoot = join(repo, 'packages', 'core', 'src');
  for (const file of walk(coreRoot)) {
    if (extname(file) !== '.ts') continue;
    if (file.endsWith('.test.ts')) continue;
    hits.push(...checkCoreFile(repo, file));
  }

  for (const root of ['packages', 'apps']) {
    for (const file of walk(join(repo, root))) {
      if (!file.endsWith('.test.ts')) continue;
      hits.push(...checkTestFile(repo, file));
    }
  }

  hits.push(...checkGitignore(repo));

  if (hits.length > 0) {
    process.stdout.write('ISOLATION_VIOLATION\n');
    for (const hit of hits) process.stdout.write(`  ${hit}\n`);
    return EXIT_VIOLATION;
  }

  process.stdout.write('ISOLATION_OK\n');
  return EXIT_OK;
}

process.exit(main());
