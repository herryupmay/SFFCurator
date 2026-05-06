/**
 * Wikipedia synopsis enrichment.
 *
 * Pulls the article intro for a work from up to four Wikipedia editions
 * (en / zh / ja / ko). Free, stable, no auth — the MediaWiki REST surface
 * has been public for two decades.
 *
 * Resolution strategy (matters a lot for SFF works with translations):
 *
 *   1. Pick an "anchor" language: the first language in priority order
 *      (en > zh > ja > ko) for which the caller supplied a query string.
 *      The anchor is searched once, and we fetch its intro extract AND its
 *      `langlinks` (cross-language equivalents) in a single call. This
 *      flexibility matters because not every work has an English title
 *      in our pipeline — Books.com.tw imports usually only have the zh
 *      title, in which case anchoring on en forces a useless creator-name
 *      search instead of finding the actual book article.
 *
 *   2. The remaining languages are resolved via the anchor's langlinks.
 *      That's far more reliable than searching each edition independently:
 *      a bare zh search for "刺客學徒" can return the voice-actor page
 *      "森川智之" because he voiced an apprentice character; resolving
 *      via en→zh / zh→en langlinks gives us the right article with no
 *      ambiguity.
 *
 *   3. For any language with no langlink available, fall back to a
 *      per-language search guarded by `validators` — the candidate extract
 *      must mention at least one of the caller-supplied tokens (creator
 *      names, work titles) before we accept it. Without that guard the
 *      fallback path reintroduces the same false-positive class.
 *
 * Disambiguation pages are detected per-language and dropped — their
 * extracts read like "X may refer to: ..." / "X 可以指：..." and contribute
 * no synopsis value.
 */

import { politeFetch } from '../sources/http';

export type WikiLang = 'en' | 'zh' | 'ja' | 'ko';

const LANG_ORDER: WikiLang[] = ['en', 'zh', 'ja', 'ko'];

const WIKI_BASES: Record<WikiLang, string> = {
  en: 'https://en.wikipedia.org/w/api.php',
  zh: 'https://zh.wikipedia.org/w/api.php',
  ja: 'https://ja.wikipedia.org/w/api.php',
  ko: 'https://ko.wikipedia.org/w/api.php',
};

const WIKI_HOSTS: Record<WikiLang, string> = {
  en: 'en.wikipedia.org',
  zh: 'zh.wikipedia.org',
  ja: 'ja.wikipedia.org',
  ko: 'ko.wikipedia.org',
};

// Regex patterns that indicate a disambiguation page in each edition.
const DISAMBIG_PATTERNS: Record<WikiLang, RegExp> = {
  en: /may refer to:/i,
  zh: /可以指[::]/,
  // Japanese disambiguation pages contain "曖昧さ回避" in the boilerplate.
  ja: /曖昧さ回避/,
  // Korean disambiguation pages contain "동음이의" (homonym) in the header.
  ko: /동음이의/,
};

interface EnrichmentResult {
  /** The language of the extracted text. */
  lang: WikiLang;
  /** The article title that was extracted. */
  title: string;
  /** The plain-text intro paragraph(s). */
  text: string;
  /** Canonical article URL for citation. */
  url: string;
}

interface FetchedExtract {
  title: string;
  text: string;
  url: string;
  /** Cross-language equivalents harvested via prop=langlinks (anchor only). */
  langlinks?: Partial<Record<WikiLang, string>>;
}

async function searchTopTitle(
  langCode: WikiLang,
  query: string,
): Promise<string | null> {
  const apiBase = WIKI_BASES[langCode];
  const searchUrl =
    `${apiBase}?action=query&format=json&list=search` +
    `&srsearch=${encodeURIComponent(query)}` +
    `&srlimit=1&utf8=1&origin=*`;
  try {
    const res = await politeFetch(searchUrl, { hostDelayMs: 100 });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      query?: { search?: Array<{ title: string }> };
    };
    return data.query?.search?.[0]?.title ?? null;
  } catch {
    return null;
  }
}

async function fetchExtract(
  langCode: WikiLang,
  title: string,
  withLanglinks: boolean,
): Promise<FetchedExtract | null> {
  const apiBase = WIKI_BASES[langCode];
  const props = withLanglinks ? 'extracts|langlinks' : 'extracts';
  // lllimit=500 covers even heavily-translated articles. Without it we'd cap
  // at the API default (10) and could miss the zh/ja/ko entry on works
  // with many language editions.
  const llExtra = withLanglinks ? '&lllimit=500' : '';
  const extractUrl =
    `${apiBase}?action=query&format=json&prop=${props}&exintro=1&explaintext=1` +
    llExtra +
    `&redirects=1&titles=${encodeURIComponent(title)}&utf8=1&origin=*`;
  try {
    const res = await politeFetch(extractUrl, { hostDelayMs: 100 });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      query?: {
        pages?: Record<string, {
          title?: string;
          extract?: string;
          langlinks?: Array<{ lang: string; '*': string }>;
        }>;
      };
    };
    const page = Object.values(data.query?.pages ?? {})[0];
    const text = page?.extract?.trim();
    if (!text) return null;
    const finalTitle = page?.title ?? title;
    const slug = encodeURIComponent(finalTitle.replace(/ /g, '_'));
    const url = `https://${WIKI_HOSTS[langCode]}/wiki/${slug}`;

    let langlinks: FetchedExtract['langlinks'];
    if (withLanglinks && Array.isArray(page?.langlinks)) {
      langlinks = {};
      for (const ll of page!.langlinks!) {
        const l = ll.lang as WikiLang;
        if (l === 'en' || l === 'zh' || l === 'ja' || l === 'ko') {
          langlinks[l] = ll['*'];
        }
      }
    }
    return { title: finalTitle, text, url, langlinks };
  } catch {
    return null;
  }
}

