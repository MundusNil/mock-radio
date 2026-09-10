import { describe, expect, it } from 'vitest';
import {
  buildDeskResearchPrompt,
  formatDeskNotesForSpeak,
  parseDeskNotes,
  planDeskQueries,
} from './desk';

const track = { title: 'Showtime!', artist: 'VA-11 HALL-A', styles: ['game-bgm'] };

describe('planDeskQueries', () => {
  it('三路查询互不合并，都带上这首和歌源', () => {
    const queries = planDeskQueries(track);
    expect(queries.map((q) => q.lane)).toEqual(['work', 'community', 'music']);
    for (const q of queries) {
      expect(q.q).toContain('Showtime!');
      expect(q.q).toContain('VA-11 HALL-A');
    }
    expect(queries[0]?.q).toContain('场景');
    expect(queries[1]?.q).toContain('玩家评价');
    expect(queries[1]?.q).toContain('原话');
    expect(queries[2]?.q).toContain('编曲');
    expect(new Set(queries.map((q) => q.q)).size).toBe(3);
  });

  it('没有艺术家时用风格兜底作品路，仍是三路', () => {
    const queries = planDeskQueries({ title: '月光小径', artist: null, styles: ['cafe'] });
    expect(queries).toHaveLength(3);
    expect(queries[0]?.q).toContain('cafe');
    expect(queries[1]?.q).toContain('月光小径');
  });
});

describe('parseDeskNotes', () => {
  const queries = planDeskQueries(track);

  it('从 JSON 抽出具体笔记，丢掉过短的空话', () => {
    const notes = parseDeskNotes(
      JSON.stringify({
        notes: [
          { lane: 'work', text: '调酒界面开场，客人进门前那几秒' },
          { lane: 'community', text: '短' },
          { lane: 'music', text: '网易云有人写「比游戏里听到的淡一点」' },
        ],
      }),
      't1',
      queries,
    );
    expect(notes.trackId).toBe('t1');
    expect(notes.notes).toEqual([
      { lane: 'work', text: '调酒界面开场，客人进门前那几秒' },
      { lane: 'music', text: '网易云有人写「比游戏里听到的淡一点」' },
    ]);
  });

  it('吃 markdown 围栏和中文 lane 名', () => {
    const notes = parseDeskNotes(
      '```json\n{"notes":[{"lane":"玩家社区","text":"Steam 有人挂标题画面一整晚"}]}\n```',
      't1',
      queries,
    );
    expect(notes.notes).toEqual([{ lane: 'community', text: 'Steam 有人挂标题画面一整晚' }]);
  });

  it('每路最多两条；坏 JSON 当空笔记', () => {
    const many = parseDeskNotes(
      JSON.stringify({
        notes: [
          { lane: 'work', text: '第一关标题画面循环' },
          { lane: 'work', text: '打烊曲客人都走了才放' },
          { lane: 'work', text: '第三段不该留下' },
        ],
      }),
      't1',
      queries,
    );
    expect(many.notes).toHaveLength(2);
    expect(parseDeskNotes('不是 JSON', 't1', queries).notes).toEqual([]);
  });
});

describe('formatDeskNotesForSpeak / buildDeskResearchPrompt', () => {
  it('有笔记时列出三路标签，空笔记禁止编设定', () => {
    const queries = planDeskQueries(track);
    expect(
      formatDeskNotesForSpeak({
        trackId: 't1',
        queries,
        notes: [{ lane: 'community', text: 'Steam 有人挂标题画面一整晚' }],
      }),
    ).toContain('[玩家社区] Steam 有人挂标题画面一整晚');
    expect(formatDeskNotesForSpeak({ trackId: 't1', queries, notes: [] })).toContain(
      '案头这次没摸到能站住的条目',
    );
  });

  it('案头提示给三路方向，禁止写口播，不强迫三次检索', () => {
    const queries = planDeskQueries(track);
    const p = buildDeskResearchPrompt({
      trackId: 't1',
      title: track.title,
      artist: track.artist,
      styles: track.styles,
      queries,
    });
    expect(p.system).toContain('[work]');
    expect(p.system).toContain('[community]');
    expect(p.system).toContain('[music]');
    expect(p.system).toContain('不要写口播');
    expect(p.system).toContain('最多搜一轮');
    expect(p.system).not.toContain('必须分别检索');
    expect(p.system).toContain(queries[1]?.q ?? '');
    expect(p.user).toContain('Showtime!');
  });
});
