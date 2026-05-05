/**
 * TMDB adapter (films + TV).
 *
 * Docs: https://developer.themoviedb.org/reference/intro/getting-started
 *
 * Requires a free API key. If no key is provided, this adapter returns []
 * silently — film/TV is "best effort", the rest of the pipeline still runs.
 *
 * We use /search/multi which returns mixed types, then keep only movie + tv
 * items that overlap with SFF genres.
 */

import type { Work, Medium } from '../types';
import { politeFetch } from './http';

const BASE = 'https://api.themoviedb.org/3';

// TMDB genre IDs we care about. Source:
// /genre/movie/list and /genre/tv/list
const SFF_GENRE_IDS = new Set<number>([
  878,    // Science Fiction (movie)
  10765,  // Sci-Fi & Fantasy (TV)
  14,     // Fantasy (movie)
  27,     // Horror (movie)
  9648,   // Mystery — useful for cosmic horror queries
]);

interface TMDBMultiResult {
  id: number;
  media_type: 'movie' | 'tv' | 'person';
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  genre_ids?: number[];
  popularity?: number;
  original_language?: string;
}

export async function searchTmdb(
  query: string,
  limit = 15,
  apiKey: string,
): Promise<Work[]> {
  if (!apiKey) return [];

  const url =
    `${BASE}/search/multi` +
    `?query=${encodeURIComponent(query)}` +
    `&include_adult=false` +
    `&language=en-US` +
    `&api_key=${encodeURIComponent(apiKey)}`;

  const res = await politeFetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('TMDB: invalid API key');
    }
    throw new Error(`TMDB: ${res.status} ${body.slice(0, 160)}`);
  }

  const data = (await res.json()) as { results: TMDBMultiResult[] };

  return data.results
    .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
    .filter(r => (r.genre_ids ?? []).some(id => SFF_GENRE_IDS.has(id)))
    .slice(0, limit)
    .map(toWork);
}

function toWork(r: TMDBMultiResult): Work {
  const medium: Medium = r.media_type === 'tv' ? 'tv' : 'film';
  const titleEn = r.title || r.name || '';
  const original = r.original_title || r.original_name;
  const dateStr = r.release_date || r.first_air_date;
  const year = dateStr ? parseInt(dateStr.slice(0, 4), 10) : undefined;

  return {
    sources: {
      tmdb: `https://www.themoviedb.org/${r.media_type}/${r.id}`,
    },
    titles: {
      en: titleEn || undefined,
      original: original && original !== titleEn ? original : undefined,
    },
    // /search/multi doesn't include credits. The matching stage doesn't need
    // them for film/TV (title + year is usually enough). Add a /credits
    // follow-up later only if cross-source merging needs it.
    creators: [],
    year: year && !Number.isNaN(year) ? year : undefined,
    medium,
    synopsis: r.overview ? { en: r.overview.slice(0, 1500) } : undefined,
    raw: { tmdb: r },
  };
}
