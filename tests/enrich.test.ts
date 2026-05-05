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
import { enrichWork } from '../src/enrich';
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
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score); // sorted high-to-low
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
    // Posts mentioning the search query are present somewhere in the bodies.
    const corpus = out.map(p => p.text).join(' ');
    expect(corpus).toContain('學徒');
    // Sorted by response count (descending).
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

  test('appends Wikipedia + Reddit text to synopsis fields', async () => {
    let mode = 'wiki';
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
            extract: isZh ? '維基百科中文條目。' : 'Wikipedia English intro.',
          } } },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const { work: enriched, report } = await enrichWork(baseWork);

    expect(enriched.synopsis?.zh).toContain('原始的中文簡介');
    expect(enriched.synopsis?.zh).toContain('維基百科:刺客學徒');
    expect(enriched.synopsis?.zh).toContain('維基百科中文條目');

    expect(enriched.synopsis?.en).toContain('Wikipedia:');
    expect(enriched.synopsis?.en).toContain('Reddit r/Fantasy');
    expect(enriched.synopsis?.en).toContain('Wikipedia English intro');

    expect(report.wikipedia.length).toBe(2);
    expect(report.reddit.length).toBeGreaterThan(0);
    // plurk is empty here because the mock fetch doesn't serve plurk.com
    // (the orchestrator test isn't testing Plurk; that's covered above).
    expect(Array.isArray(report.plurk)).toBe(true);

    // _enrichment annotation in raw for UI/debug.
    const ann = (enriched.raw as Record<string, unknown>)._enrichment;
    expect(ann).toBeDefined();
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
          query: { pages: { '1': { title: "Assassin's Apprentice", extract: 'Wiki body.' } } },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;

    const { work, report } = await enrichWork(baseWork);
    expect(work.synopsis?.en).toContain('Wikipedia:');
    expect(report.reddit).toEqual([]);
  });
});
