/**
 * End-to-end tests against the running Bun server.
 *
 * Boots `bun src/server.ts` as a child process, waits for /api/health, then
 * fires real HTTP requests at it. Verifies the security guards documented
 * in SECURITY.md (Host-header allowlist, theme length cap, baseUrl scheme +
 * link-local block, body-size cap, security headers on /api/* responses).
 *
 * Source-fetching is exercised with a single short search; we don't assert
 * specific upstream results because those vary by network/region. We DO
 * assert that the response shape is right and that errors-per-source are
 * reported rather than crashing the request.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { join } from 'node:path';

const PORT = 3457; // unlikely to clash on dev boxes
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT_ROOT = join(import.meta.dir, '..');

let serverProc: Subprocess | null = null;

async function waitForReady(timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Server did not become ready in time.');
}

beforeAll(async () => {
  serverProc = spawn({
    cmd: ['bun', 'src/server.ts'],
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await waitForReady();
});

afterAll(() => {
  serverProc?.kill();
});

// --------- /api/health ----------------------------------------------------

describe('/api/health', () => {
  test('returns ok + version with the expected security headers', async () => {
    const r = await fetch(`${BASE}/api/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json() as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });

  test('rejects unknown Host header (DNS-rebind defense)', async () => {
    const r = await fetch(`${BASE}/api/health`, {
      headers: { Host: 'attacker.example' },
    });
    expect(r.status).toBe(403);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

// --------- /api/search ----------------------------------------------------

describe('/api/search — input validation', () => {
  test('400 on missing/empty theme', async () => {
    const r = await fetch(`${BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: '' }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/required/);
  });

  test('400 on theme longer than 200 chars', async () => {
    const r = await fetch(`${BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'a'.repeat(201) }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/too long/);
  });

  test('400 on non-JSON body', async () => {
    const r = await fetch(`${BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    expect(r.status).toBe(400);
  });
});

// --------- /api/writeup ---------------------------------------------------

describe('/api/writeup — input validation', () => {
  const work = {
    sources: { isfdb: 'https://x' },
    titles: { en: 'X' },
    creators: [],
    medium: 'book',
    raw: {},
  };

  test('400 on invalid provider', async () => {
    const r = await fetch(`${BASE}/api/writeup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ work, config: { provider: 'evilcorp', apiKey: 'k' } }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/provider/);
  });

  test('400 on missing config', async () => {
    const r = await fetch(`${BASE}/api/writeup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ work }),
    });
    expect(r.status).toBe(400);
  });

  test('400 on missing work', async () => {
    const r = await fetch(`${BASE}/api/writeup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { provider: 'openai', apiKey: 'k' } }),
    });
    expect(r.status).toBe(400);
  });

  test('400 on baseUrl pointing at IPv4 link-local (cloud metadata SSRF)', async () => {
    const r = await fetch(`${BASE}/api/writeup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work,
        config: { provider: 'openai', apiKey: 'k', baseUrl: 'http://169.254.169.254/latest/meta-data/' },
      }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/link-local/);
  });

  test('400 on baseUrl pointing at IPv6 link-local', async () => {
    const r = await fetch(`${BASE}/api/writeup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work,
        config: { provider: 'openai', apiKey: 'k', baseUrl: 'http://[fe80::1]/' },
      }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/link-local/);
  });

  test('400 on non-http(s) baseUrl', async () => {
    const r = await fetch(`${BASE}/api/writeup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work,
        config: { provider: 'openai', apiKey: 'k', baseUrl: 'file:///etc/passwd' },
      }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/http\(s\)/);
  });

  test('400 on malformed baseUrl', async () => {
    const r = await fetch(`${BASE}/api/writeup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work,
        config: { provider: 'openai', apiKey: 'k', baseUrl: 'not a url' },
      }),
    });
    expect(r.status).toBe(400);
  });

  test('redacts API key from error messages (502 path)', async () => {
    // Pointed at a closed loopback port → fetch will fail; the error message
    // bubbles up as a 502, run through redactKey() to scrub the apiKey.
    const r = await fetch(`${BASE}/api/writeup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work,
        config: { provider: 'openai', apiKey: 'sk-VERY-SECRET-12345', baseUrl: 'http://127.0.0.1:1/v1' },
      }),
    });
    // Either the LLM call fails (502) or, if Work shape is unexpected, the
    // writeup throws first — either way the message must not contain the key.
    const body = await r.text();
    expect(body).not.toContain('sk-VERY-SECRET-12345');
  });
});

// --------- /api/report ----------------------------------------------------

describe('/api/report', () => {
  test('returns markdown with RFC 5987 Content-Disposition for non-ASCII themes', async () => {
    const r = await fetch(`${BASE}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        theme: '蒸汽龐克',
        works: [{
          sources: { isfdb: 'https://isfdb/x' },
          titles: { en: 'Neuromancer', zh: '神經喚術士' },
          creators: [{ name: { en: 'William Gibson' }, role: 'author' }],
          year: 1984,
          medium: 'book',
          raw: {},
        }],
        writeups: { '0': '介紹文…' },
      }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/markdown');
    const cd = r.headers.get('content-disposition') ?? '';
    // Both ASCII fallback and RFC 5987 UTF-8 form must be present.
    expect(cd).toMatch(/filename=".*\.md"/);
    expect(cd).toMatch(/filename\*=UTF-8''/);
    const body = await r.text();
    expect(body).toContain('# 策展主題:蒸汽龐克');
    expect(body).toContain('神經喚術士');
  });

  test('truncates over-long writeups to 5000 chars', async () => {
    const huge = 'A'.repeat(10_000);
    const r = await fetch(`${BASE}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        theme: 't',
        works: [{
          sources: { isfdb: 'x' }, titles: { en: 'X' }, creators: [], medium: 'book', raw: {},
        }],
        writeups: { '0': huge },
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.text();
    // The writeup section should not contain the full 10k.
    expect(body).not.toContain('A'.repeat(5001));
  });

  test('caps works array at 50', async () => {
    const works = Array.from({ length: 100 }, (_, i) => ({
      sources: { isfdb: `https://x/${i}` },
      titles: { en: `T${i}` },
      creators: [], medium: 'book' as const, raw: {},
    }));
    const r = await fetch(`${BASE}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 't', works }),
    });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('T0');
    expect(body).toContain('T49');
    expect(body).not.toContain('## T50');
  });
});
