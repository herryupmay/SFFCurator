/**
 * Tests for src/core/writeup.ts:
 *   - bad-phrases post-check correctly flags 大陸用語
 *   - char-count counts CJK characters and ignores ASCII / punctuation
 *   - the system prompt locks zh-TW + 200字 + no-fabrication invariants
 *
 * The LLM call itself is replaced via global fetch monkey-patch.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeup } from '../src/core/writeup';
import type { Work } from '../src/types';

const baseWork: Work = {
  sources: { isfdb: 'https://x' },
  titles: { en: 'Neuromancer', zh: '神經喚術士' },
  creators: [{ name: { en: 'William Gibson', zh: '威廉·吉布森' }, role: 'author' }],
  year: 1984,
  medium: 'book',
  subgenres: ['cyberpunk'],
  raw: {},
  hasZhTranslation: true,
  availableInTw: true,
};

let originalFetch: typeof fetch;
let lastReq: { url: string; init?: RequestInit } | null = null;
let nextResponseText: string;
let nextResponseStatus = 200;
let providerShape: 'anthropic' | 'openai' | 'google' | 'ollama' = 'anthropic';

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastReq = null;
  nextResponseText = '';
  nextResponseStatus = 200;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : (input instanceof URL ? input.toString() : input.url);
    lastReq = { url, init };
    let body: object;
    switch (providerShape) {
      case 'anthropic':
        body = { content: [{ type: 'text', text: nextResponseText }] };
        break;
      case 'openai':
        body = { choices: [{ message: { content: nextResponseText } }] };
        break;
      case 'google':
        body = { candidates: [{ content: { parts: [{ text: nextResponseText }] } }] };
        break;
      case 'ollama':
        body = { message: { content: nextResponseText } };
        break;
    }
    return new Response(JSON.stringify(body), { status: nextResponseStatus });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('writeup - output shape', () => {
  test('returns text, flagged[], charCount', async () => {
    providerShape = 'anthropic';
    nextResponseText = '這是一段乾淨的台灣繁體中文介紹文字。它應該通過所有檢查。'.repeat(2);
    const out = await writeup(baseWork, { provider: 'anthropic', apiKey: 'sk-test' });
    expect(typeof out.text).toBe('string');
    expect(Array.isArray(out.flagged)).toBe(true);
    expect(typeof out.charCount).toBe('number');
    expect(out.charCount).toBeGreaterThan(20);
  });

  test('trims whitespace from the model response', async () => {
    providerShape = 'anthropic';
    nextResponseText = '   \n  乾淨的中文。\n   ';
    const out = await writeup(baseWork, { provider: 'anthropic', apiKey: 'sk' });
    expect(out.text).toBe('乾淨的中文。');
  });
});

describe('writeup - bad-phrases post-check', () => {
  test('flags 視頻 / 軟件 / 質量', async () => {
    providerShape = 'anthropic';
    nextResponseText = '這部小說在某個視頻軟件上被熱烈討論,質量很高。';
    const out = await writeup(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out.flagged.sort()).toEqual(['視頻', '質量', '軟件']);
  });

  test('flags 默認 / 通過 / 屏幕 (frequent leakage)', async () => {
    providerShape = 'anthropic';
    nextResponseText = '默認設定下通過螢幕…啊不對是屏幕。';
    const out = await writeup(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out.flagged).toEqual(expect.arrayContaining(['默認', '通過', '屏幕']));
  });

  test('clean Taiwanese-Chinese passes with empty flagged[]', async () => {
    providerShape = 'anthropic';
    nextResponseText =
      '《神經喚術士》是威廉·吉布森一九八四年出版的長篇小說,公認為網路龐克的奠基之作。\n\n' +
      '故事以近未來為舞台,失意駭客凱斯被一位神秘僱主重新拉回網路空間,執行一項目標不明的入侵任務。\n\n' +
      '這是一本理解類型源頭的必修之作。';
    const out = await writeup(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out.flagged).toEqual([]);
  });
});

describe('writeup - char count', () => {
  test('counts CJK chars only, ignores ASCII + punctuation', async () => {
    providerShape = 'anthropic';
    nextResponseText = '一二三四五,abc...!?';
    const out = await writeup(baseWork, { provider: 'anthropic', apiKey: 'k' });
    expect(out.charCount).toBe(5);
  });
});

describe('writeup - request shape', () => {
  test('forwards system prompt with 台灣繁體 lock + bad-phrase mapping', async () => {
    providerShape = 'anthropic';
    nextResponseText = '乾淨。';
    await writeup(baseWork, { provider: 'anthropic', apiKey: 'k' });
    const body = JSON.parse((lastReq!.init!.body as string));
    expect(body.system).toContain('台灣繁體中文');
    expect(body.system).toContain('視頻→影片');
    expect(body.system).toContain('200 字 ±20');
  });

  test('embeds the work payload as JSON in the user message', async () => {
    providerShape = 'anthropic';
    nextResponseText = '乾淨。';
    await writeup(baseWork, { provider: 'anthropic', apiKey: 'k' });
    const body = JSON.parse((lastReq!.init!.body as string));
    const userText = body.messages[0].content;
    expect(userText).toContain('Neuromancer');
    expect(userText).toContain('神經喚術士');
    expect(userText).toContain('cyberpunk');
    expect(userText).toContain('"year": 1984');
  });
});
