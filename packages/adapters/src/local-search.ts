/**
 * 案头本地检索：SearXNG 查询 → 抓正文 → 拼「网页材料」文本喂给模型提炼。
 *
 * 存在的理由：方舟 web_search 把搜索和阅读捆在贵 token 里，且来源不可回查。
 * 这里拆开：检索免费（本地 docker），阅读用普通 prompt token，材料带 URL 可溯源。
 *
 * 容错纪律与图一致：反爬墙（Cloudflare 质询站）在域名黑名单直接跳过，
 * 单页失败不影响其余结果——有几条算几条，全挂才抛（交给 search 节点的降级契约）。
 */
import type { DeskQuery } from '@mock-radio/core';

export interface LocalSearchOptions {
  /** SearXNG 实例地址，如 http://127.0.0.1:8888 */
  searxngUrl: string;
  /** 每条查询向 SearXNG 取几个候选（沿用 Google 一页 10 条惯例） */
  maxResults?: number;
  /** 单页抓取超时（ms） */
  fetchTimeoutMs?: number;
  /** 喂给模型的总字符预算——决定实际抓几页，不单独设页数 */
  maxMaterialChars?: number;
}

/** 一轮执行全部查询，返回拼好的「网页材料」文本；无可读结果时返回 null；检索全挂时抛错。 */
export type DeskSearcher = (
  queries: DeskQuery[],
  deadlineAt: number,
  signal?: AbortSignal,
) => Promise<string | null>;

/**
 * 已知反爬质询站（Cloudflare challenge / 简单封禁），抓了也是 403，省一轮超时。
 * 替代品实测可读：Steam 社区评测 200、bandcamp 200、Wikipedia 200、MusicBrainz 200。
 */
const UNFETCHABLE_HOSTS = new Set([
  'gamefaqs.gamespot.com',
  'rateyourmusic.com',
  'giantbomb.com',
  'old.reddit.com',
  'www.reddit.com',
  'reddit.com',
  'tvtropes.org',
]);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 粗 HTML → 纯文本：去 script/style/标签、解实体、压空白。喂模型够用，不追求排版。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 导航/页脚在纯文本里是连片短行（Steam 案例：前 2200 字符全是菜单）。丢短行、留正文长句。 */
export function keepProse(text: string, minLen = 40): string {
  return text
    .split('\n')
    .filter((line) => line.length >= minLen)
    .join('\n');
}

function fetchable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return !UNFETCHABLE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

type SearxResult = { title?: string; url?: string; content?: string };
type SearxInfobox = { infobox?: string; id?: string; content?: string };

/** SearXNG 已替我们抽好的词条正文（wikipedia 引擎只走这个通道，results 恒空）。 */
function infoboxPart(b: SearxInfobox): string | null {
  if (typeof b.id !== 'string' || !fetchable(b.id)) return null;
  const text = (b.content ?? '').trim().slice(0, PER_PAGE_CHARS);
  if (text.length < 80) return null;
  return `#### 词条：${b.infobox ?? ''}\nURL: ${b.id}\n${text}`;
}

/** 单页正文进材料的字符上限 */
const PER_PAGE_CHARS = 2_200;

/**
 * 抓几页不固定死（Google 式的分配思路）：候选池 = 每查询 10 条（一页惯例），
 * 抓取深度由总材料预算驱动——按名次轮转（各查询先抢第 1 名，再第 2 名……），
 * 预算/挂钟耗尽自然停。料厚的查询自动多分几页，料薄的自动少分。跨查询 URL 去重。
 */
