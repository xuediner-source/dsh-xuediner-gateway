/**
 * Command Code Go upstream (subscription, custom /alpha/generate protocol).
 *
 * CommandCode is not OpenAI-shaped: the CLI posts a single JSON envelope to
 * `/alpha/generate` and reads back a custom SSE event stream
 * (`text-delta` / `reasoning-delta` / `tool-input-*` / `tool-call` /
 * `finish-step` / `finish`). This module owns the transport and the model
 * catalog; the adapter owns the harness-message conversion and the SSE
 * consumption.
 *
 * Credential sources, in priority order (paths only — no secrets in this repo):
 *   1. COMMANDCODE_API_KEY environment variable, or
 *   2. ~/.commandcode/auth.json `apiKey` (what the official `commandcode` CLI
 *      writes after `cmd login`), or
 *   3. the subscription hub's entry in
 *      ~/.dsh/plugins/subscriptions/auth.json (provider "commandcode").
 *
 * Verified against the working implementation in dsh-subs-hub (same protocol).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COMMANDCODE_API_BASE = 'https://api.commandcode.ai';
export const COMMANDCODE_GENERATE_URL = `${COMMANDCODE_API_BASE}/alpha/generate`;
export const COMMANDCODE_WHOAMI_URL = `${COMMANDCODE_API_BASE}/alpha/whoami`;
export const COMMANDCODE_CREDITS_URL = `${COMMANDCODE_API_BASE}/alpha/billing/credits`;

/** CLI version the upstream expects in `x-command-code-version`. */
export const COMMANDCODE_CLI_VERSION = '1.62.0';

const HEADER_TIMEOUT_MS = 30_000;

/** One model served by the Go plan. */
export interface CommandCodeModel {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  maxTokens: number;
  supportsImage: boolean;
  efforts: readonly string[];
  defaultEffort: string;
}

/**
 * Catalog advertised by the Go plan.
 *
 * Kept static rather than fetched: `/alpha/models` is not part of the observed
 * API surface, and a wrong catalog would silently hide models. Mirrors the
 * verified dsh-subs-hub list.
 */
export const COMMANDCODE_MODELS: readonly CommandCodeModel[] = [
  {
    id: 'meta/muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor (Go)',
    description: 'Meta Muse Spark 1.3 Contributor · 1M 上下文 · 支持思考与多模态',
    contextWindow: 1_048_576,
    maxTokens: 64_000,
    supportsImage: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash (Go)',
    description: 'DeepSeek V4.1 Flash · 1M 上下文 · 支持思考与多模态',
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImage: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'xiaomi/mimo-v2.6-pro',
    name: 'MiMo V2.6 Pro (Go)',
    description: 'Xiaomi MiMo V2.6 Pro · 1M 上下文 · 支持思考与多模态',
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImage: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'poolside/laguna-s-2.1-free',
    name: 'Laguna S 2.1 (Free) (Go)',
    description: 'Poolside Laguna S 2.1 (Free) · 256K 上下文 · 免费额度',
    contextWindow: 262_144,
    maxTokens: 64_000,
    supportsImage: false,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'low',
  },
  {
    id: 'inclusionai/ling-3.0-flash-sante:free',
    name: 'Ling 3.0 Flash Sante (Free) (Go)',
    description: 'Ling 3.0 Flash Sante (Free) · 256K 上下文 · 免费额度',
    contextWindow: 256_000,
    maxTokens: 64_000,
    supportsImage: false,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'low',
  },
];

/**
 * Resolve a picker id to a catalog entry.
 *
 * Exact match first, then a suffix match so a caller that passes a fully
 * qualified id (e.g. `commandcode/meta/muse-spark-1.3-contributor`, the shape
 * the subscription hub uses) still resolves. Falls back to the first entry so
 * an unknown id is still answerable instead of failing outright.
 */
export function findCommandCodeModel(id: string): CommandCodeModel {
  const exact = COMMANDCODE_MODELS.find((m) => m.id === id);
  if (exact !== undefined) return exact;
  const bySuffix = COMMANDCODE_MODELS.find(
    (m) => typeof id === 'string' && (m.id.endsWith(id) || id.endsWith(m.id)),
  );
  return bySuffix ?? COMMANDCODE_MODELS[0]!;
}

/** Read `~/.commandcode/auth.json` (the official CLI's credential file). */
function readCommandCodeAuthFile(): string | undefined {
  try {
    const file = path.join(os.homedir(), '.commandcode', 'auth.json');
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { apiKey?: unknown };
    if (typeof parsed.apiKey !== 'string' || parsed.apiKey.length === 0) return undefined;
    return parsed.apiKey;
  } catch {
    return undefined;
  }
}

/** Read the subscription hub's `commandcode` entry (accessToken). */
function readSubscriptionToken(): string | undefined {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  try {
    const file = path.join(home, 'plugins', 'subscriptions', 'auth.json');
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const entry = parsed?.commandcode as Record<string, unknown> | undefined;
    if (!entry) return undefined;
    for (const field of ['accessToken', 'access_token', 'apiKey', 'api_key', 'key']) {
      const value = entry[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the CommandCode API key.
 * env > ~/.commandcode/auth.json > subscription hub store.
 */
export function resolveCommandCodeKey(): string | undefined {
  const fromEnv = process.env.COMMANDCODE_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return readCommandCodeAuthFile() ?? readSubscriptionToken();
}

/** One tool declaration in CommandCode's own shape. */
export interface CommandCodeTool {
  type: 'function';
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CommandCodeChatRequest {
  /** Upstream model id (already resolved through findCommandCodeModel). */
  model: string;
  /** Messages already converted to CommandCode's wire shape. */
  messages: Array<Record<string, unknown>>;
  system: string;
  tools?: CommandCodeTool[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  /** Stable id grouping one logical thread; a fresh uuid per call is fine. */
  threadId: string;
  signal?: AbortSignal;
}

/** Build the request headers the CLI sends. */
function headers(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-command-code-version': COMMANDCODE_CLI_VERSION,
    'x-cli-environment': 'production',
    'x-project-slug': 'dsh',
    'x-taste-learning': 'true',
    'x-co-flag': 'false',
  };
}

/**
 * POST one streamed `/alpha/generate` request with a header timeout.
 *
 * The envelope shape (config / memory / taste / skills / params / threadId) is
 * what the CLI itself sends; `config` is repo context the plan uses for
 * ranking, so it is filled with harmless neutral values.
 */
export async function commandCodeChat(
  apiKey: string,
  req: CommandCodeChatRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const body: Record<string, unknown> = {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().slice(0, 10),
      environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: req.model,
      messages: req.messages,
      system: req.system,
      stream: true,
      ...(req.tools !== undefined && req.tools.length > 0 ? { tools: req.tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoning_effort: req.reasoningEffort } : {}),
    },
    threadId: req.threadId,
  };

  const controller = new AbortController();
  const onAbort = () => controller.abort(req.signal?.reason);
  if (req.signal) {
    if (req.signal.aborted) controller.abort(req.signal.reason);
    else req.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`commandcode header timeout after ${HEADER_TIMEOUT_MS}ms`)),
    HEADER_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(COMMANDCODE_GENERATE_URL, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (req.signal) req.signal.removeEventListener('abort', onAbort);
  }
}
