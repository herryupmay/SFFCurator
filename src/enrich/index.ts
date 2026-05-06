/**
 * Synopsis enrichment orchestrator.
 *
 * Called by /api/writeup before invoking the LLM. Pulls additional plot /
 * reception material from outside sources so the LLM has more than thin
 * adapter metadata to work with - especially important for works no one
 * on the team has read yet, which is the bulk of the curation backlog.
 *
 * Pipeline (all stages best-effort; each can fail independently):
 *
 *   STEP 0 — LLM title resolution (only when llmConfig is supplied):
 *     Books.com.tw / Readmoo records arrive with only a noisy zh title
 *     ("刺客正傳1刺客學徒(經典紀念版)") and no English title at all. The
 *     resolver asks the LLM for the canonical English form ("Assassin's
 *     Apprentice") plus a cleaned zh form, so the rest of the pipeline
 *     can hit Reddit (English-only) and the right Wikipedia anchor.
 *
 *   STEP 1 — Sources:
 *     SYNOPSIS material (Wikipedia, en/zh/ja/ko):
 *       - Encyclopedic plot, themes, publication facts.
 *       - Used to ground paragraphs 1-3 of the writeup (background + story).
 *       - For non-Latin originals, ja/ko Wikipedia is also the best place
 *         to find the proper Chinese-character names of characters /
 *         places — the LLM tends to fabricate transliterations otherwise.
 *
 *     RECEPTION material (Reddit + Plurk):
 *       - Reader reactions, comparisons, vibes.
 *       - Used ONLY for the final "what people think" paragraph. We do not
 *         blend reader takes into the plot summary — fan speculation
 *         contaminates the LLM's grounded-facts pool and the writeup
 *         starts asserting opinions as plot.
 *       - Reddit search ALWAYS uses the (resolved) English title because
 *         English-language SFF subs are where the discussion actually
 *         lives; a zh-only query returns essentially nothing.
 *
 * Failures are non-fatal at every step; we still return whatever survived.
 * Total time is bounded by the slowest source (Wikipedia + Reddit + Plurk
 * all run in parallel after the title resolver).
 */

import type { Work, Creator } from '../types';
import { enrichFromWikipedia, type EnrichmentResult } from './wikipedia';
import { enrichFromReddit, type RedditEnrichment } from './reddit';
import { enrichFromPlurk, type PlurkEnrichment } from './plurk';
import { resolveTitles, type ResolvedTitles } from './title-resolve';
import {
  fetchBooksTwProduct,
  extractBooksTwItemId,
  type BooksTwProductDetails,
} from '../sources/books_tw';
import type { LLMConfig } from '../llm/client';

export interface EnrichmentReport {
  wikipedia: EnrichmentResult[];
  reddit: RedditEnrichment[];
  plurk: PlurkEnrichment[];
  /** Whatever the LLM-driven title resolver returned (null if it didn't run). */
  resolved?: ResolvedTitles | null;
}

/**
 * Reader-reaction material drawn from English (Reddit) and Taiwanese (Plurk)
 * communities. The writeup function consumes this separately from the
 * Work's synopsis field — see writeup.ts for prompt wiring.
 */
export interface ReceptionMaterial {
  reddit: RedditEnrichment[];
  plurk: PlurkEnrichment[];
}

/**
 * Strip trailing publisher/edition noise before sending a title to the
 * Wikipedia search API. Covers common Books.com.tw / Readmoo decorations
 * like "(經典紀念版)", "(完整版)", "(2nd ed)", "(豪華版)" — these almost
 * never appear in Wikipedia article titles and just dilute search ranking.
 *
 * The cleanup is conservative: only the trailing parenthetical group is
 * removed, and only when something else remains. We never collapse to an
 * empty string.
 */
export function cleanWikiQuery(s: string | undefined | null): string | undefined {
  if (typeof s !== 'string') return undefined;
  let cleaned = s.trim();
  for (let i = 0; i < 2; i++) {
    const next = cleaned.replace(/[（(][^)）]*[)）]\s*$/, '').trim();
    if (next === cleaned) break;
    if (!next) break; // never collapse to empty
    cleaned = next;
  }
  return cleaned || undefined;
}

