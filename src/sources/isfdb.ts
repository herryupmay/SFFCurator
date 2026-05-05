/**
 * ISFDB adapter — Internet Speculative Fiction Database.
 *
 * ISFDB is the gold-standard SFF bibliography. Curated, not crowdsourced,
 * with rich subgenre tagging.
 *
 * Their public Web API (getauthor_xml.cgi, getpub_xml.cgi) only does
 * lookups by author ID or ISBN — not keyword search. So we scrape their
 * Title_Search results page and parse it with cheerio.
 *
 * Selectors live here, isolated. When ISFDB's HTML changes (rare but it
 * happens), this file is the only thing that needs patching. Save a fresh
 * fixture into tests/fixtures/isfdb-<query>.html and adjust the selectors.
 */

import * as cheerio from 'cheerio';
import type { Work, Medium } from '../types';
import { politeFetch } from './http';

const BASE = 'https://www.isfdb.org';
const SEARCH_URL = (q: string) =>
  `${BASE}/cgi-bin/se.cgi?arg=${encodeURIComponent(q)}&type=Title`;

export async function searchIsfdb(query: string, limit = 15): Promise<Work[]> {
  const res = await politeFetch(SEARCH_URL(query));
  if (!res.ok) {
    throw new Error(`ISFDB: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const works: Work[] = [];

  // ISFDB's title search returns a single results table. Each row links
  // to a title.cgi page; surrounding cells hold author, year, type.
  // We read the cell sequence defensively — if ISFDB reorders columns we
  // fall back to "best effort" rather than throwing.
  $('a[href*="title.cgi?"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href');
    const titleText = $a.text().trim();
    if (!titleText || !href) return;

    // Skip "Series" / "Variant Title" / nav links — only keep links inside
    // results table rows.
    const $row = $a.closest('tr');
    if (!$row.length) return;

    const url = href.startsWith('http') ? href : `${BASE}/cgi-bin/${href.replace(/^\/?(cgi-bin\/)?/, '')}`;

    // Sweep neighbour cells for year + author.
    let year: number | undefined;
    let author: string | undefined;
    let typeLabel: string | undefined;

    $row.find('td').each((__, td) => {
      const text = $(td).text().trim();
      if (!text) return;
      const yearMatch = text.match(/^(\d{4})$/);
      if (yearMatch && !year) {
        const y = parseInt(yearMatch[1], 10);
        if (y >= 1500 && y <= 2100) year = y;
        return;
      }
      // Author cells contain links to ea.cgi (author pages).
      if ($(td).find('a[href*="ea.cgi"]').length && !author) {
        author = $(td).find('a').first().text().trim() || undefined;
        return;
      }
      // Type cells hold strings like "novel", "novella", "shortfiction".
      if (/^(novel|novella|shortfiction|collection|anthology|chapbook|omnibus|nonfiction|essay)$/i.test(text)) {
        typeLabel = text.toLowerCase();
      }
    });

    works.push({
      sources: { isfdb: url },
      titles: { en: titleText },
      creators: author ? [{ name: { en: author }, role: 'author' }] : [],
      year,
      medium: mediumFromType(typeLabel),
      raw: { isfdb: { titleText, url, year, author, typeLabel } },
    });

    if (works.length >= limit) return false;
  });

  return works;
}

function mediumFromType(t?: string): Medium {
  if (!t) return 'book';
  // ISFDB's "shortfiction" is still a book-medium thing for our purposes.
  return 'book';
}
