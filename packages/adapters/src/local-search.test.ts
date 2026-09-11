/**
 * 全 stub fetch，不打真实网络；假时钟只在预算测试用 Date.now spy（禁真 timer 规矩）。
 */

import type { DeskQuery } from '@mock-radio/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalDeskSearcher, htmlToText, keepProse } from './local-search';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const QUERIES: DeskQuery[] = [
  { lane: 'work', q: 'Showtime VA-11 场景' },
  { lane: 'community', q: 'Showtime 玩家 原话' },
  { lane: 'music', q: 'Showtime 编曲 乐器' },
];

const FAR = () => Date.now() + 60_000;

const PAGE = (marker: string) =>
  `<html><head><style>.x{color:red}</style><script>evil()</script></head>
<body><h1>Home</h1><h2>Store</h2><p>${marker}: Jill said &quot;keep it up&quot; &amp; more&nbsp;text ${'filler '.repeat(80)}</p></body></html>`;

type Stub = { match: string | RegExp; json?: unknown; text?: string; status?: number };

/** fetch 桩：按 URL 匹配路由（SearXNG JSON vs 页面正文），记录调用序。 */
function stubFetch(stubs: Stub[]) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    for (const s of stubs) {
      const hit = typeof s.match === 'string' ? url.startsWith(s.match) : s.match.test(url);
      if (!hit) continue;
      if (s.status && s.status !== 200)
        return {
          ok: false,
          status: s.status,
          async text() {
            return '';
          },
        };
      return {
        ok: true,
        status: 200,
        async json() {
          return s.json;
        },
        async text() {
          return s.text ?? '';
        },
      };
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  return urls;
}

const searxOk = (q: string, results: object[]) => ({
  match: `http://sx.test/search?format=json&q=${encodeURIComponent(q)}`,
  json: { results },
});

const r = (url: string, title = 'T', content = '摘要') => ({ url, title, content });

describe('htmlToText / keepProse', () => {
  it('去 script/style/标签，解实体，压空白', () => {
    const out = htmlToText(PAGE('A'));
    expect(out).not.toContain('evil');
    expect(out).not.toContain('color:red');
    expect(out).toContain('Jill said "keep it up" & more text');
    expect(out).not.toMatch(/\n\n/);
  });
  it('keepProse 丢导航短行、留正文长句', () => {
    const out = keepProse(htmlToText(PAGE('A')));
    expect(out).not.toContain('Home');
    expect(out).toContain('Jill said');
  });
});

