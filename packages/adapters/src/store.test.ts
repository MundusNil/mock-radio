import type { Track } from '@mock-radio/core';
import { describe, expect, it } from 'vitest';
import { createStore } from './store';

const T = (id: string, path: string): Track => ({
  id,
  path,
  title: `曲目-${id}`,
  artist: null,
  durationMs: 240_000,
  styles: ['cafe'],
  enabled: true,
  addedAt: 1_700_000_000_000,
});

describe('store · tracks', () => {
  it('upsert 按 path 幂等，不产生重复行', () => {
    const store = createStore(':memory:');
    store.upsertTracks([T('a', 'cafe/a.mp3'), T('b', 'cafe/b.mp3')]);
    store.upsertTracks([{ ...T('a2', 'cafe/a.mp3'), title: '改名' }]);
    const tracks = store.listTracks();
    expect(tracks).toHaveLength(2);
    const a = tracks.find((t) => t.path === 'cafe/a.mp3');
    expect(a?.id).toBe('a');
    expect(a?.title).toBe('改名');
  });

  it('styles 数组往返完整', () => {
    const store = createStore(':memory:');
    const track: Track = {
      ...T('a', 'cafe/a.mp3'),
      styles: ['cafe', 'night-quiet'],
      artist: '测试歌手',
    };
    store.upsertTracks([track]);
    expect(store.listTracks()[0]).toMatchObject({
      styles: ['cafe', 'night-quiet'],
      artist: '测试歌手',
    });
  });

  it('setTrackEnabled 后 upsert 不覆盖开关', () => {
    const store = createStore(':memory:');
    store.upsertTracks([T('a', 'cafe/a.mp3')]);
    store.setTrackEnabled('a', false);
    store.upsertTracks([{ ...T('a', 'cafe/a.mp3'), title: '新标题', enabled: true }]);
    const row = store.listTracks()[0];
    expect(row?.enabled).toBe(false);
    expect(row?.title).toBe('新标题');
  });
});

describe('store · plays（时间线重建依据）', () => {
  it('播放开始后 lastUnfinished 可见；结束后消失', () => {
    const store = createStore(':memory:');
    store.upsertTracks([T('a', 'cafe/a.mp3')]);
    const playId = store.startPlay('a', 1_000_000);
    expect(store.getLastUnfinishedPlay()).toEqual({
      id: playId,
      trackId: 'a',
      startedAt: 1_000_000,
    });
    store.endPlay(playId, 1_240_000);
    expect(store.getLastUnfinishedPlay()).toBeNull();
  });

  it('listRecentPlays 按时间过滤（喂回调度器防重复滑窗）', () => {
    const store = createStore(':memory:');
    store.upsertTracks([T('a', 'cafe/a.mp3'), T('b', 'cafe/b.mp3')]);
    const p1 = store.startPlay('a', 1_000_000);
    store.endPlay(p1, 1_240_000);
    const p2 = store.startPlay('b', 1_300_000);
    store.endPlay(p2, 1_500_000);
    const recent = store.listRecentPlays(1_100_000); // 只含 b
    expect(recent).toEqual([{ trackId: 'b', startedAt: 1_300_000 }]);
  });
});

describe('store · segments（节目记录，P3 记忆的基础）', () => {
  it('插入后可读取', () => {
    const store = createStore(':memory:');
    store.insertSegment({
      id: 'seg-1',
      kind: 'interlude',
      text: '你好',
      audioPath: '/tmp/a.mp3',
      durationMs: 5000,
      plannedAt: 1_000_000,
      airedAt: 1_000_500,
      status: 'aired',
    });
    expect(store.listSegments()).toHaveLength(1);
    expect(store.listSegments()[0]).toMatchObject({ kind: 'interlude', text: '你好' });
  });
});

describe('store · messages（P2，FR-091/092）', () => {
  it('留言入库带过期时间，可查询活跃留言', () => {
    const store = createStore(':memory:');
    store.insertMessage({
      id: 'm1',
      body: '你好',
      receivedAt: 1_000_000,
      expiresAt: 1_000_000 + 7 * 86_400_000,
    });
    const active = store.listActiveMessages(1_500_000);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ body: '你好' });
  });

  it('回复播出后留言被删除（FR-051：重启不重播）', () => {
    const store = createStore(':memory:');
    store.insertMessage({ id: 'm1', body: '第一条', receivedAt: 1_000_000, expiresAt: 9_000_000 });
    store.insertMessage({ id: 'm2', body: '第二条', receivedAt: 1_100_000, expiresAt: 9_000_000 });
    store.insertMessage({ id: 'm3', body: '未回复', receivedAt: 1_200_000, expiresAt: 9_000_000 });
    store.deleteMessages(['m1', 'm2']);
    const active = store.listActiveMessages(1_500_000);
    expect(active.map((m) => m.id)).toEqual(['m3']);
  });
});

describe('store · memories（P3，L1 节目记忆）', () => {
  it('写入、列出、删除', () => {
    const store = createStore(':memory:');
    store.insertMemories([
      {
        id: 'mem-1',
        kind: 'topic',
        text: '听众喜欢暖色调',
        importance: 0.7,
        createdAt: 1_000_000,
        lastUsedAt: null,
        status: 'active',
      },
    ]);
    expect(store.listMemories()).toHaveLength(1);
    store.deleteMemory('mem-1');
    expect(store.listMemories()).toHaveLength(0);
  });

  it('更新最近引用时间（检索加权）', () => {
    const store = createStore(':memory:');
    store.insertMemories([
      {
        id: 'mem-1',
        kind: 'meme',
        text: '内部梗',
        importance: 0.5,
        createdAt: 1_000_000,
        lastUsedAt: null,
        status: 'active',
      },
    ]);
    store.touchMemory('mem-1', 2_000_000);
    const memories = store.listMemories();
    expect(memories[0]?.lastUsedAt).toBe(2_000_000);
  });
});

describe('store · 曲库清理（scan 删歌同步）', () => {
  it('删除 DB 中已不存在的曲目（文件被删/移动后）', () => {
    const store = createStore(':memory:');
    store.upsertTracks([T('a', 'cafe/a.mp3'), T('b', 'cafe/b.mp3'), T('c', 'cafe/c.mp3')]);
    store.deleteTracksNotIn(['cafe/a.mp3', 'cafe/c.mp3']); // b 的文件被删了
    const paths = store.listTracks().map((t) => t.path);
    expect(paths).toEqual(['cafe/a.mp3', 'cafe/c.mp3']);
  });

  it('已播过的曲目被移出曲库时，连播放记录一起清掉，不因外键失败', () => {
    const store = createStore(':memory:');
    store.upsertTracks([T('a', 'cafe/a.mp3'), T('b', 'cafe/b.mp3')]);
    const playA = store.startPlay('a', 1_000_000);
    store.endPlay(playA, 1_240_000);
    store.startPlay('b', 1_300_000);
    store.deleteTracksNotIn(['cafe/a.mp3']);
    expect(store.listTracks().map((t) => t.path)).toEqual(['cafe/a.mp3']);
    expect(store.listRecentPlays(0)).toEqual([{ trackId: 'a', startedAt: 1_000_000 }]);
    expect(store.getLastUnfinishedPlay()).toBeNull();
  });

  it('曲库清空时连播放记录一起清', () => {
    const store = createStore(':memory:');
    store.upsertTracks([T('a', 'cafe/a.mp3')]);
    store.startPlay('a', 1_000_000);
    store.deleteTracksNotIn([]);
    expect(store.listTracks()).toEqual([]);
    expect(store.getLastUnfinishedPlay()).toBeNull();
  });
});
