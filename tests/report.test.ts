/**
 * Tests for src/core/report.ts - the markdown composer.
 *
 * Covers normal output, the writeup-block toggling, the source list,
 * the confidence stars, the medium label table, and the failure mode the
 * sandbox smoke-test surfaced (missing `titles` on input throws).
 */

import { describe, test, expect } from 'bun:test';
import { reportSection, reportHeader, buildReport } from '../src/core/report';
import type { Work } from '../src/types';

const sampleWork: Work = {
  sources: {
    isfdb: 'https://isfdb.org/diff',
    openlibrary: 'https://openlibrary.org/diff',
    books_tw: 'https://books.com.tw/diff',
  },
  titles: { en: 'The Difference Engine', zh: '差分機' },
  creators: [
    { name: { en: 'William Gibson', zh: '威廉·吉布森' }, role: 'author' },
    { name: { en: 'Bruce Sterling', zh: '布魯斯·斯特林' }, role: 'co-author' },
  ],
  year: 1990,
  medium: 'book',
  subgenres: ['steampunk', 'alt-history'],
  raw: {},
  confidence: 'high',
  hasZhTranslation: true,
  availableInTw: true,
  flags: undefined,
};

describe('reportSection - happy path', () => {
  const out = reportSection(sampleWork, '這是一段中文介紹。');

  test('heading combines zh and en titles', () => {
    expect(out).toMatch(/^## 差分機 \(The Difference Engine\)/);
  });
  test('lists creators with both en and zh names', () => {
    expect(out).toContain('William Gibson / 威廉·吉布森');
    expect(out).toContain('Bruce Sterling / 布魯斯·斯特林');
  });
  test('shows medium label and subgenres', () => {
    expect(out).toContain('書籍 · steampunk, alt-history');
  });
  test('shows year, translation, TW availability, confidence stars', () => {
    expect(out).toContain('**出版年**: 1990');
    expect(out).toContain('**譯本狀況**: 已中譯');
    expect(out).toContain('**台灣供應**: 在台灣可購得');
    expect(out).toContain('★★★ (high — 3 sources)');
  });
  test('embeds writeup text under the 草稿介紹 heading', () => {
    expect(out).toContain('### 草稿介紹\n\n這是一段中文介紹。');
  });
  test('lists every source URL', () => {
    expect(out).toContain('[isfdb](https://isfdb.org/diff)');
    expect(out).toContain('[openlibrary](https://openlibrary.org/diff)');
    expect(out).toContain('[books_tw](https://books.com.tw/diff)');
  });
});

describe('reportSection - edge cases', () => {
  test('without writeup, drops in the placeholder line', () => {
    const out = reportSection(sampleWork);
    // Note: the placeholder uses CJK full-width parens, not ASCII ().
    expect(out).toContain('_（尚未生成 / not yet generated）_');
  });
  test('singular "source" when only one', () => {
    const w: Work = {
      ...sampleWork,
      sources: { isfdb: 'https://x' },
      confidence: 'medium',
    };
    const out = reportSection(w);
    expect(out).toContain('★★ (medium — 1 source)');
  });
  test('en-only title drops the zh half of the heading', () => {
    const w: Work = { ...sampleWork, titles: { en: 'Neuromancer' } };
    const out = reportSection(w);
    expect(out).toMatch(/^## Neuromancer\n/);
  });
  test('zh-only title is fine', () => {
    const w: Work = { ...sampleWork, titles: { zh: '差分機' } };
    const out = reportSection(w);
    expect(out).toMatch(/^## 差分機\n/);
  });
  test('no titles at all -> "(untitled)"', () => {
    const w: Work = { ...sampleWork, titles: {} };
    const out = reportSection(w);
    expect(out).toMatch(/^## \(untitled\)/);
  });
  test('flags appear after the confidence line', () => {
    const w: Work = { ...sampleWork, flags: ['未中譯', 'low-confidence'] };
    const out = reportSection(w);
    expect(out).toContain('**備註**: 未中譯 / low-confidence');
  });
  test('hasZhTranslation undefined -> "不確定"', () => {
    const w: Work = { ...sampleWork, hasZhTranslation: undefined };
    const out = reportSection(w);
    expect(out).toContain('**譯本狀況**: 不確定');
  });

  // This pins down the failure mode that the sandbox smoke-test caught:
  // /api/report sends raw user-controlled `Work` shapes through to
  // reportSection, and reportSection accesses `work.titles.zh` directly.
  // If `titles` is missing entirely the function throws. Today that's the
  // contract - flagged here so a future "soft-fail" fix doesn't slip in
  // silently. If you fix it, update this test.
  test('throws on Work without titles object (current behaviour - see note)', () => {
    const malformed = { ...sampleWork, titles: undefined } as unknown as Work;
    expect(() => reportSection(malformed)).toThrow();
  });
});

describe('reportSection - medium labels', () => {
  for (const [m, label] of [
    ['book', '書籍'], ['film', '電影'], ['tv', '影集'],
    ['anime', '動畫'], ['manga', '漫畫'], ['game', '遊戲'],
  ] as const) {
    test(`${m} -> ${label}`, () => {
      const out = reportSection({ ...sampleWork, medium: m, subgenres: [] });
      expect(out).toContain(`**類型**: ${label}`);
    });
  }
});

describe('reportHeader / buildReport', () => {
  test('header includes theme + ISO date', () => {
    const out = reportHeader('蒸汽龐克', new Date('2026-05-04T12:00:00Z'));
    expect(out).toContain('# 策展主題:蒸汽龐克');
    expect(out).toContain('2026-05-04');
  });
  test('buildReport joins sections with a horizontal rule', () => {
    const out = buildReport('cyberpunk', ['## A\n', '## B\n']);
    expect(out).toContain('# 策展主題:cyberpunk');
    expect(out).toMatch(/## A\n[\s\S]*\n---\n\n[\s\S]*## B\n/);
  });
});
