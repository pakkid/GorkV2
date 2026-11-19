import { web as cfg } from './config';
import { env } from './env';
import { untrusted } from './history';
import { logger } from './log';

const log = logger('web-search');

/** Whether gork can search the web at all (needs an Exa key, like the original gork). */
export const canSearchWeb = !!env.EXA_API_KEY;

interface ExaResult {
  title?: string | null;
  url: string;
  publishedDate?: string | null;
  text?: string;
  highlights?: string[];
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Search the web with Exa and format the hits for the prompt. Never throws. */
export async function searchWeb(query: string): Promise<string> {
  if (!env.EXA_API_KEY) return 'web search is turned off';
  try {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.EXA_API_KEY },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: cfg.results,
        // highlights are the bits of each page that answer the query. the start of a page's
        // text (what gork used to get) is mostly menus, cookie banners and headlines,
        // so the actual answer was usually cut off. a little text is the fallback
        contents: {
          highlights: { query, maxCharacters: cfg.charsPerResult },
          text: { maxCharacters: 400 },
        },
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { results?: ExaResult[] };
    const results = data.results ?? [];
    if (!results.length) return `no results for "${query}"`;
    return results
      .map((r) => {
        const date = r.publishedDate ? ` (published ${r.publishedDate.slice(0, 10)})` : '';
        const highlights = (r.highlights ?? []).map(flat).filter(Boolean).join(' … ');
        const body = clip(highlights || flat(r.text ?? ''), cfg.charsPerResult);
        return untrusted(`- ${flat(r.title || r.url)}${date} ${r.url}\n  ${body}`);
      })
      .join('\n');
  } catch (error) {
    log.warn(`search for "${query}" failed`, error);
    return `search for "${query}" failed`;
  }
}
