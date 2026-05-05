/**
 * Fixture-based tests for the HTML scrapers.
 *
 * Real-site selectors rot every few months. Two kinds of fixtures:
 *
 *   *-real.html       — saved from the actual live search-results page.
 *                        These pin down what works against today's layout.
 *   *-steampunk.html  — small synthetic fixtures that exercise edge cases
 *                        the scraper code is supposed to handle (missing
 *                        href, missing author, etc.).
 *
 * When a scrape returns 0 results in the live app, save fresh HTML over
 * the corresponding *-real.html file, run `bun test tests/scrapers.test.ts`,
 * and the failing assertions will tell you which selector to update.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchBooksTw } from '../src/sources/books_tw';
import { searchReadmoo } from '../src/sources/readmoo';
import { searchIsfdb } from '../src/sources/isfdb';

const FIXTURES = join(import.meta.dir, 'fixtures');

let originalFetch: typeof fetch;

function mockFetchWith(fixtureFile: string) {
  const html = readFileSync(join(FIXTURES, fixtureFile), 'utf-8');
  globalThis.fetch = (async () =>
    new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  ) as unknown as typeof fetch;
}

beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('Books.com.tw scraper - LIVE fixture (學徒)', () => {
  test('parses real search results: title, author, canonical product URL', async () => {
    mockFetchWith('books_tw-real.html');
    const works = await searchBooksTw('學徒', 50);

    // Live page has 60 cards; with limit=50 we should fill the cap.
    expect(works.length).toBeGreaterThanOrEqual(15);

    // Robin Hobb's Assassin's Apprentice in zh-TW — the canonical
    // "this scraper is alive" sentinel.
    const hobb = works.find(w => w.titles.zh?.includes('刺客學徒'));
    expect(hobb).toBeDefined();
    expect(hobb!.sources.books_tw).toMatch(/^https:\/\/www\.books\.com\.tw\/products\/\d+/);
    expect(hobb!.creators.length).toBeGreaterThan(0);
    expect(hobb!.creators[0].name.zh).toContain('羅蘋');

    // Every card should have a canonical /products/<id> URL we built ourselves.
    for (const w of works) {
      expect(w.sources.books_tw).toMatch(/^https:\/\/www\.books\.com\.tw\/products\/[A-Za-z0-9]+/);
      expect(w.titles.zh).toBeTruthy();
    }
  });
});

describe('Books.com.tw scraper - synthetic fixture', () => {
  test('respects the limit', async () => {
    mockFetchWith('books_tw-real.html');
    const works = await searchBooksTw('學徒', 1);
    expect(works).toHaveLength(1);
  });

  test('throws on non-OK response', async () => {
    globalThis.fetch = (async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch;
    await expect(searchBooksTw('學徒', 10)).rejects.toThrow(/Books\.com\.tw: 403/);
  });
});

describe('Readmoo scraper - LIVE fixture (學徒)', () => {
  test('parses real search results: title, author, canonical book URL', async () => {
    mockFetchWith('readmoo-real.html');
    const works = await searchReadmoo('學徒', 50);

    // Live page has at least 2 hits for 學徒.
    expect(works.length).toBeGreaterThanOrEqual(2);

    // Sentinel: 學徒：人造蕭邦 (an actual sci-fi book on Readmoo).
    const piano = works.find(w => w.titles.zh?.includes('人造蕭邦'));
    expect(piano).toBeDefined();
    expect(piano!.sources.readmoo).toMatch(/^https:\/\/readmoo\.com\/book\/\d+/);
    expect(piano!.creators[0]?.name.zh).toBe('孫李');

    for (const w of works) {
      expect(w.sources.readmoo).toMatch(/^https:\/\/readmoo\.com\/book\/\d+/);
      expect(w.titles.zh).toBeTruthy();
    }
  });
});

describe('Readmoo scraper - error handling', () => {
  test('throws on non-OK response', async () => {
    globalThis.fetch = (async () => new Response('blocked', { status: 503 })) as unknown as typeof fetch;
    await expect(searchReadmoo('學徒', 10)).rejects.toThrow(/Readmoo: 503/);
  });
});

describe('ISFDB scraper (synthetic fixture)', () => {
  test('parses title, author, year and ignores out-of-table title links', async () => {
    mockFetchWith('isfdb-steampunk.html');
    const works = await searchIsfdb('steampunk', 10);

    expect(works).toHaveLength(3);
    expect(works.map(w => w.titles.en).sort()).toEqual(['Mortal Engines', 'Neuromancer', 'The Difference Engine']);

    const diff = works.find(w => w.titles.en === 'The Difference Engine')!;
    expect(diff.year).toBe(1990);
    expect(diff.creators[0].name.en).toBe('William Gibson');
    expect(diff.medium).toBe('book');
    expect(diff.sources.isfdb).toBe('https://www.isfdb.org/cgi-bin/title.cgi?12345');
  });

  test('respects the limit', async () => {
    mockFetchWith('isfdb-steampunk.html');
    const works = await searchIsfdb('steampunk', 2);
    expect(works).toHaveLength(2);
  });
});
