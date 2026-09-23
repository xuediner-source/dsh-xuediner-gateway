/**
 * Groq upstream (free tier).
 *
 * Groq serves an OpenAI-compatible endpoint with a generous free tier
 * (verified 2026-09-14): gpt-oss-120b/20b, qwen3.6-27b, qwen3.8-27b,
 * groq/compound(-mini), allam-2-7b.
 *
 * Model ids must be the fully-qualified names shown by GET /openai/v1/models
 * (e.g. "openai/gpt-oss-120b", not "gpt-oss-120b"), otherwise the API returns
 * 404 "does not exist or you do not have access".
 */
import fs from 'node:fs';
import path from 'node:path';

export const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
export const GROQ_CHAT_URL = `${GROQ_API_BASE}/chat/completions`;

const HEADER_TIMEOUT_MS = 20_000;

/** Free-tier chat models confirmed working on 2026-09-14. */
export const GROQ_MODELS = [
  { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B (Groq)', contextLength: 131_072 },
  { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B (Groq)', contextLength: 131_072 },
  { id: 'qwen/qwen3.8-27b', name: 'Qwen3.8 27B (Groq)', contextLength: 131_072 },
  { id: 'qwen/qwen3.6-27b', name: 'Qwen3.6 27B (Groq)', contextLength: 131_072 },
  { id: 'groq/compound', name: 'Compound (Groq)', contextLength: 131_072 },
  { id: 'groq/compound-mini', name: 'Compound Mini (Groq)', contextLength: 131_072 },
  { id: 'allam-2-7b', name: 'Allam 2 7B (Groq)', contextLength: 32_768 },
] as const;

export type GroqModelId = (typeof GROQ_MODELS)[number]['id'];

/** Resolve the Groq API key from the harness credential store. */
export function resolveGroqKey(): string | undefined {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  try {
    const credPath = path.join(home, '.credentials.yaml');
    if (!fs.existsSync(credPath)) return undefined;
    const text = fs.readFileSync(credPath, 'utf8');
    const m = text.match(/^\s*GROQ_API_KEY:\s*(.+)$/m);
    if (!m) return undefined;
    const value = m[1].trim().replace(/^['"]|['"]$/g, '');
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface GroqChatRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/** POST one streamed chat request to Groq with a header timeout. */
export async function groqChat(
  apiKey: string,
  req: GroqChatRequest,
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
  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;

  const controller = new AbortController();
  const onAbort = () => controller.abort(req.signal?.reason);
  if (req.signal) {
    if (req.signal.aborted) controller.abort(req.signal.reason);
    else req.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`groq header timeout after ${HEADER_TIMEOUT_MS}ms`)),
    HEADER_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(GROQ_CHAT_URL, {
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
