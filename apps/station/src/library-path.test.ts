import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { folderNameOk, joinLibraryRel, parentLibraryDir, resolveLibraryPath } from './library-path';

const ROOT = resolve('/tmp/mock-radio-library');

describe('resolveLibraryPath', () => {
  it('根目录是 libraryRoot 本身', () => {
    expect(resolveLibraryPath(ROOT, '')).toBe(ROOT);
    expect(resolveLibraryPath(ROOT, '   ')).toBe(ROOT);
  });

  it('合法嵌套拼在根下', () => {
    expect(resolveLibraryPath(ROOT, 'ENDER LILIES')).toBe(resolve(ROOT, 'ENDER LILIES'));
    expect(resolveLibraryPath(ROOT, 'VA-11 HALL-A/ost')).toBe(resolve(ROOT, 'VA-11 HALL-A', 'ost'));
  });

  it('拒绝 .. 与夹在中间的 ..', () => {
    expect(() => resolveLibraryPath(ROOT, '../x')).toThrow('非法路径');
    expect(() => resolveLibraryPath(ROOT, 'VA-11 HALL-A/../x')).toThrow('非法路径');
    expect(() => resolveLibraryPath(ROOT, 'a/../../b')).toThrow('非法路径');
  });

  it('拒绝 Windows 盘符绝对路径', () => {
    expect(() => resolveLibraryPath(ROOT, 'C:\\Windows')).toThrow('非法路径');
    expect(() => resolveLibraryPath(ROOT, 'C:/Windows')).toThrow('非法路径');
  });
});

describe('parentLibraryDir / joinLibraryRel / folderNameOk', () => {
  it('上一级：子目录回到根，根没有上一级', () => {
    expect(parentLibraryDir('ENDER LILIES')).toBe('');
    expect(parentLibraryDir('VA-11 HALL-A/ost')).toBe('VA-11 HALL-A');
    expect(parentLibraryDir('')).toBeNull();
  });

  it('拼接当前目录与文件名', () => {
    expect(joinLibraryRel('', 'a.flac')).toBe('a.flac');
    expect(joinLibraryRel('ENDER LILIES', '01. Lily.flac')).toBe('ENDER LILIES/01. Lily.flac');
  });

  it('文件夹名拒绝斜杠和 . / ..', () => {
    expect(folderNameOk('OST')).toBe(true);
    expect(folderNameOk('')).toBe(false);
    expect(folderNameOk('..')).toBe(false);
    expect(folderNameOk('a/b')).toBe(false);
  });
});
