/**
 * Tests for the synopsis enrichment pipeline (Wikipedia + Reddit).
 *
 * Real network is mocked via the global fetch monkey-patch. The fixtures
 * live inline because the JSON shapes are short and stable.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { enrichFromWikipedia } from '../src/enrich/wikipedia';
import { enrichFromReddit } from '../src/enrich/reddit';
import { enrichFromPlurk, parsePlurkHtml } from '../src/enrich/plurk';
import { enrichWork, cleanWikiQuery } from '../src/enrich';
import type { Work } from '../src/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

// ---- Wikipedia ---------------------------------------------------------

const WIKI_SEARCH_BODY = (title: string) =>
  JSON.stringify({ query: { search: [{ title }] } });
const WIKI_EXTRACT_BODY = (title: string, extract: string) =>
  JSON.stringify({ query: { pages: { '12345': { title, extract } } } });

function mockWikipedia(map: Record<string, string>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    if (url.includes('list=search')) {
      const q = decodeURIComponent(url.match(/srsearch=([^&]+)/)?.[1] ?? '');
      const titleHit = Object.keys(map).find(k => q.includes(k.split(' ')[0]));
      if (!titleHit) return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 });
      return new Response(WIKI_SEARCH_BODY(titleHit), { status: 200 });
    }
    if (url.includes('prop=extracts')) {
      const t = decodeURIComponent(url.match(/titles=([^&]+)/)?.[1] ?? '').replace(/_/g, ' ');
      const text = map[t] ?? '';
      return new Response(WIKI_EXTRACT_BODY(t, text), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('Wikipedia enrichment', () => {
  test('returns intro paragraph for an English query', async () => {
    mockWikipedia({
      "Assassin's Apprentice": 'Assassin\'s Apprentice is a 1995 fantasy novel by Robin Hobb. It introduces FitzChivalry Farseer.',
    });
    const out = await enrichFromWikipedia({ enQuery: "Assassin's Apprentice" });
    expect(out).toHaveLength(1);
    expect(out[0].lang).toBe('en');
    expect(out[0].title).toBe("Assassin's Apprentice");
    expect(out[0].text).toContain('Robin Hobb');
    expect(out[0].url).toContain('en.wikipedia.org/wiki/');
  });

  test('skips disambiguation pages', async () => {
    mockWikipedia({
      'Apprentice': 'Apprentice may refer to: an apprentice in a trade, etc.',
    });
    const out = await enrichFromWikipedia({ enQuery: 'Apprentice' });
    expect(out).toEqual([]);
  });

  test('returns both en and zh when both queries provided', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls++;
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      const isZh = url.includes('zh.wikipedia.org');
      if (url.includes('list=search')) {
        return new Response(JSON.stringify({
          query: { search: [{ title: isZh ? '刺客學徒' : "Assassin's Apprentice" }] },
        }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        return new Response(JSON.stringify({
          query: { pages: { '1': {
            title: isZh ? '刺客學徒' : "Assassin's Apprentice",
            extract: isZh ? '《刺客學徒》是羅蘋·荷布的奇幻小說。' : 'A 1995 fantasy novel by Robin Hobb.',
          } } },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;
    const out = await enrichFromWikipedia({ enQuery: "Assassin's Apprentice", zhQuery: '刺客學徒' });
    expect(out).toHaveLength(2);
    expect(out.find(x => x.lang === 'en')!.text).toContain('Robin Hobb');
    expect(out.find(x => x.lang === 'zh')!.text).toContain('刺客學徒');
    expect(calls).toBe(4); // 2 langs × (search + extract)
  });

  test('on network failure returns []', async () => {
    globalThis.fetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const out = await enrichFromWikipedia({ enQuery: 'X' });
    expect(out).toEqual([]);
  });

  test('resolves zh via en→zh langlink instead of zh search', async () => {
    // Simulates the "刺客學徒 → 森川智之 voice actor" failure mode.
    // When we ALSO query zh, the zh search would return the unrelated voice
    // actor article. But because the en article exposes a langlink to the
    // correct zh article ("刺客學徒"), we must prefer the langlink path
    // and never fire a zh search at all.
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      calls.push(url);
      const isZh = url.includes('zh.wikipedia.org');
      const isEn = url.includes('en.wikipedia.org');
      if (url.includes('list=search')) {
        if (isEn) {
          return new Response(JSON.stringify({
            query: { search: [{ title: "Assassin's Apprentice" }] },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          query: { search: [{ title: '森川智之' }] },
        }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        if (isEn) {
          return new Response(JSON.stringify({
            query: { pages: { '1': {
              title: "Assassin's Apprentice",
              extract: "Assassin's Apprentice is a 1995 fantasy novel by Robin Hobb.",
              langlinks: [
                { lang: 'zh', '*': '刺客學徒' },
                { lang: 'fr', '*': "L'Assassin royal" },
              ],
            } } },
          }), { status: 200 });
        }
        if (isZh) {
          const t = decodeURIComponent(url.match(/titles=([^&]+)/)?.[1] ?? '').replace(/_/g, ' ');
          if (t === '刺客學徒') {
            return new Response(JSON.stringify({
              query: { pages: { '1': {
                title: '刺客學徒',
                extract: '《刺客學徒》是羅蘋·荷布的奇幻小說。',
              } } },
            }), { status: 200 });
          }
          if (t === '森川智之') {
            return new Response(JSON.stringify({
              query: { pages: { '1': {
                title: '森川智之',
                extract: '森川智之是一名日本男性配音員。',
              } } },
            }), { status: 200 });
          }
        }
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const out = await enrichFromWikipedia({
      enQuery: "Assassin's Apprentice",
      zhQuery: '刺客學徒',
    });

    expect(out).toHaveLength(2);
    const zh = out.find(x => x.lang === 'zh')!;
    expect(zh.title).toBe('刺客學徒');
    expect(zh.text).toContain('羅蘋·荷布');
    expect(out.some(x => x.text.includes('配音員'))).toBe(false);
    const zhSearchHits = calls.filter(u => u.includes('zh.wikipedia.org') && u.includes('list=search'));
    expect(zhSearchHits).toHaveLength(0);
  });

  test('rejects fallback zh search hit that does not mention any validator', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      const isEn = url.includes('en.wikipedia.org');
      const isZh = url.includes('zh.wikipedia.org');
      if (url.includes('list=search')) {
        return new Response(JSON.stringify({
          query: { search: [{ title: isEn ? "Assassin's Apprentice" : '森川智之' }] },
        }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        if (isEn) {
          return new Response(JSON.stringify({
            query: { pages: { '1': {
              title: "Assassin's Apprentice",
              extract: "Assassin's Apprentice is a 1995 fantasy novel by Robin Hobb.",
            } } },
          }), { status: 200 });
        }
        if (isZh) {
          return new Response(JSON.stringify({
            query: { pages: { '1': {
              title: '森川智之',
              extract: '森川智之是一名日本男性配音員,出生於東京都。',
            } } },
          }), { status: 200 });
        }
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const out = await enrichFromWikipedia({
      enQuery: "Assassin's Apprentice",
      zhQuery: '刺客學徒',
      validators: ['Robin Hobb', "Assassin's Apprentice", '刺客學徒'],
    });

    expect(out.map(x => x.lang).sort()).toEqual(['en']);
    expect(out.find(x => x.lang === 'en')!.text).toContain('Robin Hobb');
  });

  test('zh-only work anchors on zh and resolves en via langlinks', async () => {
    // Real failure mode: a Books.com.tw record gives us titles.zh
    // ("刺客學徒") but no titles.en. Old code anchored on en and fell back
    // to the creator name as the en search query, returning Robin Hobb's
    // *biography* instead of the novel article. New code anchors on zh,
    // and the zh article's langlinks resolve the correct en article.
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      calls.push(url);
      const isZh = url.includes('zh.wikipedia.org');
      const isEn = url.includes('en.wikipedia.org');
      if (url.includes('list=search')) {
        if (isZh) {
          return new Response(JSON.stringify({
            query: { search: [{ title: '刺客學徒' }] },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        if (isZh) {
          return new Response(JSON.stringify({
            query: { pages: { '1': {
              title: '刺客學徒',
              extract: '《刺客學徒》是羅蘋·荷布於 1995 年出版的奇幻小說。',
              langlinks: [
                { lang: 'en', '*': "Assassin's Apprentice" },
              ],
            } } },
          }), { status: 200 });
        }
        if (isEn) {
          const t = decodeURIComponent(url.match(/titles=([^&]+)/)?.[1] ?? '').replace(/_/g, ' ');
          if (t === "Assassin's Apprentice") {
            return new Response(JSON.stringify({
              query: { pages: { '1': {
                title: "Assassin's Apprentice",
                extract: "Assassin's Apprentice is a 1995 fantasy novel by Robin Hobb.",
              } } },
            }), { status: 200 });
          }
        }
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const out = await enrichFromWikipedia({ zhQuery: '刺客學徒' });

    expect(out.map(x => x.lang).sort()).toEqual(['en', 'zh']);
    expect(out.find(x => x.lang === 'zh')!.text).toContain('羅蘋·荷布');
    expect(out.find(x => x.lang === 'en')!.text).toContain('Robin Hobb');
    const enSearchHits = calls.filter(u => u.includes('en.wikipedia.org') && u.includes('list=search'));
    expect(enSearchHits).toHaveLength(0);
  });

  test('returns [] when no language has a query', async () => {
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response('{}'); }) as unknown as typeof fetch;
    const out = await enrichFromWikipedia({});
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });

  test('keeps fallback zh hit that mentions a validator', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      const isEn = url.includes('en.wikipedia.org');
      const isZh = url.includes('zh.wikipedia.org');
      if (url.includes('list=search')) {
        return new Response(JSON.stringify({
          query: { search: [{ title: isEn ? "Assassin's Apprentice" : '刺客學徒' }] },
        }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        if (isEn) {
          return new Response(JSON.stringify({
            query: { pages: { '1': {
              title: "Assassin's Apprentice",
              extract: 'A 1995 fantasy novel by Robin Hobb.',
            } } },
          }), { status: 200 });
        }
        if (isZh) {
          return new Response(JSON.stringify({
            query: { pages: { '1': {
              title: '刺客學徒',
              extract: '《刺客學徒》是羅蘋·荷布的奇幻小說。',
            } } },
          }), { status: 200 });
        }
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const out = await enrichFromWikipedia({
      enQuery: "Assassin's Apprentice",
      zhQuery: '刺客學徒',
      validators: ['Robin Hobb', "Assassin's Apprentice", '刺客學徒'],
    });

    expect(out.map(x => x.lang).sort()).toEqual(['en', 'zh']);
  });
});

// ---- cleanWikiQuery ---------------------------------------------------

describe('cleanWikiQuery', () => {
  test('strips common Books.com.tw / Readmoo edition suffixes', () => {
    expect(cleanWikiQuery('刺客正傳1刺客學徒(經典紀念版)')).toBe('刺客正傳1刺客學徒');
    expect(cleanWikiQuery('Neuromancer (Sprawl, #1)')).toBe('Neuromancer');
    expect(cleanWikiQuery('AKIRA(完全版)（豪華版）')).toBe('AKIRA');
  });
  test('returns undefined for null/undefined/empty input', () => {
    expect(cleanWikiQuery(undefined)).toBeUndefined();
    expect(cleanWikiQuery(null)).toBeUndefined();
    expect(cleanWikiQuery('   ')).toBeUndefined();
  });
  test('never collapses to empty when input is just a parenthetical', () => {
    // "(全)" alone shouldn't get stripped to '' — keep it as-is.
    expect(cleanWikiQuery('(全)')).toBe('(全)');
  });
});

// ---- Reddit ------------------------------------------------------------

function mockReddit(threads: Array<{ sub?: string; title: string; selftext: string; score?: number; permalink?: string }>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    const subMatch = url.match(/\/r\/([^/]+)\/search\.json/);
    const sub = subMatch?.[1] ?? '?';
    const matching = threads.filter(t => (t.sub ?? sub) === sub);
    return new Response(JSON.stringify({
      data: {
        children: matching.map(t => ({
          data: {
            title: t.title,
            selftext: t.selftext,
            permalink: t.permalink ?? `/r/${sub}/comments/abc/${t.title.replace(/\s+/g, '_')}/`,
            subreddit: sub,
            score: t.score ?? 100,
            num_comments: 12,
          },
        })),
      },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('Reddit enrichment', () => {
  test('returns top-scoring threads with non-trivial bodies', async () => {
    mockReddit([
      {
        sub: 'Fantasy', title: 'Just finished Assassin\'s Apprentice — wow',
        selftext: 'A long, thoughtful post about FitzChivalry Farseer and how the book reframes the chosen-one tradition. '.repeat(3),
        score: 500,
      },
      {
        sub: 'printSF', title: 'Hobb worth starting with this one?',
        selftext: 'Yes — start here. The slow-burn pacing pays off in Royal Assassin. '.repeat(2),
        score: 200,
      },
    ]);
    const out = await enrichFromReddit({ enTitle: "Assassin's Apprentice", limit: 5 });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
    expect(out[0].text.length).toBeGreaterThan(80);
    expect(out[0].url).toMatch(/^https:\/\/www\.reddit\.com\//);
  });

  test('skips link-only / very short posts', async () => {
    mockReddit([
      { sub: 'Fantasy', title: 'Link', selftext: '', score: 999 },
      { sub: 'Fantasy', title: 'too short', selftext: 'meh', score: 999 },
      { sub: 'Fantasy', title: 'real post', selftext: 'A genuinely long discussion about the book. '.repeat(5), score: 100 },
    ]);
    const out = await enrichFromReddit({ enTitle: 'X' });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('real post');
  });

  test('respects the limit', async () => {
    mockReddit(Array.from({ length: 10 }, (_, i) => ({
      sub: 'Fantasy', title: `t${i}`, selftext: 'A '.repeat(60), score: 1000 - i,
    })));
    const out = await enrichFromReddit({ enTitle: 'X', limit: 3 });
    expect(out).toHaveLength(3);
    expect(out.map(x => x.title)).toEqual(['t0', 't1', 't2']);
  });

  test('empty title -> empty result, no fetch attempted', async () => {
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response('{}'); }) as unknown as typeof fetch;
    const out = await enrichFromReddit({ enTitle: '   ' });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });
});

// ---- Plurk -------------------------------------------------------------

describe('Plurk enrichment - LIVE fixture (刺客學徒)', () => {
  test('parses real plurks: pid, content, permalink, response count', () => {
    const html = readFileSync(
      join(import.meta.dir, 'fixtures', 'plurk-real.html'),
      'utf-8',
    );
    const out = parsePlurkHtml(html, 10);
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const p of out) {
      expect(p.pid).toMatch(/^\d+$/);
      expect(p.url).toMatch(/^https:\/\/www\.plurk\.com\//);
      expect(p.text.length).toBeGreaterThan(20);
      expect(p.lang).toBe('zh');
    }
    const corpus = out.map(p => p.text).join(' ');
    expect(corpus).toContain('學徒');
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].respCount).toBeGreaterThanOrEqual(out[i].respCount);
    }
  });

  test('skips form_holder / non-post wrappers', () => {
    const html = readFileSync(
      join(import.meta.dir, 'fixtures', 'plurk-real.html'),
      'utf-8',
    );
    const out = parsePlurkHtml(html, 50);
    for (const p of out) {
      expect(p.pid.startsWith('form_')).toBe(false);
      expect(p.pid).not.toBe('form_holder');
    }
  });

  test('respects the limit', () => {
    const html = readFileSync(
      join(import.meta.dir, 'fixtures', 'plurk-real.html'),
      'utf-8',
    );
    const out = parsePlurkHtml(html, 1);
    expect(out).toHaveLength(1);
  });

  test('on non-OK fetch returns empty array', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('blocked', { status: 503 })) as unknown as typeof fetch;
    try {
      const out = await enrichFromPlurk({ query: '刺客學徒' });
      expect(out).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('empty query short-circuits without fetching', async () => {
    let called = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { called++; return new Response('{}'); }) as unknown as typeof fetch;
    try {
      const out = await enrichFromPlurk({ query: '   ' });
      expect(out).toEqual([]);
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---- Orchestrator ------------------------------------------------------

describe('enrichWork orchestrator', () => {
  const baseWork: Work = {
    sources: { isfdb: 'https://x' },
    titles: { en: "Assassin's Apprentice", zh: '刺客學徒' },
    creators: [{ name: { en: 'Robin Hobb' }, role: 'author' }],
    medium: 'book',
    raw: {},
    synopsis: { zh: '原始的中文簡介。' },
  };

  test('Wikipedia material lands in synopsis; Reddit/Plurk go to reception (NOT synopsis)', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.includes('reddit.com')) {
        return new Response(JSON.stringify({
          data: { children: [{ data: {
            title: 'Reddit thread title',
            selftext: 'A long Reddit thread body that discusses Hobb at length. '.repeat(5),
            permalink: '/r/Fantasy/comments/x/y/', subreddit: 'Fantasy', score: 200, num_comments: 10,
          } }] },
        }), { status: 200 });
      }
      if (url.includes('list=search')) {
        const isZh = url.includes('zh.wikipedia.org');
        return new Response(JSON.stringify({
          query: { search: [{ title: isZh ? '刺客學徒' : "Assassin's Apprentice" }] },
        }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        const isZh = url.includes('zh.wikipedia.org');
        return new Response(JSON.stringify({
          query: { pages: { '1': {
            title: isZh ? '刺客學徒' : "Assassin's Apprentice",
            extract: isZh
              ? '《刺客學徒》是羅蘋·荷布的奇幻小說,出版於 1995 年。'
              : "Assassin's Apprentice is a 1995 fantasy novel by Robin Hobb.",
          } } },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const { work: enriched, reception, report } = await enrichWork(baseWork);

    expect(enriched.synopsis?.zh).toContain('原始的中文簡介');
    expect(enriched.synopsis?.zh).toContain('維基百科:刺客學徒');
    expect(enriched.synopsis?.zh).toContain('刺客學徒');
    expect(enriched.synopsis?.zh).toContain('羅蘋·荷布');

    expect(enriched.synopsis?.en).toContain('Wikipedia:');
    expect(enriched.synopsis?.en).toContain('Robin Hobb');

    expect(enriched.synopsis?.en ?? '').not.toContain('Reddit');
    expect(enriched.synopsis?.en ?? '').not.toContain('A long Reddit thread body');
    expect(enriched.synopsis?.zh ?? '').not.toContain('Reddit');

    expect(reception.reddit.length).toBeGreaterThan(0);
    expect(reception.reddit[0].subreddit).toBe('Fantasy');
    expect(reception.reddit[0].text).toContain('discusses Hobb');
    expect(Array.isArray(reception.plurk)).toBe(true);

    expect(report.wikipedia.length).toBe(2);
    expect(report.reddit.length).toBeGreaterThan(0);
    expect(Array.isArray(report.plurk)).toBe(true);

    const ann = (enriched.raw as Record<string, unknown>)._enrichment;
    expect(ann).toBeDefined();
  });

  test('zh-only work (no titles.en) still produces en+zh via langlinks anchored on zh', async () => {
    // The Books.com.tw failure mode end-to-end: only titles.zh is populated,
    // and the orchestrator must NOT fall back to creator name for the en
    // query. Anchoring on zh + harvesting the zh article's en langlink
    // produces the correct en article without ever searching en.
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      calls.push(url);
      if (url.includes('reddit.com') || url.includes('plurk.com')) {
        return new Response(JSON.stringify({ data: { children: [] } }), { status: 200 });
      }
      const isZh = url.includes('zh.wikipedia.org');
      const isEn = url.includes('en.wikipedia.org');
      if (url.includes('list=search')) {
        if (isZh) {
          return new Response(JSON.stringify({
            query: { search: [{ title: '刺客學徒' }] },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        if (isZh) {
          return new Response(JSON.stringify({
            query: { pages: { '1': {
              title: '刺客學徒',
              extract: '《刺客學徒》是羅蘋·荷布於 1995 年出版的奇幻小說。',
              langlinks: [{ lang: 'en', '*': "Assassin's Apprentice" }],
            } } },
          }), { status: 200 });
        }
        if (isEn) {
          return new Response(JSON.stringify({
            query: { pages: { '1': {
              title: "Assassin's Apprentice",
              extract: "Assassin's Apprentice is a 1995 fantasy novel by Robin Hobb.",
            } } },
          }), { status: 200 });
        }
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const zhOnlyWork: Work = {
      sources: { books_tw: 'https://x' },
      // The Books.com.tw raw title includes publisher noise.
      titles: { zh: '刺客正傳1刺客學徒(經典紀念版)' },
      creators: [{ name: { en: 'Robin Hobb', zh: '羅蘋·荷布' }, role: 'author' }],
      medium: 'book',
      raw: {},
    };

    const { work: enriched } = await enrichWork(zhOnlyWork);

    // Both en and zh synopsis populated, despite no titles.en.
    expect(enriched.synopsis?.en).toContain('Wikipedia:');
    expect(enriched.synopsis?.en).toContain('Robin Hobb');
    expect(enriched.synopsis?.zh).toContain('維基百科:刺客學徒');
    expect(enriched.synopsis?.zh).toContain('羅蘋·荷布');
    // We must NOT have searched en wiki by the creator name (the old
    // failure mode that returned the author bio).
    const enSearchHits = calls.filter(u => u.includes('en.wikipedia.org') && u.includes('list=search'));
    expect(enSearchHits).toHaveLength(0);
    // Cleaned query "刺客正傳1刺客學徒" reached zh search (no parenthetical noise).
    const zhSearchUrl = calls.find(u => u.includes('zh.wikipedia.org') && u.includes('list=search'));
    expect(zhSearchUrl).toBeDefined();
    expect(decodeURIComponent(zhSearchUrl!)).toContain('刺客正傳1刺客學徒');
    expect(decodeURIComponent(zhSearchUrl!)).not.toContain('經典紀念版');
  });

  test('manga with kana original triggers ja Wikipedia query', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      calls.push(url);
      if (url.includes('reddit.com') || url.includes('plurk.com')) {
        return new Response(JSON.stringify({ data: { children: [] } }), { status: 200 });
      }
      const isJa = url.includes('ja.wikipedia.org');
      const isZh = url.includes('zh.wikipedia.org');
      const isEn = url.includes('en.wikipedia.org');
      const title = isJa ? 'AKIRA (漫画)' : isZh ? '阿基拉' : 'Akira (manga)';
      if (url.includes('list=search')) {
        return new Response(JSON.stringify({ query: { search: [{ title }] } }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        const extract = isJa ? '『AKIRA』は大友克洋による日本の漫画。'
          : isZh ? '《阿基拉》是大友克洋所創作的日本漫畫。'
          : isEn ? 'Akira is a Japanese manga series by Katsuhiro Otomo.'
          : '';
        return new Response(JSON.stringify({
          query: { pages: { '1': { title, extract } } },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const mangaWork: Work = {
      sources: { anilist: 'https://x' },
      titles: { en: 'Akira', zh: '阿基拉', original: 'アキラ' },
      creators: [{ name: { en: 'Katsuhiro Otomo' }, role: 'author' }],
      medium: 'manga',
      raw: {},
    };

    const { work: enriched, report } = await enrichWork(mangaWork);

    expect(calls.some(u => u.includes('ja.wikipedia.org'))).toBe(true);
    expect(report.wikipedia.find(w => w.lang === 'ja')).toBeDefined();
    expect(enriched.synopsis?.en).toContain('Wikipedia (ja):');
    expect(enriched.synopsis?.en).toContain('大友克洋');
  });

  test('manhwa with hangul original triggers ko Wikipedia query', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      calls.push(url);
      if (url.includes('reddit.com') || url.includes('plurk.com')) {
        return new Response(JSON.stringify({ data: { children: [] } }), { status: 200 });
      }
      const isKo = url.includes('ko.wikipedia.org');
      const title = isKo ? '신과함께' : 'Along With the Gods';
      if (url.includes('list=search')) {
        return new Response(JSON.stringify({ query: { search: [{ title }] } }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        const extract = isKo
          ? '《신과함께》는 주호민 작가의 한국 웹툰이다.'
          : 'Along With the Gods is a Korean webtoon by Joo Ho-min.';
        return new Response(JSON.stringify({
          query: { pages: { '1': { title, extract } } },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const manhwaWork: Work = {
      sources: { anilist: 'https://x' },
      titles: { en: 'Along With the Gods', zh: '與神同行', original: '신과함께' },
      creators: [{ name: { en: 'Joo Ho-min' }, role: 'author' }],
      medium: 'comic',
      raw: {},
    };

    const { work: enriched, report } = await enrichWork(manhwaWork);

    expect(calls.some(u => u.includes('ko.wikipedia.org'))).toBe(true);
    expect(report.wikipedia.find(w => w.lang === 'ko')).toBeDefined();
    expect(enriched.synopsis?.en).toContain('Wikipedia (ko):');
    expect(enriched.synopsis?.en).toContain('주호민');
  });

  test('LLM title resolver supplies en title -> Reddit fires + en backfilled', async () => {
    // The end-to-end zh-only Books.com.tw scenario WITH LLM available.
    // The LLM mock resolves the noisy Books.com.tw title to "Assassin's
    // Apprentice", which (a) lets Reddit search the English SFF subs and
    // (b) gives Wikipedia an en anchor, AND (c) is backfilled into the
    // returned Work so the writeup payload sees title_en.
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      calls.push(url);

      // LLM resolver call (Anthropic shape).
      if (url.includes('api.anthropic.com')) {
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({
            english_title: "Assassin's Apprentice",
            chinese_title: '刺客學徒',
            original_title: null,
            confidence: 'high',
          }) }],
        }), { status: 200 });
      }

      if (url.includes('reddit.com')) {
        const q = decodeURIComponent(url.match(/[?&]q=([^&]+)/)?.[1] ?? '');
        if (q.includes("Assassin's Apprentice")) {
          return new Response(JSON.stringify({
            data: { children: [{ data: {
              title: 'r/Fantasy take',
              selftext: 'A long-form discussion of FitzChivalry Farseer and the chosen-one inversion. '.repeat(3),
              permalink: '/r/Fantasy/comments/x/y/', subreddit: 'Fantasy', score: 400, num_comments: 30,
            } }] },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { children: [] } }), { status: 200 });
      }

      if (url.includes('plurk.com')) {
        return new Response('<html></html>', { status: 200 });
      }

      const isEn = url.includes('en.wikipedia.org');
      const isZh = url.includes('zh.wikipedia.org');
      if (url.includes('list=search')) {
        if (isEn) {
          return new Response(JSON.stringify({
            query: { search: [{ title: "Assassin's Apprentice" }] },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        if (isEn) {
          return new Response(JSON.stringify({
            query: { pages: { '1': {
              title: "Assassin's Apprentice",
              extract: "Assassin's Apprentice is a 1995 fantasy novel by Robin Hobb.",
              langlinks: [{ lang: 'zh', '*': '刺客學徒' }],
            } } },
          }), { status: 200 });
        }
        if (isZh) {
          const t = decodeURIComponent(url.match(/titles=([^&]+)/)?.[1] ?? '').replace(/_/g, ' ');
          if (t === '刺客學徒') {
            return new Response(JSON.stringify({
              query: { pages: { '1': {
                title: '刺客學徒',
                extract: '《刺客學徒》是羅蘋·荷布於 1995 年出版的奇幻小說。',
              } } },
            }), { status: 200 });
          }
        }
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const zhOnlyWork: Work = {
      sources: { books_tw: 'https://x' },
      titles: { zh: '刺客正傳1刺客學徒(經典紀念版)' },
      creators: [{ name: { en: 'Robin Hobb', zh: '羅蘋·荷布' }, role: 'author' }],
      medium: 'book',
      raw: {},
    };

    const { work: enriched, reception, report } = await enrichWork(
      zhOnlyWork,
      { provider: 'anthropic', apiKey: 'sk-test' },
    );

    expect(calls.some(u => u.includes('api.anthropic.com'))).toBe(true);
    expect(report.resolved?.english_title).toBe("Assassin's Apprentice");

    const redditCalls = calls.filter(u => u.includes('reddit.com'));
    expect(redditCalls.length).toBeGreaterThan(0);
    expect(redditCalls.some(u => decodeURIComponent(u).includes("Assassin's Apprentice"))).toBe(true);
    expect(reception.reddit.length).toBeGreaterThan(0);
    expect(reception.reddit[0].text).toContain('FitzChivalry Farseer');

    expect(enriched.titles.en).toBe("Assassin's Apprentice");
    expect(enriched.titles.zh).toBe('刺客學徒');

    const zhSearchCalls = calls.filter(u => u.includes('zh.wikipedia.org') && u.includes('list=search'));
    expect(zhSearchCalls).toHaveLength(0);
    expect(enriched.synopsis?.en).toContain('Robin Hobb');
    expect(enriched.synopsis?.zh).toContain('羅蘋·荷布');
  });

  test('LLM resolver returning low-confidence is ignored (existing fallback path runs)', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.includes('api.anthropic.com')) {
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({
            english_title: 'Made Up English Title',
            chinese_title: null,
            original_title: null,
            confidence: 'low',
          }) }],
        }), { status: 200 });
      }
      if (url.includes('reddit.com') || url.includes('plurk.com')) {
        return new Response(JSON.stringify({ data: { children: [] } }), { status: 200 });
      }
      if (url.includes('list=search')) {
        return new Response(JSON.stringify({
          query: { search: [{ title: '刺客學徒' }] },
        }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        return new Response(JSON.stringify({
          query: { pages: { '1': {
            title: '刺客學徒',
            extract: '《刺客學徒》是羅蘋·荷布的奇幻小說。',
            langlinks: [{ lang: 'en', '*': "Assassin's Apprentice" }],
          } } },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const zhOnlyWork: Work = {
      sources: { books_tw: 'https://x' },
      titles: { zh: '刺客學徒' },
      creators: [{ name: { en: 'Robin Hobb' }, role: 'author' }],
      medium: 'book',
      raw: {},
    };

    const { work: enriched } = await enrichWork(zhOnlyWork, { provider: 'anthropic', apiKey: 'k' });
    expect(enriched.titles.en).not.toBe('Made Up English Title');
  });

  test('books_tw deep-fetch supplies authoritative en title + zh names + zh synopsis (no LLM transliteration)', async () => {
    const productHtml = [
      '<html><body><div class=\"mod_b\">',
      '<h1>畫家的祕密學徒</h1>',
      '<h2><a>I, Juan de Pareja</a></h2>',
      '<ul class=\"list_title\">',
      '<li>作者: <a>伊莉莎白．波頓．崔維尼奧</a></li>',
      '<li>原文作者: <a>Elizabeth Borton de Treviño</a></li>',
      '<li>譯者: <a>柯清心</a></li>',
      '<li>出版社: <a>小麥田</a></li>',
      '<li>出版日期:2022/03/26</li>',
      '</ul>',
      '<div class=\"bookDataInfo\">ISBN:9786267000694</div>',
      '</div>',
      '<div class=\"content\">',
      '<h3>內容簡介</h3>',
      '<p>十七世紀的西班牙宮廷裡,畫家委拉斯奎茲身邊有一位沉默而忠誠的奴隸——胡安.德.巴雷哈.胡安自小被當作財產買賣,輾轉到了塞維亞委拉斯奎茲畫室,他不能說話、不能讀書,但日復一日凝視著主人筆下成形的肖像,胡安偷偷學會了畫畫.</p>',
      '<p>這部作品以胡安第一人稱回憶錄寫成,描繪十七世紀西班牙宮廷生活、藝術家工坊的日常勞動.</p>',
      '</div>',
      '</body></html>',
    ].join('');
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      calls.push(url);
      if (url.includes('books.com.tw/products/')) {
        return new Response(productHtml, { status: 200 });
      }
      if (url.includes('api.anthropic.com')) {
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({
            english_title: 'I, Juan de Pareja',
            chinese_title: '畫家的祕密學徒',
            original_title: null,
            confidence: 'high',
          }) }],
        }), { status: 200 });
      }
      if (url.includes('reddit.com')) {
        return new Response(JSON.stringify({ data: { children: [] } }), { status: 200 });
      }
      if (url.includes('plurk.com')) {
        return new Response('<html></html>', { status: 200 });
      }
      if (url.includes('list=search')) {
        return new Response(JSON.stringify({
          query: { search: [{ title: 'I, Juan de Pareja' }] },
        }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        return new Response(JSON.stringify({
          query: { pages: { '1': {
            title: 'I, Juan de Pareja',
            extract: 'I, Juan de Pareja is a 1965 historical novel by Elizabeth Borton de Treviño.',
          } } },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const booksTwWork: Work = {
      sources: { books_tw: 'https://www.books.com.tw/products/0010918750' },
      titles: { zh: '畫家的祕密學徒(紐伯瑞金獎作品‧全新經典珍藏版)' },
      creators: [{ name: { zh: '伊莉莎白．波頓．崔維尼奧' }, role: 'author' }],
      medium: 'book',
      raw: {},
    };

    const { work: enriched } = await enrichWork(
      booksTwWork,
      { provider: 'anthropic', apiKey: 'sk-test' },
    );

    expect(calls.some(u => u.includes('/products/0010918750'))).toBe(true);
    expect(enriched.titles.en).toBe('I, Juan de Pareja');
    const author = enriched.creators.find(c => c.role === 'author');
    expect(author).toBeDefined();
    expect(author!.name.zh).toBe('伊莉莎白．波頓．崔維尼奧');
    expect(author!.name.en).toBe('Elizabeth Borton de Treviño');
    const translator = enriched.creators.find(c => c.role === 'translator');
    expect(translator).toBeDefined();
    expect(translator!.name.zh).toBe('柯清心');
    expect(enriched.isbn13).toBe('9786267000694');
    expect(enriched.year).toBe(2022);
    expect(enriched.synopsis?.zh).toBeDefined();
    expect(enriched.synopsis?.zh).toContain('胡安');
    expect(enriched.synopsis?.zh).toContain('委拉斯奎茲');
    expect(enriched.synopsis?.zh).toContain('十七世紀');
  });

  test('books_tw deep-fetch is skipped when titles.en is already present', async () => {
    let productCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.includes('books.com.tw/products/')) productCalls++;
      if (url.includes('reddit.com') || url.includes('plurk.com')) {
        return new Response(JSON.stringify({ data: { children: [] } }), { status: 200 });
      }
      if (url.includes('list=search')) {
        return new Response(JSON.stringify({
          query: { search: [{ title: "Assassin's Apprentice" }] },
        }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        return new Response(JSON.stringify({
          query: { pages: { '1': {
            title: "Assassin's Apprentice",
            extract: "Assassin's Apprentice is a 1995 fantasy novel by Robin Hobb.",
          } } },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const alreadyEnrichedWork: Work = {
      sources: { books_tw: 'https://www.books.com.tw/products/0010918750', openlibrary: 'https://x' },
      titles: { en: "Assassin's Apprentice", zh: '刺客學徒' },
      creators: [{ name: { en: 'Robin Hobb', zh: '羅蘋·荷布' }, role: 'author' }],
      medium: 'book',
      raw: {},
      synopsis: { zh: '已存在的中文簡介。' },
    };

    await enrichWork(alreadyEnrichedWork);
    expect(productCalls).toBe(0);
  });

  test('partial failure (Reddit down) still returns a usable work', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.includes('reddit.com')) throw new Error('reddit down');
      if (url.includes('list=search')) {
        return new Response(JSON.stringify({ query: { search: [{ title: "Assassin's Apprentice" }] } }), { status: 200 });
      }
      if (url.includes('prop=extracts')) {
        return new Response(JSON.stringify({
          query: { pages: { '1': {
            title: "Assassin's Apprentice",
            extract: "Assassin's Apprentice is a 1995 fantasy novel by Robin Hobb.",
          } } },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const { work, reception, report } = await enrichWork(baseWork);
    expect(work.synopsis?.en).toContain('Wikipedia:');
    expect(work.synopsis?.en).toContain('Robin Hobb');
    expect(report.reddit).toEqual([]);
    expect(reception.reddit).toEqual([]);
  });
});
