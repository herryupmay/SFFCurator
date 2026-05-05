/**
 * Reddit synopsis enrichment.
 *
 * Pulls top-voted discussion threads about a work from key SFF subreddits.
 * Reddit's anonymous JSON endpoint at <reddit>.json is publicly readable
 * (rate-limited to ~100 requests / 10 minutes per IP). We stay well below
 * that by only firing during /api/writeup, not on every search.
 *
 * Why Reddit: for English SFF, r/Fantasy / r/printSF / r/booksuggestions
 * accumulate readers' actual reactions and comparisons. The post body
 * (selftext) of a top-voted thread is often a 200-500 word reader take -
 * useful flavor for an intro that grounds in *how readers see it* rather
 * than just publisher copy.
 *
 * We deliberately don't pull comments here - that would require an extra
 * fetch per thread (3-5x the cost) and comments are noisy enough that the
 * marginal value isn't worth the extra latency.
 */

import { politeFetch } from '../sources/http';

const SFF_SUBS = ['Fantasy', 'printSF', 'scifi', 'booksuggestions'];
const SEARCH_URL = (sub: string, q: string) =>
  `https://www.reddit.com/r/${sub}/search.json` +
  `?q=${encodeURIComponent('"' + q + '"')}&restrict_sr=on&sort=top&t=all&limit=3`;

interface RedditChild {
  data: {
    title?: string;
    selftext?: string;
    permalink?: string;
    subreddit?: string;
    score?: number;
    num_comments?: number;
  };
}
interface RedditListing {
  data?: { children?: RedditChild[] };
}

interface RedditEnrichment {
  lang: 'en';
  /** Original thread title. */
  title: string;
  /** Thread body (selftext). */
  text: string;
  url: string;
  subreddit: string;
  score: number;
  numComments: number;
}

/**
 * Search English-SFF subreddits for the work's English title and return
 * the highest-scoring threads with non-empty bodies. Capped at `limit`
 * across all subreddits combined.
 */
export async function enrichFromReddit(opts: {
  enTitle: string;
  limit?: number;
}): Promise<RedditEnrichment[]> {
  const { enTitle } = opts;
  const limit = opts.limit ?? 3;
  if (!enTitle.trim()) return [];

  const tasks = SFF_SUBS.map(async sub => {
    try {
      const res = await politeFetch(SEARCH_URL(sub, enTitle), {
        hostDelayMs: 1000,
      });
      if (!res.ok) return [] as RedditEnrichment[];
      const data = (await res.json()) as RedditListing;
      const children = data.data?.children ?? [];
      const out: RedditEnrichment[] = [];
      for (const c of children) {
        const d = c.data || {};
        const text = (d.selftext ?? '').trim();
        // Skip link-only posts and very short noise.
        if (!text || text.length < 80) continue;
        out.push({
          lang: 'en',
          title: d.title ?? '(untitled)',
          text,
          url: d.permalink ? `https://www.reddit.com${d.permalink}` : '',
          subreddit: d.subreddit ?? sub,
          score: d.score ?? 0,
          numComments: d.num_comments ?? 0,
        });
      }
      return out;
    } catch {
      return [] as RedditEnrichment[];
    }
  });

  const settled = await Promise.allSettled(tasks);
  const all: RedditEnrichment[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }
  // Highest-scoring threads first; truncate to `limit`.
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, limit);
}

export type { RedditEnrichment };
