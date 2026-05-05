/**
 * OPT-IN integration test against your actual local LLM.
 *
 * Skipped by default. Run with:
 *
 *   # llama-cpp-python or LM Studio with Gemma:
 *   SFF_LOCAL_LLM_URL=http://localhost:8000/v1 \
 *   SFF_LOCAL_LLM_MODEL=gemma-3-27b-it.gguf \
 *   bun test tests/integration-local-llm.test.ts
 *
 *   # Or Ollama:
 *   SFF_LOCAL_LLM_PROVIDER=ollama \
 *   SFF_LOCAL_LLM_MODEL=llama3 \
 *   bun test tests/integration-local-llm.test.ts
 *
 * What this verifies on a real run:
 *   - The end-to-end path (writeup → llm/client → your local server) works.
 *   - The 200-字 prompt produces output close to that length.
 *   - The bad-phrases post-check is plumbed through (whether anything
 *     trips depends on the model — Gemma in particular sometimes leaks).
 *
 * Pass criteria are deliberately loose because local-LLM output varies
 * widely. The point isn't to grade the model; it's to confirm the wiring.
 */

import { describe, test, expect } from 'bun:test';
import { writeup } from '../src/core/writeup';
import type { Work } from '../src/types';
import type { LLMConfig, Provider } from '../src/llm/client';

const url = process.env.SFF_LOCAL_LLM_URL;
const provider = (process.env.SFF_LOCAL_LLM_PROVIDER ?? 'openai') as Provider;
const model = process.env.SFF_LOCAL_LLM_MODEL;

const enabled = Boolean(url) || provider === 'ollama';
const describeIf = enabled ? describe : describe.skip;

const work: Work = {
  sources: { isfdb: 'https://x' },
  titles: { en: 'Neuromancer', zh: '神經喚術士' },
  creators: [{ name: { en: 'William Gibson', zh: '威廉·吉布森' }, role: 'author' }],
  year: 1984,
  medium: 'book',
  subgenres: ['cyberpunk'],
  raw: {},
  hasZhTranslation: true,
  availableInTw: true,
};

describeIf(`integration: local LLM (${provider}${url ? ` @ ${url}` : ''})`, () => {
  test('produces a non-trivial zh-TW writeup end-to-end', async () => {
    const cfg: LLMConfig = {
      provider,
      apiKey: process.env.SFF_LOCAL_LLM_KEY ?? 'local',
      baseUrl: url || undefined,
      model: model || undefined,
    };

    const out = await writeup(work, cfg);
    console.log('--- live writeup output ---');
    console.log(out.text);
    console.log(`charCount=${out.charCount}, flagged=${JSON.stringify(out.flagged)}`);

    expect(out.text.length).toBeGreaterThan(40);
    // Roughly 200 字 ±20, but local models drift; allow a wide window.
    expect(out.charCount).toBeGreaterThanOrEqual(80);
    expect(out.charCount).toBeLessThanOrEqual(400);
    // Any output should contain at least some Han characters.
    expect(/\p{Script=Han}/u.test(out.text)).toBe(true);
  }, 60_000);
});

if (!enabled) {
  // Tiny non-test note printed once when the suite runs without the env var.
  console.log('[integration-local-llm] skipped — set SFF_LOCAL_LLM_URL or SFF_LOCAL_LLM_PROVIDER=ollama to enable.');
}
