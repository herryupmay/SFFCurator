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

// =====================================================================
// Per-product deep-fetch
// =====================================================================
//
// The search-results page only carries the noisy zh title and (sometimes)
// the zh author transliteration. The 原文書名 (original/English title),
// 原文作者 (author in original language), 譯者 (zh translator) and the
// publisher's plot blurb (內容簡介) ONLY appear on the per-product page.
//
// Without these fields, downstream enrichment is forced to ask the LLM
// to back-translate the Chinese title from scratch — and that confidently
// fails on edge cases like 畫家的祕密學徒 (back-translates to "The
// Painter's Apprentice", a real but unrelated book; the actual original
// is "I, Juan de Pareja"). Worse, the LLM cannot be trusted to produce
// Chinese transliterations of foreign names — Taiwanese publishers pick
// their own conventions ("羅蘋·荷布", "伊莉莎白．波頓．崔維尼奧") that
// are not derivable from the English form.
//
// So we fetch the product page once at writeup time and pull every
// authoritative metadata field Books.com.tw exposes.

export interface BooksTwProductDetails {
  /** 原文書名 — the original-language title shown under the Chinese title. */
  originalTitle?: string;
  /** Authors as listed on the product page (zh transliterations). */
  zhAuthors?: string[];
  /** 原文作者 — author names in the source language. */
  originalAuthors?: string[];
  /** 譯者 — Chinese translator(s). */
  zhTranslators?: string[];
  /** 出版社 — publisher name (zh). */
  publisher?: string;
  /** Year extracted from 出版日期. */
  year?: number;
  /** ISBN-13. */
  isbn13?: string;
  /** 內容簡介 — the publisher's plot blurb in zh-TW. */
  synopsisZh?: string;
}

/**
 * Extract the books.com.tw item id from any URL we have on a Work record.
 * Handles both canonical /products/<id> URLs and the /redirect/.../item/<id>/...
 * shape that the search adapter sometimes preserves.
 */