describe('createLocalDeskSearcher', () => {
  it('正常路：三路并发查询，各抓正文，材料带来源 URL 且按 lane 分节', async () => {
    const urls = stubFetch([
      searxOk('Showtime VA-11 场景', [r('https://a.test/p1')]),
      searxOk('Showtime 玩家 原话', [r('https://b.test/p2')]),
      searxOk('Showtime 编曲 乐器', [r('https://c.test/p3')]),
      { match: 'https://a.test/p1', text: PAGE('A') },
      { match: 'https://b.test/p2', text: PAGE('B') },
      { match: 'https://c.test/p3', text: PAGE('C') },
    ]);
    const material = await createLocalDeskSearcher({ searxngUrl: 'http://sx.test/' })(
      QUERIES,
      FAR(),
    );
    expect(urls.filter((u) => u.startsWith('http://sx.test/search'))).toHaveLength(3);
    expect(material).toContain('### 查询 [work]');
    expect(material).toContain('### 查询 [music]');
    expect(material).toContain('URL: https://a.test/p1');
    expect(material).toContain('A: Jill said');
    // 导航短行不进材料，正文长句进
    expect(material).not.toContain('Home');
  });

  it('抓取深度自适应：好 lane 抓到第 2 名；跨 lane 重复 URL 只抓一次；缺席 lane 不占额度', async () => {
    const urls = stubFetch([
      searxOk('Showtime VA-11 场景', [r('https://a.test/p1'), r('https://a.test/p2')]),
      searxOk('Showtime 玩家 原话', [r('https://a.test/p1'), r('https://b.test/p1')]),
      searxOk('Showtime 编曲 乐器', [r('https://c.test/p1')]),
      { match: 'https://a.test/p1', text: PAGE('A1') },
      { match: 'https://a.test/p2', text: PAGE('A2') },
      { match: 'https://b.test/p1', text: PAGE('B1') },
      { match: 'https://c.test/p1', text: PAGE('C1') },
    ]);
    const material = await createLocalDeskSearcher({ searxngUrl: 'http://sx.test' })(
      QUERIES,
      FAR(),
    );
    // 去重：a/p1 被两条查询命中，只发一次页面请求
    expect(urls.filter((u) => u === 'https://a.test/p1')).toHaveLength(1);
    // 轮转：work 拿到第 2 名页；community 第 1 名是重复 URL→本轮缺席、第 2 名补上
    expect(material).toContain('URL: https://a.test/p2');
    expect(material).toContain('URL: https://b.test/p1');
    expect(material).toContain('URL: https://c.test/p1');
    const work = material?.split('### 查询')[1] ?? '';
    expect((work.match(/#### 来源页/g) ?? []).length).toBe(2);
  });

  it('黑名单域跳过：GameFAQs 结果不进抓取候选，落到下一条可读源', async () => {
    const urls = stubFetch([
      searxOk('Showtime VA-11 场景', [
        r('https://gamefaqs.gamespot.com/pc/194742'),
        r('https://a.test/p1'),
      ]),
      searxOk('Showtime 玩家 原话', []),
      searxOk('Showtime 编曲 乐器', []),
      { match: 'https://a.test/p1', text: PAGE('A') },
    ]);
    const material = await createLocalDeskSearcher({ searxngUrl: 'http://sx.test' })(
      QUERIES,
      FAR(),
    );
    expect(urls.some((u) => u.includes('gamefaqs'))).toBe(false);
    expect(urls.some((u) => u.startsWith('https://a.test/p1'))).toBe(true);
    expect(material).toContain('URL: https://a.test/p1');
  });

  it('正文抓取失败 → 退搜索摘要兜底，材料仍含 URL 可溯源', async () => {
    stubFetch([
      searxOk('Showtime VA-11 场景', [
        r('https://a.test/p1', '页面标题', '玩家说标题画面能挂一晚'),
      ]),
      searxOk('Showtime 玩家 原话', []),
      searxOk('Showtime 编曲 乐器', []),
      { match: 'https://a.test/p1', status: 403 },
    ]);
    const material = await createLocalDeskSearcher({ searxngUrl: 'http://sx.test' })(
      QUERIES,
      FAR(),
    );
    expect(material).toContain('搜索摘要（正文未取回）');
    expect(material).toContain('玩家说标题画面能挂一晚');
    expect(material).toContain('https://a.test/p1');
  });

  it('全部查询失败 → 抛错（SearXNG 没起 = 交 search 节点上抛）', async () => {
    stubFetch([{ match: 'http://sx.test/search', status: 500 }]);
    await expect(
      createLocalDeskSearcher({ searxngUrl: 'http://sx.test' })(QUERIES, FAR()),
    ).rejects.toThrow();
  });

  it('部分查询失败 → 不炸，好的那几路照常出材料', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch([
      { match: 'http://sx.test/search?format=json&q=Showtime%20VA-11', status: 500 },
      searxOk('Showtime 玩家 原话', [r('https://b.test/p2')]),
      searxOk('Showtime 编曲 乐器', [r('https://c.test/p3')]),
      { match: 'https://b.test/p2', text: PAGE('B') },
      { match: 'https://c.test/p3', text: PAGE('C') },
    ]);
    const material = await createLocalDeskSearcher({ searxngUrl: 'http://sx.test' })(
      QUERIES,
      FAR(),
    );
    expect(material).toContain('### 查询 [community]');
    expect(material).toContain('### 查询 [music]');
    expect(material).not.toContain('### 查询 [work]');
    expect(errSpy).toHaveBeenCalled();
  });

  it('挂钟不足 1 秒 → 直接 null，一个请求都不发', async () => {
    const urls = stubFetch([]);
    const material = await createLocalDeskSearcher({ searxngUrl: 'http://sx.test' })(
      QUERIES,
      Date.now() + 500,
    );
    expect(material).toBeNull();
    expect(urls).toHaveLength(0);
  });

  it('总预算截断：maxMaterialChars 之后的查询节不再拼入', async () => {
    stubFetch([
      searxOk('Showtime VA-11 场景', [r('https://a.test/p1')]),
      searxOk('Showtime 玩家 原话', [r('https://b.test/p2')]),
      searxOk('Showtime 编曲 乐器', [r('https://c.test/p3')]),
      { match: 'https://a.test/p1', text: PAGE('A') },
      { match: 'https://b.test/p2', text: PAGE('B') },
      { match: 'https://c.test/p3', text: PAGE('C') },
    ]);
    const material = await createLocalDeskSearcher({
      searxngUrl: 'http://sx.test',
      maxMaterialChars: 1200,
    })(QUERIES, FAR());
    expect(material).toContain('### 查询 [work]');
    expect(material).not.toContain('### 查询 [music]');
  });
});