/**
 * Decide which Wikipedia editions are worth querying for this work.
 *
 *   - en/zh: only when the work has a corresponding TITLE. We deliberately
 *     do NOT fall back to the creator's name as a search query — that
 *     returns the author's biography page rather than the work's article.
 *   - ja: only when the original title contains kana, OR the original is
 *     kanji-only and the medium is manga/anime (likely Japanese).
 *   - ko: only when the original title contains hangul.
 *
 * Title strings are run through cleanWikiQuery() to drop publisher/edition
 * suffixes that the catalog adapters preserve verbatim.
 */
function decideWikiQueries(work: Work): {
  enQuery?: string;
  zhQuery?: string;
  jaQuery?: string;
  koQuery?: string;
} {
  const enQuery = cleanWikiQuery(work.titles.en);
  const zhQuery = cleanWikiQuery(work.titles.zh);

  let jaQuery: string | undefined;
  let koQuery: string | undefined;
  const original = work.titles.original?.trim();
  if (original) {
    if (/\p{Script=Hangul}/u.test(original)) {
      koQuery = cleanWikiQuery(original);
    } else if (/[぀-ゟ゠-ヿ]/.test(original)) {
      jaQuery = cleanWikiQuery(original);
    } else if (/\p{Script=Han}/u.test(original)) {
      if (work.medium === 'manga' || work.medium === 'anime') {
        jaQuery = cleanWikiQuery(original);
      }
    }
  }

  return { enQuery, zhQuery, jaQuery, koQuery };
}

/**
 * Apply the LLM resolver's output to the work record. Only fields the LLM
 * was confident about (and that we don't already have a value for) are
 * used. We never *overwrite* a non-empty source-supplied title — the
 * adapter's title is closer to ground truth than an LLM guess for that
 * specific field.
 *
 * Low-confidence resolutions are ignored entirely.
 */
