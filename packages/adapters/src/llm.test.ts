import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiCompatibleLlm } from './llm';

afterEach(() => {
  vi.unstubAllGlobals();
});

type ChatBody = {
  response_format?: { type: string };
  web_search?: { enable: boolean };
  thinking?: { type: string };
  messages?: Array<{ role: string; content: string }>;
};

function stubChat(content: string): ChatBody[] {
  const calls: ChatBody[] = [];
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as ChatBody);
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content } }] };
      },
    };
  });
  return calls;
}

function llm() {
  return createOpenAiCompatibleLlm({
    baseUrl: 'https://example.test/api/v3',
    apiKey: 'k',
    model: 'm',
    webSearch: true,
  });
}

describe('createOpenAiCompatibleLlm', () => {
  it('generateSegment 开口关闭 web_search；纯文本当口播', async () => {
    const calls = stubChat('这段低音贴着地走，我插一句就走。');
    const draft = await llm().generateSegment({ system: 's', user: 'u' });
    expect(draft).toEqual({ text: '这段低音贴着地走，我插一句就走。', songRequest: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.web_search).toBeUndefined();
    expect(calls[0]?.thinking).toBeUndefined();
    expect(calls[0]?.response_format).toBeUndefined();
  });

  it('generateSegment 若模型仍包 JSON 则拆出 text', async () => {
    stubChat('{"text":"旋律自己已经说完了。","songRequest":null}');
    const draft = await llm().generateSegment({ system: 's', user: 'u' });
    expect(draft).toEqual({ text: '旋律自己已经说完了。', songRequest: null });
  });

  it('extractMemories 仍要 json_object，且关闭 web_search', async () => {
    const calls = stubChat('{"memories":[]}');
    const memories = await llm().extractMemories('一段口播');
    expect(memories).toEqual([]);
    expect(calls[0]?.response_format).toEqual({ type: 'json_object' });
    expect(calls[0]?.web_search).toBeUndefined();
  });

  it('generateSegment 外部 abort 时立刻失败且不重试', async () => {
    let fetches = 0;
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      fetches += 1;
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener('abort', onAbort);
      });
    });
    const ac = new AbortController();
    const pending = llm().generateSegment({ system: 's', user: 'u' }, ac.signal);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetches).toBe(1);
  });

  it('researchDesk 开 web_search 并解析笔记', async () => {
    const calls = stubChat('{"notes":[{"lane":"community","text":"Steam 有人挂标题画面一整晚"}]}');
    const notes = await llm().researchDesk!({
      trackId: 't1',
      title: 'Showtime!',
      artist: 'VA-11 HALL-A',
      styles: ['game-bgm'],
      queries: [
        { lane: 'work', q: 'q1' },
        { lane: 'community', q: 'q2' },
        { lane: 'music', q: 'q3' },
      ],
    });
    expect(notes.notes).toEqual([{ lane: 'community', text: 'Steam 有人挂标题画面一整晚' }]);
    expect(calls[0]?.web_search).toEqual({ enable: true });
    expect(calls[0]?.thinking).toEqual({ type: 'disabled' });
    expect(calls[0]?.messages?.[0]?.content).toContain('q2');
  });

  it('webSearch 关闭时 researchDesk 不发请求', async () => {
    const calls = stubChat('should not run');
    const client = createOpenAiCompatibleLlm({
      baseUrl: 'https://example.test/api/v3',
      apiKey: 'k',
      model: 'm',
      webSearch: false,
    });
    const notes = await client.researchDesk!({
      trackId: 't1',
      title: 'Showtime!',
      artist: null,
      styles: [],
      queries: [],
    });
    expect(notes.notes).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
