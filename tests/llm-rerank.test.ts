/**
 * Tests for src/core/llm-rerank.ts - the batched theme/genre LLM classifier.
 *
 * Network is mocked via global fetch monkey-patch so we don't depend on a
 * real model. Two layers:
 *   - parseRerankReply: pure parser for the LLM's "<idx>: YES|MAYBE|NO" format
 *   - rerankByTheme + applyRerankVerdicts: end-to-end through a stubbed LLM
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  parseRerankReply,
  rerankByTheme,
  applyRerankVerdicts,
  type RerankResult,
} from '../src/core/llm-rerank';
import type { Work } from '../src/types';
import type { LLMConfig } from '../src/llm/client';

function w(partial: Partial<Work> & { sources: Work['sources'] }): Work {
  return { titles: {}, creators: [], medium: 'book', raw: {}, ...partial };
}

describe('parseRerankReply', () => {
  test('parses well-formed reply with mixed YES/MAYBE/NO', () => {
    const reply = '0: YES\n1: MAYBE\n2: NO\n3: YES';
    expect(parseRerankReply(reply, 4)).toEqual([
      { index: 0, verdict: 'yes' },
      { index: 1, verdict: 'maybe' },
      { index: 2, verdict: 'no' },
      { index: 3, verdict: 'yes' },
    ]);
  });
  test('case-insensitive on the verdict word', () => {
    expect(parseRerankReply('0: yes\n1: Maybe\n2: nO', 3))
      .toEqual([
        { index: 0, verdict: 'yes' },
        { index: 1, verdict: 'maybe' },
        { index: 2, verdict: 'no' },
      ]);
  });
  test('accepts full-width colon and surrounding whitespace', () => {
    expect(parseRerankReply('  0:YES\n  1: NO\n  2 : maybe', 3))
      .toEqual([
        { index: 0, verdict: 'yes' },
        { index: 1, verdict: 'no' },
        { index: 2, verdict: 'maybe' },
      ]);
  });
  test('skips out-of-range indices and stray prose', () => {
    const reply = 'Sure, here are the verdicts:\n0: YES\n5: NO\n1: MAYBE\nthanks!';
    // expectedCount=3, so 5 is dropped
    expect(parseRerankReply(reply, 3)).toEqual([
      { index: 0, verdict: 'yes' },
      { index: 1, verdict: 'maybe' },
    ]);
  });
  test('dedupes repeat indices (first wins)', () => {
    expect(parseRerankReply('0: YES\n0: NO', 1))
      .toEqual([{ index: 0, verdict: 'yes' }]);
  });
});

describe('rerankByTheme - end-to-end with stubbed LLM', () => {
  let originalFetch: typeof fetch;
  let nextResponseText: string;
  let lastSystem: string | null = null;
  let lastUser: string | null = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    nextResponseText = '';
    lastSystem = null;
    lastUser = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      lastSystem = body?.system ?? null;
      lastUser = body?.messages?.[0]?.content ?? null;
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: nextResponseText }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const cfg: LLMConfig = { provider: 'anthropic', apiKey: 'sk-test' };

  const works: Work[] = [
    w({
      sources: { isfdb: 'a' },
      titles: { en: 'Neuromancer' },
      creators: [{ name: { en: 'William Gibson' }, role: 'author' }],
      year: 1984,
      medium: 'book',
      synopsis: { en: 'A washed-up hacker is recruited for one last job in cyberspace.' },
      subgenres: ['cyberpunk', 'science fiction'],
    }),
    w({
      sources: { books_tw: 'a' },
      titles: { zh: '刺客學徒' },
      creators: [{ name: { zh: '羅蘋·荷布' }, role: 'author' }],
      medium: 'book',
    }),
    w({
      sources: { anilist: 'a' },
      titles: { en: 'Romance Manga' },
      medium: 'manga',
    }),
  ];

  test('returns one verdict per input, preserving order', async () => {
    nextResponseText = '0: YES\n1: MAYBE\n2: NO';
    const out = await rerankByTheme(works, '學徒, 科幻', cfg);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ index: 0, verdict: 'yes' });
    expect(out[1]).toEqual({ index: 1, verdict: 'maybe' });
    expect(out[2]).toEqual({ index: 2, verdict: 'no' });
  });

  test('missing verdict for an index defaults to MAYBE (recall over precision)', async () => {
    nextResponseText = '0: YES\n2: NO'; // missing index 1
    const out = await rerankByTheme(works, 'theme', cfg);
    expect(out).toEqual([
      { index: 0, verdict: 'yes' },
      { index: 1, verdict: 'maybe' },
      { index: 2, verdict: 'no' },
    ]);
  });

  test('embeds the user theme in the prompt', async () => {
    nextResponseText = '0: YES\n1: MAYBE\n2: NO';
    await rerankByTheme(works, '學徒, 科幻', cfg);
    expect(lastUser).toContain('學徒, 科幻');
    expect(lastUser).toContain('Neuromancer');
    expect(lastUser).toContain('刺客學徒');
  });

  test('system prompt asks for YES|MAYBE|NO in line format and erring toward MAYBE', async () => {
    nextResponseText = '0: YES\n1: MAYBE\n2: NO';
    await rerankByTheme(works, 't', cfg);
    expect(lastSystem).toContain('YES');
    expect(lastSystem).toContain('MAYBE');
    expect(lastSystem).toContain('NO');
    expect(lastSystem!.toLowerCase()).toContain('maybe');
  });

  test('empty works array short-circuits without calling the LLM', async () => {
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response('{}'); }) as unknown as typeof fetch;
    const out = await rerankByTheme([], 't', cfg);
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });
});

describe('applyRerankVerdicts', () => {
  const works: Work[] = [
    w({ sources: { a: 'a' }, titles: { en: 'A' } }),
    w({ sources: { b: 'b' }, titles: { en: 'B' } }),
    w({ sources: { c: 'c' }, titles: { en: 'C' } }),
  ];

  test('keeps YES + MAYBE, drops NO', () => {
    const verdicts: RerankResult[] = [
      { index: 0, verdict: 'yes' },
      { index: 1, verdict: 'maybe' },
      { index: 2, verdict: 'no' },
    ];
    const out = applyRerankVerdicts(works, verdicts);
    expect(out).toHaveLength(2);
    expect(out.map(w => w.titles.en)).toEqual(['A', 'B']);
  });

  test('annotates each kept work with _aiVerdict on the raw map', () => {
    const verdicts: RerankResult[] = [
      { index: 0, verdict: 'yes' },
      { index: 1, verdict: 'maybe' },
      { index: 2, verdict: 'no' },
    ];
    const out = applyRerankVerdicts(works, verdicts);
    expect((out[0].raw as Record<string, unknown>)._aiVerdict).toBe('yes');
    expect((out[1].raw as Record<string, unknown>)._aiVerdict).toBe('maybe');
  });

  test('missing verdict defaults to MAYBE (and the work is kept)', () => {
    const verdicts: RerankResult[] = [
      { index: 0, verdict: 'no' },
      // no verdict for index 1 or 2
    ];
    const out = applyRerankVerdicts(works, verdicts);
    expect(out).toHaveLength(2); // 1 and 2 default to maybe
    expect(out.map(w => w.titles.en)).toEqual(['B', 'C']);
  });
});
