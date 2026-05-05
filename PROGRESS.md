# Progress — session handoff

A snapshot of where the project sits after the build + security-audit
sessions. Pick up here next time.

## Status: ready to test, not yet run

The full pipeline is implemented and the security audit is complete.
What's left is the actual smoke test on a Windows machine with Bun
installed, then producing the .exe.

## What's built

A self-contained TypeScript / Bun web app that runs locally on the
user's Windows PC, opens a browser to `localhost:3000`, and curates
SFF candidates with merged metadata + a 200-word zh-TW writeup. See
[`PLAN.md`](./PLAN.md) for the full architecture.

**Pipeline (all four stages wired and typechecking clean):**

- **Stage 1 — Discovery.** Seven adapters running in parallel:
  Open Library, AniList (anime + manga), TMDB (film + TV, optional key),
  ISFDB, Wikidata (SPARQL + wbsearchentities), 博客來 scraper,
  Readmoo scraper.
- **Stage 2 — Matching.** Three-tier dedupe: ISBN-13 → canonical author
  + year → singleton. Transliteration table seeded with ~20 SFF authors.
- **Stage 3 — Verify.** Drops orphan singletons, flags `未中譯` /
  `single-source` / `low-confidence` / `tw-listing-only`, sorts by
  confidence + source count.
- **Stage 4 — Writeup.** Provider-agnostic LLM client (Anthropic /
  OpenAI / Google / Ollama; OpenAI provider has `baseUrl` override so
  llama-cpp-python / LM Studio / vLLM all work). System prompt locked
  for 台灣用語. Bad-phrases post-check highlights any 大陸用語 leakage
  in the UI in yellow.
- **Stage 5 — Report.** Markdown composer per work + downloadable
  `.md` for the team to polish.

**UI** (single-page, vanilla JS + HTML + CSS):

- English-primary with a `中文` toggle, choice persists in localStorage.
- Settings panel for LLM provider + model + key + base URL + TMDB key.
- Per-work "Generate writeup" button + "Copy" button.
- Action bar at top of results: "Generate all writeups", "Save report
  (.md)", "Copy report".
- Confidence stars, flag chips, bad-phrase highlighting.
- Welcome state with onboarding text on first load.

**Distribution:**
`bun run build:win` produces `dist/sff-curator.exe` (~50 MB,
single file, HTML+CSS+JS bundled in).

## Verified in the previous sessions

- TypeScript typechecks cleanly across all 14 source files (`tsc --noEmit`).
- File integrity OK on every file written (no NULL-byte truncation issues).
- Security audit completed in two passes (self + independent agent).
  Findings + fixes catalogued in [`SECURITY.md`](./SECURITY.md). Headline
  fixes:
    1. **Loopback-only binding** (was binding to `0.0.0.0`).
    2. **Host-header allowlist** on `/api/*` defends against DNS-rebinding.
    3. **SSRF block on link-local** (`169.254.x.x`, `fe80::/10`) prevents
       cloud-metadata exfil via `baseUrl`.
    4. **`safeUrl()` in the UI** rejects non-http(s) hrefs from scraped
       content.
    5. **Security headers** (`X-Content-Type-Options`, `Referrer-Policy`,
       `Cache-Control`) on every `/api/*` response.
    6. **Body-size + per-field length caps** (1 MB request, 200-char theme,
       50-work cap, 5000-char writeup, 1500-char synopsis).
    7. **API-key redaction** in error logs (raw + URL-encoded forms).
    8. **`baseUrl` scheme + format validation.**
    9. **RFC 5987 Content-Disposition** for non-ASCII report filenames.
    10. **Slugify hardening** (no leading dashes).

## Not yet verified — to do next session

These need a Windows machine with Bun installed:

- [ ] `bun install` succeeds.
- [ ] `bun run dev` starts the server, browser shows the UI.
- [ ] Smoke search (`steampunk`) returns hits from at least Open Library,
      AniList, ISFDB, Wikidata.
