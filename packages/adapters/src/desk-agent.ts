/**
 * 案头多轮检索 agent（LangGraph.js）：search → evaluate →(不足)→ search ↺ → END。
 *
 * search 一轮拿基础笔记，evaluate 当「案头质检」：缺带具体名字的事实才补搜，≤3 轮。
 * 对外是一个 LlmClient——producer / 调度器 / 2.5s 竞态全部无感知。
 *
 * 挂钟语义：deskTimeoutMs 从「单次调用超时」升级为「整图预算」。
 * deadlineAt 在 researchDesk 入口算一次；每个节点用剩余量做 fetch 超时，
 * 过期即 finalize——轮数是软限制，挂钟是硬限制（与调度器同一哲学）。
 * 刻意不装 checkpointer：笔记活不过重启，是既有决定。
 */
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type {
  DeskLane,
  DeskNote,
  DeskNotes,
  DeskQuery,
  DeskResearchBrief,
  LlmClient,
} from '@mock-radio/core';
import { buildDeskResearchPrompt, parseDeskNotes } from '@mock-radio/core';
import type { ChatFn, OpenAiCompatibleOptions } from './llm';
import { createChat, createOpenAiCompatibleLlm, DEFAULT_DESK_TIMEOUT_MS } from './llm';

const MAX_ROUNDS = 3;
const MAX_TOTAL_NOTES = 3;
const QUERY_LANES = new Set<DeskLane>(['work', 'community', 'music']);

/** 累积合并：同 lane 同文本去重；lane 内 ≤2、总 ≤3；先搜到的优先。 */
function mergeNotes(existing: DeskNote[], incoming: DeskNote[]): DeskNote[] {
  const seen = new Set(existing.map((n) => `${n.lane}|${n.text}`));
  const perLane: Record<DeskLane, number> = { work: 0, community: 0, music: 0 };
  for (const n of existing) perLane[n.lane] += 1;
  const out = [...existing];
  for (const n of incoming) {
    const key = `${n.lane}|${n.text}`;
    if (seen.has(key) || perLane[n.lane] >= 2 || out.length >= MAX_TOTAL_NOTES) continue;
    seen.add(key);
    perLane[n.lane] += 1;
    out.push(n);
  }
  return out;
}

