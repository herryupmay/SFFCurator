/**
 * Tests for the author-exclude filter in src/server.ts.
 *
 * Driven by the user-facing scenario from the 2026-05-05 curation session:
 * 10 of 26 results were Sandman variants and we needed a way to drop
 * "Neil Gaiman" without filtering by anything else.
 */

import { describe, test, expect } from 'bun:test';
import { makeExcludeFilter } from '../src/server';
import type { Work } from '../src/types';

function w(creators: Work['creators']): Work {
  return {
    sources: { books_tw: 'a' },
    titles: { en: 'Some Title' },
    creators,
    medium: 'book',
    raw: {},
  };
}

describe('makeExcludeFilter', () => {
  test('empty exclude list -> always keeps (predicate is false for everyone)', () => {
    const isExcluded = makeExcludeFilter([]);
    expect(isExcluded(w([{ name: { en: 'Neil Gaiman' }, role: 'author' }]))).toBe(false);
  });

  test('exact English-name match', () => {
    const isExcluded = makeExcludeFilter(['Neil Gaiman']);
    expect(isExcluded(w([{ name: { en: 'Neil Gaiman' }, role: 'author' }]))).toBe(true);
  });

  test('case-insensitive English match', () => {
    const isExcluded = makeExcludeFilter(['NEIL gaiman']);
    expect(isExcluded(w([{ name: { en: 'Neil Gaiman' }, role: 'author' }]))).toBe(true);
  });

  test('matches against the zh-name field too', () => {
    const isExcluded = makeExcludeFilter(['尼爾蓋曼']);
    expect(isExcluded(w([{ name: { zh: '尼爾．蓋曼' }, role: 'author' }]))).toBe(true);
  });

  test('matches against the original-name field too', () => {
    const isExcluded = makeExcludeFilter(['Murakami Haruki']);
    expect(isExcluded(w([{ name: { original: 'Murakami Haruki' }, role: 'author' }]))).toBe(true);
  });

  test('substring match: "Neil Gaiman" matches "尼爾．蓋曼（Neil Gaiman）" combined field', () => {
    // Books.com.tw sometimes packs multiple representations into one field.
    const isExcluded = makeExcludeFilter(['Neil Gaiman']);
    expect(isExcluded(w([{ name: { zh: '尼爾．蓋曼（Neil Gaiman）' }, role: 'author' }]))).toBe(true);
  });

  test('substring match: zh form caught even when only the en form is given', () => {
    // Mirror of the above: user types the en form, the work's only field
    // is the zh combined form. normalizeName strips the parens too.
    const isExcluded = makeExcludeFilter(['Neil Gaiman']);
    const work: Work = {
      sources: { books_tw: 'x' },
      titles: { zh: '睡魔' },
      creators: [{ name: { zh: '尼爾．蓋曼（Neil Gaiman）、桑妮' }, role: 'author' }],
      medium: 'book',
      raw: {},
    };
    expect(isExcluded(work)).toBe(true);
  });

  test('does NOT drop unrelated work (no Neil Gaiman anywhere)', () => {
    const isExcluded = makeExcludeFilter(['Neil Gaiman']);
    expect(isExcluded(w([{ name: { en: 'Robin Hobb' }, role: 'author' }]))).toBe(false);
    expect(isExcluded(w([{ name: { en: 'Ursula K. Le Guin', zh: '勒瑰恩' }, role: 'author' }]))).toBe(false);
  });

  test('drops if ANY creator matches (multi-author works like collaborations)', () => {
    const isExcluded = makeExcludeFilter(['Neil Gaiman']);
    const work = w([
      { name: { en: 'Yoshitaka Amano' }, role: 'illustrator' },
      { name: { en: 'Neil Gaiman' }, role: 'author' },
    ]);
    expect(isExcluded(work)).toBe(true);
  });

  test('multiple exclude entries: any match drops the work', () => {
    const isExcluded = makeExcludeFilter(['Neil Gaiman', 'Brandon Sanderson']);
    expect(isExcluded(w([{ name: { en: 'Brandon Sanderson' }, role: 'author' }]))).toBe(true);
    expect(isExcluded(w([{ name: { en: 'Neil Gaiman' }, role: 'author' }]))).toBe(true);
    expect(isExcluded(w([{ name: { en: 'Robin Hobb' }, role: 'author' }]))).toBe(false);
  });

  test('whitespace + punctuation + half-/full-width differences are normalized away', () => {
    // normalizeName uses NFKC + strips spaces/punct, so all of these collapse.
    const isExcluded = makeExcludeFilter(['Neil  Gaiman']);
    expect(isExcluded(w([{ name: { en: 'Neil-Gaiman' }, role: 'author' }]))).toBe(true);
    expect(isExcluded(w([{ name: { en: 'Neil. Gaiman' }, role: 'author' }]))).toBe(true);
  });

  test('blank/whitespace-only entries in exclude list are ignored', () => {
    const isExcluded = makeExcludeFilter(['', '   ', 'Neil Gaiman']);
    expect(isExcluded(w([{ name: { en: 'Neil Gaiman' }, role: 'author' }]))).toBe(true);
    expect(isExcluded(w([{ name: { en: 'Robin Hobb' }, role: 'author' }]))).toBe(false);
  });

  test('work with no creators -> never excluded', () => {
    const isExcluded = makeExcludeFilter(['Neil Gaiman']);
    expect(isExcluded(w([]))).toBe(false);
  });

  test('does NOT match across separate creator entries (each creator checked individually)', () => {
    // "Neil" alone is dangerous as an exclude term — make sure the
    // substring match doesn't cross from one creator's name into another's.
    const isExcluded = makeExcludeFilter(['Neil']);
    // "Neil" is too short and would over-match "Cornelia"; this is on the
    // user, but we should at least confirm cross-creator leakage isn't
    // happening.
    const work = w([
      { name: { en: 'Cornelia Funke' }, role: 'author' },
      { name: { en: 'Brian K. Vaughan' }, role: 'author' },
    ]);
    // 'cornelia' contains 'neil'? c-o-r-n-e-l-i-a — no, it doesn't.
    // 'brian k vaughan' — no 'neil' either.
    expect(isExcluded(work)).toBe(false);
  });
});
