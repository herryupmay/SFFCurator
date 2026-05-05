# SFF Curator — Build Plan

Forum SFF curation pipeline. Given a theme (e.g. `steampunk`, `蒸汽龐克`),
produce 5–8 verified candidate works (books / films / manga / anime) with
merged metadata from English + Taiwanese sources, a confidence score,
translation status, and a 200-word zh-TW draft introduction ready for human
polish.

## Stack

- **Language:** TypeScript
- **Runtime:** [Bun](https://bun.sh) (HTTP server, bundler, single-binary compile)
- **Distribution:** single Windows `.exe` — friend downloads, double-clicks,
  browser opens to `localhost:3000`. No install, no deploy.
- **API keys:** bring-your-own (BYOK). Each user pastes their own keys into
  the UI on first visit; stored in browser localStorage.
- **LLM:** provider-agnostic via Vercel AI SDK. Default Anthropic Claude;
  user can switch to OpenAI / Google / Ollama in settings.

## Architecture

Four pipeline stages, each independently testable.

### Stage 1 — Discovery (parallel API calls)

Seven source adapters, all async, each exporting
`search(query, limit) -> Promise<Work[]>`:

- `openlibrary.ts` — Open Library REST. Books, broad coverage.
- `isfdb.ts` — ISFDB. Best for SFF subgenre tagging. Curated, not crowdsourced.
- `anilist.ts` — AniList GraphQL. Anime + manga. No auth.
- `tmdb.ts` — TMDB. Films + TV. Free API key.
- `wikidata.ts` — Wikidata SPARQL. Cross-language labels (often has zh-TW
  for the work entity); useful for matching `差分機` ↔ `The Difference Engine`.
- `books_tw.ts` — 博客來 ([Books.com.tw](https://books.com.tw)) scraper.
  Confirms zh-TW availability + translation.
- `readmoo.ts` — Readmoo scraper. Second TW availability source.

Optional 8th: `kingstone.ts` (金石堂) — third TW bookstore, add later if needed.
Skipped: LibraryThing — duplicates ISFDB + Open Library, half-deprecated API.

All hit in parallel via `Promise.all`. Per-host rate limiting (1 req/sec) for
scraped sources. Polite User-Agent.

### Stage 2 — Matching & merging

Three-tier dedupe across sources, in priority order:

1. **ISBN-13 match** — most reliable. Use Open Library's edition graph to map
   zh-TW ISBNs back to original-edition ISBNs.
2. **Author + year fuzzy match** — normalize names (handle 威廉·吉布森 ↔
   William Gibson via known transliteration table + LLM fallback for unknowns),
   match if year within ±2.
3. **Title back-translation match** — LLM translates 繁中 title to English,
   fuzzy-match against pooled English titles. Lower confidence, flag for review.

Output: merged `Work[]` with `confidence: 'high' | 'medium' | 'low'` and a
`sources` map listing every URL that contributed.

### Stage 3 — Verification & filtering

- Drop records found in only one source AND lacking a strong ID
  (no ISBN, no AniList/TMDB/ISFDB ID).
- Keep single-source records with strong IDs (one ISFDB hit with full metadata
  is fine — ISFDB is curated).
- Flag `hasZhTranslation` (true if any zh-TW source has it).
- Flag `availableInTw` (true if 博客來 or Readmoo currently lists it).
- Per spec: keep untranslated works, label them 「未中譯」.

### Stage 4 — Writeup

For each verified work, call the configured LLM with:

- Merged record as structured JSON (titles, creators, year, synopsis, subgenres).
- System prompt locking in 台灣繁體中文 + 台灣用語. Explicit blocklist:
  視頻→影片, 軟件→軟體, 數據→資料, 網絡→網路, 質量→品質, 默認→預設, etc.
- Hard rule: do not invent details beyond the record. Better short and accurate
  than padded and made up.

Output: 200 words ±20, ready for the team to polish.

Post-check: `bad_phrases.txt` regex pass on the output. Flag any 大陸用語 leaks
in the UI for the user to fix manually. (Especially important when running on
non-Claude models, which haven't been tuned for zh-TW.)

### Stage 5 — Report

Single markdown document, one section per work:

```markdown
## 差分機 (The Difference Engine)
- **作者**: William Gibson, Bruce Sterling / 威廉·吉布森、布魯斯·斯特林
- **類型**: 長篇小說 · 蒸汽龐克
- **出版年**: 1990 (原文) / 2012 (繁中譯本)
- **譯本狀況**: 已中譯（[出版社]）
- **信心評級**: ★★★ (high — 4 sources confirmed)

### 草稿介紹
[200 words zh-TW from LLM]

### 來源
- ISFDB: ...
- Open Library: ...
- 博客來: ...
- Readmoo: ...
```

Saved to `output/curate_<theme>_<YYYYMMDD>.md`. Also rendered in the browser
with copy-to-clipboard buttons per section.

## Project layout

```
sff-curator/
├── PLAN.md                  # this file
├── README.md                # end-user (friend) guide
├── BUILD.md                 # dev guide: building the .exe
├── package.json
├── tsconfig.json
├── .gitignore
├── src/
│   ├── server.ts            # Bun HTTP server entry point
│   ├── types.ts             # Work + Creator types
│   ├── html.d.ts            # TS declaration for HTML imports
│   ├── ui/
│   │   └── index.html       # Single-page app
│   ├── core/
│   │   ├── matching.ts      # ISBN/author/title merge logic
│   │   ├── verify.ts        # Stage 3 filter
│   │   ├── writeup.ts       # LLM call + zh-TW prompt
│   │   └── report.ts        # Markdown writer
│   ├── sources/
│   │   ├── http.ts          # Polite-GET, rate limiting, UA
│   │   ├── openlibrary.ts
│   │   ├── isfdb.ts
│   │   ├── anilist.ts
│   │   ├── tmdb.ts
│   │   ├── wikidata.ts
│   │   ├── books_tw.ts      # Scraper — selectors here, fixtures in tests/
│   │   └── readmoo.ts       # Scraper — selectors here, fixtures in tests/
│   └── llm/
│       └── client.ts        # Vercel AI SDK wrapper, BYOK + provider switch
├── tests/
│   ├── matching.test.ts
│   └── fixtures/            # saved HTML for scraper tests
└── output/                  # generated reports (.gitignored)
```

## Build order

Each step is shippable on its own.

1. **Skeleton + Open Library + AniList + TMDB.** All English-only, real APIs,
   no scraping. Verify pipeline works end-to-end with overlapping records.
2. **Add ISFDB.** Quirky API, do after the easy ones work.
3. **Add Wikidata.** SPARQL is verbose but powerful; gives zh-TW labels.
4. **Add 博客來 scraper.** HTML fixtures + tests.
5. **Add Readmoo scraper.** Same pattern.
6. **Refine matching.** Cross-language matching gets exercised once real
   zh-TW + English records are flowing. Tune fuzzy thresholds.
7. **Add LLM writeup stage.** Iterate on the zh-TW prompt with sample records.
8. **Polish report formatting + UI.**
9. **First Windows binary.** `bun build --compile --target=bun-windows-x64`.

## Things that won't work first try

Expect to iterate on:

- **Scraper selectors** for 博客來 and Readmoo — site HTML changes occasionally.
  Keep selectors isolated, with saved HTML fixtures so tests catch breakage.
- **Author name matching across languages** — easy cases like 威廉·吉布森 ↔
  William Gibson are handled by a known-mapping table; obscure translators
  fall back to LLM. Build the table organically as misses come up.
- **The zh-TW prompt** — first drafts will leak some 大陸用語 even with
  explicit instruction. The `bad_phrases.txt` post-check catches what slips
  through. Prompt iteration with good/bad examples is unavoidable.

---

## Architecture v2 — pipelines + enrichment (2026-05)

After running the MVP and getting real workflow feedback, the search +
writeup architecture has crystallized into **two parallel discovery
pipelines** that converge into the same result list, plus a **per-work
enrichment pass** that fires lazily when generating a writeup.

### Pipeline A — Catalog discovery (shipping)

The original Stage 1-3 path. Theme keyword(s) → bilingual LLM expansion
→ parallel fan-out to seven catalog sources → `mergeWorks` (3-tier ISBN /
canonical-author / singleton dedupe) → `verify` (drop low-signal singletons,
sort TW-first) → results list.

What's wired:
- Multi-keyword AND on commas (`學徒,科幻,漫畫`)
- Medium recognition: `漫畫` / `manga` / `comic` etc. resolve to a
  `work.medium` filter rather than text-match
- Bilingual LLM expansion (zh ↔ en) — fires when CJK is in the query and
  an LLM is configured
- Sort priority: `availableInTw` → confidence → source count → has-zh

### Pipeline B — Social discovery (NOT yet built)

Designed but deferred until Pipeline A produces a usable curation cycle.

```
theme
  → search Reddit (r/Fantasy, r/printSF, r/scifi, r/booksuggestions) by theme
  → search Plurk by theme
  → LLM extracts book / film / manga TITLES from the matched posts
  → for each extracted title: verify in catalogs (Pipeline A's adapters)
  → merge into Pipeline A's result set
```

This mirrors the human "I read someone mention this and went looking for
it" path. Higher latency and cost than Pipeline A, but surfaces works that
keyword-on-catalog can't reach (e.g. `Mob Psycho 100` for `學徒`).

### Enrichment — per-work, lazy on writeup

Triggered only when the user clicks **Generate zh-TW intro** for a specific
work. Runs in parallel:

| Source | Status | Searched by |
| --- | --- | --- |
| Wikipedia (en + zh, MediaWiki API) | ✅ wired | exact title |
| Reddit (SFF subreddits, JSON endpoint) | ✅ wired | exact English title |
| Plurk (web search scrape) | ✅ wired | exact title (zh first, en fallback) |
| Books.com.tw / Readmoo product page (內容簡介) | ⏳ planned | product URL |

All of the above concatenate into the work's `synopsis.en` / `synopsis.zh`
before the existing writeup prompt runs. The LLM produces the same 200-字
zh-TW intro it always did, but grounded in real plot/reception/reader
material instead of thin adapter metadata.

Failures are non-fatal: each source can fall over independently and the
writeup still produces output from whatever survived.

### Translation-hunt pass (NOT yet built)

After Pipeline A returns, for any work that's English-only (no `books_tw`
or `readmoo` source), look up the canonical Chinese title via Wikidata's
`zh-tw` label first, falling back to the LLM. Then search Books.com.tw +
Readmoo for that exact zh title and merge any hit into the same record.
Removes the manual "is this translated?" research step.

### Build roadmap (post-MVP, in order)

1. **Plurk enrichment** — ✅ done. Adapter targets `tests/fixtures/plurk-real.html`, sorts by `data-respcount`, hooks into `enrichWork` searched by zh title (en fallback).
2. **Books.com.tw / Readmoo product-page detail** — fetch 內容簡介 + 推薦序 for
   richer Chinese synopsis material in the writeup prompt.
3. **Translation-hunt pass** — wire the Wikidata zh-tw label lookup +
   follow-up TW bookstore search.
4. **Pipeline B social discovery** — only after a real curation session has
   run on the post-step-3 build and produced a punch list of remaining gaps.

Ordering rationale: each step ships an end-to-end usable improvement, the
risk profile rises gradually, and Pipeline B (the largest) only happens
after we've seen what actually hurts in real use.

### Things deliberately deferred

- **Goodreads** — actively blocks scrapers since 2020, no public API.
  Replaced by Wikipedia + Reddit + Plurk for the same ground.
- **Genre/medium filter UI (checkboxes)** — current commas-in-search
  approach with medium recognition handles the common cases. Revisit if
  users hit limits.
- **金石堂 (Kingstone) adapter** — third TW bookstore, redundant with
  Books.com.tw + Readmoo for current users.
- **LLM-as-discovery-source** — too many hallucinations and training-cutoff
  misses. We always verify titles against real catalogs.

## Known issues (from the test pass)

- `AUTHOR_ALIASES['tedchang']` is keyed `tedchang` but
  `normalizeName('Ted Chiang')` produces `tedchiang` — typo means the
  cross-language merge for Ted Chiang never fires. Two-character fix in
  `src/core/matching.ts` line 36. Pinned by `test.todo` in
  `tests/matching.test.ts`.
- `/api/report` and `/api/writeup` crash 500/502 if `body.work` is missing
  the `titles` object. The UI always sends well-formed objects so this is
  low-severity, but adding a guard would harden the API. Documented in
  `tests/report.test.ts`.
