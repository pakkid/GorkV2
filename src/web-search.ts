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
        contents: { text: { maxCharacters: cfg.charsPerResult } },
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { results?: ExaResult[] };
    const results = data.results ?? [];
    if (!results.length) return `no results for "${query}"`;
    return results
      .map((r) => {
        const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : '';
        const text = (r.text ?? '').replace(/\s+/g, ' ').trim();
        return untrusted(`- ${r.title ?? r.url}${date} ${r.url}\n  ${text}`);
      })
      .join('\n');
  } catch (error) {
    log.warn(`search for "${query}" failed`, error);
    return `search for "${query}" failed`;
  }
}
