/**
 * Tests for src/enrich/title-resolve.ts.
 *
 * The LLM call is replaced via the global fetch monkey-patch so the
 * test can return any provider-shaped response we want.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { resolveTitles, __test_only } from '../src/enrich/title-resolve';
import type { Work } from '../src/types';

const baseWork: Work = {
  sources: { books_tw: 'https://x' },
  titles: { zh: '刺客正傳1刺客學徒(經典紀念版)' },
  creators: [{ name: { en: 'Robin Hobb', zh: '羅蘋·荷布' }, role: 'author' }],
  year: 1995,
  medium: 'book',
  raw: {},
};

let originalFetch: typeof fetch;
let nextResponseText: string;
let nextResponseStatus = 200;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  nextResponseText = '';
  nextResponseStatus = 200;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ content: [{ type: 'text', text: nextResponseText }] }),
    { status: nextResponseStatus },
  )) as unknown as typeof fetch;
});

afterEach(() => { globalThis.fetch = originalFetch; });

describe('resolveTitles', () => {
  test('parses a clean JSON response with high confidence', async () => {
    nextResponseText = JSON.stringify({
      english_title: "Assassin's Apprentice",
      chinese_title: '刺客學徒',
      original_title: null,
      confidence: 'high',
    });
    const out = await resolveTitles(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out).not.toBeNull();
    expect(out!.english_title).toBe("Assassin's Apprentice");
    expect(out!.chinese_title).toBe('刺客學徒');
    expect(out!.original_title).toBeNull();
    expect(out!.confidence).toBe('high');
  });

  test('peels markdown ```json fences before parsing', async () => {
    nextResponseText = '```json\n' + JSON.stringify({
      english_title: 'Akira',
      chinese_title: '阿基拉',
      original_title: 'アキラ',
      confidence: 'high',
    }) + '\n```';
    const out = await resolveTitles(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out).not.toBeNull();
    expect(out!.english_title).toBe('Akira');
    expect(out!.original_title).toBe('アキラ');
  });

  test('returns null when LLM emits unparseable text', async () => {
    nextResponseText = 'I cannot find this work in my training data, sorry!';
    const out = await resolveTitles(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out).toBeNull();
  });

  test('returns null on missing fields / wrong types', async () => {
    nextResponseText = JSON.stringify({ english_title: 'X' }); // missing rest
    const out = await resolveTitles(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out).toBeNull();
  });

  test('returns null when the LLM HTTP call throws', async () => {
    globalThis.fetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const out = await resolveTitles(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out).toBeNull();
  });

  test('returns null on non-OK HTTP status', async () => {
    nextResponseStatus = 500;
    nextResponseText = '...';
    const out = await resolveTitles(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out).toBeNull();
  });

  test('empty-string fields are normalised to null', async () => {
    nextResponseText = JSON.stringify({
      english_title: '',
      chinese_title: '   ',
      original_title: 'アキラ',
      confidence: 'medium',
    });
    const out = await resolveTitles(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out).not.toBeNull();
    expect(out!.english_title).toBeNull();
    expect(out!.chinese_title).toBeNull();
    expect(out!.original_title).toBe('アキラ');
  });

  test('extractJson handles a response with leading commentary', () => {
    const out = __test_only.extractJson(
      'Here is the result:\n{"english_title":"Akira","chinese_title":"阿基拉","original_title":"アキラ","confidence":"high"}\nDone.',
    );
    expect(out).toEqual({
      english_title: 'Akira',
      chinese_title: '阿基拉',
      original_title: 'アキラ',
      confidence: 'high',
    });
  });

  test('system prompt actually includes the canonicalisation rules', () => {
    expect(__test_only.SYSTEM_PROMPT).toContain('Wikipedia');
    expect(__test_only.SYSTEM_PROMPT).toContain('經典紀念版');
    expect(__test_only.SYSTEM_PROMPT).toContain('confidence');
  });
});
