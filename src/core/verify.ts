/**
 * Verification stage.
 *
 * Runs after matching/merge. Decides which records to keep, computes the
 * derived flags the UI and report rely on, and ranks results so the
 * highest-priority candidates for a Taiwan SFF forum appear first.
 *
 * Rules:
 *   - Drop singletons that lack a strong identifier (no ISBN, no
 *     anilist/tmdb/isfdb/wikidata source, no Books.com.tw/Readmoo URL).
 *   - Keep singletons that DO have a strong identifier (e.g. lone ISFDB
 *     hits — ISFDB is curated, not crowdsourced, so a single hit is fine).
 *   - Set hasZhTranslation if any zh source contributed.
 *   - Set availableInTw if Books.com.tw or Readmoo contributed.
 *   - Append flags ('未中譯', 'tw-only', 'low-confidence') for the UI.
 *
 * Sort priority (top to bottom, first non-tie wins):
 *   1. availableInTw      — Taiwan-listed works always lead. This is a
 *                           curation tool for a Taiwan SFF forum, so works
 *                           the readers can actually buy locally are the
 *                           headline. Imported-only stuff lives below.
 *   2. confidence         — high > medium > low.
 *   3. source count       — more independent confirmations is better.
 *   4. hasZhTranslation   — a Chinese edition exists somewhere, even if
 *                           not in TW (e.g. mainland-only). Tiebreak.
 */

import type { Work } from '../types';

const STRONG_SOURCES = new Set([
  'isfdb',
  'anilist',
  'tmdb',
  'wikidata',
  'books_tw',
  'readmoo',
]);

const ZH_SOURCES = new Set(['books_tw', 'readmoo', 'wikidata']);
const TW_SOURCES = new Set(['books_tw', 'readmoo']);

export function verify(works: Work[]): Work[] {
  const kept: Work[] = [];

  for (const w of works) {
    const sourceNames = Object.keys(w.sources);
    const hasStrongId =
      Boolean(w.isbn13) ||
      sourceNames.some(s => STRONG_SOURCES.has(s));

    // Drop low-signal singletons.
    if (sourceNames.length === 1 && !hasStrongId) continue;

    const flags: string[] = [];

    const hasZh = sourceNames.some(s => ZH_SOURCES.has(s)) || Boolean(w.titles.zh);
    const inTw  = sourceNames.some(s => TW_SOURCES.has(s));

    if (!hasZh)               flags.push('未中譯');
    if (inTw && !hasZh)       flags.push('tw-listing-only'); // unusual, surfaces edge cases
    if (sourceNames.length === 1 && hasStrongId && !inTw) flags.push('single-source');
    if (w.confidence === 'low') flags.push('low-confidence');

    kept.push({
      ...w,
      hasZhTranslation: hasZh,
      availableInTw: inTw,
      flags: flags.length ? flags : undefined,
    });
  }

  // Sort priority documented at the top of the file.
  const confidenceRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  kept.sort((a, b) => {
    // 1. TW-listed first.
    const ta = a.availableInTw ? 1 : 0;
    const tb = b.availableInTw ? 1 : 0;
    if (ta !== tb) return tb - ta;
    // 2. Confidence.
    const ca = confidenceRank[a.confidence ?? 'low'];
    const cb = confidenceRank[b.confidence ?? 'low'];
    if (ca !== cb) return cb - ca;
    // 3. Source count.
    const sa = Object.keys(a.sources).length;
    const sb = Object.keys(b.sources).length;
    if (sa !== sb) return sb - sa;
    // 4. Has Chinese translation tiebreak.
    const za = a.hasZhTranslation ? 1 : 0;
    const zb = b.hasZhTranslation ? 1 : 0;
    return zb - za;
  });

  return kept;
}
