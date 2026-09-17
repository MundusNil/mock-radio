/** 曲库扫描：config/library 下任意嵌套的音频 → Track[]。第一层文件夹名仍是可选风格标签（D3）。 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { probeDurationMs } from '@mock-radio/adapters';
import type { Track } from '@mock-radio/core';

export const AUDIO_EXT = new Set(['.mp3', '.flac', '.ogg', '.m4a', '.wav', '.opus', '.aac']);

/** 清洗曲名：去掉文件名开头的曲目序号（01. / 1-01 / [01]），歌名本身的数字保留。 */
export function cleanTitle(filename: string): string {
  const stem = basename(filename, extname(filename)).trim();
  const stripped = stem
    .replace(/^\(\d{1,3}\)\s*/, '')
    .replace(/^\[\d{1,3}\]\s*/, '')
    .replace(/^\d{1,2}[-.]\d{1,3}(?:[.)\]～~._\-–—]\s*|\s+)/, '')
    .replace(/^\d{1,3}[.)\]～~._\-–—]\s*/, '')
    .replace(/^0\d{1,2}(?!\d)\s+/, '')
    .replace(/^[-–—.~～]+\s*/, '')
    .trim();
  return stripped.length > 0 ? stripped : stem;
}

function trackIdOf(root: string, absPath: string): string {
  return createHash('md5').update(relative(root, absPath)).digest('hex').slice(0, 12);
}

function stylesFromRel(rel: string): string[] {
  const slash = rel.indexOf('/');
  return slash === -1 ? [] : [rel.slice(0, slash)];
}

async function collectAudioFiles(dir: string, acc: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectAudioFiles(absPath, acc);
      continue;
    }
    if (!entry.isFile() || !AUDIO_EXT.has(extname(entry.name).toLowerCase())) continue;
    acc.push(absPath);
  }
}

export async function scanLibrary(root: string): Promise<Track[]> {
  const files: string[] = [];
  await collectAudioFiles(root, files);
  const tracks: Track[] = [];
  for (const absPath of files) {
    const durationMs = await probeDurationMs(absPath).catch(() => null);
    if (durationMs === null) {
      console.warn(
        `[library] 无法读取时长，跳过：${relative(root, absPath).replaceAll('\\', '/')}`,
      );
      continue;
    }
    const rel = relative(root, absPath).replaceAll('\\', '/');
    tracks.push({
      id: trackIdOf(root, absPath),
      path: rel,
      title: cleanTitle(absPath),
      artist: null,
      durationMs,
      styles: stylesFromRel(rel),
      enabled: true,
      addedAt: Date.now(),
    });
  }
  return tracks;
}