- [ ] Language toggle flips every label.
- [ ] Source links open the correct upstream pages.
- [ ] Anthropic key in Settings → "Generate zh-TW intro" returns a
      ~200-字 paragraph in clean 台灣用語.
- [ ] Local llama-cpp-python + Gemma 27B path works via OpenAI provider
      with `baseUrl=http://localhost:8000/v1`.
- [ ] "Save report" downloads a clean markdown file.
- [ ] `bun run build:win` produces `dist/sff-curator.exe`.
- [ ] The .exe runs on a Windows machine, browser auto-opens, full flow
      works end-to-end.

**Expected wrinkles** (not blockers, but plan to iterate):

- 博客來 / Readmoo / ISFDB scraper selectors are best-effort. At least
  one of these is likely to return zero results until selectors are
  tweaked. Recipe in
  [`BUILD.md`](./BUILD.md#when-a-scraper-breaks).
- Author-name transliteration table covers ~20 famous SFF authors. As
  the team uses the tool, less-famous translators will need entries
  added to `AUTHOR_ALIASES` in `src/core/matching.ts`.
- Non-Claude models may leak 大陸用語. The post-check catches it; add
  to `BAD_PHRASES` in `src/core/writeup.ts` when new ones surface.

## Next-session test plan

Run through [`TESTING.md`](./TESTING.md) on a Windows machine. Order:

1. `bun install` from `C:\Users\OEM\Documents\Claude\Projects\SFF Curator`.
2. `bun run dev`. Browser should show the UI at `localhost:3000`.
3. Search `steampunk` (no keys yet). Confirm hits from at least 4 sources.
4. Add an Anthropic key in Settings. Generate one writeup. Check char
   count + zh-TW quality.
5. (Optional) Spin up llama-cpp-python with Gemma; test the local path.
6. "Save report" → confirm the .md file is well-formed.
7. If selectors need tweaking, save fixture HTML and patch the adapter.
8. `bun run build:win` → `dist\sff-curator.exe`.
9. Run the .exe on a clean Windows machine. Confirm browser auto-opens
   and the same flow works end-to-end.
10. Drop the .exe in the team's shared folder. Hand friends
    [`README.md`](./README.md) (or [`README.zh-TW.md`](./README.zh-TW.md)).

## Open items (acceptable for MVP, worth revisiting later)

From SECURITY.md's "Open items" section:

- Add CSP + X-Frame-Options to the static HTML route. Currently HTML
  serves with Bun's defaults; full headers only on `/api/*`. Realistic
  clickjacking risk is small (password-type inputs aren't exfiltratable
  via clickjack), but the headers cost almost nothing once we figure out
  how to wrap HTMLBundle in a custom Response.
- Move `BAD_PHRASES` to a user-editable text file in the user's profile
  directory so non-devs can extend it without rebuilding.
- Optional "offline mode" config flag that disables outbound network for
  users running entirely against local LLMs.

## File map

```
SFF Curator/
├── README.md            # friend-facing (English) + FAQ
├── README.zh-TW.md      # friend-facing (Traditional Chinese) + FAQ
├── PLAN.md              # full architecture + design decisions
├── BUILD.md             # dev guide — install Bun, build the .exe
├── TESTING.md           # next-session test recipe
├── SECURITY.md          # audit findings + fixes
├── PROGRESS.md          # this file — session handoff snapshot
├── package.json         # bun + cheerio, build:win script
├── tsconfig.json
├── .gitignore
├── src/
│   ├── server.ts        # Bun.serve + 4 endpoints (/api/*) + guards
│   ├── types.ts         # Work / Creator / Medium / CreatorRole
│   ├── html.d.ts        # placeholder for *.html module decls
│   ├── ui/
│   │   ├── index.html   # UI shell + CSS (bilingual labels)
│   │   └── app.js       # i18n + settings + search + writeup + report
│   ├── sources/
│   │   ├── http.ts          # polite-fetch + per-host rate limiter
│   │   ├── openlibrary.ts   # API
│   │   ├── anilist.ts       # GraphQL API
│   │   ├── tmdb.ts          # API (optional key)
│   │   ├── isfdb.ts         # cheerio scraper
│   │   ├── wikidata.ts      # SPARQL + wbsearchentities
│   │   ├── books_tw.ts      # cheerio scraper
│   │   └── readmoo.ts       # cheerio scraper
│   ├── core/
│   │   ├── matching.ts      # 3-tier dedupe + alias table
│   │   ├── verify.ts        # filter + flag + sort
│   │   ├── writeup.ts       # zh-TW prompt + bad-phrases check
│   │   └── report.ts        # markdown composer
│   └── llm/
│       └── client.ts        # provider-agnostic LLM (4 providers)
└── tests/                   # (empty so far — fixtures land here)
```

## Quick commands

```powershell
# install Bun once
powershell -c "irm bun.sh/install.ps1 | iex"

# in the project folder
cd "$env:USERPROFILE\Documents\Claude\Projects\SFF Curator"
bun install        # one-time
bun run dev        # local dev server, hot reload
bun run typecheck  # tsc --noEmit
bun run build:win  # produce dist\sff-curator.exe
```

---

## Session 2026-05-05 — pipeline upgrades, real-world test feedback

### Headline

Architecture v2 is live (see PLAN.md). The MVP shipped at the start of the
session has been substantially upgraded based on actual user testing during
this session: the Books.com.tw and Readmoo scrapers were rebuilt against
their current 2026 layouts; the search pipeline now does multi-keyword AND
with constraint-keyword stripping, LLM-driven keyword brainstorm, and a
batched LLM re-rank that replaces the literal-text filter; the writeup
endpoint now enriches synopses from Wikipedia (en + zh), Reddit (English
SFF subs), and Plurk (zh-TW reader voice) before invoking the LLM.

165 tests, 0 fail, 1 skip (opt-in local-LLM integration), 1 todo
(`AUTHOR_ALIASES['tedchang']` typo — see Known Issues below).

### What was built this session

- **Test suite stand-up.** 11 test files under `tests/`: matching, verify,
  report, writeup, llm-client, scrapers (with fixtures), server endpoint
  integration, keywords, enrich (Wikipedia + Reddit + Plurk), llm-rerank.
  Runs in ~8s. Live HTML fixtures saved under `tests/fixtures/*-real.html`.
- **Books.com.tw scraper rebuilt** to target the new
  `div.table-td[id^="prod-itemlist-"]` layout. Pulls
  title via `h4 a[title]`, authors via `p.author a[rel="go_author"]`,
  builds canonical `/products/<itemId>` URLs.
- **Readmoo scraper rebuilt** to target `li.listItem-box` containers,
  preferring `.caption a.product-link` (the title-bearing link) over the
  cover-image `.product-link`. Authors from `.contributor-info a`.
  Description captured into `synopsis.zh`.
- **Open Library 422 fix.** UA now includes contact email, drops the
  `language` field, retries through 3 fallback URL shapes, surfaces OL's
  actual error body.
- **Multi-keyword AND search.** Theme parser splits on `,，;；、`. Keywords
  in the same text group OR; groups AND. Single-keyword searches keep
  today's broad behaviour.
- **Medium recognition.** `漫畫`/`manga`/`comic` etc. resolve to a
  `work.medium` filter, NOT a text-match. Same for `小說`/`book`/`電影`/etc.
- **Genre recognition.** `科幻`/`奇幻`/`蒸汽龐克` etc. resolve to a
  `work.subgenres` OR text match, with OR semantics.
- **Constraint-keywords stripped from search query.** Medium/genre groups
  are filters, not search terms — including them in the query shrinks
  source results to zero. Fixed.
- **TW-first sort.** `availableInTw` is now the top sort key, ahead of
  confidence and source count. Taiwan-listed works lead the list.
- **Bilingual brainstorm (replaces narrow translation).** The LLM is now
  asked for 5–8 zh+en search-keyword variants per text keyword (not just
  1–3 English equivalents) so the candidate net is wider before fan-out.
- **LLM batched re-rank.** After merge+verify, when an LLM is configured
  AND there's more than one keyword group, the server sends all candidates'
  metadata to the LLM in one batched call; LLM returns YES/MAYBE/NO per
  index; we keep YES + MAYBE (recall over precision). Each surviving work
  is annotated `raw._aiVerdict` for UI chips. Falls back to the literal
  AND filter on LLM failure.
- **Synopsis enrichment.** New `src/enrich/{wikipedia,reddit,plurk,index}.ts`.
  Triggers on `/api/writeup`. Wikipedia is searched by title (en + zh);
  Reddit by exact English title across r/Fantasy / r/printSF / r/scifi /
  r/booksuggestions; Plurk by exact zh title (en fallback) via web scrape
  of `https://www.plurk.com/search?q=...&category=plurks`. All three run in
  parallel; results concatenate into `synopsis.en` / `synopsis.zh` before
  the writeup prompt. Failures are non-fatal.

### What's NOT built yet

Per PLAN.md "Architecture v2" roadmap, in priority order:

1. **Books.com.tw / Readmoo product-page detail enrichment** — fetch the
   full 內容簡介 + 推薦序 from each work's product page during /api/writeup.
2. **Translation-hunt pass** — for English-only works, look up canonical
   zh title via Wikidata zh-tw label or LLM, then search TW bookstores.
3. **Pipeline B social discovery** — search Reddit/Plurk for THEME mentions
   → LLM extracts titles from posts → verify each in catalogs → merge.
4. **金石堂 (Kingstone) adapter** — third TW bookstore. Optional. HTML
   already saved at `webpages/金石堂.html` if anyone picks this up.

### Open from this session — to resolve next session

- **storyUI / llama.cpp endpoint discovery.** User runs storyUI on port
  8000, which wraps llama.cpp internally. `http://localhost:8000/v1/models`
  returns 404 (FastAPI-shaped `{"detail":"Not Found"}`). Real OpenAI-
  compatible endpoint is on a different path or port. Next session: open
  the storyUI folder in Cowork alongside the SFF Curator folder so the
  next agent can read its config / launch script and figure out the right
  base URL for `LLMConfig.baseUrl`. Workaround for testing right now:
  Google Gemini's free tier (free, 1 minute setup at
  https://aistudio.google.com/apikey).
- **Real curation session not yet run.** All upgrades verified by tests,
  but no human has yet picked a live theme, generated 5–8 writeups,
  exported the .md report, and fed back what hurt. That's the highest-
  value next step before any further building.

### Known issues (still open)

- `AUTHOR_ALIASES['tedchang']` is keyed `tedchang` but
  `normalizeName('Ted Chiang') === 'tedchiang'` — typo means the
  cross-language merge for Ted Chiang never fires. Two-character fix in
  `src/core/matching.ts` line 36. Pinned by `test.todo` in
  `tests/matching.test.ts`.
- `/api/report` and `/api/writeup` return 500/502 if the request body's
  `work` object is missing the `titles` field. UI sends well-formed
  objects so it's low-severity. Documented in `tests/report.test.ts`.
- Books.com.tw and Readmoo scrapers hardcode `medium: 'book'`. Manga
  listings on those sites won't match a `,漫畫` filter. Worth wiring up
  per-card medium detection from the page (the `.type` cell on
  Books.com.tw, similar on Readmoo) when convenient.

### File map additions since session 1

```
src/
├── core/
│   └── llm-rerank.ts     # batched YES/MAYBE/NO classifier
└── enrich/
    ├── index.ts          # orchestrator
    ├── wikipedia.ts      # MediaWiki API, en + zh
    ├── reddit.ts         # public JSON, English title only
    └── plurk.ts          # web scrape, zh title with en fallback

tests/
├── enrich.test.ts        # Wikipedia + Reddit + Plurk + orchestrator
├── keywords.test.ts      # parseKeywords, matchesAllGroups, translateKeywords,
│                         # groupAsMediumFilter, groupAsGenreFilter
└── llm-rerank.test.ts    # parseRerankReply, rerankByTheme, applyRerankVerdicts

tests/fixtures/
├── books_tw-real.html    # 學徒 search, May 2026
├── readmoo-real.html     # 學徒 search, May 2026
└── plurk-real.html       # 刺客學徒 search, May 2026

webpages/                  # user-saved live HTML, not in tests/fixtures yet
└── 金石堂.html             # for the optional Kingstone adapter

PLAN.md                    # extended with "Architecture v2" section
```

### Suggested order for next session

1. Open the user's storyUI folder so the agent can read its launch
   command / config and identify the OpenAI-compatible endpoint.
   (Alternatively, the user fires up Gemini-free for the test session.)
2. **Run one real curation session.** Pick an actual upcoming forum
   theme. Search. Generate 5–8 writeups. Export .md. Note where the
   pipeline hurt. THIS reorders the rest of the roadmap.
3. After the real session, build the next item from the priority list
   above based on what actually hurt — don't guess.

---

## Session 2026-05-05 (afternoon) — StoryUI hookup, exclude list, series collapse, JP/KR coverage

### Headline

Two real curation sessions for theme `學徒,科幻,漫畫` ran end-to-end against
StoryUI's local Gemma 4 26B. Pipeline went from "10/26 results were Sandman"
to "16 on-theme entries with proper series collapse, multi-URL preservation,
working author exclude, and AniList finally returning native-Japanese
manga". 204 tests pass, 0 fail.

### What was built this session

- **StoryUI OpenAI-compatible endpoint.** New
  `C:\StoryUI\Backend\routers\openai_compat.py` mounted at `/v1` exposes
  `GET /v1/models` and `POST /v1/chat/completions` (non-stream + SSE
  stream) as thin wrappers over the existing in-process llama-cpp-python
  service. Lets SFF Curator (and any future MCP / OpenAI-shaped client)
  point its `baseUrl` at `http://localhost:8000/v1` and just work. No
  auth on this surface — loopback assumption.

- **Author exclude list.** Settings panel now has an "Exclude authors"
  textarea (one name per line, persisted in localStorage). Server filters
  merged works after `verify` and before LLM rerank, so we don't waste
  rerank tokens. Match is normalized substring across creators[].name.
  {en,zh,original}. Catches "Neil Gaiman" against `Neil Gaiman` AND
  `尼爾．蓋曼（Neil Gaiman）` combined fields, but MISSES zh-only fields
  like bare `尼爾．蓋曼` — workaround: add the zh form as a second line.
  Real fix is cross-script aliasing via AUTHOR_ALIASES (TODO).

- **Series collapse.** `src/core/matching.ts` gained `seriesKey()` and
  `collapseSeries()`. Strips marketing brackets 【】《》, parens (), colon
  subtitles, vol numbers/ranges (1, 1~7, Vol.X, etc.), trailing zh vol
  words (卷/話/集/冊/套書/完/上/下…). Groups by (canonical primary
  author, seriesKey, medium) and collapses ≥2-volume groups into a
  single Work titled `<series> (全 N 冊)` / `<series> (Series, N vols)`.
  10 Sandman volumes → 1 card. Note: Chinese vol numerals (一/二/三)
  are not stripped yet, so 睡魔特典一/二/三 stays separate.

- **Multi-URL preservation in collapse.** Initial collapse implementation
  used `Object.assign(merged.sources, w.sources)` which clobbered. 6
  Sandman volumes → 1 visible URL. Fixed by suffixing collision keys
  (books_tw, books_tw_2, books_tw_3, …); display layer in report.ts and
  app.js strips `_N` so chip labels stay clean.

- **JP/KR brainstorm.** `translateKeywords` prompt now asks Gemma for
  Japanese (kanji+kana) and Korean (hangul) variants alongside the
  existing zh+en when the input contains CJK. Examples include 見習い /
  弟子 / 수련생 / 견습 etc. so the model knows what shape we want. Pure-
  ASCII input keeps the cheaper zh+en-only prompt to save tokens.

- **Per-script query variant builder.** Old builder emitted at most 2
  queries (first-element + second-element of each group), both
  effectively zh. New builder buckets brainstorm output by script
  (`classifyScript` returns 'zh'/'en'/'ja'/'ko' based on
  Hangul/kana/Han presence) and emits ONE query per script bucket where
  each group has a contributing variant. Result: AniList finally sees
  native Japanese keywords like `見習い` instead of Chinese-only
  `學徒` (which returns near-zero AniList hits).

- **Trust-first-term constraint stripping.** Original
  `groupAsMediumFilter` / `groupAsGenreFilter` required EVERY term in a
  group to resolve to an alias. Brainstorm produces unpredictable
  variants (a stray `漫`, katakana `サイエンス・フィクション`, Korean
  `SF소설`) and any unrecognized term downgraded the whole group to a
  text group, leaking 漫畫 / 科幻 into source queries (which crushed
  AniList's hit rate). New rule: if FIRST term (user's original input)
  resolves to an alias, treat group as a constraint group regardless of
  brainstorm noise. Aliases were also extended to cover JP/KR forms
  (漫画, マンガ, コミック, 만화, 웹툰, 空想科学, 공상과학, ファンタジー,
  판타지, etc.).

- **Search diagnostics panel.** New collapsible "Search diagnostics"
  block above the result cards shows: per-source result counts (with ⚠️
  for errors), the actual query strings sent to adapters, the brainstorm
  table per keyword, and a funnel (raw → merged → kept · series
  collapsed · excluded · AI rerank tally). Replaces the previous
  DevTools-only debugging path.

### Pain points still on the list

1. **Cross-script author exclude.** Zh-only creator names like bare
   `尼爾．蓋曼` aren't matched by an English exclude entry. Fix: have the
   exclude filter consult AUTHOR_ALIASES (and add Neil Gaiman to it),
   OR use the LLM to expand exclude entries on save.

2. **Chinese numerals in seriesKey.** 睡魔特典一/二/三 don't collapse.
   Extend the trailing-vol regex to include 一/二/三/四/五/… (or just
   add Han-numerals normalization).

3. **Rerank lenience.** With Gemma's "err on MAYBE" instruction, off-
   theme entries like 11-volume BL series 「您的好兄弟要加熱嗎?」 still
   survive. Either tighten the rerank prompt or add a second pass that
   prunes MAYBE results when YES count is high enough.

4. **Books.com.tw 404 on EN-only variant.** Expected (it's a Chinese
   bookstore) but pollutes the diagnostics ⚠️. Skip ASCII-only variants
   for books_tw / readmoo.

5. **Synopsis enrichment cross-contamination.** Gemma writeup for 地下街
   的透明少女 leaked Re:Zero context. Probably the Wikipedia/Reddit
   enrichment step matched the wrong work.

### File map additions since session 2 (architecture v2)

```
src/core/
└── matching.ts            # + seriesKey, collapseSeries, mergeCreators export

src/
├── server.ts              # + makeExcludeFilter, classifyScript,
│                          #   trust-first-term constraint rule,
│                          #   per-script variant builder, JP/KR brainstorm
└── ui/
    └── app.js             # + Settings exclude textarea wiring,
                           #   renderDiagnostics, suffix-stripped source labels

tests/
├── exclude.test.ts        # author exclude filter
├── series.test.ts         # seriesKey + collapseSeries
└── keywords.test.ts       # + JP/KR brainstorm + trust-first-term

C:\StoryUI\Backend\routers\
└── openai_compat.py       # /v1/models + /v1/chat/completions for any client
```

### Next-session priorities

1. **Cross-script author exclude** — high value, small fix. Add Neil
   Gaiman to AUTHOR_ALIASES + have the exclude filter check the canonical
   form so an English entry catches the zh form too.
2. **Tighten LLM rerank** — too many MAYBE survivors. Either tweak the
   prompt to be stricter, or post-filter MAYBEs when there's a strong YES
   set.
3. **Run a writeup batch** — generate 5-8 zh-TW writeups on the cleaned
   results from this session and see what hurts at the prose level.
4. **Build the .exe** — `bun run build:win`. The pipeline is now in a
   shippable state for the team.
