/**
 * Tests for the books.com.tw per-product deep-fetch parser.
 *
 * Fixture: tests/fixtures/books_tw-product-juan.html — synthetic but
 * follows the live DOM shape of a real product page (verified against
 * https://www.books.com.tw/products/0010918750 May 2026). When the live
 * page redesigns, save fresh HTML over the fixture and the assertions
 * below should keep working.
 */

import { describe, test, expect } from 'bun:test';
import { parseBooksTwProduct, extractBooksTwItemId } from '../src/sources/books_tw';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(
  join(import.meta.dir, 'fixtures', 'books_tw-product-juan.html'),
  'utf-8',
);

describe('parseBooksTwProduct (畫家的祕密學徒 / I, Juan de Pareja)', () => {
  const parsed = parseBooksTwProduct(html);

  test('extracts the original English title (原文書名)', () => {
    expect(parsed.originalTitle).toBe('I, Juan de Pareja');
  });

  test('extracts the zh author transliteration (作者)', () => {
    expect(parsed.zhAuthors).toEqual(['伊莉莎白．波頓．崔維尼奧']);
  });

  test('extracts the original-language author (原文作者)', () => {
    expect(parsed.originalAuthors).toEqual(['Elizabeth Borton de Treviño']);
  });

  test('extracts the zh translator (譯者)', () => {
    expect(parsed.zhTranslators).toEqual(['柯清心']);
  });

  test('extracts publisher (出版社)', () => {
    expect(parsed.publisher).toBe('小麥田');
  });

  test('extracts publication year (from 出版日期)', () => {
    expect(parsed.year).toBe(2022);
  });

  test('extracts ISBN-13', () => {
    expect(parsed.isbn13).toBe('9786267000694');
  });

  test('extracts the publisher synopsis (內容簡介)', () => {
    expect(parsed.synopsisZh).toBeDefined();
    expect(parsed.synopsisZh!.length).toBeGreaterThan(100);
    // Real plot details, with the Taiwan-publisher transliteration of the
    // characters — exactly the material the writeup needs and exactly the
    // material the LLM cannot invent on its own.
    expect(parsed.synopsisZh).toContain('胡安');
    expect(parsed.synopsisZh).toContain('委拉斯奎茲');
    expect(parsed.synopsisZh).toContain('十七世紀');
    // Award-decoration short paragraphs were dropped by the anti-noise filter.
    expect(parsed.synopsisZh).not.toMatch(/^★/);
  });
});

describe('extractBooksTwItemId', () => {
  test('parses canonical /products/<id> URL', () => {
    expect(extractBooksTwItemId('https://www.books.com.tw/products/0010918750'))
      .toBe('0010918750');
  });
  test('parses search redirect URL with /item/<id>/', () => {
    expect(extractBooksTwItemId(
      'https://search.books.com.tw/redirect/move/key/X/area/mid_image/item/0010918750/page/1/idx/8/cat/001/pdf/1/spell/3',
    )).toBe('0010918750');
  });
  test('returns null for unrelated URLs', () => {
    expect(extractBooksTwItemId('https://example.com')).toBeNull();
    expect(extractBooksTwItemId('')).toBeNull();
    expect(extractBooksTwItemId(undefined)).toBeNull();
  });
});
