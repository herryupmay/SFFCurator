# Testing the dev server (before building the .exe)

Run through this once on your Windows machine to confirm everything
works before you produce the binary your friends will use.

## 0. One-time setup

Install [Bun](https://bun.sh) — runs in PowerShell, no admin needed:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Close and reopen PowerShell so the `bun` command is on your PATH. Verify:

```powershell
bun --version    # should print 1.1.x or newer
```

## 1. Install dependencies

In PowerShell:

```powershell
cd "$env:USERPROFILE\Documents\Claude\Projects\SFF Curator"
bun install
```

Should finish in seconds and create a `node_modules/` folder + `bun.lockb`.

## 2. Start the dev server

```powershell
bun run dev
```

You should see:

```
SFF Curator running at http://localhost:3000
(bound to 127.0.0.1; loopback only)
Open this URL in your browser. Press Ctrl+C to stop.
```

Keep this PowerShell window open while testing. `--hot` is enabled, so
edits to anything in `src/` reload the browser automatically.

Open <http://localhost:3000> in your browser.

## 3. Smoke checks (no keys needed)

These work without any API keys configured.

- **Search returns results.** Type `steampunk` → Search. You should see
  ~5–15 results within a few seconds. Open Library, AniList, ISFDB,
  Wikidata should all return hits. Books.com.tw / Readmoo / TMDB might
  show as "source errors" — that's expected without selectors verified
  and without a TMDB key.
- **Language toggle.** Click `中文` in the top-right. Every label should
  flip to Traditional Chinese. Click `English` to switch back.
- **Source links.** Each work card has clickable source chips
  (`openlibrary`, `anilist`, etc.). Each should open the correct page on
  the source site in a new tab.
- **Confidence + flag chips.** Some works should show ★★ or ★★★, plus
  yellow chips for `未中譯` / `single source` / `low confidence`.

## 4. Settings + writeup test

This needs at least one LLM key. Easiest is Anthropic — if you don't
have one, sign up at <https://console.anthropic.com> and create a key.

- Click ⚙ Settings.
- Provider: `Anthropic Claude`.
- Model: leave blank (uses the default) or set `claude-sonnet-4-5`.
- Paste your API key.
- Click Save.

Then in any work card, click **Generate zh-TW intro**. Within ~10 seconds
you should see:

- A 3-paragraph intro in Traditional Chinese.
- A char count badge (`200 字` or similar).
- A copy button.
- If the model leaked any 大陸用語, those phrases will be highlighted in
  yellow with a count badge.

Try the **Generate all writeups** action-bar button to fan out across all
visible works. (This will run them sequentially to keep your rate-limit
usage low.)

## 5. Local-LLM test (optional, the use case you flagged)

If you have llama-cpp-python with Gemma loaded:

```powershell
python -m llama_cpp.server --model path\to\gemma-3-27b-it.gguf --port 8000
```

Then in Settings:
- Provider: `OpenAI / OpenAI-compatible`
- Model: whatever the server reports (often the gguf filename)
- Base URL: `http://localhost:8000/v1`
- Key: any non-empty placeholder, e.g. `local`

Generate a writeup. With Gemma 27B+ you should get usable zh-TW with
relatively few `大陸用語` flags. Iterate the prompt in
`src/core/writeup.ts` if you want to push quality up.

## 6. Report export test

After generating writeups for a few works, click **Save report (.md)**
in the action bar. Browser should download `curate_<theme>_<date>.md`.
Open it — should be a clean markdown document with one section per work.

## 7. Stop the server

Back in PowerShell, press `Ctrl+C`.

## What to do if a scraper returns 0 results

The Books.com.tw / Readmoo / ISFDB selectors are best-effort and likely
need adjustment on first run. Recipe in
[`BUILD.md`](./BUILD.md#when-a-scraper-breaks):

1. In your browser, hit the URL the adapter uses (e.g.
   `https://search.books.com.tw/search/query/key/steampunk/cat/all`).
2. Right-click → Save Page As, into `tests/fixtures/<source>-steampunk.html`.
3. Open the HTML in your editor; find the title / author selectors.
4. Edit the `itemSelectors` array at the top of
   `src/sources/{books_tw,readmoo,isfdb}.ts`.
5. The dev server hot-reloads; try the search again.

## When you're happy → build the .exe

```powershell
bun run build:win
```

Produces `dist\sff-curator.exe`. Drop it in your shared folder for the team.
