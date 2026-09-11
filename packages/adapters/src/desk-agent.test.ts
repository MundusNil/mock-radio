import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeskAgentGraph, createDeskAgentLlm } from './desk-agent';
import { createChat } from './llm';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type ChatBody = {
  response_format?: { type: string };
  web_search?: { enable: boolean };
  thinking?: { type: string };
  messages?: Array<{ role: string; content: string }>;
};

type Scripted = { content: string; bumpMs?: number } | { error: Error };

/**
 * 按调用顺序吐响应的 fetch 桩。bumpMs 走假时钟（Date.now 被 mock 时用），
 * 绝不用真实 sleep 制造超时——挂钟语义测试必须确定性。
 */
function stubScript(script: Scripted[]) {
  const calls: ChatBody[] = [];
  let n = 0;
  let clockBump = 0;
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as ChatBody);
    const step = script[Math.min(n, script.length - 1)];
    n += 1;
    if ('error' in step) throw step.error;
    if (step.bumpMs && clockBump === 0) {
      clockBump = step.bumpMs;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: step.content } }] };
      },
    };
  });
  return {
    calls,
    /** 配合 vi.spyOn(Date,'now') 的假时钟偏移 */
    get offsetMs() {
      return clockBump;
    },
  };
}

const brief = {
  trackId: 't1',
  title: 'Showtime!',
  artist: 'VA-11 HALL-A',
  styles: ['game-bgm'],
  queries: [
    { lane: 'work' as const, q: 'Showtime! VA-11 HALL-A 这首歌出现在哪个场景 关卡 剧情' },
    { lane: 'community' as const, q: '玩家评价 Showtime! VA-11 HALL-A 这首歌 原话' },
    { lane: 'music' as const, q: 'Showtime! VA-11 HALL-A 编曲 乐器 具体评论' },
  ],
};

const NOTE_WORK = { lane: 'work', text: '开场调酒教学关卡，Jill 在吧台边教调酒' };
const NOTE_MUSIC = { lane: 'music', text: '萨克斯贴地走线，鼓点是二拍律动' };
const NOTE_COMMUNITY = { lane: 'community', text: 'Steam 评测原话：标题画面能挂一晚' };

const searchJson = (notes: object[]) => JSON.stringify({ notes });
const evalJson = (sufficient: boolean, queries: object[] = []) =>
  JSON.stringify({ sufficient, queries });

const baseOpts = {
  baseUrl: 'https://example.test/api/v3',
  apiKey: 'k',
  model: 'm',
  webSearch: true,
};

