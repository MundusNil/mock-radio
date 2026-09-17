#!/usr/bin/env node
/**
 * Agent 改动范围裁判：对照允许路径检查工作区，越界 fail-closed。
 *
 * 不 reset、不 clean、不改工作区。Windows / Ubuntu 同一入口。
 *
 * 退出码：
 *   0  SCOPE_OK
 *   1  用法或 git 错误
 *   2  SCOPE_VIOLATION
 *
 * 用法：
 *   node scripts/agent/check-scope.mjs --ticket docs/impl/tickets/01-foo.md
 *   node scripts/agent/check-scope.mjs --allow packages/core/src/engine/engine.ts
 *   node scripts/agent/check-scope.mjs --scope-file /tmp/allow.txt
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_VIOLATION = 2;

const HEADING_SCOPE = /^## 允许修改范围\s*$/;
const HEADING_ANY = /^##\s+/;
const BACKTICK = /`([^`]+)`/g;
const FENCE = /```(?:[\w.-]+)?\n(.*?)```/gs;
const PATH_EXT = new Set([
  '.md',
  '.py',
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.vue',
  '.yml',
  '.yaml',
  '.sh',
  '.ps1',
  '.json',
]);
const AUDIO_EXT = /\.(flac|mp3|wav|ogg|m4a|aac|opus)$/i;

/** 父 glob 不能放行。必须在允许名单里写精确路径（或 data/ 目录本身）。 */
const PROTECTED_FILES = new Set(['config/persona.md', '.gitignore', '.env']);

function posix(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function looksLikePath(value) {
  const s = posix(value).trim();
  if (!s || s.includes('\n') || s.startsWith('#') || s.includes('://')) return false;
  if (isAbsolute(s) || s.startsWith('/')) return false;
  if (/[./\\*]/.test(s)) return true;
  return PATH_EXT.has(extname(s));
}

function globToRegExp(pattern) {
  let i = 0;
  let out = '^';
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else if (pattern[i] === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`${out}$`);
}

function patternMatches(path, pattern) {
  const p = posix(path);
  const g = posix(pattern).trim();
  if (!g) return false;
  if (g.endsWith('/')) return p === g.slice(0, -1) || p.startsWith(g);
  if (/[*?[]/.test(g)) return globToRegExp(g).test(p);
  return p === g || p.startsWith(`${g}/`);
}

function unique(items) {
  return [...new Set(items)];
}

function parseAllowlistFromTicket(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_SCOPE.test(lines[i] ?? '')) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (HEADING_ANY.test(lines[i] ?? '') && !HEADING_SCOPE.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join('\n');
  const found = [];
  for (const m of body.matchAll(BACKTICK)) {
    if (looksLikePath(m[1] ?? '')) found.push(posix(m[1] ?? ''));
  }
  for (const m of body.matchAll(FENCE)) {
    for (const line of (m[1] ?? '').split(/\r?\n/)) {
      const item = line.trim().replace(/^[-*]\s+/, '');
      if (looksLikePath(item)) found.push(posix(item));
    }
  }
  return unique(found);
}

function parseAllowlistFromScopeFile(text) {
  const found = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const item = line.replace(/^[-*]\s+/, '');
    if (looksLikePath(item)) found.push(posix(item));
  }
  return unique(found);
}

function git(repo, args) {
  const env = { ...process.env, LC_ALL: process.env.LC_ALL ?? 'C.UTF-8' };
  return spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env,
  });
}

function gitOk(repo, args) {
  return git(repo, args).status === 0;
}

function gitLines(repo, args) {
  const result = git(repo, args);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'git failed').trim());
  }
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => posix(line.trim()))
    .filter(Boolean);
}

function detectBase(repo) {
  for (const ref of ['origin/main', 'main']) {
    if (gitOk(repo, ['rev-parse', '--verify', ref])) {
      const merged = git(repo, ['merge-base', ref, 'HEAD']);
      if (merged.status === 0) return merged.stdout.trim();
    }
  }
  return 'HEAD';
}

