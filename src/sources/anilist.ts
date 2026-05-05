/**
 * AniList adapter (anime + manga).
 *
 * GraphQL API, no auth required.
 * Docs: https://docs.anilist.co/guide/graphql/
 *
 * We run ANIME and MANGA queries in parallel and merge results.
 */

import type { Work, Medium, CreatorRole } from '../types';
import { politeFetch } from './http';

const ENDPOINT = 'https://graphql.anilist.co/';

const QUERY = `
query ($search: String, $perPage: Int, $type: MediaType) {
  Page(perPage: $perPage) {
    media(search: $search, type: $type, sort: SEARCH_MATCH) {
      id
      type
      format
      seasonYear
      startDate { year }
      title { romaji english native }
      genres
      tags { name rank isGeneralSpoiler }
      siteUrl
      description(asHtml: false)
      staff(perPage: 4) {
        edges {
          role
          node { name { full native } }
        }
      }
    }
  }
}`;

interface AniListMedia {
  id: number;
  type: 'ANIME' | 'MANGA';
  format: string | null;
  seasonYear: number | null;
  startDate: { year: number | null } | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  genres: string[];
  tags: Array<{ name: string; rank: number; isGeneralSpoiler: boolean }>;
  siteUrl: string;
  description: string | null;
  staff: { edges: Array<{ role: string; node: { name: { full: string; native: string | null } } }> };
}

async function searchType(
  search: string,
  type: 'ANIME' | 'MANGA',
  perPage: number,
): Promise<AniListMedia[]> {
  const res = await politeFetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: QUERY, variables: { search, perPage, type } }),
    // AniList allows up to 90 req/min — be conservative.
    hostDelayMs: 750,
  });
  if (!res.ok) {
    throw new Error(`AniList: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: { Page?: { media: AniListMedia[] } }; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`AniList: ${json.errors[0].message}`);
  }
  return json.data?.Page?.media ?? [];
}

export async function searchAniList(query: string, limit = 15): Promise<Work[]> {
  // Split the budget between anime and manga.
  const half = Math.max(5, Math.floor(limit / 2));
  const [anime, manga] = await Promise.all([
    searchType(query, 'ANIME', half).catch((err): AniListMedia[] => {
      console.warn('[anilist anime]', err);
      return [];
    }),
    searchType(query, 'MANGA', half).catch((err): AniListMedia[] => {
      console.warn('[anilist manga]', err);
      return [];
    }),
  ]);
  return [...anime, ...manga].map(mediaToWork);
}

function mediaToWork(m: AniListMedia): Work {
  const medium: Medium = m.type === 'MANGA'
    ? (m.format === 'NOVEL' ? 'book' : 'manga')
    : 'anime';

  const creators = (m.staff?.edges ?? [])
    .filter(e => isInterestingRole(e.role))
    .map(e => ({
      name: {
        en: e.node.name.full || undefined,
        original: e.node.name.native || undefined,
      },
      role: mapRole(e.role),
    }));

  // High-signal subgenre tags only (rank ≥ 70, no spoilers, normalized).
  const subgenres = [
    ...(m.genres ?? []).map(g => g.toLowerCase()),
    ...(m.tags ?? [])
      .filter(t => t.rank >= 70 && !t.isGeneralSpoiler)
      .slice(0, 6)
      .map(t => t.name.toLowerCase()),
  ];

  return {
    sources: { anilist: m.siteUrl },
    titles: {
      en: m.title.english || m.title.romaji || undefined,
      original: m.title.native || undefined,
    },
    creators,
    year: m.seasonYear ?? m.startDate?.year ?? undefined,
    medium,
    subgenres: dedupe(subgenres),
    synopsis: m.description ? { en: stripHtml(m.description).slice(0, 1500) } : undefined,
    raw: { anilist: m },
  };
}

function isInterestingRole(role: string): boolean {
  return /story|art|original|writer|director|creator|author/i.test(role);
}

function mapRole(role: string): CreatorRole {
  const r = role.toLowerCase();
  if (r.includes('director')) return 'director';
  if (r.includes('story') || r.includes('original') || r.includes('writer') || r.includes('author')) return 'author';
  if (r.includes('art') || r.includes('illustrat')) return 'illustrator';
  if (r.includes('screenplay')) return 'screenwriter';
  return 'author';
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
