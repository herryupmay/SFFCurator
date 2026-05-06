/**
 * Bun HTTP server entry point.
 *
 * Uses Bun's fullstack routes API: importing an HTML file gives an
 * HTMLBundle that Bun knows how to serve directly. Works the same in
 * dev (hot reload) and in the compiled binary (HTML embedded at build time).
 *
 * Security notes (see SECURITY.md):
 *   - Bound to 127.0.0.1 only - no other devices on the network can
 *     reach this server, even when the user's Windows firewall would
 *     otherwise allow it.
 *   - Host header allowlist on /api/* - defends against DNS-rebinding.
 *   - maxRequestBodySize caps payloads at 1 MB to prevent local DoS.
 *   - LLM keys are forwarded in-memory only, never persisted server-side.
 *   - baseUrl is hostname-validated to block link-local (cloud metadata).
 */

import indexHtml from './ui/index.html';
import { searchOpenLibrary } from './sources/openlibrary';
import { searchAniList } from './sources/anilist';
import { searchTmdb } from './sources/tmdb';
import { searchIsfdb } from './sources/isfdb';
import { searchWikidata } from './sources/wikidata';
import { searchBooksTw } from './sources/books_tw';
import { searchReadmoo } from './sources/readmoo';
import { mergeWorks, normalizeName, collapseSeries } from './core/matching';
import { verify } from './core/verify';
import { writeup } from './core/writeup';
import { enrichWork } from './enrich';
import { buildReport, reportSection } from './core/report';
import { complete, type LLMConfig, type Provider } from './llm/client';
import { rerankByTheme, applyRerankVerdicts, type RerankResult } from './core/llm-rerank';
import type { Work } from './types';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// Host header values we accept on /api/*. Anything else gets 403.
// Defends against DNS-rebinding: a malicious page that points
// "evil.com" -> 127.0.0.1 will arrive with Host: evil.com.
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
]);

interface SearchKeys {
  tmdb?: string;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  maxRequestBodySize: 1 * 1024 * 1024,

  routes: {
    '/': indexHtml,
    '/index.html': indexHtml,

    '/api/health': (req: Request) => guardApi(req, () => Response.json({ ok: true, version: '0.1.0' })),
    '/api/search':  { POST: (req: Request) => guardApi(req, () => handleSearch(req)) },
    '/api/writeup': { POST: (req: Request) => guardApi(req, () => handleWriteup(req)) },
    '/api/report':  { POST: (req: Request) => guardApi(req, () => handleReport(req)) },
  },
  fetch() {
    return new Response('Not found', { status: 404 });
  },
  error(err) {
    console.error('[server error]', err);
    return new Response('Internal error', { status: 500 });
  },
});

console.log(`SFF Curator running at http://localhost:${server.port}`);
console.log(`(bound to ${HOST}; loopback only)`);
console.log(`Open this URL in your browser. Press Ctrl+C to stop.`);

if (!process.env.NODE_ENV?.includes('dev') && process.platform === 'win32') {
  openBrowser(`http://localhost:${server.port}`);
}

// ---- API guards ---------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

async function guardApi(req: Request, handler: () => Promise<Response> | Response): Promise<Response> {
  const host = req.headers.get('host') ?? '';
  if (!ALLOWED_HOSTS.has(host)) {
    return withSecurityHeaders(new Response('Forbidden', { status: 403 }));
  }
  const res = await handler();
  return withSecurityHeaders(res);
}

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// ---- Keyword parsing + bilingual expansion ------------------------------

const VALID_PROVIDERS: Provider[] = ['anthropic', 'openai', 'google', 'ollama'];

/**
 * Split a theme string into individual keyword groups.
 * We split on commas (ASCII + full-width + ideographic) and semicolons.
 * Whitespace inside a single keyword is preserved (e.g. "science fiction"
 * is one term, "學徒,科幻" is two terms).
 */
