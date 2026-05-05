/**
 * Matching + merge logic.
 *
 * Each source adapter produces partial Work records. We dedupe across
 * sources so e.g. "The Difference Engine" from ISFDB and "差分機" from
 * Books.com.tw collapse into one record.
 *
 * Three-tier strategy, in priority order:
 *   1. ISBN-13 match — most reliable. Currently exact-match.
 *      (TODO: walk Open Library editions to map zh-TW ISBNs back to
 *      original-edition ISBNs — implement when zh-TW ISBNs start showing
 *      up from the bookstore scrapers.)
 *   2. Author + year fuzzy match — normalize names with a known-author
 *      transliteration table; group on canonical-name + year (±2 year
 *      window collapse is a TODO refinement).
 *   3. Title back-translation — TODO once the LLM stage is wired in. For
 *      now we leave these as singletons; the verification stage flags
 *      them as low-confidence.
 *
 * Output: merged Work[] with a `confidence` rating and a `sources` map
 * recording every URL that contributed.
 */

import type { Work, Creator } from '../types';

// Small transliteration table for the most common SFF author names.
// Keys are normalized (lowercase, no punctuation, no spaces). Add to it
// organically as cross-language misses come up.
const AUTHOR_ALIASES: Record<string, string[]> = {
  'williamgibson':       ['威廉吉布森', '威廉吉卜遜', '威廉吉布生'],
  'brucesterling':       ['布魯斯斯特林'],
  'philipkdick':         ['菲利普狄克', '菲利浦狄克'],
  'ursulakleguin':       ['娥蘇拉勒瑰恩', '勒瑰恩'],
  'isaacasimov':         ['以撒艾西莫夫', '艾西莫夫'],
  'arthurcclarke':       ['亞瑟克拉克', '克拉克'],
  'tedchang':            ['姜峯楠', '姜峰楠', '特德姜'],
  'liucixin':            ['劉慈欣'],
  'kazuoishiguro':       ['石黑一雄'],
  'harukimurakami':      ['村上春樹'],
  'kentaromiura':        ['三浦建太郎'],
  'naokiurasawa':        ['浦澤直樹'],
  'hayaomiyazaki':       ['宮崎駿'],
  'mamoruoshii':         ['押井守'],
  'satoshikon':          ['今敏'],
  'masamuneshirow':      ['士郎正宗'],
  'genurobuchi':         ['虛淵玄'],
  'yoshiyukitomino':     ['富野由悠季'],
  'shinichirowatanabe':  ['渡邊信一郎'],
};

const ALIAS_LOOKUP: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [canon, aliases] of Object.entries(AUTHOR_ALIASES)) {
    m.set(normalizeName(canon), canon);
    for (const a of aliases) m.set(normalizeName(a), canon);
  }
  return m;
})();

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s,\.\-·・]/g, '')
    .replace(/[​‌‍]/g, '');
}

function canonicalAuthor(name: string): string {
  const n = normalizeName(name);
  return ALIAS_LOOKUP.get(n) ?? n;
}

/** Public entry: dedupe a flat Work[] from multiple sources. */
export function mergeWorks(works: Work[]): Work[] {
  // Tier 1: group by ISBN-13 if present.
  const byIsbn = new Map<string, Work[]>();
  const noIsbn: Work[] = [];
  for (const w of works) {
    if (w.isbn13) {
      const arr = byIsbn.get(w.isbn13) ?? [];
      arr.push(w);
      byIsbn.set(w.isbn13, arr);
    } else {
      noIsbn.push(w);
    }
  }
  const tier1: Work[] = [];
  for (const group of byIsbn.values()) {
    tier1.push(reduceMerge(group, 'high'));
  }

  // Tier 2: group remaining by canonical-author + year.
  const byKey = new Map<string, Work[]>();
  const looseKeys: Work[] = [];
  for (const w of noIsbn) {
    const key = workMatchKey(w);
    if (key) {
      const arr = byKey.get(key) ?? [];
      arr.push(w);
      byKey.set(key, arr);
    } else {
      looseKeys.push(w);
    }
  }
  const tier2: Work[] = [];
  for (const group of byKey.values()) {
    tier2.push(reduceMerge(group, group.length >= 2 ? 'medium' : 'low'));
  }

  // Tier 3 (title back-translation) — not yet implemented. Singletons.
  const tier3: Work[] = looseKeys.map(w => reduceMerge([w], 'low'));

  return [...tier1, ...tier2, ...tier3];
}

function workMatchKey(w: Work): string | null {
  if (!w.year) return null;
  const author = w.creators[0];
  if (!author) return null;
  const name = author.name.en || author.name.zh || author.name.original;
  if (!name) return null;
  return `${canonicalAuthor(name)}|${w.year}`;
}

/**
 * Merge a list of Work records (assumed to refer to the same work) into
 * one. Picks the most-complete value per field; unions sources and tags.
 */