export function createLocalDeskSearcher(options: LocalSearchOptions): DeskSearcher {
  const maxResults = options.maxResults ?? 10;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 8_000;
  const maxMaterialChars = options.maxMaterialChars ?? 20_000;

  return async function search(queries, deadlineAt, signal) {
    const remaining = () => deadlineAt - Date.now();
    if (remaining() <= 1_000) return null;

    // 1) SearXNG JSON API（本地实例，不开限流）
    const perQuery = await Promise.allSettled(
      queries.map(async (q): Promise<{ results: SearxResult[]; infoboxes: SearxInfobox[] }> => {
        const url = `${options.searxngUrl.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(q.q)}`;
        const res = await fetch(url, {
          signal: AbortSignal.any([
            signal ?? new AbortController().signal,
            AbortSignal.timeout(Math.min(fetchTimeoutMs, remaining())),
          ]),
          headers: { 'User-Agent': UA },
        });
        if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
        const data = (await res.json()) as {
          results?: SearxResult[];
          infoboxes?: SearxInfobox[];
        };
        return {
          results: (data.results ?? []).filter(
            (r) => typeof r.url === 'string' && fetchable(r.url),
          ),
          infoboxes: data.infoboxes ?? [],
        };
      }),
    );
    // 查询全挂（SearXNG 没起）→ 抛错走 search 节点的降级/上抛契约
    if (perQuery.length > 0 && perQuery.every((p) => p.status === 'rejected')) {
      const failed = perQuery.find((p) => p.status === 'rejected');
      throw failed?.status === 'rejected' ? failed.reason : new Error('SearXNG 无响应');
    }
    // 部分查询挂：挂的那路留结果空，日志不静默
    for (const p of perQuery)
      if (p.status === 'rejected') console.error('[local-search] 查询失败，跳过：', p.reason);

    // 2) 按名次轮转抓正文，预算/挂钟耗尽即停
    const pools = queries.map((q, i) => {
      const ok =
        perQuery[i]?.status === 'fulfilled'
          ? (
              perQuery[i] as PromiseFulfilledResult<{
                results: SearxResult[];
                infoboxes: SearxInfobox[];
              }>
            ).value
          : null;
      return {
        q,
        head: `### 查询 [${q.lane}] ${q.q}`,
        top: ok ? ok.results.slice(0, maxResults) : [],
        boxes: ok ? ok.infoboxes.slice(0, 2) : [],
        parts: [] as string[],
      };
    });
    const usable = pools.filter((p) => p.top.length > 0);
    const seen = new Set<string>();
    let used = 0;
    // 词条免抓取、信息密度最高：直接占本 lane 材料头部（每查询 ≤2 条，跨查询按 URL 去重）
    for (const p of pools) {
      for (const b of p.boxes) {
        const part = infoboxPart(b);
        if (!part || seen.has(b.id as string)) continue;
        seen.add(b.id as string);
        p.parts.push(part);
        used += part.length;
      }
    }
    const pageOf = async (r: SearxResult): Promise<string | null> => {
      const res = await fetch(r.url as string, {
        redirect: 'follow',
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(Math.min(fetchTimeoutMs, remaining())),
        ]),
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' },
      });
      if (!res.ok) return null;
      const text = keepProse(htmlToText(await res.text())).slice(0, PER_PAGE_CHARS);
      return text.length > 80 ? `#### 来源页：${r.title ?? ''}\nURL: ${r.url}\n${text}` : null;
    };
    for (let rank = 0; rank < maxResults && remaining() > 1_500; rank += 1) {
      // 先到先得：同轮多查询命中同 URL，只让第一家用（重复正文=白烧 token），后者下轮补位
      const picks: (typeof usable)[number][] = [];
      for (const p of usable) {
        const u = p.top[rank]?.url;
        if (!u || seen.has(u)) continue;
        seen.add(u);
        picks.push(p);
      }
      if (picks.length === 0) break;
      const got = await Promise.allSettled(picks.map((p) => pageOf(p.top[rank] as SearxResult)));
      let added = 0;
      for (let j = 0; j < picks.length; j += 1) {
        const g = got[j];
        const pick = picks[j];
        if (!pick) continue;
        if (g?.status === 'fulfilled' && g.value) {
          pick.parts.push(g.value);
          added += g.value.length;
        } else if (
          g?.status === 'rejected' &&
          (g.reason as Error)?.name === 'AbortError' &&
          signal?.aborted
        ) {
          throw g.reason;
        }
      }
      used += added;
      // 预算装不下下一轮（一页 + 节头 + 余量）就收工
      if (used + PER_PAGE_CHARS + 300 > maxMaterialChars) break;
    }

    // 3) 拼节：正文在前；没拿到正文的查询退摘要兜底
    const sections: string[] = [];
    let budget = maxMaterialChars;
    let any = false;
    for (const p of pools) {
      const parts = [...p.parts];
      if (parts.length === 0 && p.top.length > 0) {
        const snips = p.top
          .map((r) => `- ${r.title ?? ''}｜${r.content ?? ''}｜${r.url ?? ''}`)
          .join('\n');
        if (snips) parts.push(`#### 搜索摘要（正文未取回）\n${snips}`);
      }
      if (parts.length === 0 || budget <= 500) continue;
      const section = [p.head, ...parts].join('\n');
      sections.push(section.slice(0, budget));
      budget -= section.length;
      any = true;
    }
    return any ? sections.join('\n\n') : null;
  };
}
