#!/usr/bin/env node
/**
 * Agent harness 入口：隔离必跑；有 --ticket/--allow/--scope-file 时再跑范围裁判。
 *
 * 不 reset、不改工作区。失败 fail-closed。
 *
 * 退出码：
 *   0  全部 OK
 *   1  用法或 git 错误
 *   2  SCOPE_VIOLATION 或 ISOLATION_VIOLATION
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function run(script, argv) {
  const result = spawnSync(process.execPath, [join(here, script), ...argv], {
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`${script}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

const argv = process.argv.slice(2);
const isolationArgv = [];
const scopeArgv = [];
let runScope = false;
let skipScope = false;

for (let i = 0; i < argv.length; i++) {
  const token = argv[i] ?? '';
  if (token === '--repo') {
    const value = argv[++i];
    if (!value) {
      process.stderr.write('HARNESS_ERROR missing value for --repo\n');
      process.exit(1);
    }
    isolationArgv.push('--repo', value);
    scopeArgv.push('--repo', value);
  } else if (
    token === '--ticket' ||
    token === '--allow' ||
    token === '--scope-file' ||
    token === '--base'
  ) {
    runScope = true;
    const value = argv[++i];
    if (!value) {
      process.stderr.write(`HARNESS_ERROR missing value for ${token}\n`);
      process.exit(1);
    }
    scopeArgv.push(token, value);
  } else if (token === '--no-scope') {
    skipScope = true;
  } else if (token === '-h' || token === '--help') {
    process.stdout.write(
      'node scripts/agent/check.mjs [--repo .] [--ticket FILE | --allow PATH | --scope-file FILE] [--no-scope]\n',
    );
    process.exit(0);
  } else {
    process.stderr.write(`HARNESS_ERROR unknown argument: ${token}\n`);
    process.exit(1);
  }
}

let code = run('check-isolation.mjs', isolationArgv);
if (code !== 0) process.exit(code);

if (runScope && skipScope) {
  process.stderr.write('HARNESS_ERROR use --ticket/--allow or --no-scope, not both\n');
  process.exit(1);
}
if (runScope) {
  code = run('check-scope.mjs', scopeArgv);
  process.exit(code);
}
if (skipScope) {
  process.stdout.write('SCOPE_SKIPPED\n');
  process.exit(0);
}
process.stderr.write(
  'HARNESS_ERROR missing --ticket / --allow / --scope-file (or pass --no-scope)\n',
);
process.exit(1);
