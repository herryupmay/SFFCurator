/**
 * LLM-based theme/genre re-rank.
 *
 * Tagging across catalog sources (ISFDB, AniList, Open Library subjects,
 * Wikidata) is famously inconsistent for SFF: "supernatural with tech"
 * floats between fantasy and sci-fi, "speculative" lumps everything,
 * publishers' own categories are even softer. Strict literal filtering
 * on those tags overshoots both ways.
 *
 * Solution: after Pipeline A produces candidates, ask the LLM to
 * classify each one against the user's theme. Output is one of
 * YES / MAYBE / NO per work. We keep YES + MAYBE (recall over precision -
 * the human still does the final cull while writing the intro).
 *
 * The call is BATCHED - one LLM round-trip for the whole candidate list.
 * That keeps cost predictable and sub-$0.05 per search at Claude rates,
 * free for local LLMs.
 */

import type { Work } from '../types';
import { complete, type LLMConfig } from '../llm/client';

export type RerankVerdict = 'yes' | 'maybe' | 'no';

export interface RerankResult {
  index: number;
  verdict: RerankVerdict;
}

const SYSTEM_PROMPT = `You are an SFF librarian helping a Taiwanese forum curator decide which works fit a curation theme. SFF tagging is famously loose (supernatural+tech, speculative, etc.) so err on the side of MAYBE rather than NO when uncertain.

For each candidate work, output exactly one line in the form:
<index>: YES|MAYBE|NO

YES   - clearly matches the theme; an SFF curator would put this on the list
MAYBE - partial match, sff-adjacent, or unfamiliar work that COULD fit
NO    - clearly does not fit (wrong genre, off-topic, romance-only, textbook, etc.)

Output every index in order. No explanation, no extra text.`;

interface CandidateInput {
  index: number;
  title: string;
  author: string;
  medium: string;
  year?: number;
  synopsis?: string;
  subgenres?: string[];
}

function workToCandidate(work: Work, idx: number): CandidateInput {
  const title = work.titles.zh || work.titles.en || work.titles.original || '(untitled)';
  const author =
    work.creators[0]?.name.zh ||
    work.creators[0]?.name.en ||
    work.creators[0]?.name.original ||
    '';
  const synopsis = work.synopsis?.zh || work.synopsis?.en;
  return {
    index: idx,
    title,
    author,
    medium: work.medium,
    year: work.year,
    synopsis: synopsis ? synopsis.slice(0, 240) : undefined,
    subgenres: work.subgenres?.length ? work.subgenres : undefined,
  };
}

/**
 * Build a compact, indexed candidate list inside the user prompt. Keep
 * each row to ~250 chars so we comfortably fit ~25 candidates inside an
 * 8k-token window even for chatty local models.
 */
function buildUserMessage(theme: string, candidates: CandidateInput[]): string {
  const rows = candidates.map(c => {
    const parts = [
      `${c.index}. "${c.title}"`,
      c.author && `by ${c.author}`,
      c.year && `(${c.year})`,
      `[${c.medium}]`,
    ].filter(Boolean);
    let line = parts.join(' ');
    if (c.subgenres?.length) line += ` tags=${c.subgenres.slice(0, 5).join(',')}`;
    if (c.synopsis) line += ` :: ${c.synopsis.replace(/\s+/g, ' ').trim()}`;
    return line;
  });
  return [
    `Theme (curator's query): ${theme}`,
    '',
    'Candidates:',
    ...rows,
    '',
    'Verdict per index, format `<idx>: YES|MAYBE|NO`, one per line.',
  ].join('\n');
}

const VERDICT_REGEX = /^(\d+)\s*[::]\s*(yes|maybe|no)\b/i;

export function parseRerankReply(reply: string, expectedCount: number): RerankResult[] {
  const out: RerankResult[] = [];
  const seen = new Set<number>();
  for (const rawLine of reply.split('\n')) {
    const m = rawLine.trim().match(VERDICT_REGEX);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= expectedCount) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push({ index: idx, verdict: m[2].toLowerCase() as RerankVerdict });
  }
  return out;
}

/**
 * Run the batched re-rank. Returns one verdict per input work. Any work
 * that the LLM didn't return a verdict for defaults to 'maybe' (recall
 * over precision - we don't want a parse glitch to silently drop works).
 */
export async function rerankByTheme(
  works: Work[],
  theme: string,
  cfg: LLMConfig,
): Promise<RerankResult[]> {
  if (!works.length) return [];
  const candidates = works.map(workToCandidate);

  const reply = await complete(cfg, {
    system: SYSTEM_PROMPT,
    user: buildUserMessage(theme, candidates),
    maxTokens: Math.max(400, works.length * 12),
    temperature: 0.1,
  });

  const parsed = parseRerankReply(reply, works.length);
  const map = new Map<number, RerankVerdict>();
  for (const v of parsed) map.set(v.index, v.verdict);

  const final: RerankResult[] = works.map((_, i) => ({
    index: i,
    verdict: map.get(i) ?? 'maybe',
  }));
  return final;
}

/**
 * Apply re-rank verdicts to a candidate list: keep YES + MAYBE, drop NO.
 * Annotates each surviving work with `_aiVerdict` on the raw map so the
 * UI can show a YES/MAYBE chip.
 */
export function applyRerankVerdicts(
  works: Work[],
  verdicts: RerankResult[],
): Work[] {
  const verdictByIndex = new Map<number, RerankVerdict>();
  for (const v of verdicts) verdictByIndex.set(v.index, v.verdict);
  const out: Work[] = [];
  works.forEach((w, i) => {
    const v = verdictByIndex.get(i) ?? 'maybe';
    if (v === 'no') return;
    out.push({
      ...w,
      raw: { ...w.raw, _aiVerdict: v },
    });
  });
  return out;
}