function extractJson(raw: string): { sufficient?: unknown; queries?: unknown } | null {
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

function toRefineQueries(raw: unknown): DeskQuery[] {
  if (!Array.isArray(raw)) return [];
  const out: DeskQuery[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const lane = 'lane' in item && typeof item.lane === 'string' ? item.lane.trim() : '';
    const q = 'q' in item && typeof item.q === 'string' ? item.q.replace(/\s+/g, ' ').trim() : '';
    if (!QUERY_LANES.has(lane as DeskLane) || q.length < 4) continue;
    out.push({ lane: lane as DeskLane, q: q.slice(0, 60) });
    if (out.length >= 2) break;
  }
  return out;
}

const DeskAgentState = Annotation.Root({
  brief: Annotation<DeskResearchBrief>(),
  queries: Annotation<DeskQuery[]>({ reducer: (_p, n) => n, default: () => [] }),
  notes: Annotation<DeskNote[]>({ reducer: mergeNotes, default: () => [] }),
  round: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
  stop: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
  deadlineAt: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
});
type DeskAgentView = typeof DeskAgentState.State;
type DeskAgentUpdate = typeof DeskAgentState.Update;
type NodeConfig = { signal?: AbortSignal };

export function createDeskAgentGraph(chat: ChatFn) {
  async function search(state: DeskAgentView, config: NodeConfig): Promise<DeskAgentUpdate> {
    if (state.stop || Date.now() >= state.deadlineAt) return { stop: true };
    const prompt = buildDeskResearchPrompt({ ...state.brief, queries: state.queries });
    try {
      const text = await chat(
        [
          { role: 'system' as const, content: prompt.system },
          { role: 'user' as const, content: prompt.user },
        ],
        {
          webSearch: true,
          disableThinking: true,
          timeoutMs: Math.max(1, state.deadlineAt - Date.now()),
          signal: config.signal,
        },
      );
      return {
        notes: parseDeskNotes(text, state.brief.trackId, state.queries).notes,
        round: state.round + 1,
      };
    } catch (err) {
      // 外部取消必须原样上抛：切歌杀在途是调度器的契约，不许降级成部分结果
      if (config.signal?.aborted) throw err;
      if (state.notes.length === 0) throw err; // 首轮全挂：保持旧契约，交给 producer 的 onError
      console.error('[desk-agent] 补搜失败，用已有笔记收尾：', err);
      return { stop: true, round: state.round + 1 };
    }
  }

  async function evaluate(state: DeskAgentView, config: NodeConfig): Promise<DeskAgentUpdate> {
    if (state.stop) return {};
    if (state.notes.length >= MAX_TOTAL_NOTES) return { stop: true };
    if (state.round >= MAX_ROUNDS || Date.now() >= state.deadlineAt) return { stop: true };
    const work = state.brief.artist?.trim();
    try {
      const raw = await chat(
        [
          {
            role: 'system' as const,
            content: `你是电台案头质检，不是主播。已有笔记（可能为空）：
${state.notes.map((n) => `- [${n.lane}] ${n.text}`).join('\n') || '（无）'}
够不够支撑一句 40 字以内、带具体名字（角色/关卡/玩家原话/乐器编制）的口播？
没有一条带名字的具体事实就不够。够 → queries 留空；不够 → 最多 2 条补搜查询，
lane 只能是 work/community/music，每条不超过 25 字，问具体的不要问泛的。
只输出 JSON：{"sufficient":true|false,"queries":[{"lane":"work","q":"..."}]}`,
          },
          {
            role: 'user' as const,
            content: `曲目：${state.brief.title}${work ? ` / ${work}` : ''}`,
          },
        ],
        {
          webSearch: false,
          jsonObject: true,
          disableThinking: true,
          timeoutMs: Math.max(1, state.deadlineAt - Date.now()),
          signal: config.signal,
        },
      );
      const parsed = extractJson(raw);
      const nextQueries = toRefineQueries(parsed?.queries);
      if (parsed?.sufficient === true || nextQueries.length === 0) return { stop: true };
      return { queries: nextQueries };
    } catch (err) {
      if (config.signal?.aborted) throw err;
      // 质检挂了不拦出口：有什么用什么
      console.error('[desk-agent] 质检失败，按已有笔记收尾：', err);
      return { stop: true };
    }
  }

  return new StateGraph(DeskAgentState)
    .addNode('search', search)
    .addNode('evaluate', evaluate)
    .addEdge(START, 'search')
    .addEdge('search', 'evaluate')
    .addConditionalEdges('evaluate', (state: DeskAgentView) => {
      if (state.stop || state.round >= MAX_ROUNDS || Date.now() >= state.deadlineAt) return END;
      return 'search';
    })
    .compile();
}

/** createOpenAiCompatibleLlm 的 drop-in 替代：只有 researchDesk 走图，其余原样委托。 */
export function createDeskAgentLlm(options: OpenAiCompatibleOptions): LlmClient {
  const base = createOpenAiCompatibleLlm(options);
  const deskTimeoutMs = options.deskTimeoutMs ?? DEFAULT_DESK_TIMEOUT_MS;
  const chat = createChat(options);
  const graph = createDeskAgentGraph(chat);

  return {
    ...base,
    async researchDesk(brief: DeskResearchBrief, signal?: AbortSignal): Promise<DeskNotes> {
      if (!options.webSearch) {
        return { trackId: brief.trackId, queries: brief.queries, notes: [] };
      }
      const state = await graph.invoke(
        { brief, queries: brief.queries, deadlineAt: Date.now() + deskTimeoutMs },
        { signal, recursionLimit: 12 },
      );
      console.log(
        `[desk-agent] ${brief.title}：${state.round} 轮搜索 / ${state.notes.length} 条笔记`,
      );
      return { trackId: brief.trackId, queries: brief.queries, notes: state.notes };
    },
  };
}
