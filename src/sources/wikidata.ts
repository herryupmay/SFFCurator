/**
 * Wikidata adapter — cross-language metadata via SPARQL.
 *
 * Two-step approach (avoids slow free-text SPARQL):
 *   1. wbsearchentities: fast keyword search → list of Q-IDs
 *   2. SPARQL filter: keep only items that are SFF-relevant works,
 *      fetch en + zh-tw labels, year, author, medium type, image
 *
 * Wikidata's strength for our pipeline is multilingual labels — many SFF
 * works have explicit zh-TW or zh-Hant labels (e.g. Q1234 → 差分機),
 * which the matching stage uses to bridge English and Taiwanese sources.
 */

import type { Work, Medium } from '../types';
import { politeFetch } from './http';

const SEARCH_API = 'https://www.wikidata.org/w/api.php';
const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

// Wikidata Q-IDs for instance-of values we accept as SFF-relevant works.
// Anything else (people, places, etc.) gets filtered out.
const WORK_INSTANCES: Record<string, Medium> = {
  Q571:      'book',   // book
  Q8261:     'book',   // novel
  Q47461344: 'book',   // written work
  Q49084:    'book',   // short story collection
  Q581714:   'book',   // short story
  Q24856:    'book',   // film series (kept here for completeness)
  Q11424:    'film',   // film
  Q5398426:  'tv',     // TV series
  Q1107:     'anime',  // anime
  Q63952888: 'anime',  // anime series
  Q1004:     'manga',  // comic — overridden below for manga
  Q8274:     'manga',  // manga
  Q21198342: 'comic',  // comic series
};

const WORK_VALUES = Object.keys(WORK_INSTANCES).map(id => `wd:${id}`).join(' ');

interface WbSearchResult {
  id: string;
  label: string;
  description?: string;
  url: string;
}

async function searchEntities(query: string, limit: number): Promise<WbSearchResult[]> {
  // Run en + zh-tw searches in parallel — gives both English-named and
  // Chinese-named works a chance to surface.
  const search = async (lang: string) => {
    const url =
      `${SEARCH_API}?action=wbsearchentities` +
      `&search=${encodeURIComponent(query)}` +
      `&language=${lang}` +
      `&format=json&type=item&limit=${Math.max(10, limit)}` +
      `&origin=*`;
    const res = await politeFetch(url);
    if (!res.ok) throw new Error(`Wikidata search: ${res.status}`);
    const data = (await res.json()) as { search?: WbSearchResult[] };
    return data.search ?? [];
  };

  const [en, zh] = await Promise.all([
    search('en').catch(() => [] as WbSearchResult[]),
    search('zh-tw').catch(() => [] as WbSearchResult[]),
  ]);

  // Dedupe by Q-ID; prefer the English label when both surface.
  const byId = new Map<string, WbSearchResult>();
  for (const item of [...en, ...zh]) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()].slice(0, limit * 3);
}

interface SparqlBinding {
  work: { value: string };
  workLabelEn?: { value: string };
  workLabelZh?: { value: string };
  workLabelOriginal?: { value: string };
  year?: { value: string };
  authorLabelEn?: { value: string };
  authorLabelZh?: { value: string };
  instance: { value: string };
}

async function fetchDetails(qids: string[]): Promise<SparqlBinding[]> {
  if (!qids.length) return [];
  const values = qids.map(q => `wd:${q}`).join(' ');

  const sparql = `
SELECT DISTINCT ?work ?workLabelEn ?workLabelZh ?workLabelOriginal ?year ?authorLabelEn ?authorLabelZh ?instance WHERE {
  VALUES ?work { ${values} }
  ?work wdt:P31 ?instance.
  VALUES ?instance { ${WORK_VALUES} }

  OPTIONAL { ?work rdfs:label ?workLabelEn. FILTER(LANG(?workLabelEn) = "en") }
  OPTIONAL {
    ?work rdfs:label ?workLabelZh.
    FILTER(LANG(?workLabelZh) IN ("zh-tw", "zh-hant", "zh-hk", "zh"))
  }
  OPTIONAL {
    ?work rdfs:label ?workLabelOriginal.
    FILTER(LANG(?workLabelOriginal) IN ("ja", "ko"))
  }
  OPTIONAL { ?work wdt:P577 ?date. BIND(YEAR(?date) AS ?year) }
  OPTIONAL {
    ?work wdt:P50 ?author.
    OPTIONAL { ?author rdfs:label ?authorLabelEn. FILTER(LANG(?authorLabelEn) = "en") }
    OPTIONAL {
      ?author rdfs:label ?authorLabelZh.
      FILTER(LANG(?authorLabelZh) IN ("zh-tw", "zh-hant", "zh"))
    }
  }
}
`.trim();

  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(sparql)}&format=json`;
  const res = await politeFetch(url, {
    headers: { Accept: 'application/sparql-results+json' },
    hostDelayMs: 1500, // WDQS is generous but rate-limits hard if abused
  });
  if (!res.ok) {
    throw new Error(`Wikidata SPARQL: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { results?: { bindings: SparqlBinding[] } };
  return data.results?.bindings ?? [];
}

export async function searchWikidata(query: string, limit = 15): Promise<Work[]> {
  const candidates = await searchEntities(query, limit);
  if (!candidates.length) return [];

  // Fetch in batches of 50 to keep the SPARQL VALUES clause sane.
  const ids = candidates.map(c => c.id);
  const bindings: SparqlBinding[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const rows = await fetchDetails(batch).catch((err): SparqlBinding[] => {
      console.warn('[wikidata sparql]', err);
      return [];
    });
    bindings.push(...rows);
  }

  // Reduce to one Work per Q-ID. The SPARQL response can have multiple
  // rows per work (e.g. when there are several authors).
  const byWork = new Map<string, Work>();
  for (const b of bindings) {
    const qid = b.work.value.replace(/^.*\//, '');
    const instance = b.instance.value.replace(/^.*\//, '');
    const medium = WORK_INSTANCES[instance] ?? 'book';

    let w = byWork.get(qid);
    if (!w) {
      w = {
        sources: { wikidata: `https://www.wikidata.org/wiki/${qid}` },
        titles: {
          en: b.workLabelEn?.value,
          zh: b.workLabelZh?.value,
          original: b.workLabelOriginal?.value,
        },
        creators: [],
        year: b.year ? parseInt(b.year.value, 10) : undefined,
        medium,
        raw: { wikidata: { qid, bindings: [b] } },
      };
      byWork.set(qid, w);
    } else {
      (w.raw.wikidata as { bindings: SparqlBinding[] }).bindings.push(b);
    }

    // Add author if present and not already in the list.
    const authorEn = b.authorLabelEn?.value;
    const authorZh = b.authorLabelZh?.value;
    if (authorEn || authorZh) {
      const key = (authorEn || authorZh || '').toLowerCase();
      const has = w.creators.some(c =>
        (c.name.en || '').toLowerCase() === key ||
        (c.name.zh || '').toLowerCase() === key,
      );
      if (!has) {
        w.creators.push({
          name: { en: authorEn, zh: authorZh },
          role: 'author',
        });
      }
    }
  }

  return [...byWork.values()];
}
