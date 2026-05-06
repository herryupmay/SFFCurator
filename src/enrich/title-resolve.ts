/**
 * LLM-driven title resolver.
 *
 * The catalog adapters give us titles in whichever languages the source
 * surface exposed. Books.com.tw and Readmoo records arrive with only the
 * Chinese title — and that title is often decorated with publisher noise
 * ("經典紀念版", "完整版", series-volume markers). For the synopsis-enrichment
 * pipeline to work well, we need the canonical English title (Wikipedia,
 * ISFDB, IMDB style) BEFORE we hit those sources, because:
 *
 *   - Reddit's SFF subs are overwhelmingly English; without the en title
 *     we miss every English reader reaction.
 *   - Wikipedia search by author name returns the AUTHOR's bio, not the
 *     book article; we need a real title to anchor en wiki.
 *
 * The LLM is the right tool for this: it has read enough catalog data to
 * recognise that "刺客正傳1刺客學徒" is "Assassin's Apprentice" by Robin
 * Hobb (1995), "三體" is "The Three-Body Problem", "AKIRA(完全版)" is
 * "Akira", etc. — much more reliably than any rule-based heuristic.
 *
 * On any failure (no LLM, network error, garbled JSON, low confidence)
 * the resolver returns null and the caller falls back to its rule-based
 * pipeline (zh anchor + langlinks).
 */

import type { Work } from '../types';
import { complete, type LLMConfig } from '../llm/client';

export type Confidence = 'high' | 'medium' | 'low';

export interface ResolvedTitles {
  /** Canonical English title (Wikipedia / ISFDB / IMDB form), or null. */
  english_title: string | null;
  /** Canonical zh title with edition / series-volume noise stripped, or null. */
  chinese_title: string | null;
  /** Original-language title for non-English-origin works (e.g. アキラ for Akira). */
  original_title: string | null;
  /** How confident the LLM is in english_title. Treat 'low' as null. */
  confidence: Confidence;
}

const SYSTEM_PROMPT = `You resolve canonical work titles for a Taiwanese SFF curation tool.

Given partial metadata about a work (titles in some languages, creator names, year, medium, subgenres), output the CANONICAL form of the title in each relevant language. The canonical form is the one used by the original publisher and authoritative databases (Wikipedia, ISFDB, IMDB) — NOT a fan translation, NOT the marketing tagline, NOT the publisher series wrapper.

⚠️ ABSOLUTE RULE — DO NOT TRANSLITERATE.
Taiwanese publishers pick their own Chinese transliterations of foreign names and titles, and those choices CANNOT be derived from the English form. Robin Hobb → 羅蘋·荷布, Elizabeth Borton de Treviño → 伊莉莎白．波頓．崔維尼奧, Katsuhiro Otomo → 大友克洋 — these are publisher-specific conventions you cannot recover by phonetic guessing. So:
- NEVER invent a Chinese title from an English title alone. chinese_title is ONLY for cleaning publisher noise out of an existing zh title that the input already provided.
- NEVER produce a Chinese name (you don't output names anyway — but if asked, refuse).
- NEVER produce a Chinese title when the input has only an English title and no zh title. Set chinese_title to null in that case, even if you "know" the canonical Taiwan title.

What you CAN do:
- Identify the original-language English/Japanese/Korean title from a Chinese input title plus author/year context (this is a lookup, not a translation — "刺客正傳1刺客學徒" + "Robin Hobb" + 1995 → english_title="Assassin's Apprentice").
- Strip volume markers and edition suffixes from an existing zh title.
- Identify the original-language title (e.g. アキラ for Akira, 三体 for The Three-Body Problem) when the work is well known under that name.

Examples:
  Input  zh="刺客正傳1刺客學徒(經典紀念版)" creator="Robin Hobb" year=1995 medium=book
  Output english_title="Assassin's Apprentice" chinese_title="刺客學徒"
         original_title=null confidence="high"
  (chinese_title is the input zh title with publisher noise stripped — NOT a translation.)

  Input  zh="畫家的祕密學徒(紐伯瑞金獎作品‧全新經典珍藏版)" creator="伊莉莎白．波頓．崔維尼奧" medium=book
  Output english_title="I, Juan de Pareja" chinese_title="畫家的祕密學徒"
         original_title=null confidence="high"
  (Note: english_title is the actual original title, NOT a back-translation of the Chinese.)

  Input  en="Neuromancer" creator="William Gibson" year=1984 medium=book
  Output english_title="Neuromancer" chinese_title=null original_title=null confidence="high"
  (No zh title in input → chinese_title is null. Even though "神經喚術士" is the well-known Taiwan title, you do NOT output it — that decision is the publisher's, not yours.)

  Input  zh="某某不知名作品" creator="某某作者" year=2020 medium=book
  Output english_title=null chinese_title="某某不知名作品" original_title=null
         confidence="low"

Strict rules:
- Only emit english_title when you are reasonably confident from the metadata. If the work is obscure or the title is ambiguous, set english_title to null and confidence to "low".
- chinese_title: ONLY a noise-stripped version of the input zh title. If the input had no zh title, output null. Never generate a zh title from an en title.
- original_title: well-documented original-language form for non-English originals (アキラ, 三体, 신과함께). If unsure, null.
- Output JSON ONLY. No markdown fence, no commentary, no leading/trailing text.

Output schema:
{"english_title": string|null, "chinese_title": string|null, "original_title": string|null, "confidence": "high"|"medium"|"low"}`;

/**
 * Best-effort JSON extractor — handles models that wrap JSON in ```json fences,
 * add trailing commentary, etc. Returns null if no parseable object is found.
 */
function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  // Quick path: direct JSON.
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // Try to peel ```json fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ }
  }
  // Locate the first { ... } block and parse.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

function isResolved(x: unknown): x is ResolvedTitles {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  const ok = (v: unknown) => v === null || typeof v === 'string';
  if (!ok(o.english_title) || !ok(o.chinese_title) || !ok(o.original_title)) return false;
  if (o.confidence !== 'high' && o.confidence !== 'medium' && o.confidence !== 'low') return false;
  return true;
}

/**
 * Ask the LLM to resolve canonical titles for this work. Returns null on any
 * failure — caller should fall back to whatever it does without LLM help.
 */
export async function resolveTitles(
  work: Work,
  config: LLMConfig,
): Promise<ResolvedTitles | null> {
  const payload = {
    titles: work.titles,
    creators: work.creators.map(c => ({ name: c.name, role: c.role })),
    year: work.year,
    medium: work.medium,
    subgenres: work.subgenres ?? [],
  };
  const userMsg =
    'Resolve canonical titles for this work record:\n\n' +
    '```json\n' + JSON.stringify(payload, null, 2) + '\n```\n\n' +
    'Output JSON only.';

  let text: string;
  try {
    text = await complete(config, {
      system: SYSTEM_PROMPT,
      user: userMsg,
      maxTokens: 300,
      // Low temperature — this is a lookup, not a creative task.
      temperature: 0.1,
    });
  } catch {
    return null;
  }

  const parsed = extractJson(text);
  if (!isResolved(parsed)) return null;

  // Empty strings → null (treat them as "the LLM had nothing useful").
  return {
    english_title: parsed.english_title?.trim() || null,
    chinese_title: parsed.chinese_title?.trim() || null,
    original_title: parsed.original_title?.trim() || null,
    confidence: parsed.confidence,
  };
}

/** Exposed for unit tests. */
export const __test_only = { extractJson, isResolved, SYSTEM_PROMPT };
