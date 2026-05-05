# Build & Dev Guide

For whoever builds the `.exe` or develops the source. End users get
[`README.md`](./README.md) instead.

## One-time setup

Install [Bun](https://bun.sh) (1.1 or newer):

```sh
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

Clone and install deps:

```sh
git clone <repo-url> sff-curator
cd sff-curator
bun install
```

## Run in dev mode

```sh
bun run dev
```

Server starts at `http://localhost:3000` with hot reload. Edit anything in
`src/` and the browser updates automatically. Open the URL manually the
first time — auto-open is only enabled in the compiled binary.

## Build the Windows .exe

```sh
bun run build:win
```

Output: `dist/sff-curator.exe` (~50 MB — the Bun runtime is bundled in).
Cross-compiles from any OS (Mac / Linux / Windows). When you ship a new
version, smoke-test on a clean Windows machine if you can.

### How bundling works

`src/server.ts` does `import indexHtml from './ui/index.html'`. Bun's
`--compile` step:

1. Treats the HTML as an entry point and walks its `<script>` /
   `<link>` references — so `src/ui/app.js` is bundled automatically.
2. Embeds the resulting bundle into the `.exe`. No external files
   travel with the binary.

If you add new static assets (images, fonts), reference them from
`index.html` and they'll be picked up too.

### Distributing the .exe

1. `bun run build:win` to produce `dist/sff-curator.exe`.
2. Smoke-test by running `dist/sff-curator.exe` locally — browser should
   auto-open to `http://localhost:3000`.
3. Drop it in your team's shared folder (Dropbox / Drive / USB stick).
4. First-run UX for friends: Windows Defender / SmartScreen will say
   "unrecognized app". Tell them: click **More info → Run anyway**. After
   the first run, Windows remembers and won't ask again on that machine.
5. If you have an Apple-style code-signing budget on Windows ($90+/yr for
   a Sectigo cert), signing removes the warning. Not worth it for a small
   team.

## Project layout

See [`PLAN.md`](./PLAN.md) for the full architecture. Quick map:

```
src/
├── server.ts             # Bun HTTP entry — routes / and /api/*
├── types.ts              # Work + Creator types
├── html.d.ts             # @types/bun handles *.html — placeholder file
├── ui/
│   ├── index.html        # Single-page UI shell (HTML + CSS)
│   └── app.js            # All UI logic — bilingual i18n, search, writeup
├── sources/              # one file per data source
│   ├── http.ts           # shared polite-fetch + per-host rate limiting
│   ├── openlibrary.ts    # API
│   ├── anilist.ts        # GraphQL API
│   ├── tmdb.ts           # API (optional key)
│   ├── isfdb.ts          # scraper (cheerio)
│   ├── wikidata.ts       # SPARQL + wbsearchentities
│   ├── books_tw.ts       # scraper (cheerio)
│   └── readmoo.ts        # scraper (cheerio)
├── core/
│   ├── matching.ts       # ISBN/author/year merge logic
│   ├── verify.ts         # filter + flag (未中譯, single-source, etc.)
│   ├── writeup.ts        # zh-TW prompt + bad-phrases post-check
│   └── report.ts         # markdown report composer
└── llm/
    └── client.ts         # provider-agnostic LLM client
                          #   (anthropic / openai / google / ollama,
                          #    OpenAI base-URL override for local LLMs)
```

## Tests

```sh
bun test
```

Tests live in `tests/`. We mostly care about:

- **Matching** — pure functions, easy to unit test with synthetic Work[].
- **Scraper selectors** — fixture-based, catches HTML drift.

Live API adapters don't need unit tests; we rely on end-to-end manual
verification through the UI.

## When a scraper breaks

Books.com.tw, Readmoo, and ISFDB redesign occasionally and the selectors
in `src/sources/{books_tw,readmoo,isfdb}.ts` will rot. Steps:

1. In a browser, hit the search URL the adapter uses — e.g.
   `https://search.books.com.tw/search/query/key/steampunk/cat/all`.
2. Right-click → Save As → save the page HTML to
   `tests/fixtures/<source>-<query>.html`.
3. Open the fixture in your editor, find the title / author / year
   elements, note their selectors.
4. Update the `itemSelectors`, `$titleLink`, etc. arrays in the adapter
   file. Try a few candidate selectors so a partial redesign doesn't
   break everything.
5. Re-run a search in the dev server, confirm hits.

## Adding a new source

1. Create `src/sources/<name>.ts`.
2. Export `async function search<Name>(query, limit) → Promise<Work[]>`.
3. Use `politeFetch()` from `./http` for all outbound HTTP — handles UA
   and per-host rate limiting.
4. Map the response into the `Work` type. Populate
   `sources[<name>] = <url>` so the merge step tracks provenance.
5. Wire it into the `sources` registry in `src/server.ts`.

## Iterating on the zh-TW prompt

The system prompt for the writeup stage lives in `src/core/writeup.ts`.
The bad-phrases array is in the same file. When you spot leakage:

1. Add the offending mainland-Chinese term to `BAD_PHRASES`.
2. If it's a recurring pattern, tighten the system prompt with a
   counterexample.
3. Re-test against a theme that triggered the leak.

Smaller models (7B / 13B) leak more frequently. The post-check + UI
highlight matter more for them than for Claude or Gemma 27B+.

## LLM provider notes

- **Anthropic Claude**: cleanest zh-TW out of the box. Recommended for
  production runs.
- **OpenAI / OpenAI-compatible**: works with the cloud OpenAI API and
  with any local server that exposes the OpenAI chat-completions shape.
  Examples:
    - `python -m llama_cpp.server --model x.gguf` → base URL
      `http://localhost:8000/v1`, key any non-empty placeholder.
    - LM Studio → base URL `http://localhost:1234/v1`.
    - vLLM → base URL `http://localhost:8000/v1`.
- **Google Gemini**: standalone REST. Quality on zh-TW is good with
  Gemini 1.5 Pro.
- **Ollama**: separate from the OpenAI-compatible path; uses Ollama's
  native `/api/chat` endpoint at `http://localhost:11434`.