function changedPaths(repo, base) {
  const paths = [
    ...gitLines(repo, ['diff', '--name-only', '--diff-filter=ACDMRTUXB', `${base}...HEAD`]),
    ...gitLines(repo, ['diff', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD']),
    ...gitLines(repo, ['diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB']),
    ...gitLines(repo, ['ls-files', '-o', '--exclude-standard']),
  ];
  return unique(paths);
}

function extras(changed, allow) {
  return changed.filter((path) => !allow.some((pattern) => patternMatches(path, pattern)));
}

function isProtected(path) {
  const p = posix(path);
  if (PROTECTED_FILES.has(p)) return true;
  if (p.startsWith('.env.') && p !== '.env.example') return true;
  if (p === 'data' || p.startsWith('data/')) return true;
  return p.startsWith('config/library/') && AUDIO_EXT.test(p);
}

function protectedHits(changed, allow) {
  const exact = new Set(allow.map((item) => posix(item)));
  return changed.filter((path) => isProtected(path) && !exact.has(posix(path)));
}

function loadAllowlist(args) {
  const allow = [];
  for (const item of args.allow) {
    if (looksLikePath(item)) allow.push(posix(item));
  }
  if (args.ticket) {
    allow.push(...parseAllowlistFromTicket(readFileSync(args.ticket, 'utf8')));
  }
  if (args.scopeFile) {
    allow.push(...parseAllowlistFromScopeFile(readFileSync(args.scopeFile, 'utf8')));
  }
  return unique(allow);
}

function parseArgs(argv) {
  const args = { repo: '.', base: '', ticket: '', scopeFile: '', allow: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${token}`);
      return value;
    };
    if (token === '--repo') args.repo = next();
    else if (token === '--base') args.base = next();
    else if (token === '--ticket') args.ticket = next();
    else if (token === '--scope-file') args.scopeFile = next();
    else if (token === '--allow') args.allow.push(next());
    else if (token === '-h' || token === '--help') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`SCOPE_ERROR ${err instanceof Error ? err.message : err}\n`);
    return EXIT_USAGE;
  }
  if (args.help) {
    process.stdout.write(
      `${readFileSync(new URL(import.meta.url), 'utf8')
        .split('*/')[0]
        .replace(/^\/\*\*\n/, '')}\n`,
    );
    return EXIT_OK;
  }

  const repo = resolve(args.repo);
  if (
    !existsSync(resolve(repo, '.git')) &&
    git(repo, ['rev-parse', '--show-toplevel']).status !== 0
  ) {
    process.stderr.write('SCOPE_ERROR git 仓库不存在\n');
    return EXIT_USAGE;
  }

  let allow;
  try {
    allow = loadAllowlist(args);
  } catch (err) {
    process.stderr.write(`SCOPE_ERROR ${err instanceof Error ? err.message : err}\n`);
    return EXIT_USAGE;
  }
  if (allow.length === 0) {
    process.stderr.write(
      'SCOPE_ERROR 没有可解析的允许路径。票的「允许修改范围」必须列出反引号文件/目录/glob，或传 --allow / --scope-file。\n',
    );
    return EXIT_USAGE;
  }

  let changed;
  try {
    const base = args.base || detectBase(repo);
    changed = changedPaths(repo, base);
  } catch (err) {
    process.stderr.write(`SCOPE_ERROR ${err instanceof Error ? err.message : err}\n`);
    return EXIT_USAGE;
  }

  const extra = extras(changed, allow);
  const locked = protectedHits(changed, allow);
  if (extra.length > 0 || locked.length > 0) {
    process.stdout.write('SCOPE_VIOLATION\n');
    if (extra.length > 0) {
      process.stdout.write('extra:\n');
      for (const path of extra) process.stdout.write(`  ${path}\n`);
    }
    if (locked.length > 0) {
      process.stdout.write('protected:\n');
      for (const path of locked) process.stdout.write(`  ${path}\n`);
    }
    process.stdout.write('allowed:\n');
    for (const path of allow) process.stdout.write(`  ${path}\n`);
    return EXIT_VIOLATION;
  }

  process.stdout.write(`SCOPE_OK files=${changed.length}\n`);
  return EXIT_OK;
}

process.exit(main());
