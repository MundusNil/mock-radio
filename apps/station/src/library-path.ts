/**
 * 曲库相对路径：一律 POSIX，禁止逃出 libraryRoot。
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class LibraryPathError extends Error {
  constructor(message = '非法路径') {
    super(message);
    this.name = 'LibraryPathError';
  }
}

function posixParts(rel: string): string[] {
  if (rel.includes('\0')) throw new LibraryPathError();
  const trimmed = rel.replaceAll('\\', '/').trim();
  if (trimmed === '' || trimmed === '.') return [];
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) throw new LibraryPathError();
  const parts = trimmed.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new LibraryPathError();
  return parts;
}

/** `""` = 曲库根。返回绝对路径。 */
export function resolveLibraryPath(libraryRoot: string, rel: string): string {
  const parts = posixParts(rel);
  const root = resolve(libraryRoot);
  const abs = resolve(root, ...parts);
  const out = relative(root, abs);
  if (out.startsWith('..') || isAbsolute(out)) throw new LibraryPathError();
  if (out.split(sep).includes('..')) throw new LibraryPathError();
  return abs;
}

export function parentLibraryDir(rel: string): string | null {
  const parts = posixParts(rel);
  if (parts.length === 0) return null;
  return parts.slice(0, -1).join('/');
}

export function joinLibraryRel(dir: string, name: string): string {
  const dirParts = posixParts(dir);
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) {
    throw new LibraryPathError();
  }
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') throw new LibraryPathError();
  return [...dirParts, trimmed].join('/');
}

export function folderNameOk(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed !== '.' && trimmed !== '..' && !/[\\/]/.test(trimmed);
}
