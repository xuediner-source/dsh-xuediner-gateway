/**
 * LLM7.io upstream.
 *
 * LLM7 exposes an OpenAI-compatible endpoint with an anonymous/free-token tier.
 * Key finding (verified 2026-09-14 with a free-token key): naming a concrete
 * model returns HTTP 402 "Insufficient balance", while the *selector aliases*
 * (`default`, `fast`, `turbo`) are served on the free tier. So this upstream
 * routes through aliases rather than concrete model ids.
 *
 * Official limits (docs.llm7.io/limits):
 *   anonymous   1/s,  10/min,  60/hour,  500k tokens/24h
 *   free token  2/s,  40/min, 100/hour,    1M tokens/24h
 */
import fs from 'node:fs';
import path from 'node:path';

export const LLM7_API_BASE = 'https://api.llm7.io/v1';
export const LLM7_CHAT_URL = `${LLM7_API_BASE}/chat/completions`;

const HEADER_TIMEOUT_MS = 20_000;

/** Selector aliases served on the free tier. */
export const LLM7_ALIASES = ['default', 'fast', 'turbo'] as const;
export type Llm7Alias = (typeof LLM7_ALIASES)[number];

export function isLlm7Alias(value: string): value is Llm7Alias {
  return (LLM7_ALIASES as readonly string[]).includes(value);
}

/** Resolve the LLM7 API key from the harness credential store. */
export function resolveLlm7Key(): string | undefined {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  try {
    const credPath = path.join(home, '.credentials.yaml');
    if (!fs.existsSync(credPath)) return undefined;
    const text = fs.readFileSync(credPath, 'utf8');
    const m = text.match(/^\s*LLM7_API_KEY:\s*(.+)$/m);
    if (!m) return undefined;
    const value = m[1].trim().replace(/^['"]|['"]$/g, '');
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface Llm7ChatRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
}

/** POST one streamed chat request to LLM7 with a header timeout. */
export async function llm7Chat(
  apiKey: string,
  req: Llm7ChatRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
  };
  if (req.tools && req.tools.length > 0) body.tools = req.tools;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.stop && req.stop.length > 0) body.stop = req.stop;

  const controller = new AbortController();
  const onAbort = () => controller.abort(req.signal?.reason);
  if (req.signal) {
    if (req.signal.aborted) controller.abort(req.signal.reason);
    else req.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`llm7 header timeout after ${HEADER_TIMEOUT_MS}ms`)),
    HEADER_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(LLM7_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (req.signal) req.signal.removeEventListener('abort', onAbort);
  }
}
