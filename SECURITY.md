# Security Audit — MVP

Audit pass before first .exe ship. Threat model: the app runs locally on
the user's Windows machine. There is no server-side database, no shared
state across users, no auth. Each user brings their own LLM keys.

Audit done in two passes: a self-review and an independent second pass.
Findings below combine both.

## Issues found and fixed

### 1. Server bound to all interfaces (CRITICAL — fixed)

**Before:** `Bun.serve({ port })` defaults to binding `0.0.0.0`. Anyone on
the same Wi-Fi as the user could hit `http://<user-ip>:3000/api/*`,
including `/api/writeup` (proxying their own LLM calls through the user's
machine) and `/api/search` (consuming the user's TMDB quota).

**After:** Bun.serve now passes `hostname: '127.0.0.1'`. Loopback only.
Override via `HOST=0.0.0.0` env var only if intentionally exposing.

### 2. SSRF on `baseUrl` — link-local addresses (MEDIUM — fixed)

**Before:** `/api/writeup` accepted any http(s) `baseUrl`, including
`http://169.254.169.254/...` — the AWS / Azure / GCP cloud-metadata
endpoint. The OpenAI client would then POST the API key + prompt there.
Mostly relevant on cloud Windows VMs, but the residual key-exfil risk
was real.

**After:** `validateBaseUrl()` parses the URL and refuses any hostname
matching `169.254.x.x` (IPv4 link-local) or `fe80::/10` (IPv6 link-local).
Other private ranges (loopback, RFC1918) are still allowed because
legitimate local-LLM servers live there.

### 3. DNS rebinding — no Host header check (MEDIUM — fixed)

**Before:** A malicious page at `evil.com` could rebind DNS to `127.0.0.1`
and have the victim's browser fetch `/api/writeup` from our server.
Loopback-only binding alone doesn't stop this — the browser issues the
request from the user's own machine.

**After:** `guardApi()` wraps every `/api/*` route and rejects requests
whose `Host` header is anything other than `127.0.0.1:<port>`,
`localhost:<port>`, or `[::1]:<port>`. Returns 403 otherwise.

### 4. Source-URL hrefs not scheme-validated (MEDIUM — fixed)

**Before:** `Work.sources` URLs come from scraped HTML (Books.com.tw,
Readmoo, ISFDB). If an upstream were compromised and served
`<a href="javascript:…">`, that URL would land in `Work.sources.<name>`
and we'd render it directly as `<a href="javascript:…">` in the UI.
Clicking it would execute attacker JS in the user's localhost origin —
where the LLM key lives in localStorage.

**After:** UI passes every source URL through `safeUrl()`, which only
allows `http(s)://`; everything else becomes `#`. Also tightened all
external links to `rel="noopener noreferrer"`.

### 5. No security response headers (MEDIUM — fixed for /api/*)

**Before:** `/api/*` responses had no `X-Content-Type-Options`,
`Referrer-Policy`, etc. Combined with `application/json` MIME on
otherwise-trustworthy responses this is normally fine, but defense in
depth costs little.

**After:** Every `/api/*` response now carries
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
`Cache-Control: no-store`.

For the static HTML route (`/`), Bun's HTMLBundle serves with default
headers; we accept this for MVP. Clickjacking via iframe is the residual
risk — see "Open items" below.

### 6. No body size limit (LOW — fixed)

**Before:** `/api/writeup` and `/api/report` accepted arbitrarily large
JSON. A local mistake (or buggy client) could OOM the process.

**After:** `Bun.serve.maxRequestBodySize = 1 MB`. Plus per-endpoint length
caps: theme ≤ 200 chars, works array ≤ 50 entries, writeup text ≤ 5000
chars, AniList / TMDB synopses ≤ 1500 chars before reaching the LLM.

### 7. API keys in error logs (LOW — fixed)

**Before:** If an upstream provider echoed back a request that contained
the API key, our `console.error('[writeup]', err.message)` line could
land the key in the terminal scrollback. Google's provider URL-encodes
the key into the request URL, which the basic redactor missed.

**After:** `redactKey()` replaces both the raw and `encodeURIComponent`
forms with `***` before logging or returning to the client.

### 8. `baseUrl` not scheme-validated (LOW — fixed)

**Before:** A malicious local script could POST `/api/writeup` with
`config.baseUrl = "file:///etc/passwd"`. Bun's fetch wouldn't follow that
in practice, but cleaner to refuse it explicitly.

**After:** `/api/writeup` rejects any `baseUrl` that isn't http(s).

### 9. Content-Disposition header — non-ASCII filenames (LOW — fixed)

**Before:** `filename="curate_蒸汽龐克_..."` is technically not legal in
non-extended `Content-Disposition`; some browsers fall back to a generic
filename or break.

**After:** Both forms emitted — `filename="<ASCII fallback>"` and
`filename*=UTF-8''<percent-encoded>` per RFC 5987.

### 10. `slugify` allowed leading dash (LOW — fixed)

A theme of `--help` slugified to `--help`, producing
`curate_--help_20260505.md` — annoying on the command line. No path
traversal; just hardened the slug to strip leading dashes.

## Things checked, no action needed

- **CSP**: not set on the HTML route. Acceptable for an MVP local app
  where the only loaded resources are our own bundled JS/CSS. Worth
  adding for defense-in-depth in a later pass:
  `default-src 'self'; style-src 'self' 'unsafe-inline'; ` +
  `connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'`.
- **CORS**: no permissive headers. Bun.serve doesn't add Access-Control-
  Allow-Origin by default. Localhost-only binding + Host-header allowlist
  makes this moot.
- **localStorage XSS**: mitigated by `escapeHtml` on all user-rendered
  text and by the `safeUrl` fix above. The remaining `innerHTML` uses
  (i18n dict, flag chips) only insert strings we control.
- **SSRF via search query**: all source-adapter URLs use
  `encodeURIComponent` on user input into fixed-base URLs. No URL
  injection possible.
- **Prompt injection** (LLM): synopses from scraped sources flow into the
  writeup user message. Worst case is a misleading writeup. There are no
  tools / agentic loops the LLM can hijack and no secrets in its context
  to exfiltrate. The bad-phrases post-check + manual review catches
  weirdness before it ships to the forum. Synopsis length is now capped.
- **Cheerio scrapers**: only call `.text()` and `.attr('href')`; no
  `.html()` sink that would reflect attacker HTML back to the user.
- **Wikidata SPARQL**: query is server-built with a `VALUES` clause of
  Q-IDs that came from `wbsearchentities`; no string interpolation of
  user input into the SPARQL.
- **Dependency surface**: only one runtime dep (`cheerio`) and
  `@types/bun` (types only). Cheerio is a popular, well-maintained HTML
  parser; it doesn't execute scripts in the parsed DOM.
- **Browser auto-open command**: `Bun.spawn(['cmd','/c','start','',URL])`
  uses the array form (not shell), and the URL is a literal localhost
  URL we just bound. No injection vector.
- **HTTPS / TLS**: server is `http://localhost`. Local-only, no TLS needed.
- **Secrets at rest**: nothing persisted server-side. localStorage holds
  the user's keys; they can clear them at any time via browser DevTools
  or by deleting the localhost origin's site data.

## Open items (acceptable for MVP, worth revisiting)

- **Add CSP + X-Frame-Options to the HTML route.** Currently the static
  HTML page can be iframed by any other origin. Cross-origin scripts
  cannot read the iframe (same-origin policy still applies), but
  clickjacking is theoretically possible. The settings keys are in
  `<input type="password">` and can't be read directly via clickjacking,
  so the realistic exploit is small. If a later release wraps the static
  HTML route in a function that returns a Response with custom headers,
  add `X-Frame-Options: DENY` plus the CSP above.
- **User-editable bad-phrases list.** Currently `BAD_PHRASES` lives in
  source. Consider rotating it to a file in the user's profile directory
  so non-devs can extend it without rebuilding.
- **Optional "offline mode"**: a config flag that disables outbound
  network for users running only against local LLMs + offline data.