export function parseKeywords(theme: string): string[] {
  return theme
    .split(/[,，;；、]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function hasCjk(s: string): boolean {
  return /\p{Script=Han}/u.test(s);
}

/**
 * Script classification for one expanded variant. We use this to bucket the
 * brainstorm output into per-script search variants (zh / en / ja / ko)
 * before fanning out to source adapters — see buildSearchVariants() below.
 *
 *  - 'ja' is only returned when the term contains hiragana / katakana
 *    (a kanji-only term is indistinguishable from zh and goes in the 'zh'
 *    bucket since Han-only matches will hit zh AniList queries too).
 *  - 'ko' requires hangul (\p{Script=Hangul}).
 *  - 'en' is the fallback for ASCII-mostly tokens.
 */
export type Script = 'zh' | 'en' | 'ja' | 'ko';
export function classifyScript(term: string): Script {
  if (/\p{Script=Hangul}/u.test(term)) return 'ko';
  if (/[぀-ゟ゠-ヿ]/.test(term)) return 'ja'; // kana presence
  if (/\p{Script=Han}/u.test(term)) return 'zh';
  return 'en';
}

/**
 * Ask the LLM to BRAINSTORM 5-12 search-keyword variants per input keyword
 * (synonyms in zh + en, plus JP + KR when the input contains CJK; common
 * related phrases; genre-typical terms). This widens the candidate net
 * before fan-out so we don't miss works that aren't tagged or titled with
 * the literal user keyword.
 *
 * Multilingual rationale: the dominant manga catalog (AniList) and most
 * Korean manhwa indexes don't return useful hits for a Chinese-only query
 * like "學徒" — they want romaji / kanji / hangul. So when the user types
 * CJK we explicitly ask for Japanese (kanji + kana) and Korean (hangul)
 * variants alongside the zh + en ones. For pure ASCII input we keep the
 * old behaviour (zh + en only) to save tokens.
 *
 * Returns parallel array: groups[i] = [original, ...variants]. Falls back
 * to singletons on network/parse failure.
 *
 * Output format expected (one line per input):
 *   <original>=<variant1>,<variant2>,...
 */
export async function translateKeywords(
  keywords: string[],
  cfg: LLMConfig,
): Promise<string[][]> {
  const anyCjk = keywords.some(hasCjk);
  // Per-language sentence + example block. Inserted only when at least one
  // keyword is CJK so we don't waste tokens for pure-English queries.
  const multilingualHint = anyCjk
    ? 'Mix languages: include zh (Traditional Chinese), en, AND Japanese ' +
      '(kanji+kana, e.g. 見習い, 弟子, 修行) AND Korean (hangul, e.g. 수련생, ' +
      '견습) variants when relevant. Japanese manga and Korean manhwa ' +
      'catalogs (AniList, Bookmeter, Naver) need native-script keywords ' +
      'to return useful hits — a Chinese-only query like "學徒" misses them.'
    : 'Mix languages (zh + en) where useful.';
  const examples = anyCjk
    ? 'Examples:\n' +
      '學徒=徒弟,見習,修行,拜師,apprentice,disciple,mentee,novice,見習い,弟子,수련생,견습\n' +
      '科幻=science fiction,sci-fi,scifi,sf,speculative fiction,SF,空想科学,SF小説\n' +
      '蒸汽龐克=蒸汽朋克,steampunk,clockwork,Victorian sci-fi,スチームパンク,스팀펑크\n' +
      '機甲=mecha,mech,giant robot,メカ,ロボット,로봇\n'
    : 'Examples:\n' +
      'apprentice=disciple,mentee,novice,trainee,journeyman,initiate\n' +
      'steampunk=clockwork,Victorian sci-fi,gaslamp fantasy,brass and steam\n' +
      'cyberpunk=cyber noir,dystopian sci-fi,neon noir,hi-tech low-life\n';
  const userMsg =
    'For each SFF curation keyword below, list 5-12 SEARCH-KEYWORD variants ' +
    'a Taiwanese librarian would try when looking for candidate works. ' +
    multilingualHint + ' Include common synonyms, genre-typical ' +
    'phrases, and likely title fragments. Drop the duplicate of the input ' +
    'itself (we already have it).\n\n' +
    examples +
    '\nOutput ONE line per input, format:\n' +
    '<input>=<variant1>,<variant2>,...\n\n' +
    'No explanation, no quotes, no markdown. If the input is already broad ' +
    'enough (e.g. just "steampunk"), give 3-4 close variants only.\n\n' +
    'Inputs:\n' +
    keywords.join('\n');

  const reply = await complete(cfg, {
    system: 'You produce structured search-keyword brainstorms for an SFF curation tool. Output is one line per input, format <input>=<v1>,<v2>,<v3>. No commentary.',
    user: userMsg,
    maxTokens: 800,
    temperature: 0.2,
  });

  // Default: every group contains at least the original term.
  const groups: string[][] = keywords.map(k => [k]);
  for (const rawLine of reply.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(.+?)\s*=\s*(.+)$/);
    if (!m) continue;
    const orig = m[1].trim();
    const eqs = m[2]
      .split(/[,，;；]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => s.toLowerCase() !== orig.toLowerCase());
    const idx = keywords.indexOf(orig);
    if (idx >= 0) groups[idx].push(...eqs);
  }
  return groups;
}

/**
 * Some keyword groups describe a TYPE of work, not a textual concept.
 * `漫畫`, `manga`, `comic`, `動畫`, `小說`, `電影`, etc. are medium constraints.
 * If a group hits this map, we filter on `work.medium` instead of doing
 * text-match across titles/synopsis (which would miss most cases since
 * a manga rarely has the literal word "manga" in its metadata text).
 */
const MEDIUM_ALIASES: Record<string, Array<Work["medium"]>> = {
  // book / novel
  '書': ['book'], '書籍': ['book'], '小說': ['book'], '輕小說': ['book'],
  'book': ['book'], 'novel': ['book'], 'lightnovel': ['book'], 'light novel': ['book'],
  // manga / comic / manhua / manhwa / webtoon — covers zh-TW + zh-CN + jp + kr
  '漫畫': ['manga', 'comic'], 'manga': ['manga'], 'comic': ['comic'], 'comics': ['comic'],
  'manhua': ['comic'], 'manhwa': ['comic'], 'graphic novel': ['comic'],
  '漫画': ['manga', 'comic'], 'マンガ': ['manga'], 'コミック': ['comic'],
  '만화': ['manga', 'comic'], '웹툰': ['comic'],
  'webtoon': ['comic'], 'web toon': ['comic'], 'webcomic': ['comic'],
  // anime
  '動畫': ['anime'], '卡通': ['anime'], 'anime': ['anime'],
  // film / movie
  '電影': ['film'], '影片': ['film'],
  'film': ['film'], 'movie': ['film'], 'films': ['film'], 'movies': ['film'],
  // tv / series
  '影集': ['tv'], '劇集': ['tv'], '電視劇': ['tv'],
  'tv': ['tv'], 'television': ['tv'], 'series': ['tv'], 'tv series': ['tv'], 'show': ['tv'],
  // game
  '遊戲': ['game'], '電玩': ['game'], '電動': ['game'],
  'game': ['game'], 'games': ['game'], 'video game': ['game'], 'videogame': ['game'],
};

/**
 * If every term in a group resolves to a Medium alias, return the union of
 * those Medium values. Otherwise null (this group is a text-match group).
 *
 * We require ALL terms to resolve so a mixed group like ['學徒','apprentice']
 * (no medium meaning) doesn't accidentally become a medium constraint, while
 * a group like ['漫畫','manga','comic'] (LLM-expanded) cleanly does.
 */
export function groupAsMediumFilter(group: string[]): Array<Work["medium"]> | null {
  if (!group.length) return null;
  // First term is the user's original input. If THAT resolves to a medium,
  // we trust the user's intent and treat the whole group as a medium
  // constraint — even if some brainstorm-added variants (e.g. a stray "漫"
  // or katakana "サイエンス・フィクション") aren't in our alias map. Without
  // this rule the constraint stripping is at the mercy of every new token
  // the LLM happens to produce.
  const first = group[0]?.trim().toLowerCase() ?? '';
  if (!MEDIUM_ALIASES[first]) return null;
  const out = new Set<Work["medium"]>();
  for (const term of group) {
    const hit = MEDIUM_ALIASES[term.trim().toLowerCase()];
    if (hit) for (const m of hit) out.add(m);
  }
  return [...out];
}

/**
 * Some keyword groups describe a GENRE/subgenre, not a textual concept.
 * `科幻` / `奇幻` / `蒸汽龐克` etc. are genre constraints that should match
 * against work.subgenres (which the source adapters populate from
 * curated tag fields like ISFDB and AniList) rather than be AND-matched
 * inside the query string sent to catalog sources. Subgenre data is
 * uneven across sources, so we ALSO accept a text hit on any term in
 * the group as a fallback - effectively giving genre groups OR semantics.
 */
const GENRE_ALIASES: Record<string, string[]> = {
  // sci-fi (zh-TW + zh-CN + en + ja + ko)
  '科幻': ['science fiction', 'sci-fi'],
  '科幻小說': ['science fiction'],
  'science fiction': ['science fiction'],
  'sci-fi': ['science fiction', 'sci-fi'],
  'scifi': ['science fiction'],
  'sf': ['science fiction'],
  '空想科学': ['science fiction'],
  'sf小説': ['science fiction'],
  '과학 소설': ['science fiction'],
  '과학소설': ['science fiction'],
  '공상과학': ['science fiction'],
  // fantasy (zh + en + ja + ko)
  '奇幻': ['fantasy'],
  '奇幻小說': ['fantasy'],
  'fantasy': ['fantasy'],
  'ファンタジー': ['fantasy'],
  '판타지': ['fantasy'],
  // horror
  '恐怖': ['horror'],
  '驚悚': ['horror', 'thriller'],
  'horror': ['horror'],
  'thriller': ['thriller'],
  // cyberpunk
  '賽博龐克': ['cyberpunk'],
  '電馭叛客': ['cyberpunk'],
  '網路龐克': ['cyberpunk'],
  'cyberpunk': ['cyberpunk'],
  // steampunk
  '蒸汽龐克': ['steampunk'],
  '蒸汽朋克': ['steampunk'],
  'steampunk': ['steampunk'],
  // dystopia
  '反烏托邦': ['dystopia', 'dystopian fiction'],
  'dystopia': ['dystopia'],
  'dystopian': ['dystopia', 'dystopian fiction'],
  // space opera
  '太空歌劇': ['space opera'],
  'space opera': ['space opera'],
  // urban / dark / epic / high fantasy
  '都市奇幻': ['urban fantasy'],
  '黑暗奇幻': ['dark fantasy'],
  '史詩奇幻': ['epic fantasy'],
  '高奇幻': ['high fantasy'],
  'urban fantasy': ['urban fantasy'],
  'dark fantasy': ['dark fantasy'],
  'epic fantasy': ['epic fantasy'],
  'high fantasy': ['high fantasy'],
  'sword and sorcery': ['sword and sorcery'],
  // post-apocalyptic
  '後末日': ['post-apocalyptic', 'apocalyptic fiction'],
  '末日': ['post-apocalyptic', 'apocalyptic fiction'],
  'post-apocalyptic': ['post-apocalyptic'],
  'apocalyptic': ['apocalyptic fiction'],
  // alternate history
  '架空歷史': ['alternate history'],
  '另類歷史': ['alternate history'],
  'alternate history': ['alternate history'],
  // time travel
  '時空旅行': ['time travel'],
  '時間旅行': ['time travel'],
  'time travel': ['time travel'],
  // hard / soft sf
  '硬科幻': ['hard science fiction'],
  '軟科幻': ['soft science fiction'],
  'hard sf': ['hard science fiction'],
  'hard science fiction': ['hard science fiction'],
  'soft science fiction': ['soft science fiction'],
  // weird / cosmic horror
  '詭異小說': ['weird fiction'],
  '宇宙恐怖': ['cosmic horror'],
  'weird fiction': ['weird fiction'],
  'cosmic horror': ['cosmic horror'],
  // misc
  '魔幻寫實': ['magical realism'],
  'magical realism': ['magical realism'],
  '哥德式': ['gothic fiction'],
  'gothic': ['gothic fiction'],
  '生物龐克': ['biopunk'],
  'biopunk': ['biopunk'],
  'speculative fiction': ['speculative fiction'],
};

/**
 * If every term in a group resolves to a genre alias, return the union of
 * canonical genre tags. Otherwise null. Same all-must-resolve rule as
 * groupAsMediumFilter: a mixed group like ['學徒', 'apprentice'] is NOT a
 * genre group; an LLM-expanded group like ['科幻', 'science fiction', 'sci-fi']
 * cleanly is.
 */
export function groupAsGenreFilter(group: string[]): string[] | null {
  if (!group.length) return null;
  // First-term-trust rule: see the matching comment in groupAsMediumFilter.
  // Same rationale — relying on every brainstormed variant being in our
  // alias map is fragile (Gemma produces サイエンス・フィクション, SF소설,
  // and other long-tail forms we'd never finish enumerating).
  const first = group[0]?.trim().toLowerCase() ?? '';
  if (!GENRE_ALIASES[first]) return null;
  const out = new Set<string>();
  for (const term of group) {
    const hit = GENRE_ALIASES[term.trim().toLowerCase()];
    if (hit) for (const g of hit) out.add(g);
  }
  return [...out];
}

/**
 * AND filter: a work survives if for every keyword GROUP either
 *   - the group is a medium constraint AND work.medium is in its set, OR
 *   - the group is a genre constraint AND work.subgenres or text matches, OR
 *   - the group is textual AND at least one term appears (case-insensitive)
 *     in the work's searchable text.
 */
export function matchesAllGroups(work: Work, groups: string[][]): boolean {
  if (!groups.length) return true;
  const haystackParts: string[] = [
    work.titles.en, work.titles.zh, work.titles.original,
    ...work.creators.flatMap(c => [c.name.en, c.name.zh, c.name.original]),
    work.synopsis?.en, work.synopsis?.zh,
    ...(work.subgenres ?? []),
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const haystack = haystackParts.join(' ').toLowerCase();
  return groups.every(group => {
    const mediumSet = groupAsMediumFilter(group);
    if (mediumSet) return mediumSet.includes(work.medium);
    const genreSet = groupAsGenreFilter(group);
    if (genreSet) {
      // Genre groups have OR semantics: subgenre tag match OR text match.
      // The text fallback is needed because subgenre data is uneven -
      // books_tw / readmoo / wikidata don't populate subgenres at all.
      const subs = (work.subgenres ?? []).map(s => s.toLowerCase());
      if (subs.some(s => genreSet.includes(s))) return true;
      const haystackHasGenre = genreSet.some(g => haystack.includes(g));
      const haystackHasTerm = group.some(term => term && haystack.includes(term.toLowerCase()));
      return haystackHasGenre || haystackHasTerm;
    }
    return group.some(term => term && haystack.includes(term.toLowerCase()));
  });
}

/**
 * Build a predicate that returns true if a Work has any creator matching
 * one of the user's excluded names. Matching is normalized substring:
 * normalizeName() is applied to both sides (NFKC + lowercase + strip
 * spaces/punctuation), then we check if the excluded form appears anywhere
 * inside the creator's normalized en/zh/original name. Substring rather
 * than exact-equals so that "Neil Gaiman" still matches a creator field
 * that came back as "尼爾．蓋曼（Neil Gaiman）" or "Neil Richard Gaiman".
 *
 * Empty exclude list → predicate always returns false (no-op).
 */
export function makeExcludeFilter(rawNames: string[]): (work: Work) => boolean {
  const normalized = rawNames.map(normalizeName).filter(s => s.length > 0);
  if (!normalized.length) return () => false;
  return (work: Work) => {
    for (const c of work.creators) {
      const fields = [c.name.en, c.name.zh, c.name.original]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .map(normalizeName);
      for (const field of fields) {
        for (const ex of normalized) {
          if (field.includes(ex)) return true;
        }
      }
    }
    return false;
  };
}

// ---- /api/search --------------------------------------------------------
async function handleSearch(req: Request): Promise<Response> {
  let body: {
    theme?: string;
    limit?: number;
    keys?: SearchKeys;
    llmConfig?: Partial<LLMConfig>;
    /**
     * Author/creator names to drop from results. Set in Settings, persisted
     * client-side. Match is normalized (lowercase, NFKC, punctuation/space
     * stripped) substring against creators[].name.{en,zh,original}.
     */
    excludeAuthors?: string[];
  };
  try { body = await req.json() as typeof body; }
  catch { return Response.json({ error: 'Body must be JSON' }, { status: 400 }); }

  const theme = (body.theme ?? '').trim();
  if (!theme) return Response.json({ error: 'theme is required' }, { status: 400 });
  if (theme.length > 200) return Response.json({ error: 'theme too long' }, { status: 400 });
  const limit = clamp(body.limit ?? 15, 1, 50);
  const keys = body.keys ?? {};
  // Build the exclude predicate up front. Hardened against junk input:
  // non-array → ignored; non-string entries → skipped; per-entry length cap
  // so a 1MB string doesn't melt normalization; 100-entry total cap.
  const rawExcludes = Array.isArray(body.excludeAuthors) ? body.excludeAuthors : [];
  const excludeAuthors = rawExcludes
    .filter((s): s is string => typeof s === 'string')
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length <= 200)
    .slice(0, 100);
  const isExcluded = makeExcludeFilter(excludeAuthors);

  const keywords = parseKeywords(theme);
  const errors: Record<string, string> = {};
  const stats: Record<string, unknown> = {};

  // Optional bilingual expansion via the configured LLM. Only triggers
  // when the user has CJK in at least one keyword AND has an LLM config.
  let groups: string[][] = keywords.map(k => [k]);
  const cfg = body.llmConfig;
  const wantsBilingual =
    cfg?.provider && VALID_PROVIDERS.includes(cfg.provider as Provider) &&
    keywords.some(hasCjk);
  if (wantsBilingual) {
    if (cfg?.baseUrl) {
      const v = validateBaseUrl(cfg.baseUrl);
      if (!v.ok) return Response.json({ error: v.reason }, { status: 400 });
    }
    try {
      groups = await translateKeywords(keywords, {
        provider: cfg!.provider as Provider,
        model: typeof cfg!.model === 'string' ? cfg!.model : undefined,
        apiKey: typeof cfg!.apiKey === 'string' ? cfg!.apiKey : '',
        baseUrl: typeof cfg!.baseUrl === 'string' ? cfg!.baseUrl : undefined,
      });
      stats.bilingualGroups = groups;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors._bilingual = msg;
      console.warn('[search] bilingual expansion failed, falling back to literal:', msg);
    }
  }

  // Constraint groups (medium/genre) are filters, not search keywords.
  // Including them in the query string narrows source results to zero
  // (e.g. "學徒 漫畫" sent to Books.com.tw rarely matches anything).
  // We send only TEXT groups to the sources, then apply the constraints
  // via the AND post-filter below.
  const isConstraintGroup = (g: string[]) =>
    groupAsMediumFilter(g) !== null || groupAsGenreFilter(g) !== null;
  const textGroups = groups.filter(g => !isConstraintGroup(g));

  // Build search variants from text groups only.
  // We construct ONE query per script bucket (zh / en / ja / ko) by picking,
  // per group, the first variant whose script matches that bucket. This
  // lets AniList finally see Japanese keywords like "見習い" / "弟子" and
  // Korean keywords like "수련생" — without it, the brainstorm's JP/KR
  // expansions would never make it into a search query because the previous
  // builder only emitted "first-element" + "second-element" strings.
  //
  // Buckets that don't contribute at least one term per group are skipped
  // (no all-empty queries). The original-term variant is always kept since
  // it's the user's literal intent.
  const variants = new Set<string>();
  if (textGroups.length) {
    variants.add(textGroups.map(g => g[0]).join(' '));
    for (const script of ['en', 'ja', 'ko', 'zh'] as const) {
      const perGroup = textGroups.map(g =>
        g.find(term => classifyScript(term) === script && term !== g[0]),
      );
      if (perGroup.every(t => typeof t === 'string' && t.length > 0)) {
        variants.add((perGroup as string[]).join(' '));
      }
    }
  } else {
    // User typed only constraint keywords (e.g. just "漫畫"). Fall back
    // to the original concatenation so we still hit the sources somehow.
    variants.add(keywords.join(' '));
  }
  stats.queryVariants = [...variants];

  const collected: Work[] = [];
  for (const variant of variants) {
    const sources: Array<{ name: string; run: () => Promise<Work[]> }> = [
      { name: 'openlibrary', run: () => searchOpenLibrary(variant, limit) },
      { name: 'anilist',     run: () => searchAniList(variant, limit) },
      { name: 'tmdb',        run: () => searchTmdb(variant, limit, keys.tmdb ?? '') },
      { name: 'isfdb',       run: () => searchIsfdb(variant, limit) },
      { name: 'wikidata',    run: () => searchWikidata(variant, limit) },
      { name: 'books_tw',    run: () => searchBooksTw(variant, limit) },
      { name: 'readmoo',     run: () => searchReadmoo(variant, limit) },
    ];
    const results = await Promise.allSettled(sources.map(s => s.run()));
    results.forEach((r, i) => {
      const name = sources[i].name;
      if (r.status === 'fulfilled') {
        collected.push(...r.value);
      } else {
        // Keep the LATEST error per source name (later variant overrides
        // earlier; if any variant succeeded, the success replaces the
        // error in `collected`).
        errors[name] = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.error(`[search] ${name} (variant=${variant}) failed:`, r.reason);
      }
    });
  }

  // Drop "errors" entries for sources that succeeded on at least one variant.
  const succeededSources = new Set<string>();
  for (const w of collected) {
    for (const k of Object.keys(w.sources)) succeededSources.add(k);
  }
  for (const k of Object.keys(errors)) {
    if (succeededSources.has(k)) delete errors[k];
  }

  let merged = mergeWorks(collected);
  // Collapse multi-volume series (Sandman 1, 2, 3, ... → "Sandman (全 N 冊)")
  // BEFORE verify so the collapsed entry's source-count contributes to the
  // confidence rating and TW-listed sort key. Singletons pass through.
  const beforeCollapse = merged.length;
  merged = collapseSeries(merged);
  if (merged.length !== beforeCollapse) {
    stats.collapsedSeries = beforeCollapse - merged.length;
  }
  let kept = verify(merged);

  // Author exclude pass. Applied AFTER verify (so the rejected works are
  // still counted in `merged` for stats / debugging) and BEFORE the LLM
  // rerank (so we don't waste rerank tokens on works the user has already
  // told us to drop).
  if (excludeAuthors.length) {
    const before = kept.length;
    kept = kept.filter(w => !isExcluded(w));
    stats.excluded = before - kept.length;
    stats.excludeAuthors = excludeAuthors;
  }

  // Filter step. When the user typed multiple keywords (theme + a
  // medium/genre constraint, or several theme keywords), apply EITHER
  // the LLM re-rank (preferred when LLM is configured) OR a literal AND
  // text-match (fallback). Single-keyword searches skip filtering.
  let rerankVerdicts: RerankResult[] | null = null;
  if (groups.length > 1 && kept.length > 0) {
    if (wantsBilingual) {
      // LLM is configured - use it for batched theme/genre classification.
      // Recall over precision: keep YES + MAYBE, drop NO.
      try {
        rerankVerdicts = await rerankByTheme(kept, theme, {
          provider: cfg!.provider as Provider,
          model: typeof cfg!.model === 'string' ? cfg!.model : undefined,
          apiKey: typeof cfg!.apiKey === 'string' ? cfg!.apiKey : '',
          baseUrl: typeof cfg!.baseUrl === 'string' ? cfg!.baseUrl : undefined,
        });
        kept = applyRerankVerdicts(kept, rerankVerdicts);
        stats.rerank = {
          yes: rerankVerdicts.filter(v => v.verdict === 'yes').length,
          maybe: rerankVerdicts.filter(v => v.verdict === 'maybe').length,
          no: rerankVerdicts.filter(v => v.verdict === 'no').length,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors._rerank = msg;
        console.warn('[search] LLM rerank failed, falling back to literal AND:', msg);
        kept = kept.filter(w => matchesAllGroups(w, groups));
      }
    } else {
      // No LLM configured - fall back to literal AND text-match filter.
      kept = kept.filter(w => matchesAllGroups(w, groups));
    }
  }

  return Response.json({
    theme,
    works: kept,
    errors,
    stats: {
      raw: collected.length,
      merged: merged.length,
      kept: kept.length,
      keywords,
      queryVariants: [...variants],
      ...stats,
    },
  });
}

// ---- /api/writeup -------------------------------------------------------
/**
 * Validate a base URL: must be http(s) AND must not target link-local
 * (cloud-metadata) addresses. Other private ranges are allowed because
 * legitimate local-LLM use cases live there (loopback, LAN servers).
 */
function validateBaseUrl(s: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(s); }
  catch { return { ok: false, reason: 'baseUrl is not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'baseUrl must be http(s)' };
  }
  if (/^169\.254\./.test(u.hostname)) {
    return { ok: false, reason: 'baseUrl points to a link-local address' };
  }
  if (/^\[?fe[89ab][0-9a-f]:/i.test(u.hostname)) {
    return { ok: false, reason: 'baseUrl points to a link-local address' };
  }
  return { ok: true };
}

async function handleWriteup(req: Request): Promise<Response> {
  let body: { work?: Work; config?: Partial<LLMConfig> };
  try { body = await req.json() as typeof body; }
  catch { return Response.json({ error: 'Body must be JSON' }, { status: 400 }); }

  if (!body.work || typeof body.work !== 'object') {
    return Response.json({ error: 'work required' }, { status: 400 });
  }
  if (!body.config || typeof body.config !== 'object') {
    return Response.json({ error: 'config required' }, { status: 400 });
  }
  const cfg = body.config;
  if (!cfg.provider || !VALID_PROVIDERS.includes(cfg.provider)) {
    return Response.json({ error: 'invalid provider' }, { status: 400 });
  }
  if (cfg.baseUrl) {
    const v = validateBaseUrl(cfg.baseUrl);
    if (!v.ok) return Response.json({ error: v.reason }, { status: 400 });
  }
  const config: LLMConfig = {
    provider: cfg.provider,
    model: typeof cfg.model === 'string' ? cfg.model : undefined,
    apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : '',
    baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
  };

  try {
    // Enrich the work's synopsis (Wikipedia: en/zh/ja/ko) and gather
    // reception material (Reddit + Plurk) before calling the LLM. The two
    // are deliberately kept separate: synopsis grounds §1-§3 (background +
    // story), reception grounds §4 (reader reactions). Failures are
    // non-fatal — if Wikipedia is down we still get a writeup from the
    // original synopsis, just without the cross-language enrichment.
    // Pass the LLM config into enrichWork so its title-resolver step can
    // run (Step 0 of the pipeline — turns "刺客正傳1刺客學徒(經典紀念版)"
    // into "Assassin's Apprentice" so Reddit and en Wikipedia get a
    // useful query). If config is unavailable the resolver is skipped and
    // the rest of the pipeline degrades gracefully.
    const { work: enriched, reception, report } = await enrichWork(body.work, config).catch(err => {
      console.warn('[writeup] enrichment failed, falling back to bare metadata:', err);
      return {
        work: body.work as Work,
        reception: { reddit: [], plurk: [] },
        report: { wikipedia: [], reddit: [], plurk: [] },
      };
    });
    const result = await writeup(enriched, config, reception);
    return Response.json({
      ...result,
      enrichment: {
        wikipedia: report.wikipedia.map(w => ({ lang: w.lang, title: w.title, url: w.url })),
        reddit: report.reddit.map(r => ({ subreddit: r.subreddit, title: r.title, url: r.url, score: r.score })),
        plurk: report.plurk.map(p => ({ pid: p.pid, url: p.url, respCount: p.respCount })),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const safe = redactKey(msg, config.apiKey);
    console.error('[writeup]', safe);
    return Response.json({ error: safe }, { status: 502 });
  }
}

function redactKey(msg: string, key: string): string {
  if (!key) return msg;
  let out = msg.split(key).join('***');
  const encoded = encodeURIComponent(key);
  if (encoded !== key) out = out.split(encoded).join('***');
  return out;
}

// ---- /api/report --------------------------------------------------------
async function handleReport(req: Request): Promise<Response> {
  let body: {
    theme?: string;
    works?: Work[];
    writeups?: Record<string, string>;
  };
  try { body = await req.json() as typeof body; }
  catch { return Response.json({ error: 'Body must be JSON' }, { status: 400 }); }

  const theme = (body.theme ?? 'untitled').trim().slice(0, 200);
  const works = Array.isArray(body.works) ? body.works.slice(0, 50) : [];
  const writeups: Record<string, string> = {};
  if (body.writeups && typeof body.writeups === 'object') {
    for (const [k, v] of Object.entries(body.writeups)) {
      if (typeof v === 'string') writeups[k] = v.slice(0, 5000);
    }
  }

  const sections = works.map((w, i) => reportSection(w, writeups[String(i)]));
  const markdown = buildReport(theme, sections);

  const filename = `curate_${slugify(theme)}_${ymd()}.md`;
  const filenameAscii = filename.replace(/[^\x20-\x7E]/g, '_');
  const filenameUtf8 = encodeURIComponent(filename);

  return new Response(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition':
        `attachment; filename="${filenameAscii}"; filename*=UTF-8''${filenameUtf8}`,
    },
  });
}

function slugify(s: string): string {
  let out = s.normalize('NFKC')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\-_一-鿿]/g, '')
    .slice(0, 60);
  out = out.replace(/^-+/, '');
  return out || 'theme';
}
function ymd(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${m}${day}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function openBrowser(url: string): void {
  try {
    Bun.spawn(['cmd', '/c', 'start', '', url], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    console.warn('[browser] could not auto-open, please open manually:', url);
  }
}
