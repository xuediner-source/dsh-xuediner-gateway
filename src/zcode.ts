/**
 * ZCode upstream (local zcode-proxy bridge -> Z.AI / BigModel coding plans).
 *
 * Why a proxy instead of calling Z.AI directly: the coding-plan entitlement is
 * NOT reachable through the public API hosts. Verified 2026-09-19 against all
 * four documented endpoints (api.z.ai/api/anthropic, api.z.ai/api/coding/paas/v4,
 * open.bigmodel.cn/api/anthropic) with the plan's own key AND the OAuth token:
 * every one answered `1113 Insufficient balance or no resource package`. The
 * subscription quota is only served on the client-shaped channel, which is what
 * the reference project TriDefender/zcode-api (zcode-proxy) speaks.
 *
 * So this module is a thin OpenAI-compatible client for the LOCAL proxy:
 *
 *   DSH -> xuedinerAPI adapter -> 127.0.0.1:8080 (zcode-proxy) -> Z.AI plan
 *
 * Model ids surface to the picker as `zcode/<model-id>` so they cannot collide
 * with the pool's own ids.
 *
 * Credential sources, in priority order:
 *   1. ZCODE_PROXY_BASE_URL / ZCODE_PROXY_API_KEY environment variables, or
 *   2. the same keys in ~/.dsh/.credentials.yaml, or
 *   3. defaults below (the proxy's documented port + its config.yaml key).
 *
 * The catalog is fetched live from GET /v1/models and falls back to an empty
 * list, so a stopped proxy never breaks the other upstreams.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Prefix that marks a model id as routed through the local zcode-proxy. */
export const ZCODE_PREFIX = 'zcode/';

/** Default zcode-proxy endpoint (its documented default port). */
export const ZCODE_DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';

/**
 * Client key the proxy expects in `Authorization`.
 *
 * Matches `auth.proxyApiKey` in the proxy's config.yaml. Only a localhost
 * shared secret (the proxy binds loopback only), not an upstream credential —
 * the real OAuth token lives in ~/.zcode-proxy/credentials.json and never
 * passes through DSH. Override via ZCODE_PROXY_API_KEY or the harness
 * credential store if the proxy's key is rotated again.
 */
export const ZCODE_DEFAULT_API_KEY = 'zcode-e1691d89275a4e7c3c1fedd18a90643c8f37';

/** Header timeout for one chat request (matches the other upstreams). */
const HEADER_TIMEOUT_MS = 20_000;

/** Catalog fetch is best-effort: a slow proxy must not stall the picker. */
const CATALOG_TIMEOUT_MS = 10_000;

/** Resolved connection settings for the local zcode-proxy. */
export interface ZcodeConfig {
  /** Base URL without a trailing slash, e.g. `http://127.0.0.1:8080/v1`. */
  baseUrl: string;
  /** Bearer key; absent means the proxy has client auth disabled. */
  apiKey?: string;
}

/** One model advertised by the proxy's `/v1/models`. */
export interface ZcodeModel {
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

/** Read one top-level key from ~/.dsh/.credentials.yaml (indent-tolerant). */
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

/** Resolve the proxy endpoint and key (env wins over the credential store). */
export function resolveZcodeConfig(): ZcodeConfig {
  const rawBase =
    process.env.ZCODE_PROXY_BASE_URL?.trim()
    || readCredential('ZCODE_PROXY_BASE_URL')
    || ZCODE_DEFAULT_BASE_URL;
  const apiKey =
    process.env.ZCODE_PROXY_API_KEY?.trim()
    || readCredential('ZCODE_PROXY_API_KEY')
    || ZCODE_DEFAULT_API_KEY;
  return {
    baseUrl: rawBase.replace(/\/+$/, ''),
    ...(apiKey.length > 0 ? { apiKey } : {}),
  };
}

/** Strip the routing prefix to obtain the upstream model id. */
export function zcodeUpstreamId(uiModel: string): string {
  return uiModel.startsWith(ZCODE_PREFIX) ? uiModel.slice(ZCODE_PREFIX.length) : uiModel;
}

/** Whether a picker model id routes through the local zcode-proxy. */
export function isZcodeModel(uiModel: string): boolean {
  return uiModel.startsWith(ZCODE_PREFIX);
}

/**
 * Upstream ids whose zcode-proxy entry is deliberately NOT advertised.
 *
 * `glm-5.3-flash` is folded into the unified `glm-5.3-flash` picker entry,
 * which rotates between the Z.AI plan quota (this proxy) and the local pool.
 * Listing it here too would advertise one upstream twice.
 */
export const ZCODE_HIDDEN_UPSTREAMS: readonly string[] = ['glm-5.3-flash'];

/**
 * Whether the per-model `zcode/*` entries are advertised in the picker.
 *
 * Set to `false` on 2026-09-21 at the user's request: the ten individual
 * `zcode/glm-*` picker rows were removed, so xuedinerAPI now shows no ZCode
 * entry at all.
 *
 * This only stops *advertising* them. The ZCode transport is deliberately kept
 * intact because the unified `glm-5.3-flash` entry still uses it as its
 * first-priority source (Z.AI plan quota, then the pool) — see
 * `glmFlashPoolStream`. Flip this back to `true` to re-list the individual
 * models without touching any other code.
 */
export const ZCODE_ADVERTISE_MODELS = false;

/** Build the request headers shared by catalog and chat calls. */
function headers(apiKey: string | undefined, accept: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: accept,
    ...(apiKey !== undefined && apiKey.length > 0 ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/**
 * Fetch the live model catalog from the proxy.
 *
 * Returns [] on any failure (proxy stopped, auth error, malformed payload) so
 * the picker simply omits these models instead of failing.
 */
export async function fetchZcodeModels(
  config: ZcodeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeModel[]> {
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
    const out: ZcodeModel[] = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id.length === 0) continue;
      const caps = row.capabilities ?? {};
      out.push({
        id: row.id,
        name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
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

export interface ZcodeChatRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/** POST one streamed chat request to the proxy with a header timeout. */
export async function zcodeChat(
  config: ZcodeConfig,
  req: ZcodeChatRequest,
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
    () => controller.abort(new Error(`zcode-proxy header timeout after ${HEADER_TIMEOUT_MS}ms`)),
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