function reduceMerge(group: Work[], confidence: Work['confidence']): Work {
  if (group.length === 1) {
    return { ...group[0], confidence: confidence ?? 'low' };
  }

  const merged: Work = {
    sources: {},
    titles: {},
    creators: [],
    medium: group[0].medium,
    raw: {},
  };

  for (const w of group) {
    Object.assign(merged.sources, w.sources);
    Object.assign(merged.raw, w.raw);
  }

  merged.titles.en       = pickBest(group.map(w => w.titles.en));
  merged.titles.zh       = pickBest(group.map(w => w.titles.zh));
  merged.titles.original = pickBest(group.map(w => w.titles.original));

  merged.creators = mergeCreators(group.flatMap(w => w.creators));

  merged.year = mode(group.map(w => w.year).filter(Boolean) as number[]);
  merged.isbn13 = group.map(w => w.isbn13).find(Boolean);

  const tags = new Set<string>();
  for (const w of group) for (const t of w.subgenres ?? []) tags.add(t);
  merged.subgenres = [...tags];

  merged.synopsis = {
    en: pickBest(group.map(w => w.synopsis?.en)),
    zh: pickBest(group.map(w => w.synopsis?.zh)),
  };

  merged.confidence = confidence ?? (group.length >= 3 ? 'high' : 'medium');

  return merged;
}

function pickBest(xs: (string | undefined)[]): string | undefined {
  const filled = xs.filter((x): x is string => !!x && x.trim().length > 0);
  if (!filled.length) return undefined;
  return filled.sort((a, b) => b.length - a.length)[0];
}

function mode(nums: number[]): number | undefined {
  if (!nums.length) return undefined;
  const counts = new Map<number, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = nums[0];
  let bestC = 0;
  for (const [n, c] of counts) {
    if (c > bestC) { best = n; bestC = c; }
  }
  return best;
}

/**
 * Strip volume / edition / subtitle markers from a title to extract the
 * series base name. Used by collapseSeries() to group multi-volume series
 * (Sandman 1, Sandman 2, ...) into a single Work.
 *
 * Stripping order matters — outermost wrappers first, then inner subtitle
 * removal, then trailing volume tokens. Conservative on purpose: a 1-char
 * residue is treated as "no useful series key" by collapseSeries() so we
 * don't accidentally group every single-character title together.
 */
export function seriesKey(title: string): string {
  if (!title) return '';
  let s = title.normalize('NFKC');
  // Marketing brackets: zh-CJK 【...】 and 《...》 wrappers
  s = s.replace(/[【《][^】》]*[】》]/g, '');
  // ASCII square brackets: [...]
  s = s.replace(/\[[^\]]*\]/g, '');
  // Parenthesized notes: full-width （...） and ASCII (...)
  s = s.replace(/[（(][^()）]*[)）]/g, '');
  // Subtitle after colon: ：subtitle or :subtitle (kept conservative — only
  // strip when there's content on both sides; titles like ":foo" are
  // implausible).
  s = s.replace(/(.+?)\s*[：:]\s*.+$/, '$1');
  // Trailing English vol markers: "vol.X", "vol. X", "volume X", with
  // optional range "vol. 1-3".
  s = s.replace(/\s*(?:vol\.?|vols?\.?|volume)\s*\d+(?:\s*[~\-–—]\s*\d+)?\s*$/i, '');
  // Trailing volume number + optional zh-tw vol unit, with optional range
  // "1~7" / "1-7" / "1–7".
  s = s.replace(/\s*\d+(?:\s*[~\-–—]\s*\d+)?\s*(?:卷|話|集|冊|套書|完|部)?\s*$/, '');
  // Trailing standalone vol-words with no number ("上", "下", "中", "前篇",
  // "後篇", "完", "套書", "新裝版" etc.)
  s = s.replace(/\s*(?:卷|話|集|冊|套書|完|上|下|中|前篇|後篇|前編|後編|新裝版|完全版)\s*$/, '');
  return s.trim();
}

/**
 * Collapse multi-volume series into single Work entries.
 *
 * Strategy: group by (canonical primary author, seriesKey, medium). Any
 * group with >= 2 entries AND a non-trivial seriesKey (>= 2 chars) gets
 * collapsed into one Work whose title becomes "<series> (full N vols)"
 * and whose sources are unioned across all the volumes. Singletons pass
 * through untouched.
 *
 * Run AFTER mergeWorks() (so cross-source dedupe has happened) and
 * BEFORE verify() (so the collapsed entry is flagged/sorted correctly
 * with its now-multi-source confidence).
 */
