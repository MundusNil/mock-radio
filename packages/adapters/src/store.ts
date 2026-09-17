/**
 * SQLite 存储适配器（技术设计 §5 数据模型）。
 * better-sqlite3 同步 API；tracks/plays/segments 三个表 P1 使用，
 * messages/memories 表结构就位（P2/P3 接入）。
 * 「电台重启不失忆」：时间线从 plays 表重建。
 */
import { randomUUID } from 'node:crypto';
import type { MemoryKind, MemoryRecordL1, Segment, SegmentKind, Track } from '@mock-radio/core';
import Database from 'better-sqlite3';

export interface PlayRow {
  id: string;
  trackId: string;
  startedAt: number;
  endedAt: number | null;
}

export interface RecentPlay {
  trackId: string;
  startedAt: number;
}

export interface StoredMessage {
  id: string;
  body: string;
  receivedAt: number;
  expiresAt: number;
}

export interface Store {
  upsertTracks(tracks: Track[]): void;
  listTracks(): Track[];
  /** 删除 DB 中已不存在的曲目，并清掉对应播放记录（scan 清理：文件被删/移动后同步） */
  deleteTracksNotIn(paths: string[]): void;
  /** 设置面板勾选：是否进入随机池（scan 再入库不得覆盖） */
  setTrackEnabled(id: string, enabled: boolean): void;
  startPlay(trackId: string, startedAt: number): string;
  endPlay(id: string, endedAt: number): void;
  getLastUnfinishedPlay(): { id: string; trackId: string; startedAt: number } | null;
  listRecentPlays(sinceMs: number): RecentPlay[];
  insertSegment(segment: Segment): void;
  listSegments(): Segment[];
  /** 原始留言入库（FR-091：后台短期保留，7 天后自动删除 FR-092） */
  insertMessage(message: StoredMessage): void;
  listActiveMessages(now: number): StoredMessage[];
  /** 删除过期留言；返回删除条数 */
  deleteExpiredMessages(now: number): number;
  /** 删除已回复播出的留言（回复完即删，重启不重播） */
  deleteMessages(ids: string[]): void;
  /** L1 节目记忆（P3，FR-077：维护者可查看/修正/删除） */
  insertMemories(memories: MemoryRecordL1[]): void;
  listMemories(): MemoryRecordL1[];
  deleteMemory(id: string): void;
  /** 更新最近引用时间（检索加权，FR-075） */
  touchMemory(id: string, at: number): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  artist TEXT,
  duration_ms INTEGER NOT NULL,
  styles_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plays (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plays_started ON plays(started_at);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  audio_path TEXT,
  duration_ms INTEGER,
  planned_at INTEGER NOT NULL,
  aired_at INTEGER,
  status TEXT NOT NULL DEFAULT 'planned'
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  importance REAL NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS station_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface TrackRow {
  id: string;
  path: string;
  title: string;
  artist: string | null;
  duration_ms: number;
  styles_json: string;
  enabled: number;
  added_at: number;
}

interface SegmentRow {
  id: string;
  kind: SegmentKind;
  text: string;
  audio_path: string | null;
  duration_ms: number | null;
  planned_at: number;
  aired_at: number | null;
  status: Segment['status'];
}

export function createStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  return {
    upsertTracks(tracks: Track[]): void {
      const upsert = db.prepare(`
        INSERT INTO tracks (id, path, title, artist, duration_ms, styles_json, enabled, added_at)
        VALUES (@id, @path, @title, @artist, @durationMs, @stylesJson, @enabled, @addedAt)
        ON CONFLICT(path) DO UPDATE SET
          title = excluded.title,
          artist = excluded.artist,
          duration_ms = excluded.duration_ms,
          styles_json = excluded.styles_json
      `);
      const tx = db.transaction((rows: Array<Record<string, unknown>>) => {
        for (const row of rows) upsert.run(row);
      });
      tx(
        tracks.map((t) => ({
          id: t.id,
          path: t.path,
          title: t.title,
          artist: t.artist,
          durationMs: t.durationMs,
          stylesJson: JSON.stringify(t.styles),
          enabled: t.enabled ? 1 : 0,
          addedAt: t.addedAt,
        })),
      );
    },

    listTracks(): Track[] {
      const rows = db.prepare('SELECT * FROM tracks ORDER BY added_at').all() as TrackRow[];
      return rows.map((r) => ({
        id: r.id,
        path: r.path,
        title: r.title,
        artist: r.artist,
        durationMs: r.duration_ms,
        styles: JSON.parse(r.styles_json) as string[],
        enabled: r.enabled === 1,
        addedAt: r.added_at,
      }));
    },

    deleteTracksNotIn(paths: string[]): void {
      const tx = db.transaction(() => {
        if (paths.length === 0) {
          db.prepare('DELETE FROM plays').run();
          db.prepare('DELETE FROM tracks').run();
          return;
        }
        const placeholders = paths.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM plays WHERE track_id IN (SELECT id FROM tracks WHERE path NOT IN (${placeholders}))`,
        ).run(...paths);
        db.prepare(`DELETE FROM tracks WHERE path NOT IN (${placeholders})`).run(...paths);
      });
      tx();
    },

    startPlay(trackId: string, startedAt: number): string {
      const id = randomUUID();
      db.prepare('INSERT INTO plays (id, track_id, started_at) VALUES (?, ?, ?)').run(
        id,
        trackId,
        startedAt,
      );
      return id;
    },

    endPlay(id: string, endedAt: number): void {
      db.prepare('UPDATE plays SET ended_at = ? WHERE id = ?').run(endedAt, id);
    },

    getLastUnfinishedPlay() {
      const row = db
        .prepare(
          'SELECT id, track_id, started_at FROM plays WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
        )
        .get() as { id: string; track_id: string; started_at: number } | undefined;
      if (!row) return null;
      return { id: row.id, trackId: row.track_id, startedAt: row.started_at };
    },

    listRecentPlays(sinceMs: number): RecentPlay[] {
      const rows = db
        .prepare('SELECT track_id, started_at FROM plays WHERE started_at >= ? ORDER BY started_at')
        .all(sinceMs) as Array<{ track_id: string; started_at: number }>;
      return rows.map((r) => ({ trackId: r.track_id, startedAt: r.started_at }));
    },

    insertSegment(segment: Segment): void {
      db.prepare(`
        INSERT INTO segments (id, kind, text, audio_path, duration_ms, planned_at, aired_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        segment.id,
        segment.kind,
        segment.text,
        segment.audioPath,
        segment.durationMs,
        segment.plannedAt,
        segment.airedAt,
        segment.status,
      );
    },

    listSegments(): Segment[] {
      const rows = db.prepare('SELECT * FROM segments ORDER BY planned_at').all() as SegmentRow[];
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        text: r.text,
        audioPath: r.audio_path,
        durationMs: r.duration_ms,
        plannedAt: r.planned_at,
        airedAt: r.aired_at,
        status: r.status,
      }));
    },
    insertMessage(message: StoredMessage): void {
      db.prepare(
        'INSERT INTO messages (id, body, received_at, expires_at) VALUES (?, ?, ?, ?)',
      ).run(message.id, message.body, message.receivedAt, message.expiresAt);
    },

    listActiveMessages(now: number): StoredMessage[] {
      const rows = db
        .prepare('SELECT * FROM messages WHERE expires_at > ? ORDER BY received_at')
        .all(now) as Array<{ id: string; body: string; received_at: number; expires_at: number }>;
      return rows.map((r) => ({
        id: r.id,
        body: r.body,
        receivedAt: r.received_at,
        expiresAt: r.expires_at,
      }));
    },

    deleteExpiredMessages(now: number): number {
      const result = db.prepare('DELETE FROM messages WHERE expires_at <= ?').run(now);
      return result.changes;
    },

    deleteMessages(ids: string[]): void {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
    },

    insertMemories(memories: MemoryRecordL1[]): void {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO memories (id, kind, text, importance, created_at, last_used_at, status)
        VALUES (@id, @kind, @text, @importance, @createdAt, @lastUsedAt, @status)
      `);
      const tx = db.transaction((rows: Array<Record<string, unknown>>) => {
        for (const row of rows) insert.run(row);
      });
      tx(
        memories.map((m) => ({
          id: m.id,
          kind: m.kind,
          text: m.text,
          importance: m.importance,
          createdAt: m.createdAt,
          lastUsedAt: m.lastUsedAt,
          status: m.status,
        })),
      );
    },

    listMemories(): MemoryRecordL1[] {
      const rows = db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all() as Array<{
        id: string;
        kind: MemoryKind;
        text: string;
        importance: number;
        created_at: number;
        last_used_at: number | null;
        status: 'active' | 'archived' | 'deleted';
      }>;
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        text: r.text,
        importance: r.importance,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        status: r.status,
      }));
    },

    deleteMemory(id: string): void {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    },

    touchMemory(id: string, at: number): void {
      db.prepare('UPDATE memories SET last_used_at = ? WHERE id = ?').run(at, id);
    },

    setTrackEnabled(id: string, enabled: boolean): void {
      db.prepare('UPDATE tracks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },
  };
}

export type { MemoryKind };
