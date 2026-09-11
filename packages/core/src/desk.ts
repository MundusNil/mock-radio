/**
 * 案头检索：Deep Research 的电台缩小版。
 *
 * Gemini / Anthropic 的研究代理是「规划 → 多路检索 → 综合笔记 → 再写」。
 * 电台没有 15 分钟和一堆子代理，但同一条缝必须拆开：
 * 开口那一次不再联网；搜索占用音乐时间（曲目开播预取），写成笔记再说话。
 *
 * 规划是确定性的三路查询（作品场景 / 玩家社区 / 乐评），不另花一次 LLM 做计划。
 * 方舟没有独立 search API，三路查询写进同一次 `researchDesk`（web_search）。
 * 笔记不是 L1 记忆、不是世界书。
 */
import type { SegmentPrompt, TrackBrief } from './context';

export type DeskLane = 'work' | 'community' | 'music';

export interface DeskQuery {
  lane: DeskLane;
  q: string;
}

export interface DeskNote {
  lane: DeskLane;
  text: string;
}

export interface DeskNotes {
  trackId: string;
  queries: DeskQuery[];
  notes: DeskNote[];
}

export interface DeskResearchBrief {
  trackId: string;
  title: string;
  artist: string | null;
  styles: string[];
  queries: DeskQuery[];
}

const LANE_LABEL: Record<DeskLane, string> = {
  work: '作品场景',
  community: '玩家社区',
  music: '乐评',
};

const LANE_FROM_RAW: Record<string, DeskLane> = {
  work: 'work',
  community: 'community',
  music: 'music',
  作品: 'work',
  场景: 'work',
  作品场景: 'work',
  社区: 'community',
  玩家: 'community',
  玩家社区: 'community',
  乐评: 'music',
  评论: 'music',
};

/**
 * 确定性三路：作品场景 / 玩家社区 / 乐评。互不合并成「游戏介绍」。
 * 模板用英文（2026-09-11 实测换形）：曲名/作品名本就是英文专有名词，活口引擎
 * （yandex/sogou/naver）对中文长尾查询漂到 mp3 站/公众号垃圾；同曲英文形状
 * 实测命中 howlongtobeat / Steam 评测页（17.8k 字符 vs 中文 9.6k、页页有料）。
 * lane 意图不变，只换问法语言。
 */
export function planDeskQueries(track: TrackBrief): DeskQuery[] {
  const title = track.title.trim();
  const work = track.artist?.trim() ?? '';
  const workBit = work ? ` ${work}` : '';
  const styleBit = !work && track.styles[0] ? ` ${track.styles[0]}` : '';
  return [
    {
      lane: 'work',
      q: `${title}${workBit}${styleBit} game scene chapter OST`,
    },
    {
      lane: 'community',
      q: `${title}${workBit} steam review player comment`,
    },
    {
      lane: 'music',
      q: `${title}${workBit} OST review instrumentation composer`,
    },
  ];
}

export function buildDeskResearchPrompt(brief: DeskResearchBrief): SegmentPrompt {
  const listed = brief.queries.map((q, i) => `${i + 1}. [${q.lane}] ${q.q}`).join('\n');
  const work = brief.artist?.trim();
  const styles = brief.styles.length > 0 ? `（${brief.styles.join('/')}）` : '';
  return {
    system: `你是电台案头编辑，不是主播。不要写口播。
最多搜一轮。下面三条是方向，搜到哪条写哪条，写不满留空；不要为凑满三条反复搜，也不要合并成一条游戏或专辑介绍：
${listed}
每条不超过 40 字。只留下可核对的具体事实：场景/关卡/角色名、一句玩家原话、一条针对这首（不是整张专辑）的乐评。
笔记里出现的人名、场景名、玩家原话照抄保留，不要总结成「玩家普遍觉得」这类没有名字的共识。
没搜到的 lane 不要硬写。
只输出 JSON：{"notes":[{"lane":"work"|"community"|"music","text":"..."}]}`,
    user: `曲目：${brief.title}${work ? ` / ${work}` : ''}${styles}
按三条方向检索，有就写，没有就空。`,
  };
}

/** 本地检索管道用：模型不开 web_search，只从给定网页材料提炼笔记（与联网路同一 JSON 契约）。 */
export function buildDeskExtractPrompt(brief: DeskResearchBrief, material: string): SegmentPrompt {
  const listed = brief.queries.map((q, i) => `${i + 1}. [${q.lane}] ${q.q}`).join('\n');
  const work = brief.artist?.trim();
  return {
    system: `你是电台案头编辑，不是主播。不要写口播。
下面给你的是刚抓回的网页材料（搜索引擎结果 + 页面正文摘录）。只从材料里提炼，材料里没有的一律不写，不许用你的记忆补：
${listed}
每条不超过 40 字。只留下可核对的具体事实：场景/关卡/角色名、一句玩家原话（注明来源页）、一条针对这首（不是整张专辑）的乐评。
材料里的人名、场景名、玩家原话照抄保留，不要总结成「玩家普遍觉得」这类没有名字的共识。
材料覆盖不到的 lane 留空，不要硬凑。
只输出 JSON：{"notes":[{"lane":"work"|"community"|"music","text":"..."}]}`,
    user: `曲目：${brief.title}${work ? ` / ${work}` : ''}
【网页材料】
${material}
按三条方向提炼，有就写，没有就空。`,
  };
}

function asLane(raw: unknown): DeskLane | null {
  if (typeof raw !== 'string') return null;
  return LANE_FROM_RAW[raw.trim()] ?? null;
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseDeskNotes(raw: string, trackId: string, queries: DeskQuery[]): DeskNotes {
  const parsed = extractJsonObject(raw);
  const notes: DeskNote[] = [];
  const perLane: Record<DeskLane, number> = { work: 0, community: 0, music: 0 };
  const rawNotes =
    parsed && typeof parsed === 'object' && 'notes' in parsed ? parsed.notes : undefined;
  if (Array.isArray(rawNotes)) {
    for (const item of rawNotes) {
      if (!item || typeof item !== 'object') continue;
      const lane = asLane('lane' in item ? item.lane : undefined);
      const rawText = 'text' in item && typeof item.text === 'string' ? item.text : '';
      const text = rawText.replace(/\s+/g, ' ').trim();
      if (!lane || text.length < 8) continue;
      if (perLane[lane] >= 2) continue;
      perLane[lane] += 1;
      notes.push({ lane, text: text.slice(0, 240) });
    }
  }
  return { trackId, queries, notes };
}

export function formatDeskNotesForSpeak(notes: DeskNotes): string {
  if (notes.notes.length === 0) {
    return '案头这次没摸到能站住的条目。就说听得见的一个具体变化，一两句，说完就停，不要拆声部做对比。';
  }
  const lines = notes.notes.map((n) => `- [${LANE_LABEL[n.lane]}] ${n.text}`);
  return [
    '案头笔记（听众看不见；只挑一条具体的事来说这首，别讲整部作品，别说你查过）：',
    ...lines,
    '引用笔记时说得出名字的那一个：角色就叫 Jill，玩家的话就说是看到的评测。不许改写成「好多人/玩过的人/大家」这种没有名字的共识。',
  ].join('\n');
}
