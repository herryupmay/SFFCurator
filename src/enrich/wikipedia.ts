/**
 * Wikipedia synopsis enrichment.
 *
 * Pulls the article intro for a work from English Wikipedia (and zh Wikipedia
 * when the work has a zh title). Free, stable, no auth - the MediaWiki API
 * has been a public REST surface for two decades.
 *
 * Two-step strategy per language:
 *   1. action=query + list=search to find the most relevant article.
 *   2. action=query + prop=extracts&exintro to get the article's intro
 *      paragraph as plain text.
 *
 * For SFF works Wikipedia typically has plot, themes, and reception
 * sections; the intro paragraph distills all of that into 100-300 words.
 * That's ideal grounding for a Chinese-language curation intro.
 */

import { politeFetch } from '../sources/http';

const EN_BASE = 'https://en.wikipedia.org/w/api.php';
const ZH_BASE = 'https://zh.wikipedia.org/w/api.php';

interface EnrichmentResult {
  /** The language of the extracted text. */
  lang: 'en' | 'zh';
  /** The article title that was extracted. */
  title: string;
  /** The plain-text intro paragraph(s). */
  text: string;
  /** Canonical article URL for citation. */
  url: string;
}

async function fetchOne(
  apiBase: string,
  query: string,
  langCode: 'en' | 'zh',
): Promise<EnrichmentResult | null> {
  // 1) Search for the best matching article.
  const searchUrl =
    `${apiBase}?action=query&format=json&list=search` +
    `&srsearch=${encodeURIComponent(query)}` +
    `&srlimit=1&utf8=1&origin=*`;
  const searchRes = await politeFetch(searchUrl, { hostDelayMs: 100 });
  if (!searchRes.ok) return null;
  const searchData = (await searchRes.json()) as {
    query?: { search?: Array<{ title: string }> };
  };
  const top = searchData.query?.search?.[0];
  if (!top?.title) return null;

  // 2) Pull the intro extract for that exact article.
  const extractUrl =
    `${apiBase}?action=query&format=json&prop=extracts&exintro=1&explaintext=1` +
    `&redirects=1&titles=${encodeURIComponent(top.title)}&utf8=1&origin=*`;
  const extractRes = await politeFetch(extractUrl, { hostDelayMs: 100 });
  if (!extractRes.ok) return null;
  const extractData = (await extractRes.json()) as {
    query?: { pages?: Record<string, { title: string; extract?: string }> };
  };
  const pages = extractData.query?.pages ?? {};
  const page = Object.values(pages)[0];
  const text = page?.extract?.trim();
  if (!text) return null;
  // Wikipedia disambiguation pages produce thin extracts that look like
  // "X may refer to:". Skip those - they aren't useful as synopsis.
  if (/may refer to:/.test(text) || /可以指[::]/.test(text)) return null;

  const slug = encodeURIComponent(top.title.replace(/ /g, '_'));
  const url =
    langCode === 'en'
      ? `https://en.wikipedia.org/wiki/${slug}`
      : `https://zh.wikipedia.org/wiki/${slug}`;
  return { lang: langCode, title: top.title, text, url };
}

/**
 * Try to fetch en + zh Wikipedia intros for a work. Returns whatever it
 * found; failures (network, no article, disambiguation) just produce nulls.
 */
export async function enrichFromWikipedia(opts: {
  enQuery?: string;
  zhQuery?: string;
}): Promise<EnrichmentResult[]> {
  const tasks: Array<Promise<EnrichmentResult | null>> = [];
  if (opts.enQuery) tasks.push(fetchOne(EN_BASE, opts.enQuery, 'en'));
  if (opts.zhQuery) tasks.push(fetchOne(ZH_BASE, opts.zhQuery, 'zh'));
  const settled = await Promise.allSettled(tasks);
  const out: EnrichmentResult[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) out.push(r.value);
  }
  return out;
}

export type { EnrichmentResult };
