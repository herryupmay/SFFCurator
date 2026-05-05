/**
 * Tests for src/core/verify.ts.
 *
 * Sort priority (see verify.ts header):
 *   1. availableInTw  — TW-listed works lead (this is a Taiwan SFF tool).
 *   2. confidence     — high > medium > low.
 *   3. source count   — more independent confirmations.
 *   4. hasZhTranslation tiebreak.
 */

import { describe, test, expect } from 'bun:test';
import { verify } from '../src/core/verify';
import type { Work } from '../src/types';

function w(partial: Partial<Work> & { sources: Work['sources'] }): Work {
  return { titles: {}, creators: [], medium: 'book', raw: {}, ...partial };
}

describe('verify - keep / drop', () => {
  test('drops a singleton from a non-strong source with no ISBN', () => {
    const out = verify([w({ sources: { openlibrary: 'a' }, titles: { en: 'X' }, confidence: 'low' })]);
    expect(out).toHaveLength(0);
  });
  test('keeps a singleton from openlibrary if ISBN is present', () => {
    const out = verify([w({
      sources: { openlibrary: 'a' }, titles: { en: 'X' },
      isbn13: '9780000000001', confidence: 'low',
    })]);
    expect(out).toHaveLength(1);
  });
  test('keeps a singleton from a strong source (ISFDB) without ISBN', () => {
    const out = verify([w({ sources: { isfdb: 'a' }, titles: { en: 'X' }, confidence: 'low' })]);
    expect(out).toHaveLength(1);
  });
  test('keeps a singleton from books_tw / readmoo', () => {
    expect(verify([w({ sources: { books_tw: 'a' }, titles: { zh: 'X' }, confidence: 'low' })])).toHaveLength(1);
    expect(verify([w({ sources: { readmoo: 'a' }, titles: { zh: 'X' }, confidence: 'low' })])).toHaveLength(1);
  });
  test('keeps a multi-source record even when no source is strong', () => {
    const out = verify([w({
      sources: { openlibrary: 'a', google_books: 'b' } as Record<string, string>,
      titles: { en: 'X' }, confidence: 'medium',
    })]);
    expect(out).toHaveLength(1);
  });
});

describe('verify - flags', () => {
  test('sets hasZhTranslation false -> flags 未中譯', () => {
    const [out] = verify([w({ sources: { isfdb: 'a' }, titles: { en: 'Neuromancer' }, confidence: 'medium' })]);
    expect(out.hasZhTranslation).toBe(false);
    expect(out.flags ?? []).toContain('未中譯');
  });
  test('books_tw alone with zh title -> hasZhTranslation true, availableInTw true, no 未中譯', () => {
    const [out] = verify([w({ sources: { books_tw: 'a' }, titles: { zh: '神經喚術士' }, confidence: 'low' })]);
    expect(out.hasZhTranslation).toBe(true);
    expect(out.availableInTw).toBe(true);
    expect(out.flags ?? []).not.toContain('未中譯');
  });
  test('low confidence record gets a low-confidence flag', () => {
    const [out] = verify([w({ sources: { isfdb: 'a' }, titles: { en: 'X' }, confidence: 'low' })]);
    expect(out.flags ?? []).toContain('low-confidence');
  });
  test('strong-source singleton not on TW gets single-source', () => {
    const [out] = verify([w({ sources: { isfdb: 'a' }, titles: { en: 'X' }, confidence: 'medium' })]);
    expect(out.flags ?? []).toContain('single-source');
  });
});

describe('verify - sort order', () => {
  test('TW-listed work outranks higher-confidence non-TW work', () => {
    // Today's design intent: a Taiwan-published manga (medium confidence,
    // 1 source) should still appear ABOVE a non-TW high-confidence work.
    const twLow = w({ sources: { books_tw: 'a' }, titles: { zh: '蒸汽朋克漫畫' }, confidence: 'medium' });
    const nonTwHi = w({
      sources: { isfdb: 'a', anilist: 'b', wikidata: 'c' },
      titles: { en: 'Neuromancer' },
      confidence: 'high',
    });
    const out = verify([nonTwHi, twLow]);
    expect(out[0].titles.zh).toBe('蒸汽朋克漫畫');
    expect(out[1].titles.en).toBe('Neuromancer');
  });

  test('within TW-listed group, confidence then source-count wins', () => {
    const twHi = w({
      sources: { books_tw: 'a', isfdb: 'b', anilist: 'c' },
      titles: { en: 'H', zh: 'H' }, confidence: 'high',
    });
    const twMed1 = w({
      sources: { books_tw: 'a', isfdb: 'b' },
      titles: { en: 'M1', zh: 'M1' }, confidence: 'medium',
    });
    const twMed2 = w({
      sources: { books_tw: 'a' },
      titles: { en: 'M2', zh: 'M2' }, confidence: 'medium',
    });
    const out = verify([twMed2, twMed1, twHi]);
    expect(out.map(x => x.titles.en)).toEqual(['H', 'M1', 'M2']);
  });

  test('within non-TW group, confidence wins; ties broken by source count', () => {
    const lo = w({ sources: { isfdb: 'a' }, titles: { en: 'L' }, confidence: 'low' });
    const med1 = w({ sources: { isfdb: 'a', anilist: 'b' }, titles: { en: 'M1' }, confidence: 'medium' });
    const med2 = w({ sources: { isfdb: 'a' }, titles: { en: 'M2' }, confidence: 'medium' });
    const hi = w({ sources: { isfdb: 'a', anilist: 'b' }, titles: { en: 'H' }, confidence: 'high' });
    const out = verify([lo, med1, med2, hi]);
    expect(out.map(x => x.titles.en)).toEqual(['H', 'M1', 'M2', 'L']);
  });

  test('within same TW status + confidence + source count, has-zh wins tiebreak', () => {
    const noZh = w({ sources: { isfdb: 'a' }, titles: { en: 'A' }, confidence: 'medium' });
    const yesZh = w({ sources: { isfdb: 'a' }, titles: { en: 'B', zh: 'B' }, confidence: 'medium' });
    const out = verify([noZh, yesZh]);
    expect(out[0].titles.en).toBe('B');
  });
});
