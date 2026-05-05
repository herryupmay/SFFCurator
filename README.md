# SFF Curator

[繁體中文版本 → README.zh-TW.md](./README.zh-TW.md)

A weekly curation helper for SFF (sci-fi / fantasy / horror) forum threads.
Type a theme, get back 5–8 candidate works (books / films / anime / manga)
with merged metadata from multiple sources and a draft 200-word zh-TW
introduction for each, ready to polish.

## Quick start (Windows)

1. **Download** `sff-curator.exe` from your team's shared folder.
2. **Double-click** it.
   - Windows may warn *"This is from an unidentified developer"*. Click
     **More info → Run anyway**. It's safe — the dev built it from open source.
   - A small terminal window will stay open while it's running. Don't close it
     until you're done.
3. Your browser will open at `http://localhost:3000`.
4. **Set up your API keys** (first time only). Click the ⚙ Settings link and
   paste:
   - **LLM key** for the writeup step. Default is Anthropic Claude — get one at
     <https://console.anthropic.com/>. You can switch to OpenAI, Google, or
     a local Ollama / llama-cpp-python server in the same panel.
   - **TMDB key** for film / TV lookup — free, sign up at
     <https://www.themoviedb.org/settings/api>. Optional — without it, books /
     anime / manga results still work.
5. **Type a theme**, e.g. `steampunk`, `cyberpunk`, `蒸汽龐克`. Click Search.
6. Review results, click **Generate zh-TW intro** per work (or **Generate all
   writeups** in the action bar), polish the prose by hand, click **Save
   report (.md)** for your forum post.

## What you'll need

- Windows 10 or 11.
- Internet connection (for the search step + remote LLM; optional for local LLM).
- A free or paid account for one LLM provider (Anthropic / OpenAI / Google) —
  *or* a local LLM running on your PC (Ollama, llama-cpp-python, LM Studio).
- Optional: free TMDB account for film / TV lookups.

## FAQ

### Are my API keys safe?

Reasonably. Here's the honest version.

**Where they live:** in your browser's localStorage on the `localhost:3000`
origin. Only scripts loaded from that origin can read them. The keys never
get written to disk by this app, never get sent anywhere except directly to
the LLM provider, and aren't bundled into the .exe.

**Protected from:** other devices on your Wi-Fi (the server only listens on
loopback), random websites in another tab (browser same-origin policy +
Host-header allowlist), other people you share the .exe with (each person
brings their own key on their own PC).

**Not protected from:** malware on your PC (true of every web app that
stores tokens this way — Slack, Discord, GitHub Desktop, etc.); someone
walking up to an unlocked PC and opening DevTools; malicious browser
extensions with localhost permissions.

**Practical recommendation:** create a *dedicated* API key for this tool,
not your main one. Set a monthly spending cap on the provider's billing
page ($5 is plenty). That way worst-case key exfil is bounded and you
rotate one key, not your whole account. Anthropic, OpenAI, and Google all
support per-key spending limits.

### Will using the API cost extra on top of my Claude/ChatGPT/Gemini subscription?

Yes. The consumer subscription and the API are separate products on every
major provider:

- **Anthropic** — Claude.ai Pro ($20/mo) does *not* include API access. You
  need a separate console.anthropic.com account with prepaid credits or
  billing set up.
- **OpenAI** — ChatGPT Plus / Pro / Team is for chatgpt.com only. API access
  needs a separate platform.openai.com account and billing.
- **Google** — Gemini app subscription is separate from API access. Get an
  API key at ai.google.dev — there's a generous **free tier** that probably
  covers casual use entirely.
- **Local LLM** (Ollama, llama-cpp-python, LM Studio) — free, runs on your
  PC's CPU/GPU.

**Rough per-session cost** for a typical 8-work curation:

| Provider | Per session | Per month (4 weekly sessions) |
|---|---|---|
| Claude Sonnet 4.5 | ~$0.05–0.07 | ~$0.20–0.30 |
| GPT-4o | ~$0.03–0.05 | ~$0.15–0.20 |
| Gemini 1.5 Pro | similar; free tier likely covers it | likely $0 |
| Local Gemma 27B | $0 | $0 |

A weekly forum cadence is firmly in "less than a coffee" territory.

### Which provider should I pick?

**For best zh-TW quality out of the box:** Anthropic Claude. Cleanest
台灣用語, fewest yellow flags. The tool is tuned to it.

**For free testing:** Google Gemini's API free tier, or a local Gemma model
via llama-cpp-python.

**For privacy / no-internet:** local LLM. Setup steps live in the BUILD doc.

### What happens if a search source returns nothing?

The Books.com.tw / Readmoo / ISFDB scrapers parse those sites' HTML, which
changes occasionally. If you see "0 results" persistently from one source
while others work, the selectors need a tweak. Not your problem unless
you're the dev — let them know.

### Where is my data stored?

- **API keys**: browser localStorage on this PC only.
- **Search results**: in the browser's memory while you have the page open.
  Closed → gone.
- **Generated writeups**: in browser memory. The "Save report" button
  downloads them to your Downloads folder as a .md file.
- **No server-side storage of anything.** There is no server beyond the
  one running on your own PC.

### How do I stop it?

Close the browser tab, then close the terminal window that opened with
the program. (Closing only the browser leaves the program running quietly
in the background — it'll exit when you close the terminal or restart your PC.)

## When something breaks

- **Browser didn't open?** Open it yourself and visit `http://localhost:3000`.
- **"Port 3000 is already in use"?** Another program is using it. Close
  whatever it is, or restart your PC, then try again.
- **A source returns no results?** See the FAQ above. The other sources
  will still work.
- **zh-TW writeup uses 大陸用語?** This sometimes happens with non-Claude
  models. The app flags suspicious phrases in yellow — fix by hand. If
  it's bad enough, switch back to Claude in Settings.
- **Anything else?** Tell the dev. Include the theme you searched, which
  provider/model you're on, and what you saw in the terminal window.

## Privacy

There is no server beyond the program running on your own PC. The program
talks directly to the API providers (Anthropic, TMDB, etc.). Your keys,
search history, and generated reports never leave your machine except for
the API calls themselves.