describe('desk-agent 图', () => {
  it('首轮笔记带名字 → 质检判充分，1 搜 1 评即停', async () => {
    const { calls } = stubScript([
      { content: searchJson([NOTE_WORK, NOTE_MUSIC]) },
      { content: evalJson(true) },
    ]);
    const notes = await createDeskAgentLlm(baseOpts).researchDesk!(brief);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.web_search).toEqual({ enable: true });
    expect(calls[0]?.thinking).toEqual({ type: 'disabled' });
    expect(calls[1]?.web_search).toBeUndefined();
    expect(notes.notes).toEqual([NOTE_WORK, NOTE_MUSIC]);
    expect(notes.trackId).toBe('t1');
    expect(notes.queries).toEqual(brief.queries); // 出口仍报原始三路
  });

  it('首轮无具体名字 → 按质检给的查询补搜一轮', async () => {
    const { calls } = stubScript([
      { content: searchJson([NOTE_MUSIC]) },
      { content: evalJson(false, [{ lane: 'community', q: 'VA-11 Showtime 玩家 原话 评价' }]) },
      { content: searchJson([NOTE_COMMUNITY]) },
      { content: evalJson(true) },
    ]);
    const notes = await createDeskAgentLlm(baseOpts).researchDesk!(brief);
    expect(calls.filter((c) => c.web_search)).toHaveLength(2); // 2 搜 + 2 评
    // 补搜请求的提示词里必须是质检的查询，不是原始三路
    expect(calls[2]?.messages?.[0]?.content).toContain('VA-11 Showtime 玩家 原话 评价');
    expect(notes.notes).toEqual([NOTE_MUSIC, NOTE_COMMUNITY]);
  });

  it('质检永远判不足 → 3 轮硬停，不无限环', async () => {
    const refine = { lane: 'work', q: 'Showtime 关卡 Jill 剧情细节' };
    const { calls } = stubScript([
      { content: searchJson([NOTE_MUSIC]) },
      { content: evalJson(false, [refine]) },
      { content: searchJson([NOTE_WORK]) },
      { content: evalJson(false, [refine]) },
      { content: searchJson([NOTE_COMMUNITY]) },
      { content: evalJson(false, [refine]) },
    ]);
    const notes = await createDeskAgentLlm(baseOpts).researchDesk!(brief);
    expect(calls.filter((c) => c.web_search)).toHaveLength(3);
    // 第 3 轮合并后总数触顶 3 → evaluate 提前收口
    expect(notes.notes).toHaveLength(3);
  });

  it('挂钟过期 → 不再补搜（轮数没到也停）', async () => {
    // 假时钟：首搜「耗时」100ms，越过 50ms 整图预算
    let fakeNow = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    const { calls } = stubScript([
      {
        content: searchJson([NOTE_MUSIC]),
        get bumpMs() {
          fakeNow += 100;
          return 100;
        },
      },
      { content: evalJson(false, [{ lane: 'work', q: '再查 Jill 具体场景' }]) },
      { content: searchJson([NOTE_WORK]) },
      { content: evalJson(true) },
    ]);
    const notes = await createDeskAgentLlm({ ...baseOpts, deskTimeoutMs: 50 }).researchDesk!(brief);
    expect(calls.filter((c) => c.web_search)).toHaveLength(1);
    expect(notes.notes).toEqual([NOTE_MUSIC]); // 半程笔记照常出口
  });

  it('切歌 abort → 取消抵达在途 fetch，promise 失败上抛', async () => {
    const controller = new AbortController();
    let fetchEntered!: () => void;
    const entered = new Promise<void>((r) => (fetchEntered = r));
    let sawSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined;
      fetchEntered();
      // 永不自行 resolve：只有 abort 才有结局，测试据此证明取消真的掐到了 fetch 层
      return new Promise((_res, rej) => {
        const abort = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort);
      });
    });
    const pending = createDeskAgentLlm(baseOpts).researchDesk!(brief, controller.signal);
    const failure = pending.catch((e: unknown) => e as Error);
    await entered; // 等真实进入 fetch，不猜时长
    expect(sawSignal).toBeDefined();
    expect(sawSignal?.aborted).toBe(false);
    controller.abort();
    const err = await failure;
    // producer 靠 name==='AbortError' 区分「静默切歌」与 onError——名字必须是契约的一部分
    expect(err.name).toBe('AbortError');
  });

  it('质检节点自己炸了 → 不拦出口：已有笔记照常 resolve，不再发请求', async () => {
    const { calls } = stubScript([
      { content: searchJson([NOTE_WORK]) },
      { error: new Error('LLM HTTP 500') }, // evaluate 的 chat 调用炸（非 abort）
    ]);
    const notes = await createDeskAgentLlm(baseOpts).researchDesk!(brief);
    expect(notes.notes).toEqual([NOTE_WORK]);
    expect(calls).toHaveLength(2); // 质检失败后没有第三次请求
  });

  it('补搜节点炸了 → 已有笔记降级出口；首轮全挂 → 照旧上抛', async () => {
    const { calls } = stubScript([
      { content: searchJson([NOTE_WORK]) },
      { content: evalJson(false, [{ lane: 'music', q: 'Showtime 编曲 乐器 分析' }]) },
      { error: new Error('LLM HTTP 500') },
    ]);
    const notes = await createDeskAgentLlm(baseOpts).researchDesk!(brief);
    expect(notes.notes).toEqual([NOTE_WORK]);
    expect(calls.filter((c) => c.web_search)).toHaveLength(2); // 炸的那次不再续环

    stubScript([{ error: new Error('LLM HTTP 500') }]);
    await expect(createDeskAgentLlm(baseOpts).researchDesk!(brief)).rejects.toThrow('HTTP 500');
  });

  it('lane 去重与每 lane ≤2 / 总 ≤3（跨轮合并语义）', async () => {
    stubScript([
      {
        content: searchJson([
          { lane: 'work', text: '第一关标题画面循环' },
          { lane: 'work', text: '酒吧后厨储物间' },
          { lane: 'work', text: '第三条同 lane 该丢' },
        ]),
      },
      { content: evalJson(false, [{ lane: 'work', q: 'Jill 调酒教学 场景细节' }]) },
      {
        content: searchJson([
          { lane: 'work', text: '第一关标题画面循环' }, // 与上轮重复
          { lane: 'community', text: 'Steam 有人挂标题画面一整晚' },
        ]),
      },
      { content: evalJson(true) },
    ]);
    const notes = await createDeskAgentLlm(baseOpts).researchDesk!(brief);
    expect(notes.notes.filter((n) => n.lane === 'work')).toHaveLength(2);
    expect(notes.notes).toHaveLength(3);
  });

  it('webSearch 关闭 → 零请求空笔记（与旧实现同契约）', async () => {
    const { calls } = stubScript([{ content: 'should not run' }]);
    const client = createDeskAgentLlm({ ...baseOpts, webSearch: false });
    const notes = await client.researchDesk!(brief);
    expect(calls).toHaveLength(0);
    expect(notes.notes).toEqual([]);
  });

  it('generateSegment 仍原样委托（除 researchDesk 外行为不变）', async () => {
    const { calls } = stubScript([{ content: '这段低音贴着地走，我插一句就走。' }]);
    const draft = await createDeskAgentLlm(baseOpts).generateSegment({ system: 's', user: 'u' });
    expect(draft.text).toBe('这段低音贴着地走，我插一句就走。');
    expect(calls[0]?.web_search).toBeUndefined();
  });
});

describe('图结构（裸节点级）', () => {
  it('search 节点：预算已尽即 stop，不发请求', async () => {
    const { calls } = stubScript([{ content: searchJson([]) }]);
    const chat = createChat(baseOpts);
    const graph = createDeskAgentGraph(chat);
    const state = await graph.invoke({
      brief,
      queries: brief.queries,
      deadlineAt: Date.now() - 1,
    });
    expect(calls).toHaveLength(0);
    expect(state.stop).toBe(true);
  });
});
