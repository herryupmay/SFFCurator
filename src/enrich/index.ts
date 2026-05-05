/**
 * Synopsis enrichment orchestrator.
 *
 * Called by /api/writeup before invoking the LLM. Pulls additional plot /
 * reception material from outside sources so the LLM has more than thin
 * adapter metadata to work with - especially important for works no one
 * on the team has read yet, which is the bulk of the curation backlog.
 *
 * Sources today:
 *   - Wikipedia (en + zh) - article intro: plot + themes + reception
 *   - Reddit (English SFF subs) - top-voted reader threads with actual reactions
 *
 * Returns a Work whose `synopsis.en` / `synopsis.zh` have been augmented
 * with the fetched material, plus a short "enrichment" notes array on the
 * `raw` map for citation/debugging in the UI.
 *
 * Failures are non-fatal: each source can fall over independently and we
 * still return whatever survived. Total time is bounded by the slowest
 * source (everything runs in parallel).
 */

import type { Work } from '../types';
import { enrichFromWikipedia, type EnrichmentResult } from './wikipedia';
import { enrichFromReddit, type RedditEnrichment } from './reddit';
import { enrichFromPlurk, type PlurkEnrichment } from './plurk';

export interface EnrichmentReport {
  wikipedia: EnrichmentResult[];
  reddit: RedditEnrichment[];
  plurk: PlurkEnrichment[];
}

export async function enrichWork(
  work: Work,
): Promise<{ work: Work; report: EnrichmentReport }> {
  const enQuery =
    work.titles.en ||
    work.creators.find(c => c.name.en)?.name.en ||
    '';
  const zhQuery =
    work.titles.zh ||
    work.creators.find(c => c.name.zh)?.name.zh ||
    '';

  // Plurk is searched by zh title first (Taiwanese platform), falling back
  // to en title if no zh title is known. Either way: EXACT title only - the
  // theme-keyword path returns far too much off-topic noise.
  const plurkQuery = zhQuery || enQuery;

  const [wiki, reddit, plurk] = await Promise.all([
    enrichFromWikipedia({ enQuery, zhQuery }).catch(() => []),
    enQuery
      ? enrichFromReddit({ enTitle: enQuery, limit: 3 }).catch(() => [])
      : Promise.resolve([] as RedditEnrichment[]),
    plurkQuery
      ? enrichFromPlurk({ query: plurkQuery, limit: 3 }).catch(() => [])
      : Promise.resolve([] as PlurkEnrichment[]),
  ]);

  // Compose a richer synopsis. Keep adapter-supplied synopsis as the
  // first paragraph (it's clean publisher copy); append fetched material
  // labelled by source so the LLM can cite or paraphrase confidently.
  const enParts: string[] = [];
  if (work.synopsis?.en) enParts.push(work.synopsis.en);
  for (const w of wiki.filter(w => w.lang === 'en')) {
    enParts.push(`【Wikipedia: ${w.title}】\n${w.text}`);
  }
  for (const r of reddit) {
    enParts.push(
      `【Reddit r/${r.subreddit} (${r.score} upvotes): ${r.title}】\n${r.text}`
    );
  }

  const zhParts: string[] = [];
  if (work.synopsis?.zh) zhParts.push(work.synopsis.zh);
  for (const w of wiki.filter(w => w.lang === 'zh')) {
    zhParts.push(`【維基百科:${w.title}】\n${w.text}`);
  }
  for (const p of plurk) {
    zhParts.push(`【Plurk(${p.respCount} 回應):${p.title}】\n${p.text}`);
  }

  const enriched: Work = {
    ...work,
    synopsis: {
      en: enParts.join('\n\n').trim() || undefined,
      zh: zhParts.join('\n\n').trim() || undefined,
    },
    raw: {
      ...work.raw,
      _enrichment: {
        wikipedia: wiki.map(w => ({ lang: w.lang, title: w.title, url: w.url })),
        reddit: reddit.map(r => ({ subreddit: r.subreddit, title: r.title, url: r.url, score: r.score })),
        plurk: plurk.map(p => ({ pid: p.pid, url: p.url, respCount: p.respCount })),
      },
    },
  };

  return {
    work: enriched,
    report: { wikipedia: wiki, reddit, plurk },
  };
}
