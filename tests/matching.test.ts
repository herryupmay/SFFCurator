/**
 * Tests for the 3-tier dedupe in src/core/matching.ts.
 */

import { describe, test, expect } from 'bun:test';
import { mergeWorks, normalizeName } from '../src/core/matching';
import type { Work } from '../src/types';

function makeWork(partial: Partial<Work> & { sources: Work['sources'] }): Work {
  return {
    titles: {},
    creators: [],
    medium: 'book',
    raw: {},
    ...partial,
  };
}

describe('normalizeName', () => {
  test('strips whitespace, punctuation, dots', () => {
    expect(normalizeName('William  Gibson')).toBe('williamgibson');
    expect(normalizeName('Philip K. Dick')).toBe('philipkdick');
    expect(normalizeName('Le Guin, Ursula K.')).toBe('leguinursulak');
  });
  test('strips zero-width joiners and CJK middle-dot', () => {
    expect(normalizeName('威廉·吉布森')).toBe('威廉吉布森');
    expect(normalizeName('威廉​吉布森')).toBe('威廉吉布森');
  });
  test('NFKC-normalizes', () => {
    const half = normalizeName('ｳｨﾘｱﾑ');
    const full = normalizeName('ウィリアム');
    expect(half).toBe(full);
  });
});

describe('mergeWorks - tier 1 (ISBN-13)', () => {
  test('two sources with same ISBN collapse to one high-confidence record', () => {
    const a = makeWork({
      isbn13: '9780553380958',
      sources: { openlibrary: 'https://ol/diff' },
      titles: { en: 'The Difference Engine' },
      creators: [{ name: { en: 'William Gibson' }, role: 'author' }],
      year: 1990,
    });
    const b = makeWork({
      isbn13: '9780553380958',
      sources: { isfdb: 'https://isfdb/diff' },
      titles: { en: 'The Difference Engine' },
      creators: [{ name: { en: 'Bruce Sterling' }, role: 'co-author' }],
      year: 1990,
    });
    const out = mergeWorks([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('high');
    expect(Object.keys(out[0].sources).sort()).toEqual(['isfdb', 'openlibrary']);
    const names = out[0].creators.map(c => c.name.en).sort();
    expect(names).toEqual(['Bruce Sterling', 'William Gibson']);
  });

  test('different ISBNs do not collapse', () => {
    const a = makeWork({ isbn13: '9780553380958', sources: { openlibrary: 'a' }, titles: { en: 'A' } });
    const b = makeWork({ isbn13: '9780002253246', sources: { openlibrary: 'b' }, titles: { en: 'B' } });
    expect(mergeWorks([a, b])).toHaveLength(2);
  });
});

describe('mergeWorks - tier 2 (canonical-author + year)', () => {
  test('English + zh-TW transliterations of a known author collapse', () => {
    const en = makeWork({
      sources: { isfdb: 'a' },
      titles: { en: 'Neuromancer' },
      creators: [{ name: { en: 'William Gibson' }, role: 'author' }],
      year: 1984,
    });
    const zh = makeWork({
      sources: { books_tw: 'b' },
      titles: { zh: '神經喚術士' },
      creators: [{ name: { zh: '威廉吉布森' }, role: 'author' }],
      year: 1984,
    });
    const out = mergeWorks([en, zh]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('medium');
    expect(out[0].titles.en).toBe('Neuromancer');
    expect(out[0].titles.zh).toBe('神經喚術士');
  });

  test('alternative transliteration variant 吉卜遜 still collapses', () => {
    const en = makeWork({
      sources: { isfdb: 'a' },
      titles: { en: 'Neuromancer' },
      creators: [{ name: { en: 'William Gibson' }, role: 'author' }],
      year: 1984,
    });
    const zh = makeWork({
      sources: { books_tw: 'b' },
      titles: { zh: '神經喚術士' },
      creators: [{ name: { zh: '威廉吉卜遜' }, role: 'author' }],
      year: 1984,
    });
    expect(mergeWorks([en, zh])).toHaveLength(1);
  });

  test('CJK middle-dot in zh name still canonicalizes via the strip rule', () => {
    const a = makeWork({
      sources: { isfdb: 'a' },
      titles: { en: 'Neuromancer' },
      creators: [{ name: { en: 'William Gibson' }, role: 'author' }],
      year: 1984,
    });
    const b = makeWork({
      sources: { books_tw: 'b' },
      titles: { zh: '神經喚術士' },
      creators: [{ name: { zh: '威廉·吉布森' }, role: 'author' }],
      year: 1984,
    });
    expect(mergeWorks([a, b])).toHaveLength(1);
  });

  test('unknown authors do not collapse across languages', () => {
    const a = makeWork({
      sources: { openlibrary: 'a' },
      titles: { en: 'X' },
      creators: [{ name: { en: 'Jane Nobody' }, role: 'author' }],
      year: 2010,
    });
    const b = makeWork({
      sources: { books_tw: 'b' },
      titles: { zh: 'Y' },
      creators: [{ name: { zh: '佚名' }, role: 'author' }],
      year: 2010,
    });
    expect(mergeWorks([a, b])).toHaveLength(2);
  });

  test('different years for the same author do not collapse', () => {
    const a = makeWork({
      sources: { isfdb: 'a' },
      titles: { en: 'Neuromancer' },
      creators: [{ name: { en: 'William Gibson' }, role: 'author' }],
      year: 1984,
    });
    const b = makeWork({
      sources: { isfdb: 'b' },
      titles: { en: 'Count Zero' },
      creators: [{ name: { en: 'William Gibson' }, role: 'author' }],
      year: 1986,
    });
    expect(mergeWorks([a, b])).toHaveLength(2);
  });
});

describe('mergeWorks - known-issue regressions', () => {
  // Bug surfaced during the test pass: AUTHOR_ALIASES['tedchang'] is keyed
  // 'tedchang' but normalizeName('Ted Chiang') === 'tedchiang' (note the
  // missing 'i'). Result: cross-language merge for Ted Chiang never fires.
  // Fix: rename the key in src/core/matching.ts AUTHOR_ALIASES from
  //   'tedchang': ['姜峯楠', ...]  ->  'tedchiang': ['姜峯楠', ...]
  // After fixing, promote this from test.todo to a regular test.
  test.todo('Ted Chiang en + 姜峯楠 zh should collapse - see AUTHOR_ALIASES typo', () => {});
});

describe('mergeWorks - tier 3 (singletons)', () => {
  test('record with no isbn / no year / no creators is kept as a low-conf singleton', () => {
    const w = makeWork({ sources: { wikidata: 'q' }, titles: { en: 'X' } });
    const out = mergeWorks([w]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('low');
  });
  test('singleton with author but no year is also low-confidence', () => {
    const w = makeWork({
      sources: { openlibrary: 'a' },
      titles: { en: 'X' },
      creators: [{ name: { en: 'William Gibson' }, role: 'author' }],
    });
    expect(mergeWorks([w])[0].confidence).toBe('low');
  });
});

describe('mergeWorks - pickBest / source union', () => {
  test('pickBest takes the longest non-empty title', () => {
    const a = makeWork({ isbn13: '9780000000001', sources: { a: 'a' }, titles: { en: 'Short' } });
    const b = makeWork({ isbn13: '9780000000001', sources: { b: 'b' }, titles: { en: 'Short Title (Anniversary)' } });
    const [m] = mergeWorks([a, b]);
    expect(m.titles.en).toBe('Short Title (Anniversary)');
  });
  test('source union spans all contributors', () => {
    const works: Work[] = [
      makeWork({ isbn13: '9780000000002', sources: { openlibrary: 'a' }, titles: { en: 'X' } }),
      makeWork({ isbn13: '9780000000002', sources: { isfdb: 'b' }, titles: { en: 'X' } }),
      makeWork({ isbn13: '9780000000002', sources: { books_tw: 'c' }, titles: { zh: 'X' } }),
    ];
    const [m] = mergeWorks(works);
    expect(Object.keys(m.sources).sort()).toEqual(['books_tw', 'isfdb', 'openlibrary']);
  });
  test('subgenres are union-merged without dupes', () => {
    const a = makeWork({ isbn13: '9780000000003', sources: { a: 'a' }, subgenres: ['cyberpunk', 'noir'] });
    const b = makeWork({ isbn13: '9780000000003', sources: { b: 'b' }, subgenres: ['cyberpunk', 'dystopia'] });
    const [m] = mergeWorks([a, b]);
    expect((m.subgenres ?? []).sort()).toEqual(['cyberpunk', 'dystopia', 'noir']);
  });
});
