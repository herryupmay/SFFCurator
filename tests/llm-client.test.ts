/**
 * Tests for src/llm/client.ts - the provider-agnostic LLM client.
 *
 * Critical for the local-LLM use case: the OpenAI provider's `baseUrl`
 * override is what routes calls to llama-cpp-python / LM Studio / vLLM.
 *
 * For an actual call to your running local LLM, see
 * tests/integration-local-llm.test.ts (opt-in via env var).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { complete, type LLMConfig } from '../src/llm/client';

let originalFetch: typeof fetch;
let calls: Array<{ url: string; init?: RequestInit }> = [];
let nextStatus = 200;
let nextBody: () => string = () => '{}';

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  nextStatus = 200;
  nextBody = () => '{}';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : (input instanceof URL ? input.toString() : input.url);
    calls.push({ url, init });
    return new Response(nextBody(), { status: nextStatus });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Anthropic provider', () => {
  test('hits api.anthropic.com /v1/messages with x-api-key header', async () => {
    nextBody = () => JSON.stringify({ content: [{ type: 'text', text: 'hi' }] });
    const cfg: LLMConfig = { provider: 'anthropic', apiKey: 'sk-ant-xxx' };
    const out = await complete(cfg, { system: 's', user: 'u' });
    expect(out).toBe('hi');
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-xxx');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.system).toBe('s');
    expect(body.messages).toEqual([{ role: 'user', content: 'u' }]);
  });

  test('throws with status + truncated body on non-OK', async () => {
    nextStatus = 401;
    nextBody = () => 'unauthorized: bad key';
    await expect(
      complete({ provider: 'anthropic', apiKey: 'k' }, { system: 's', user: 'u' })
    ).rejects.toThrow(/Anthropic 401/);
  });

  test('throws on empty content array', async () => {
    nextBody = () => JSON.stringify({ content: [] });
    await expect(
      complete({ provider: 'anthropic', apiKey: 'k' }, { system: 's', user: 'u' })
    ).rejects.toThrow(/empty response/);
  });
});

describe('OpenAI provider - including local-LLM baseUrl override', () => {
  test('hits api.openai.com/v1/chat/completions by default', async () => {
    nextBody = () => JSON.stringify({ choices: [{ message: { content: 'hello' } }] });
    const out = await complete({ provider: 'openai', apiKey: 'sk-openai' }, { system: 's', user: 'u' });
    expect(out).toBe('hello');
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-openai');
  });

  test('local llama-cpp-python (custom baseUrl) routes to localhost:8000', async () => {
    nextBody = () => JSON.stringify({ choices: [{ message: { content: '本地回應' } }] });
    const cfg: LLMConfig = {
      provider: 'openai',
      apiKey: 'local',
      baseUrl: 'http://localhost:8000/v1',
      model: 'gemma-3-27b-it.gguf',
    };
    const out = await complete(cfg, { system: 's', user: 'u' });
    expect(out).toBe('本地回應');
    expect(calls[0].url).toBe('http://localhost:8000/v1/chat/completions');
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.model).toBe('gemma-3-27b-it.gguf');
  });

  test('LM Studio shape (baseUrl with trailing slash) - trailing slash stripped', async () => {
    nextBody = () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
    await complete(
      { provider: 'openai', apiKey: 'k', baseUrl: 'http://localhost:1234/v1/' },
      { system: 's', user: 'u' }
    );
    expect(calls[0].url).toBe('http://localhost:1234/v1/chat/completions');
  });

  test('empty apiKey - "Bearer local" placeholder so local servers accept the request', async () => {
    nextBody = () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
    await complete(
      { provider: 'openai', apiKey: '', baseUrl: 'http://localhost:8000/v1' },
      { system: 's', user: 'u' }
    );
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer local');
  });

  test('throws on non-OK from a local server (e.g. model not loaded)', async () => {
    nextStatus = 500;
    nextBody = () => 'model not loaded';
    await expect(
      complete(
        { provider: 'openai', apiKey: 'k', baseUrl: 'http://localhost:8000/v1' },
        { system: 's', user: 'u' }
      )
    ).rejects.toThrow(/OpenAI 500.*model not loaded/);
  });
});

describe('Google provider', () => {
  test('routes to v1beta gemini API with key in query string', async () => {
    nextBody = () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'gemini reply' }] } }],
    });
    const out = await complete(
      { provider: 'google', apiKey: 'AIza-xxx', model: 'gemini-1.5-pro' },
      { system: 's', user: 'u' }
    );
    expect(out).toBe('gemini reply');
    expect(calls[0].url).toContain('generativelanguage.googleapis.com');
    expect(calls[0].url).toContain('models/gemini-1.5-pro:generateContent');
    expect(calls[0].url).toContain('key=AIza-xxx');
  });

  test('URL-encodes the API key', async () => {
    nextBody = () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });
    await complete(
      { provider: 'google', apiKey: 'a=b&c' },
      { system: 's', user: 'u' }
    );
    expect(calls[0].url).toContain('key=a%3Db%26c');
  });
});

describe('Ollama provider', () => {
  test('routes to localhost:11434/api/chat by default', async () => {
    nextBody = () => JSON.stringify({ message: { content: 'ollama reply' } });
    const out = await complete(
      { provider: 'ollama', apiKey: '' },
      { system: 's', user: 'u' }
    );
    expect(out).toBe('ollama reply');
    expect(calls[0].url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.stream).toBe(false);
  });

  test('respects custom baseUrl (Ollama on a LAN host)', async () => {
    nextBody = () => JSON.stringify({ message: { content: 'ok' } });
    await complete(
      { provider: 'ollama', apiKey: '', baseUrl: 'http://192.168.1.10:11434' },
      { system: 's', user: 'u' }
    );
    expect(calls[0].url).toBe('http://192.168.1.10:11434/api/chat');
  });
});

describe('temperature + maxTokens forwarding', () => {
  test('Anthropic: max_tokens + temperature go to the body', async () => {
    nextBody = () => JSON.stringify({ content: [{ type: 'text', text: 'ok' }] });
    await complete(
      { provider: 'anthropic', apiKey: 'k' },
      { system: 's', user: 'u', maxTokens: 333, temperature: 0.1 }
    );
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.max_tokens).toBe(333);
    expect(body.temperature).toBe(0.1);
  });

  test('Ollama: num_predict / temperature live under options', async () => {
    nextBody = () => JSON.stringify({ message: { content: 'ok' } });
    await complete(
      { provider: 'ollama', apiKey: '' },
      { system: 's', user: 'u', maxTokens: 222, temperature: 0.7 }
    );
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.options.num_predict).toBe(222);
    expect(body.options.temperature).toBe(0.7);
  });
});