export function extractBooksTwItemId(url: string | undefined | null): string | null {
  if (!url) return null;
  const m1 = url.match(/\/products\/([A-Za-z0-9]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/\/item\/([A-Za-z0-9]+)/);
  if (m2) return m2[1];
  return null;
}

/**
 * Fetch + parse a Books.com.tw product page. Returns null on any error.
 * Polite throttle is per-host, so this won't burst against books.com.tw.
 */
export async function fetchBooksTwProduct(
  itemId: string,
): Promise<BooksTwProductDetails | null> {
  const url = `https://www.books.com.tw/products/${itemId}`;
  let html: string;
  try {
    const res = await politeFetch(url, {
      hostDelayMs: 1500,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }
  return parseBooksTwProduct(html);
}

/**
 * Pure parser. Exposed for fixture-based unit tests.
 *
 * Strategy: run a list of label-match rules over the metadata <li> rows
 * inside the product header. Each rule pairs a label (作者, 原文作者,
 * 譯者, 出版社, 出版日期) with an extractor that pulls names or text from
 * the matched element. We work label-by-label rather than positionally
 * because the order isn't 100% stable across categories.
 */
export function parseBooksTwProduct(html: string): BooksTwProductDetails {
  const $ = cheerio.load(html);
  const out: BooksTwProductDetails = {};

  // 原文書名 — the second-level title. Several layouts try the same idea:
  //   <h2><a>...</a></h2>           (modern)
  //   <h2 class="origin-title">     (some categories)
  //   <p class="orig-name">         (legacy)
  const originalTitleSelectors = [
    '.mod_b h2 a',
    '.mod_b h2',
    'h2.origin-title a',
    'h2.origin-title',
    '.orig-name',
  ];
  for (const sel of originalTitleSelectors) {
    const t = $(sel).first().text().replace(/\s+/g, ' ').trim();
    if (t && t.length < 200) {
      out.originalTitle = t;
      break;
    }
  }

  // Metadata rows. The list usually lives in `.list_title` but books.com.tw
  // has shipped enough variations that we cast a wider net.
  const $rows = $('.list_title li, .info-item li, .mod_b ul li');

  $rows.each((_, el) => {
    const $el = $(el);
    // Prefer the FIRST direct text node (label) and pull names from <a>.
    const fullText = $el.text().replace(/\s+/g, ' ').trim();
    if (!fullText) return;

    // Helper: collect <a> text from this row, dropping the dummy
    // "新功能介紹" / "看更多" pseudo-links that books.com.tw appends.
    const linkNames = $el
      .find('a')
      .map((_, a) => $(a).text().trim())
      .get()
      .filter(s => s && !/新功能介紹|看更多|介紹/.test(s));

    // Order the label checks from MORE specific to LESS specific so
    // "原文作者" doesn't get caught by the "作者" rule.
    if (/原文作者/.test(fullText)) {
      if (linkNames.length) {
        out.originalAuthors = (out.originalAuthors ?? []).concat(linkNames);
      }
    } else if (/原文書名/.test(fullText) && !out.originalTitle) {
      // Some templates put the original title inside the metadata list.
      const candidate = (linkNames[0] ?? fullText.replace(/^.*?原文書名[::\s]*/, '')).trim();
      if (candidate) out.originalTitle = candidate;
    } else if (/^譯\s*者/.test(fullText) || /^譯者[::]/.test(fullText) || /譯\s*者[::]/.test(fullText)) {
      if (linkNames.length) {
        out.zhTranslators = (out.zhTranslators ?? []).concat(linkNames);
      }
    } else if (/^作\s*者/.test(fullText) || /^作者[::]/.test(fullText) || /作\s*者[::]/.test(fullText)) {
      if (linkNames.length) {
        out.zhAuthors = (out.zhAuthors ?? []).concat(linkNames);
      }
    } else if (/出版社/.test(fullText)) {
      if (linkNames.length && !out.publisher) out.publisher = linkNames[0];
    } else if (/出版日期/.test(fullText) && !out.year) {
      const m = fullText.match(/(19|20)\d{2}/);
      if (m) {
        const y = parseInt(m[0], 10);
        if (y >= 1900 && y <= 2100) out.year = y;
      }
    } else if (/^ISBN/i.test(fullText)) {
      const m = fullText.match(/(97[89]\d{10})/);
      if (m) out.isbn13 = m[1];
    }
  });

  // ISBN can also live in a separate panel (.bookDataInfo). Check there too.
  if (!out.isbn13) {
    const txt = $('.bookDataInfo').text();
    const m = txt.match(/(97[89]\d{10})/);
    if (m) out.isbn13 = m[1];
  }

  // 內容簡介 — the publisher's plot blurb. There are two common layouts:
  //   <div class="content"><h3>內容簡介</h3><p>...</p>...</div>
  //   <div class="bookIntroduction"><p>...</p>...</div>
  //
  // We grab every paragraph inside the matched container, join with blank
  // lines, and trim. Anti-spam heuristics: drop very short paragraphs
  // (likely award badges) and drop the trailing 作者介紹 / 媒體推薦 sections
  // when they're concatenated into the same container.
  const $intro =
    $('.content h3').filter((_, el) => /內容簡介/.test($(el).text())).first().parent().length
      ? $('.content h3').filter((_, el) => /內容簡介/.test($(el).text())).first().parent()
      : $('.bookIntroduction').first();
  if ($intro && $intro.length) {
    const paras: string[] = [];
    $intro.children('p').each((_, el) => {
      const t = $(el).text().replace(/^[\s　]+/, '').replace(/\s+$/, '');
      // Drop empty / star-decoration-only paragraphs — they're badges, not synopsis.
      if (!t) return;
      if (/^[\s　★☆◎※\-—]+$/.test(t)) return;
      // Drop very short single-line paragraphs that are clearly metadata
      // ("★1966 年紐伯瑞金牌獎"). Keep them only if they're prose-length.
      if (t.length < 30 && /^[★☆◎※]/.test(t)) return;
      paras.push(t);
    });
    const joined = paras.join('\n\n').trim();
    if (joined.length >= 60) out.synopsisZh = joined;
  }

  return out;
}