function applyResolvedTitles(work: Work, resolved: ResolvedTitles | null): Work {
  if (!resolved) return work;
  if (resolved.confidence === 'low') return work;

  const titles = { ...work.titles };

  // en/original: only fill when missing. The adapter's value, when
  // present, is closer to ground truth than an LLM guess.
  if (!titles.en && resolved.english_title) titles.en = resolved.english_title;
  if (!titles.original && resolved.original_title) titles.original = resolved.original_title;

  // zh: ONLY use the LLM's chinese_title to noise-strip an existing zh
  // title. Never use it to *generate* a zh title that the source didn't
  // supply — Taiwanese publishers pick their own transliterations and the
  // LLM cannot derive those reliably (羅蘋·荷布 / 伊莉莎白．波頓．崔維尼奧
  // are not phonetically guessable from "Robin Hobb" / "Elizabeth Borton
  // de Treviño"). We only swap when the resolver's value is a strict
  // substring of the source value, which signals "this is the same title
  // with publisher noise removed", e.g.:
  //   "刺客正傳1刺客學徒(經典紀念版)" + parens → "刺客學徒"  ✓ accept
  //   ""              + LLM "畫家的祕密學徒"                  ✗ reject
  //   "X Y Z"         + LLM "完全不一樣"                      ✗ reject
  if (
    resolved.chinese_title &&
    titles.zh &&
    /[（(]/.test(titles.zh) &&
    titles.zh.includes(resolved.chinese_title)
  ) {
    titles.zh = resolved.chinese_title;
  }

  return { ...work, titles };
}

/**
 * Merge a Books.com.tw product-page deep-fetch result into a Work.
 *
 * This is the AUTHORITATIVE path for proper-noun resolution on Taiwanese
 * book records. The product page exposes:
 *   - 原文書名 → titles.en (NOT a back-translation; the actual English title)
 *   - 原文作者 → creator.name.en (matched up by index with zh authors)
 *   - 譯者    → adds a translator creator entry (name.zh only)
 *   - 內容簡介 → synopsis.zh (publisher's plot blurb in zh-TW, with the
 *               correct Taiwanese transliterations of character/place names)
 *   - publisher / year / isbn13 backfill the obvious metadata fields
 *
 * Existing values on the Work are preserved — we only fill what's missing.
 */
function mergeBooksTwDetails(work: Work, details: BooksTwProductDetails): Work {
  const titles = { ...work.titles };
  if (!titles.en && details.originalTitle) titles.en = details.originalTitle;

  // Creators: pair zh authors with original-language authors by index.
  // Books.com.tw lists them in the same order on the product page.
  const creators: Creator[] = [];
  const zhAuthors = details.zhAuthors ?? [];
  const origAuthors = details.originalAuthors ?? [];
  // Start from the work's existing creators — preserve any data the search
  // adapter already gave us. Then enrich with original-language names.
  // We store the COPY in the map (not the original) so subsequent mutations
  // land on the object that's actually in the output array.
  const existingByZh = new Map<string, Creator>();
  for (const c of work.creators) {
    const copy = { ...c, name: { ...c.name } };
    creators.push(copy);
    if (copy.name.zh) existingByZh.set(copy.name.zh, copy);
  }
  zhAuthors.forEach((zh, i) => {
    const en = origAuthors[i];
    const existing = existingByZh.get(zh);
    if (existing) {
      if (en && !existing.name.en) existing.name.en = en;
    } else {
      creators.push({
        name: { zh, ...(en ? { en } : {}) },
        role: 'author',
      });
    }
  });
  // Edge case: more original authors than zh authors. Append the spares.
  if (origAuthors.length > zhAuthors.length) {
    for (let i = zhAuthors.length; i < origAuthors.length; i++) {
      creators.push({ name: { en: origAuthors[i] }, role: 'author' });
    }
  }
  // Translators get their own creator entries (we only know zh form).
  for (const zhT of details.zhTranslators ?? []) {
    if (!creators.some(c => c.role === 'translator' && c.name.zh === zhT)) {
      creators.push({ name: { zh: zhT }, role: 'translator' });
    }
  }

  // Year: only if missing.
  const year = work.year ?? details.year;

  // ISBN-13: only if missing.
  const isbn13 = work.isbn13 ?? details.isbn13;

  // Synopsis: only fill zh if missing. NEVER overwrite — the adapter / a
  // previous enrichment step might have a better one.
  const synopsis = { ...(work.synopsis ?? {}) };
  if (!synopsis.zh && details.synopsisZh) synopsis.zh = details.synopsisZh;

  return { ...work, titles, creators, year, isbn13, synopsis };
}

export async function enrichWork(
  work: Work,
  llmConfig?: LLMConfig,
): Promise<{ work: Work; reception: ReceptionMaterial; report: EnrichmentReport }> {
  // Step 0a: deep-fetch the Books.com.tw product page when applicable.
  // Books.com.tw search results only carry the noisy zh title and (sometimes)
  // the zh author transliteration; the per-product page is where the
  // 原文書名 / 原文作者 / 譯者 / 內容簡介 actually live. Pulling them
  // BEFORE the LLM step matters for two reasons:
  //   1) The LLM can't reliably back-translate Chinese titles to their real
  //      English originals (畫家的祕密學徒 → "The Painter's Apprentice"
  //      sounds plausible but is a different book; the actual original is
  //      "I, Juan de Pareja"). The product page tells us authoritatively.
  //   2) Taiwanese publisher transliterations of foreign names (羅蘋·荷布,
  //      伊莉莎白．波頓．崔維尼奧) are NOT derivable phonetically. The
  //      product page tells us the exact form the publisher chose.
  let workAfterDeepFetch = work;
  const booksTwUrl = work.sources.books_tw;
  const itemId = extractBooksTwItemId(booksTwUrl);
  // Only fetch when there's something we don't already have. Skipping when
  // the search-stage adapter already gave us a real titles.en is fine —
  // those records typically came from an English-first source like
  // OpenLibrary that merged with the books_tw record.
  const shouldDeepFetch =
    !!itemId &&
    (!work.titles.en || !work.synopsis?.zh || !work.creators.some(c => c.name.en));
  if (shouldDeepFetch) {
    const details = await fetchBooksTwProduct(itemId!).catch(() => null);
    if (details) workAfterDeepFetch = mergeBooksTwDetails(work, details);
  }

  // Step 0b: LLM title resolution. Best-effort; null on any failure.
  // Runs AFTER the deep-fetch so the LLM sees whatever the publisher
  // already supplied (which makes its job near-trivial - confirming an
  // already-correct english_title rather than guessing one).
  let resolved: ResolvedTitles | null = null;
  if (llmConfig) {
    resolved = await resolveTitles(workAfterDeepFetch, llmConfig).catch(() => null);
  }
  const resolvedWork = applyResolvedTitles(workAfterDeepFetch, resolved);

  const wikiQueries = decideWikiQueries(resolvedWork);

  // Plurk: zh title first (Taiwanese platform), falling back to en.
  const plurkQuery = wikiQueries.zhQuery ?? wikiQueries.enQuery ?? '';
  // Reddit ALWAYS uses the en title.
  const redditQuery = wikiQueries.enQuery ?? '';

  // Validators harden the Wikipedia per-language search fallback.
  const validators: string[] = [];
  const collect = (s: string | undefined | null) => {
    if (typeof s === 'string' && s.trim().length >= 2) validators.push(s.trim());
  };
  for (const c of resolvedWork.creators) {
    collect(c.name.en);
    collect(c.name.zh);
    collect(c.name.original);
  }
  collect(resolvedWork.titles.en);
  collect(resolvedWork.titles.zh);
  collect(resolvedWork.titles.original);

  const [wiki, reddit, plurk] = await Promise.all([
    enrichFromWikipedia({ ...wikiQueries, validators }).catch(() => []),
    redditQuery
      ? enrichFromReddit({ enTitle: redditQuery, limit: 3 }).catch(() => [])
      : Promise.resolve([] as RedditEnrichment[]),
    plurkQuery
      ? enrichFromPlurk({ query: plurkQuery, limit: 3 }).catch(() => [])
      : Promise.resolve([] as PlurkEnrichment[]),
  ]);

  // Compose synopsis from Wikipedia material + the work's existing zh synopsis.
  const enParts: string[] = [];
  if (resolvedWork.synopsis?.en) enParts.push(resolvedWork.synopsis.en);
  for (const w of wiki.filter(w => w.lang === 'en')) {
    enParts.push(`【Wikipedia: ${w.title}】\n${w.text}`);
  }
  for (const w of wiki.filter(w => w.lang === 'ja')) {
    enParts.push(`【Wikipedia (ja): ${w.title}】\n${w.text}`);
  }
  for (const w of wiki.filter(w => w.lang === 'ko')) {
    enParts.push(`【Wikipedia (ko): ${w.title}】\n${w.text}`);
  }

  const zhParts: string[] = [];
  if (resolvedWork.synopsis?.zh) zhParts.push(resolvedWork.synopsis.zh);
  for (const w of wiki.filter(w => w.lang === 'zh')) {
    zhParts.push(`【維基百科:${w.title}】\n${w.text}`);
  }

  const titlesForWriteup = { ...resolvedWork.titles };
  if (!titlesForWriteup.en) {
    const enHit = wiki.find(w => w.lang === 'en');
    if (enHit) titlesForWriteup.en = enHit.title;
  }

  const enriched: Work = {
    ...resolvedWork,
    titles: titlesForWriteup,
    synopsis: {
      en: enParts.join('\n\n').trim() || undefined,
      zh: zhParts.join('\n\n').trim() || undefined,
    },
    raw: {
      ...resolvedWork.raw,
      _enrichment: {
        wikipedia: wiki.map(w => ({ lang: w.lang, title: w.title, url: w.url })),
        reddit: reddit.map(r => ({ subreddit: r.subreddit, title: r.title, url: r.url, score: r.score })),
        plurk: plurk.map(p => ({ pid: p.pid, url: p.url, respCount: p.respCount })),
        resolved: resolved ?? null,
      },
    },
  };

  return {
    work: enriched,
    reception: { reddit, plurk },
    report: { wikipedia: wiki, reddit, plurk, resolved },
  };
}
