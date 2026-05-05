/**
 * 博客來 (Books.com.tw) scraper.
 *
 * Used to confirm zh-TW availability + translation existence. If a query
 * has hits here, the work is in print in Taiwan and (almost certainly)
 * has a Chinese edition.
 *
 * Selectors (verified May 2026 against the live site, fixture
 * tests/fixtures/books_tw-real.html):
 *   - Each result is a <div class="table-td" id="prod-itemlist-<itemId>">.
 *     The itemId is what books.com.tw uses on the product page, e.g.
 *     0011025574 (regular) or E070009569 (audio/ebook).
 *   - Title: <h4><a title="..."> — read the `title` attr, not the visible
 *     text, because the visible text contains <em>highlight</em> markup.
 *   - Author: <p class="author"><a rel="go_author">name</a></p>, possibly
 *     multiple. Sometimes the author block is missing (e.g. audiobooks).
 *   - The new layout no longer surfaces publication year in search-results
 *     view, so `year` is left undefined here.
 *
 * Canonical product URL: https://www.books.com.tw/products/<itemId>.
 *
 * If books.com.tw redesigns again, save fresh HTML into
 *   tests/fixtures/books_tw-real.html
 * and adjust the selectors below; tests/scrapers.test.ts will tell you
 * when you've matched them.
 *
 * URL pattern (stable for years):
 *   https://search.books.com.tw/search/query/key/<query>/cat/all
 */

import * as cheerio from 'cheerio';
import type { Work } from '../types';
import { politeFetch } from './http';

const SEARCH_URL = (q: string) =>
  `https://search.books.com.tw/search/query/key/${encodeURIComponent(q)}/cat/all`;

export async function searchBooksTw(query: string, limit = 15): Promise<Work[]> {
  const res = await politeFetch(SEARCH_URL(query), {
    headers: {
      // Books.com.tw is sensitive about UA and language. Mimic a regular
      // browser politely; Accept-Language is also set in politeFetch.
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    hostDelayMs: 1500,
  });
  if (!res.ok) {
    throw new Error(`Books.com.tw: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const works: Work[] = [];

  // Newer layout — each card carries id="prod-itemlist-<itemId>".
  // Try several candidate selectors so a partial redesign doesn't take
  // everything down at once.
  const itemSelectors = [
    'div.table-td[id^="prod-itemlist-"]',
    'ul.searchbook li',
    '.search-listbox li',
    '.searchbook li',
    'li.item',
  ];
  let $items = $();
  for (const sel of itemSelectors) {
    $items = $(sel);
    if ($items.length) break;
  }

  $items.each((_, el) => {
    if (works.length >= limit) return false;
    const $el = $(el);

    // Pull itemId from id="prod-itemlist-<itemId>" so we can build a stable
    // product URL even though the visible link is a redirect URL.
    const idAttr = $el.attr('id') || '';
    const itemIdMatch = idAttr.match(/^prod-itemlist-(.+)$/);
    let itemId = itemIdMatch ? itemIdMatch[1] : '';

    // Title: prefer <h4> a[title]. Falls back to legacy h3/share link.
    const $titleLink =
      $el.find('h4 a[title]').first().length ? $el.find('h4 a[title]').first() :
      $el.find('h3 a').first().length ? $el.find('h3 a').first() :
      $el.find('a.share').first().length ? $el.find('a.share').first() :
      $el.find('a[href*="/products/"]').first();
    const title = ($titleLink.attr('title') || $titleLink.text()).trim();

    // URL: prefer the canonical product page if we know the itemId, fall
    // back to whatever href is on the title link.
    let url = '';
    if (itemId) {
      url = `https://www.books.com.tw/products/${itemId}`;
    } else {
      url = $titleLink.attr('href') || '';
      if (url.startsWith('//')) url = 'https:' + url;
      // Try to recover an itemId from a redirect URL like
      // /redirect/move/key/.../item/0011025574/...
      const m = url.match(/\/item\/([A-Za-z0-9]+)/);
      if (m) {
        itemId = m[1];
        url = `https://www.books.com.tw/products/${itemId}`;
      }
    }
    if (!title || !url) return;

    // Author: <p class="author"><a rel="go_author">name</a></p>, may be
    // multiple. Fall back to legacy selectors for older layouts.
    const authorNames =
      $el.find('p.author a[rel="go_author"]').map((_, a) => $(a).text().trim()).get().filter(Boolean);
    const legacyAuthor = !authorNames.length
      ? (
        $el.find('.searchbook-author a').map((_, a) => $(a).text().trim()).get().join('、') ||
        $el.find('a[href*="/authors/"]').map((_, a) => $(a).text().trim()).get().join('、') ||
        $el.find('.author').first().text().trim()
      )
      : '';
    const authors: string[] = authorNames.length
      ? authorNames
      : (legacyAuthor ? legacyAuthor.split(/[、,，]/).map(s => s.trim()).filter(Boolean) : []);

    // Year: the new search-results card doesn't expose pub year. Try the
    // old "出版日:YYYY" pattern as a fallback in case some categories still do.
    let year: number | undefined;
    const dateText = $el.text();
    const m = dateText.match(/出版日[::\s]*?(\d{4})/);
    if (m) {
      const y = parseInt(m[1], 10);
      if (y >= 1900 && y <= 2100) year = y;
    }

    works.push({
      sources: { books_tw: url },
      titles: { zh: title },
      creators: authors.map(name => ({
        name: { zh: name },
        role: 'author' as const,
      })),
      year,
      medium: 'book',
      raw: { books_tw: { title, url, authors, year, itemId } },
    });
  });

  return works;
}
