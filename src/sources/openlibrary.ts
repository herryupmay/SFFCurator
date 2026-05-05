/**
 * Open Library adapter.
 *
 * Docs: https://openlibrary.org/dev/docs/api/search
 *
 * No auth, generous rate limits. Best for general bibliographic data + ISBNs.
 * SFF coverage is OK but ISFDB will be deeper for subgenre tagging.
 *
 * Open Library updated their API in 2025-2026 to be stricter about:
 *   1. User-Agent: must identify the caller with contact info (URL or email).
 *      Vague UAs get rejected with 422 even though the request body is fine.
 *      We send a UA that includes both a project URL and an email.
 *   2. The `fields` whitelist: some legacy field names (e.g. "language") now
 *      occasionally trigger 422 depending on the search type. We omit it.
 *   3. CJK queries: occasionally rejected on the default endpoint; the
 *      retry below tries again without `fields` if the first attempt 422s.
 */

import type { Work } from '../types';
import { politeFetch } from './http';

interface OLDoc {
  key: string;
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  subject?: string[];
  language?: string[];
}

interface OLSearchResponse {
  docs: OLDoc[];
  numFound: number;
}

// Open Library asks (per their docs) that automated callers identify
// themselves with a contact address. Use a stable UA they can reach.
const OL_UA = 'sff-curator/0.1 (forum curation tool; +https://github.com/janeypa/sff-curator; mailto:janeypa@gmail.com)';

export async function searchOpenLibrary(
  query: string,
  limit = 15,
): Promise<Work[]> {
  const base = 'https://openlibrary.org/search.json';
  // Conservative field list - only fields the docs currently document and
  // that we actually use. Drop "language" which has been a 422 trigger.
  const fields = 'key,title,author_name,first_publish_year,isbn,subject';

  const candidates = [
    `${base}?q=${encodeURIComponent(query)}&limit=${limit}&fields=${fields}`,
    // Fallback 1: drop the fields parameter entirely (returns more bytes,
    // but works for broader query shapes that the fields whitelist rejects).
    `${base}?q=${encodeURIComponent(query)}&limit=${limit}`,
    // Fallback 2: search by title specifically.
    `${base}?title=${encodeURIComponent(query)}&limit=${limit}`,
  ];

  let lastErr: Error | null = null;
  for (const url of candidates) {
    try {
      const res = await politeFetch(url, {
        headers: { 'User-Agent': OL_UA },
      });
      if (res.ok) {
        const data = (await res.json()) as OLSearchResponse;
        return (data.docs || []).map(docToWork).filter((w): w is Work => w !== null);
      }
      // Pull the body for diagnostics; OL usually sends a JSON {"error":"..."}.
      const body = await res.text().catch(() => '');
      lastErr = new Error(
        `Open Library ${res.status} ${res.statusText}` +
          (body ? `: ${body.slice(0, 200)}` : '')
      );
      // Only retry on 422 (validation) or 5xx; bail on other client errors.
      if (res.status !== 422 && res.status < 500) break;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      break;
    }
  }

  throw lastErr ?? new Error('Open Library search failed: unknown error');
}

function docToWork(doc: OLDoc): Work | null {
  if (!doc.title) return null;
  return {
    sources: { openlibrary: `https://openlibrary.org${doc.key}` },
    titles: { en: doc.title },
    creators: (doc.author_name ?? []).map(name => ({
      name: { en: name },
      role: 'author' as const,
    })),
    year: doc.first_publish_year,
    isbn13: pickIsbn13(doc.isbn ?? []),
    medium: 'book',
    subgenres: filterSubgenres(doc.subject ?? []),
    raw: { openlibrary: doc },
  };
}

function pickIsbn13(isbns: string[]): string | undefined {
  return isbns.find(i => i.replace(/-/g, '').length === 13);
}

const SUBGENRE_TAGS = new Set([
  'science fiction',
  'fantasy',
  'horror',
  'cyberpunk',
  'steampunk',
  'biopunk',
  'space opera',
  'hard science fiction',
  'soft science fiction',
  'dystopia',
  'dystopian fiction',
  'post-apocalyptic',
  'apocalyptic fiction',
  'time travel',
  'alternate history',
  'cosmic horror',
  'weird fiction',
  'gothic fiction',
  'urban fantasy',
  'dark fantasy',
  'epic fantasy',
  'high fantasy',
  'sword and sorcery',
  'magical realism',
  'speculative fiction',
]);

function filterSubgenres(subjects: string[]): string[] {
  const seen = new Set<string>();
  for (const s of subjects) {
    const norm = s.toLowerCase().trim();
    if (SUBGENRE_TAGS.has(norm)) seen.add(norm);
  }
  return [...seen];
}
