/**
 * Tests for src/core/writeup.ts:
 *   - bad-phrases post-check correctly flags 大陸用語
 *   - char-count counts CJK characters and ignores ASCII / punctuation
 *   - the system prompt locks zh-TW + ~500 字 four-section structure +
 *     no-fabrication invariants
 *   - reception material (Reddit / Plurk) is forwarded into the user
 *     payload but kept separate from the work's synopsis
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
  test('forwards system prompt with 台灣繁體 lock + bad-phrase mapping + new 500-字 four-section structure', async () => {
    providerShape = 'anthropic';
    nextResponseText = '乾淨。';
    await writeup(baseWork, { provider: 'anthropic', apiKey: 'k' });
    const body = JSON.parse((lastReq!.init!.body as string));
    expect(body.system).toContain('台灣繁體中文');
    expect(body.system).toContain('視頻→影片');
    // New length target: ~500 字 instead of 200.
    expect(body.system).toContain('500 字 ±50');
    // Four-section structure: §1 background, §2-§3 story (longest), §4 reception.
    expect(body.system).toContain('第一段');
    expect(body.system).toContain('第二、三段');
    expect(body.system).toContain('第四段');
    // Explicit instruction to ground §4 in the reception data.
    expect(body.system).toContain('reception');

    // Rule 5 covers BOTH transliteration AND semantic translation of
    // proper nouns — series titles included. The concrete examples
    // (Tawny Man Trilogy, Fitz and the Fool, FitzChivalry, Buckkeep)
    // are what stops the model from guessing translations like
    // "棕色男人三部曲" / "費茲與愚人三部曲" / "費滋駿騎" / "公鹿堡".
    expect(body.system).toContain('音譯');
    expect(body.system).toContain('意譯');
    expect(body.system).toContain('Tawny Man');
    expect(body.system).toContain('Fitz and the Fool');
    expect(body.system).toContain('Buckkeep');
    // Worked example showing the correct (English-preserved) form is
    // present, demonstrating the desired output to the model.
    expect(body.system).toContain('FitzChivalry');
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
    // Reception block is always present in the payload (empty arrays when
    // no reception material was supplied), so the LLM sees the schema.
    expect(userText).toContain('"reception"');
  });

  test('forwards reception material (Reddit + Plurk) into the user payload', async () => {
    providerShape = 'anthropic';
    nextResponseText = '乾淨。';
    await writeup(
      baseWork,
      { provider: 'anthropic', apiKey: 'k' },
      {
        reddit: [{
          lang: 'en',
          title: 'r/printSF take',
          text: 'A long-form reader take that frames the book as the prototype of the cyberpunk genre. '.repeat(3),
          url: 'https://reddit.com/x',
          subreddit: 'printSF',
          score: 420,
          numComments: 30,
        }],
        plurk: [{
          lang: 'zh',
          title: '神經喚術士心得',
          text: '節奏緩慢但後勁強,讀完才反應過來剛剛看的是什麼。',
          url: 'https://www.plurk.com/p/abc',
          pid: 'abc',
          respCount: 12,
        }],
      },
    );
    const body = JSON.parse((lastReq!.init!.body as string));
    const userText = body.messages[0].content;
    // Reddit excerpt + subreddit name make it through.
    expect(userText).toContain('printSF');
    expect(userText).toContain('prototype of the cyberpunk genre');
    // Plurk excerpt makes it through.
    expect(userText).toContain('節奏緩慢但後勁強');
  });

  test('omitted reception arg defaults to empty arrays in the payload', async () => {
    providerShape = 'anthropic';
    nextResponseText = '乾淨。';
    await writeup(baseWork, { provider: 'anthropic', apiKey: 'k' });
    const body = JSON.parse((lastReq!.init!.body as string));
    const userText = body.messages[0].content;
    // Even with no reception arg, the payload includes the field with
    // empty arrays so the LLM has a stable schema to read.
    expect(userText).toContain('"reception"');
    expect(userText).toMatch(/"reddit":\s*\[\]/);
    expect(userText).toMatch(/"plurk":\s*\[\]/);
  });
});