/**
 * Validator guard for fallback search hits. Returns true if the extract
 * mentions at least one usable token from `validators`. Tokens shorter than
 * 2 chars are dropped (too noisy — a one-char common substring would
 * false-positive on almost any extract).
 *
 * If no usable validators are supplied, the guard is a no-op (returns true).
 */
function passesValidators(
  text: string,
  validators: string[] | undefined,
): boolean {
  if (!validators || validators.length === 0) return true;
  const usable = validators.filter(v => v && v.trim().length >= 2);
  if (usable.length === 0) return true;
  const lc = text.toLowerCase();
  return usable.some(v => lc.includes(v.toLowerCase()));
}

async function tryByQuery(
  langCode: WikiLang,
  query: string,
  validators: string[] | undefined,
): Promise<EnrichmentResult | null> {
  const title = await searchTopTitle(langCode, query);
  if (!title) return null;
  const r = await fetchExtract(langCode, title, false);
  if (!r) return null;
  if (DISAMBIG_PATTERNS[langCode].test(r.text)) return null;
  if (!passesValidators(r.text, validators)) return null;
  return { lang: langCode, title: r.title, text: r.text, url: r.url };
}

async function tryByExactTitle(
  langCode: WikiLang,
  title: string,
): Promise<EnrichmentResult | null> {
  const r = await fetchExtract(langCode, title, false);
  if (!r) return null;
  if (DISAMBIG_PATTERNS[langCode].test(r.text)) return null;
  return { lang: langCode, title: r.title, text: r.text, url: r.url };
}

/**
 * Try to fetch Wikipedia intros for a work in any combination of supported
 * editions. Returns whatever it found; failures (network, no article,
 * disambiguation, validator rejection) just produce nulls and are dropped.
 *
 * `validators` is the recommended way to harden the per-language fallback
 * path: pass the work's creator names and titles, and any zh/ja/ko hit that
 * mentions none of them is rejected as off-topic. The langlink-resolved
 * path is trusted without validation because it's already cross-referenced
 * by Wikipedia's interlanguage editors.
 */
export async function enrichFromWikipedia(opts: {
  enQuery?: string;
  zhQuery?: string;
  jaQuery?: string;
  koQuery?: string;
  validators?: string[];
}): Promise<EnrichmentResult[]> {
  const queries: Record<WikiLang, string | undefined> = {
    en: opts.enQuery,
    zh: opts.zhQuery,
    ja: opts.jaQuery,
    ko: opts.koQuery,
  };

  // Pick the anchor language: first language in priority order (en > zh >
  // ja > ko) for which we have a query. The anchor's langlinks resolve the
  // other editions. Anchoring flexibly matters because zh-only works
  // (typical for Books.com.tw imports) wouldn't get a useful en hit by
  // searching en wiki for the *creator* name — that returns the author bio.
  const anchorLang = LANG_ORDER.find(l => queries[l] && queries[l]!.trim());
  if (!anchorLang) return [];

  const out: EnrichmentResult[] = [];
  let langlinks: Partial<Record<WikiLang, string>> = {};

  // Step 1: anchor.
  const anchorTitle = await searchTopTitle(anchorLang, queries[anchorLang]!);
  if (anchorTitle) {
    const fetched = await fetchExtract(anchorLang, anchorTitle, true);
    if (
      fetched &&
      !DISAMBIG_PATTERNS[anchorLang].test(fetched.text) &&
      passesValidators(fetched.text, opts.validators)
    ) {
      out.push({
        lang: anchorLang,
        title: fetched.title,
        text: fetched.text,
        url: fetched.url,
      });
      if (fetched.langlinks) langlinks = fetched.langlinks;
    }
  }

  // Step 2: every non-anchor language. Prefer the anchor's langlink-resolved
  // title (highest confidence — Wikipedia's own interlanguage editors); fall
  // back to per-language search + validator guard only when no langlink
  // exists for that lang.
  const tasks: Array<Promise<EnrichmentResult | null>> = [];
  for (const lang of LANG_ORDER) {
    if (lang === anchorLang) continue;
    const langlinkTitle = langlinks[lang];
    const query = queries[lang];
    if (langlinkTitle) {
      tasks.push(tryByExactTitle(lang, langlinkTitle));
    } else if (query && query.trim()) {
      tasks.push(tryByQuery(lang, query, opts.validators));
    }
  }

  const settled = await Promise.allSettled(tasks);
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) out.push(r.value);
  }
  return out;
}

export type { EnrichmentResult };
