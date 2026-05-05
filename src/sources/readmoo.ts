/**
 * Readmoo scraper.
 *
 * Second TW availability source - complements Books.com.tw. If a work has
 * a Readmoo listing it's available as an ebook to Taiwanese readers.
 *
 * Selectors (verified May 2026, fixture tests/fixtures/readmoo-real.html):
 *   - Each result is wrapped in <li class="listItem-box swiper-slide">.
 *   - Title link: <a class="product-link" href="https://readmoo.com/book/<id>"
 *     title="..."> - the `title` attribute is the clean title; the link's
 *     visible text contains highlight padding.
 *   - Author: <div class="contributor-info"><a href=".../contributor/N">name</a></div>,
 *     possibly multiple anchors.
 *   - Publisher: <div class="publisher-info"> (we don't extract it today).
 *   - Description: <p itemprop="description" class="description"> - useful
 *     for the LLM writeup stage as `synopsis.zh`.
 *
 * Year is not exposed in Readmoo's search-results card, so it's left
 * undefined and the merge stage will rely on cross-source matching.
 *
 * If Readmoo's real layout drifts and the scraper goes to 0 results,
 * save fresh HTML over tests/fixtures/readmoo-real.html and update the
 * selectors below; tests/scrapers.test.ts will tell you when you've
 * matched them.
 *
 * URL pattern:
 *   https://readmoo.com/search/keyword?q=<query>
 */

import * as cheerio from 'cheerio';
import type { Work } from '../types';
import { politeFetch } from './http';

const SEARCH_URL = (q: string) =>
  `https://readmoo.com/search/keyword?q=${encodeURIComponent(q)}`;

export async function searchReadmoo(query: string, limit = 15): Promise<Work[]> {
  const res = await politeFetch(SEARCH_URL(query), {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    hostDelayMs: 1500,
  });
  if (!res.ok) {
    throw new Error(`Readmoo: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const works: Work[] = [];

  // Newer layout: <li class="listItem-box swiper-slide"> wraps each result.
  // Try several candidate selectors so a partial redesign doesn't take
  // everything down at once.
  const itemSelectors = [
    'li.listItem-box',
    '.book-list-item',
    '.book.search-item',
    'article.book',
    '.search-result-item',
  ];
  let $items = $();
  for (const sel of itemSelectors) {
    $items = $(sel);
    if ($items.length) break;
  }

  $items.each((_, el) => {
    if (works.length >= limit) return false;
    const $el = $(el);

    // Title link: <a class="product-link" href="https://readmoo.com/book/N" title="...">.
    // There are typically TWO .product-link anchors per card - one wrapping
    // the cover image (no title attr), one inside .caption with the title.
    // Prefer .caption, then any product-link with a title attribute, then
    // the older selectors as last resort.
    const $titleLink =
      $el.find('.caption a.product-link').first().length ? $el.find('.caption a.product-link').first() :
      $el.find('a.product-link[title]').first().length ? $el.find('a.product-link[title]').first() :
      $el.find('a.product-link').first().length ? $el.find('a.product-link').first() :
      $el.find('h3 a').first().length ? $el.find('h3 a').first() :
      $el.find('a[href*="/book/"]').first();
    const title = ($titleLink.attr('title') || $titleLink.text() || '').replace(/\s+/g, ' ').trim();
    let url = $titleLink.attr('href') || '';
    if (!title || !url) return;
    if (url.startsWith('/')) url = 'https://readmoo.com' + url;

    // Author: <div class="contributor-info"><a>name</a></div>, maybe multiple.
    let authors: string[] = $el.find('.contributor-info a')
      .map((_, a) => $(a).text().trim()).get().filter(Boolean);
    if (!authors.length) {
      // Legacy fallbacks.
      const legacy =
        $el.find('.author a, .author').map((_, a) => $(a).text().trim()).get().join('、') ||
        $el.find('a[href*="/author/"]').map((_, a) => $(a).text().trim()).get().join('、');
      authors = legacy
        ? legacy.split(/[、,，]/).map(s => s.trim()).filter(Boolean)
        : [];
    }
    // Dedupe (some pages list a contributor link twice — once in a label,
    // once in the inline text — and we don't want phantom co-authors).
    authors = Array.from(new Set(authors));

    // Description (optional) - useful for the LLM stage.
    const synopsisZh = $el.find('p.description, p[itemprop="description"]').first().text().trim() || undefined;

    // Year: rarely surfaced on the card; try a "(YYYY 年)" or "YYYY-MM-DD"
    // pattern as a best effort.
    let year: number | undefined;
    const m = $el.text().match(/(19\d{2}|20\d{2})\s*年/);
    if (m) {
      const y = parseInt(m[1], 10);
      if (y >= 1900 && y <= 2100) year = y;
    }

    works.push({
      sources: { readmoo: url },
      titles: { zh: title },
      creators: authors.map(name => ({
        name: { zh: name },
        role: 'author' as const,
      })),
      year,
      medium: 'book',
      synopsis: synopsisZh ? { zh: synopsisZh } : undefined,
      raw: { readmoo: { title, url, authors, year } },
    });
  });

  return works;
}
