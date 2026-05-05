/**
 * LLM client — provider-agnostic.
 *
 * Thin custom wrappers (no SDK deps) so the compiled binary stays small
 * and there's no third-party-package churn to track.
 *
 * Supported providers:
 *   - anthropic   → api.anthropic.com /v1/messages
 *   - openai      → {baseUrl ?? api.openai.com}/v1/chat/completions
 *                   (also used for llama-cpp-python, LM Studio, vLLM, etc.
 *                    — anything OpenAI-shaped, just override baseUrl)
 *   - google      → generativelanguage.googleapis.com gemini API
 *   - ollama      → {baseUrl ?? localhost:11434}/api/chat
 *
 * The user's choice + key + optional baseUrl come from the browser's
 * localStorage. The Bun server forwards them to the relevant provider
 * — the LLM key is held in memory only, never persisted server-side.
 */

export type Provider = 'anthropic' | 'openai' | 'google' | 'ollama';

export interface LLMConfig {
  provider: Provider;
  /** Model name. If omitted, a sensible per-provider default is used. */
  model?: string;
  apiKey: string;
  /** OpenAI- or Ollama-compatible base URL (omit for the cloud default). */
  baseUrl?: string;
}

export interface LLMRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai:    'gpt-4o',
  google:    'gemini-1.5-pro',
  ollama:    'llama3',
};

export async function complete(config: LLMConfig, req: LLMRequest): Promise<string> {
  switch (config.provider) {
    case 'anthropic': return completeAnthropic(config, req);
    case 'openai':    return completeOpenAI(config, req);
    case 'google':    return completeGoogle(config, req);
    case 'ollama':    return completeOllama(config, req);
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}

async function completeAnthropic(config: LLMConfig, req: LLMRequest): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL.anthropic,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      temperature: req.temperature ?? 0.5,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 240)}`);
  }
  const data = await res.json() as { content: Array<{ type: string; text?: string }> };
  const block = data.content?.find(b => b.type === 'text');
  if (!block?.text) throw new Error('Anthropic: empty response');
  return block.text;
}

async function completeOpenAI(config: LLMConfig, req: LLMRequest): Promise<string> {
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey || 'local'}`,
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL.openai,
      max_tokens: req.maxTokens ?? 1024,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      temperature: req.temperature ?? 0.5,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 240)}`);
  }
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI: empty response');
  return text;
}

async function completeGoogle(config: LLMConfig, req: LLMRequest): Promise<string> {
  const model = config.model || DEFAULT_MODEL.google;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      systemInstruction: { parts: [{ text: req.system }] },
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0.5,
      },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Google ${res.status}: ${txt.slice(0, 240)}`);
  }
  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Google: empty response');
  return text;
}

async function completeOllama(config: LLMConfig, req: LLMRequest): Promise<string> {
  const baseUrl = (config.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL.ollama,
      stream: false,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      options: {
        temperature: req.temperature ?? 0.5,
        num_predict: req.maxTokens ?? 1024,
      },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${txt.slice(0, 240)}`);
  }
  const data = await res.json() as { message?: { content?: string } };
  if (!data.message?.content) throw new Error('Ollama: empty response');
  return data.message.content;
}
