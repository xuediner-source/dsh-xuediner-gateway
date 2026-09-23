/**
 * OpenRouter free-models upstream.
 *
 * OpenRouter speaks the OpenAI chat-completions protocol. Zero-priced models
 * carry a `:free` suffix (or are listed at price 0), and the free tier allows
 * ~50 requests/day without credit; a one-time $10 top-up raises it to 1000/day.
 *
 * Two credential sources, in priority order:
 *   1. OPENROUTER_API_KEY in ~/.dsh/.credentials.yaml (manual key), or
 *   2. the subscription hub's OAuth-issued key in
 *      ~/.dsh/plugins/subscriptions/auth.json (provider "openrouter").
 *
 * Docs: https://openrouter.ai/docs  ·  free catalog: GET /api/v1/models
 */
import fs from 'node:fs';
import path from 'node:path';

export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_CHAT_URL = `${OPENROUTER_API_BASE}/chat/completions`;

const HEADER_TIMEOUT_MS = 20_000;

/** Resolve the OpenRouter API key from either credential source. */
export function resolveOpenRouterKey(): string | undefined {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');

  // 1) Manual key in the harness credential store.
  try {
    const credPath = path.join(home, '.credentials.yaml');
    if (fs.existsSync(credPath)) {
      const text = fs.readFileSync(credPath, 'utf8');
      const m = text.match(/^\s*OPENROUTER_API_KEY:\s*(.+)$/m);
      if (m) {
        const value = m[1].trim().replace(/^['"]|['"]$/g, '');
        if (value.length > 0) return value;
      }
    }
  } catch {
    // fall through
  }

  // 2) OAuth-issued key from the subscription hub.
  try {
    const authPath = path.join(home, 'plugins', 'subscriptions', 'auth.json');
    if (fs.existsSync(authPath)) {
      const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
      const entry = parsed?.openrouter as Record<string, unknown> | undefined;
      if (entry) {
        for (const field of ['accessToken', 'access_token', 'apiKey', 'api_key', 'key']) {
          const value = entry[field];
          if (typeof value === 'string' && value.length > 0) return value;
        }
      }
    }
  } catch {
    // fall through
  }

  return undefined;
}

export interface OpenRouterChatRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/** POST one streamed chat request to OpenRouter with a header timeout. */
export async function openRouterChat(
  apiKey: string,
  req: OpenRouterChatRequest,
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
    () => controller.abort(new Error(`openrouter header timeout after ${HEADER_TIMEOUT_MS}ms`)),
    HEADER_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        // OpenRouter attributes traffic by these two headers (optional but polite).
        'HTTP-Referer': 'https://github.com/xuediner-source/dsh-xuediner-gateway',
        'X-Title': 'xuedinerAPI (DSH)',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (req.signal) req.signal.removeEventListener('abort', onAbort);
  }
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number;
  supportsTools: boolean;
}

/**
 * Fetch the live zero-priced text model catalog.
 * Returns [] on any failure so callers can fall back to a static list.
 */
export async function fetchOpenRouterFreeModels(
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterModel[]> {
  try {
    const response = await fetchImpl(`${OPENROUTER_API_BASE}/models`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
        architecture?: { output_modalities?: string[] };
        supported_parameters?: string[];
      }>;
    };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const out: OpenRouterModel[] = [];
    for (const m of rows) {
      if (typeof m.id !== 'string' || m.id.length === 0) continue;
      const prompt = Number.parseFloat(m.pricing?.prompt ?? '0');
      const completion = Number.parseFloat(m.pricing?.completion ?? '0');
      if (prompt !== 0 || completion !== 0) continue;
      const outputs = m.architecture?.output_modalities ?? [];
      if (!outputs.includes('text')) continue;
      out.push({
        id: m.id,
        name: m.name ?? m.id,
        contextLength: typeof m.context_length === 'number' ? m.context_length : 0,
        supportsTools: (m.supported_parameters ?? []).includes('tools'),
      });
    }
    return out.sort((a, b) => b.contextLength - a.contextLength);
  } catch {
    return [];
  }
}

/** Offline fallback: the free text models observed on 2026-09-14. */
export const FALLBACK_FREE_MODELS: readonly OpenRouterModel[] = [
  { id: 'thinkingmachines/inkling:free', name: 'Inkling (free)', contextLength: 1_048_576, supportsTools: true },
  { id: 'thinkingmachines/inkling-small:free', name: 'Inkling Small (free)', contextLength: 1_048_576, supportsTools: true },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B (free)', contextLength: 1_000_000, supportsTools: true },
  { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning (free)', contextLength: 1_000_000, supportsTools: true },
  { id: 'dots-studio/dots-3-note-preview:free', name: 'Dots 3 Note (free)', contextLength: 512_000, supportsTools: true },
  { id: 'inclusionai/ling-3.0-flash-vl:free', name: 'Ling 3.0 Flash VL (free)', contextLength: 262_144, supportsTools: true },
  { id: 'inclusionai/ling-3.0-flash-sante:free', name: 'Ling 3.0 Flash Sante (free)', contextLength: 262_144, supportsTools: true },
  { id: 'inclusionai/ling-3.0-flash-fin:free', name: 'Ling 3.0 Flash Fin (free)', contextLength: 262_144, supportsTools: true },
  { id: 'nex-agi/nex-n2.5-pro:free', name: 'Nex N2.5 Pro (free)', contextLength: 262_144, supportsTools: true },
  { id: 'nex-agi/nex-n2.5-mini:free', name: 'Nex N2.5 Mini (free)', contextLength: 262_144, supportsTools: true },
  { id: 'poolside/laguna-s-2.1:free', name: 'Laguna S 2.1 (free)', contextLength: 262_144, supportsTools: true },
  { id: 'poolside/laguna-xs-2.1:free', name: 'Laguna XS 2.1 (free)', contextLength: 262_144, supportsTools: true },
  { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)', contextLength: 262_144, supportsTools: true },
  { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B A4B (free)', contextLength: 262_144, supportsTools: true },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B (free)', contextLength: 262_144, supportsTools: true },
  { id: 'cohere/north-mini-code:free', name: 'North Mini Code (free)', contextLength: 256_000, supportsTools: true },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'Nemotron 3 Nano Omni 30B (free)', contextLength: 256_000, supportsTools: true },
  { id: 'openrouter/free', name: 'OpenRouter Free Router', contextLength: 200_000, supportsTools: true },
  { id: 'liquid/lfm-2.5-2.6b:free', name: 'LFM 2.5 2.6B (free)', contextLength: 65_536, supportsTools: true },
];
