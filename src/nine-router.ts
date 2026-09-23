/**
 * 9Router upstream (local multi-provider AI gateway).
 *
 * 9Router (https://github.com/decolua/9router) exposes an OpenAI-compatible
 * surface on top of 100+ providers, so it plugs into this adapter exactly like
 * the other OpenAI-compatible upstreams (Groq / Zhipu / OpenRouter / LLM7):
 * a model-id prefix picks the route, and one module owns transport + catalog.
 *
 * Model ids are surfaced to the picker as `9r/<upstream-model-id>` because
 * 9Router ids are namespaced with their own slash (`kr/claude-sonnet-4.5`,
 * `gh/gpt-5`), which would otherwise be indistinguishable from our prefixes.
 *
 * Credential sources, in priority order:
 *   1. NINE_ROUTER_BASE_URL / NINE_ROUTER_API_KEY environment variables, or
 *   2. the same keys in ~/.dsh/.credentials.yaml (harness credential store).
 *
 * The catalog is fetched live from GET /v1/models and falls back to an empty
 * list, so a stopped 9Router never breaks the other upstreams.
 *
 * Docs: https://github.com/decolua/9router  ·  API: <baseUrl>/chat/completions
 */
import fs from 'node:fs';
import path from 'node:path';

/** Prefix that marks a model id as routed through 9Router. */
export const NINE_ROUTER_PREFIX = '9r/';

/**
 * Picker id of the dedicated 9Router rotation entry.
 *
 * This is deliberately its own virtual model rather than a member of the
 * "Free" pool: 9Router fronts subscription/paid upstreams too, and folding it
 * into Free would misreport both cost and availability. It rotates only across
 * 9Router's own catalog, with its own cursor and cooldown.
 */
export const NINE_ROUTER_AGGREGATE_ID = '9Router';

/** Default 9Router OpenAI-compatible endpoint (its documented default port). */
export const NINE_ROUTER_DEFAULT_BASE_URL = 'http://127.0.0.1:20128/v1';

/** Header timeout for one chat request (matches the other upstreams). */
const HEADER_TIMEOUT_MS = 20_000;

/** Catalog fetch is best-effort: a slow 9Router must not stall the picker. */
const CATALOG_TIMEOUT_MS = 10_000;

/** Resolved connection settings for the 9Router upstream. */
export interface NineRouterConfig {
  /** Base URL without a trailing slash, e.g. `http://127.0.0.1:20128/v1`. */
  baseUrl: string;
  /** Bearer key; absent means the instance has auth disabled. */
  apiKey?: string;
}

/** One model advertised by 9Router's `/v1/models`. */
export interface NineRouterModel {
  id: string;
  name: string;
  contextLength: number;
  maxOutput: number;
  supportsImage: boolean;
  supportsTools: boolean;
}

/** Path of the harness credential store (mirrors the sibling upstreams). */
function credentialsPath(): string {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  return path.join(home, '.credentials.yaml');
}

/**
 * Read one top-level key from ~/.dsh/.credentials.yaml.
 *
 * The file nests plain keys under `refs:`, so the match is indentation-
 * tolerant rather than anchored to column zero.
 */
function readCredential(name: string): string | undefined {
  try {
    const file = credentialsPath();
    if (!fs.existsSync(file)) return undefined;
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'));
    if (!match) return undefined;
    const value = match[1].trim().replace(/^['"]|['"]$/g, '');
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the 9Router endpoint and key (env wins over the credential store). */
export function resolveNineRouterConfig(): NineRouterConfig {
  const rawBase =
    process.env.NINE_ROUTER_BASE_URL?.trim()
    || readCredential('NINE_ROUTER_BASE_URL')
    || NINE_ROUTER_DEFAULT_BASE_URL;
  const apiKey = process.env.NINE_ROUTER_API_KEY?.trim() || readCredential('NINE_ROUTER_API_KEY');
  return {
    baseUrl: rawBase.replace(/\/+$/, ''),
    ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
  };
}

/** Strip the routing prefix to obtain the upstream 9Router model id. */
export function nineRouterUpstreamId(uiModel: string): string {
  return uiModel.startsWith(NINE_ROUTER_PREFIX)
    ? uiModel.slice(NINE_ROUTER_PREFIX.length)
    : uiModel;
}

/** Whether a picker model id routes through 9Router. */
export function isNineRouterModel(uiModel: string): boolean {
  return uiModel.startsWith(NINE_ROUTER_PREFIX);
}

/** Build the request headers shared by catalog and chat calls. */
function headers(apiKey: string | undefined, accept: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: accept,
    ...(apiKey !== undefined && apiKey.length > 0 ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/**
 * Fetch the live 9Router catalog.
 *
 * Returns [] on any failure (unreachable instance, auth error, malformed
 * payload) so the picker simply omits the 9Router models instead of failing.
 */
export async function fetchNineRouterModels(
  config: NineRouterConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<NineRouterModel[]> {
  try {
    const response = await fetchImpl(`${config.baseUrl}/models`, {
      headers: headers(config.apiKey, 'application/json'),
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        context_length?: number;
        max_completion_tokens?: number;
        capabilities?: { contextWindow?: number; maxOutput?: number; vision?: boolean; tools?: boolean };
      }>;
    };
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const out: NineRouterModel[] = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id.length === 0) continue;
      const caps = row.capabilities ?? {};
      out.push({
        id: row.id,
        name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
        // 9Router emits snake_case at top level and camelCase inside
        // `capabilities`; accept both rather than guessing from the name.
        contextLength: row.context_length ?? caps.contextWindow ?? 0,
        maxOutput: row.max_completion_tokens ?? caps.maxOutput ?? 0,
        supportsImage: caps.vision === true,
        supportsTools: caps.tools === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export interface NineRouterChatRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/** POST one streamed chat request to 9Router with a header timeout. */
export async function nineRouterChat(
  config: NineRouterConfig,
  req: NineRouterChatRequest,
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
    () => controller.abort(new Error(`9router header timeout after ${HEADER_TIMEOUT_MS}ms`)),
    HEADER_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(config.apiKey, 'text/event-stream'),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (req.signal) req.signal.removeEventListener('abort', onAbort);
  }
}