export function collapseSeries(works: Work[]): Work[] {
  type GroupVal = {
    works: Work[];
    seriesBase: string;
    primaryField: 'en' | 'zh' | 'original';
  };
  const groups = new Map<string, GroupVal>();
  const standalone: Work[] = [];

  for (const w of works) {
    const titlePairs: Array<['en' | 'zh' | 'original', string]> = [];
    if (typeof w.titles.zh === 'string' && w.titles.zh.length > 0) titlePairs.push(['zh', w.titles.zh]);
    if (typeof w.titles.en === 'string' && w.titles.en.length > 0) titlePairs.push(['en', w.titles.en]);
    if (typeof w.titles.original === 'string' && w.titles.original.length > 0) titlePairs.push(['original', w.titles.original]);
    if (!titlePairs.length) { standalone.push(w); continue; }
    titlePairs.sort((a, b) => b[1].length - a[1].length);
    const [primaryField, primaryTitle] = titlePairs[0];

    const base = seriesKey(primaryTitle);
    if (base.length < 2) { standalone.push(w); continue; }

    const author = w.creators[0];
    if (!author) { standalone.push(w); continue; }
    const authorName = author.name.en || author.name.zh || author.name.original || '';
    if (!authorName) { standalone.push(w); continue; }

    const gk = `${canonicalAuthor(authorName)}|${base}|${w.medium}|${primaryField}`;
    const existing = groups.get(gk);
    if (existing) existing.works.push(w);
    else groups.set(gk, { works: [w], seriesBase: base, primaryField });
  }

  const out: Work[] = [...standalone];
  for (const g of groups.values()) {
    if (g.works.length < 2) {
      out.push(...g.works);
    } else {
      out.push(collapseSeriesGroup(g.works, g.seriesBase, g.primaryField));
    }
  }
  return out;
}

function collapseSeriesGroup(
  works: Work[],
  base: string,
  primaryField: 'en' | 'zh' | 'original',
): Work {
  const count = works.length;
  const merged: Work = {
    sources: {},
    titles: {},
    creators: mergeCreators(works.flatMap(w => w.creators)),
    medium: works[0].medium,
    raw: {},
  };

  // Merge sources WITHOUT clobbering: if two volumes both come from
  // books_tw, naive Object.assign would overwrite the first URL with the
  // second, so the user loses N-1 click-throughs. Suffix repeats with
  // _2 / _3 / ... so every volume's URL survives. Display layer (report.ts
  // / app.js) strips the suffix back off when rendering source chips.
  for (const w of works) {
    for (const [k, url] of Object.entries(w.sources)) {
      let key = k;
      let n = 2;
      while (key in merged.sources) {
        key = `${k}_${n}`;
        n++;
      }
      (merged.sources as Record<string, string>)[key] = url;
    }
    Object.assign(merged.raw, w.raw);
  }

  const zhSuffix = ` (全 ${count} 冊)`;
  const enSuffix = ` (Series, ${count} vols)`;
  const origSuffix = ` (×${count})`;

  if (primaryField === 'zh') merged.titles.zh = base + zhSuffix;
  else if (primaryField === 'en') merged.titles.en = base + enSuffix;
  else merged.titles.original = base + origSuffix;

  for (const field of ['en', 'zh', 'original'] as const) {
    if (merged.titles[field]) continue;
    const candidates = works
      .map(w => w.titles[field])
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .map(seriesKey)
      .filter(s => s.length >= 2)
      .sort((a, b) => b.length - a.length);
    if (!candidates.length) continue;
    const suf = field === 'zh' ? zhSuffix : field === 'en' ? enSuffix : origSuffix;
    merged.titles[field] = candidates[0] + suf;
  }

  merged.synopsis = {
    en: pickBest(works.map(w => w.synopsis?.en)),
    zh: pickBest(works.map(w => w.synopsis?.zh)),
  };

  const years = works.map(w => w.year).filter((n): n is number => typeof n === 'number');
  if (years.length) merged.year = Math.min(...years);

  const tags = new Set<string>();
  for (const w of works) for (const t of w.subgenres ?? []) tags.add(t);
  if (tags.size) merged.subgenres = [...tags];

  const ratings = works.map(w => w.confidence);
  if (ratings.includes('high')) merged.confidence = 'high';
  else if (count >= 3 || ratings.includes('medium')) merged.confidence = 'medium';
  else merged.confidence = 'low';

  return merged;
}

function mergeCreators(creators: Creator[]): Creator[] {
  const byCanon = new Map<string, Creator>();
  for (const c of creators) {
    const name = c.name.en || c.name.zh || c.name.original || '';
    if (!name) continue;
    const key = canonicalAuthor(name) + '|' + c.role;
    const existing = byCanon.get(key);
    if (existing) {
      existing.name.en       = existing.name.en       || c.name.en;
      existing.name.zh       = existing.name.zh       || c.name.zh;
      existing.name.original = existing.name.original || c.name.original;
    } else {
      byCanon.set(key, { ...c, name: { ...c.name } });
    }
  }
  return [...byCanon.values()];
}
