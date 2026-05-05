/**
 * Polite HTTP client shared across all source adapters.
 *
 * Responsibilities:
 *  - identify ourselves with a stable User-Agent
 *  - rate-limit per host (default 1 req/sec) to stay friendly with
 *    scraped sites like books.com.tw and readmoo
 *  - basic retry on 5xx / network errors with exponential backoff
 *
 * Usage: `await politeFetch(url)` — same shape as the global fetch.
 */

const USER_AGENT =
  'sff-curator/0.1 (+https://github.com/janeypa/sff-curator; weekly forum curation tool)';

const PER_HOST_DELAY_MS = 1000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

const lastRequestAt = new Map<string, number>();

export interface PoliteFetchOptions extends RequestInit {
  /** Override the per-host throttle for this call (e.g. 0 to skip). */
  hostDelayMs?: number;
  /** Override the retry count. */
  maxRetries?: number;
}

export async function politeFetch(
  url: string,
  options: PoliteFetchOptions = {},
): Promise<Response> {
  const { hostDelayMs, maxRetries, ...init } = options;

  const host = new URL(url).host;
  const delay = hostDelayMs ?? PER_HOST_DELAY_MS;

  const last = lastRequestAt.get(host) ?? 0;
  const wait = delay - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(host, Date.now());

  const headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) headers.set('User-Agent', USER_AGENT);
  if (!headers.has('Accept-Language')) {
    headers.set('Accept-Language', 'zh-TW,zh;q=0.9,en;q=0.8');
  }

  const retries = maxRetries ?? MAX_RETRIES;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers });
      if (res.status >= 500 && attempt < retries) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
    }
  }

  throw lastErr ?? new Error(`politeFetch failed: ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
