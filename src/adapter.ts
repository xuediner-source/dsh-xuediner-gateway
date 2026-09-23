/**
 * xuedinerAPI Adapter
 *
 * Unified provider "xuedinerAPI" backed by a hybrid account pool:
 *  - N x Huawei Cloud CodeArts (AK/SK + auto refresh; upstream model deepseek-v4-flash)
 *  - 3 x Tencent WorkBuddy via local gateway (2 CN + 1 intl)
 *
 * Model mapping (user-specified):
 *  - UI "deepseek-v4.1-flash" -> CodeArts "deepseek-v4-flash", gateway "deepseek-v4-flash"
 *    (never send the UI id to the Tencent pool — it is not a registered model)
 *  - UI "hy4-preview"         -> gateway "hy4-preview"
 *
 * Reliability contract:
 *  - Every upstream fetch is bounded by a header timeout.
 *  - Every SSE read is bounded by first-token / idle timeouts (no permanent hangs).
 *  - Account switching only happens BEFORE any output was emitted.
 *  - After output started, errors terminate the stream (never stitch two models).
 *  - Gateway is the final fallback; calls always terminate with output or a typed error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { Message } from '@deepseek-ai/dsh-llm';
import { signRequestHuawei } from './huawei-sign.js';
import { exchangeRefreshToken, keyPairFromStoredJwk } from './codearts-auth.js';
import type { DpopPrivateJwk } from './codearts-auth.js';
import { intlChat, isIntlModel, loadIntlAccounts } from './intl-direct.js';
import {
  openRouterChat,
  resolveOpenRouterKey,
  fetchOpenRouterFreeModels,
  FALLBACK_FREE_MODELS,
} from './openrouter.js';
import { llm7Chat, resolveLlm7Key, LLM7_ALIASES } from './llm7.js';
import { groqChat, resolveGroqKey, GROQ_MODELS } from './groq.js';
import { zhipuChat, resolveZhipuKey, ZHIPU_MODELS } from './zhipu.js';
import {
  NINE_ROUTER_PREFIX,
  NINE_ROUTER_AGGREGATE_ID,
  isNineRouterModel,
  nineRouterChat,
  nineRouterUpstreamId,
  resolveNineRouterConfig,
  fetchNineRouterModels,
} from './nine-router.js';
import type { NineRouterModel } from './nine-router.js';
import {
  QODER_ENTRIES,
  QODER_HIDDEN_UPSTREAMS,
  QODER_MODEL_DEEPSEEK_FLASH,
  QODER_ORIGIN,
  QODER_JOB_ORIGIN,
  selectOrigin,
  qoderChat,
  qoderDirectModel,
  resolveQoderCredential,
  unwrapQoderEvent,
} from './qoder.js';
import {
  ZCODE_PREFIX,
  ZCODE_ADVERTISE_MODELS,
  ZCODE_HIDDEN_UPSTREAMS,
  fetchZcodeModels,
  isZcodeModel,
  resolveZcodeConfig,
  zcodeChat,
  zcodeUpstreamId,
} from './zcode.js';
import type { ZcodeModel } from './zcode.js';
import {
  CODEX_POOL_ID,
  CODEX_MODELS,
  listCodexAccounts,
  codexChat,
  type CodexAccount,
} from './codex.js';
import {
  COMMANDCODE_MODELS,
  commandCodeChat,
  findCommandCodeModel,
  resolveCommandCodeKey,
} from './commandcode.js';
import type { CommandCodeTool } from './commandcode.js';
import { recordCodeArtsUsage } from './codearts-usage.js';

/** OpenRouter free-model ids are prefixed so routing can recognize them. */
export const OPENROUTER_PREFIX = 'or/';
/** LLM7 alias ids are prefixed to avoid colliding with native model names. */
export const LLM7_PREFIX = 'l7/';
/** Groq model ids are prefixed for the same reason. */
export const GROQ_PREFIX = 'groq/';
/** Zhipu model ids are prefixed for the same reason. */
export const ZHIPU_PREFIX = 'zp/';

/**
 * Command Code Go model ids are prefixed for the same reason. Their upstream
 * ids are already slash-namespaced (`meta/muse-spark-1.3-contributor`), so
 * without a prefix they could collide with other routing namespaces.
 */
export const COMMANDCODE_PREFIX = 'cc/';

/**
 * 9Router model ids are prefixed for the same reason. 9Router's own ids are
 * slash-namespaced (`kr/claude-sonnet-4.5`), so without a prefix they would be
 * indistinguishable from this adapter's other routing prefixes.
 */
export { NINE_ROUTER_PREFIX, isNineRouterModel };

/**
 * ZCode (local zcode-proxy) model ids are prefixed for the same reason. The
 * proxy fronts the Z.AI / BigModel coding-plan quota, which is unreachable
 * through the public API hosts (they answer `1113 Insufficient balance`).
 */
export { ZCODE_PREFIX, isZcodeModel };

/** Strip the routing prefix to obtain the upstream OpenRouter model id. */
export function openRouterUpstreamId(uiModel: string): string {
  return uiModel.startsWith(OPENROUTER_PREFIX) ? uiModel.slice(OPENROUTER_PREFIX.length) : uiModel;
}

export function isOpenRouterModel(uiModel: string): boolean {
  return uiModel.startsWith(OPENROUTER_PREFIX);
}

export function isLlm7Model(uiModel: string): boolean {
  return uiModel.startsWith(LLM7_PREFIX);
}

export function isGroqModel(uiModel: string): boolean {
  return uiModel.startsWith(GROQ_PREFIX);
}

export function isZhipuModel(uiModel: string): boolean {
  return uiModel.startsWith(ZHIPU_PREFIX);
}

/** Whether a picker model id routes to Command Code Go. */
export function isCommandCodeModel(uiModel: string): boolean {
  return uiModel.startsWith(COMMANDCODE_PREFIX);
}

/** Strip the routing prefix to obtain the upstream CommandCode model id. */
export function commandCodeUpstreamId(uiModel: string): string {
  return uiModel.startsWith(COMMANDCODE_PREFIX) ? uiModel.slice(COMMANDCODE_PREFIX.length) : uiModel;
}

/**
 * Tencent WorkBuddy pool ids. The UI name "deepseek-v4.1-flash" is not
 * registered upstream; sending it makes the pool reject / 503 the call.
 */
export function workbuddyUpstreamModel(uiModel: string): string {
  if (uiModel.toLowerCase().includes('deepseek')) return 'deepseek-v4-flash';
  return uiModel;
}

/** The single merged free-tier model shown in the picker. */
export const FREE_MODEL_ID = 'Free';

/**
 * GLM-5.3-Flash, served by the local pool gateway.
 *
 * A dedicated route rather than a member of "Free": the pool reports it with
 * reasoning support and a real credit cost (observed credit=0.01 per call), so
 * folding it into the free rotation would misreport both.
 */
export const GLM_FLASH_MODEL_ID = 'glm-5.3-flash';

/**
 * Reject OpenRouter free entries that are not conversational chat models.
 * The zero-priced catalog includes music generation (lyria) and content
 * classifiers, which always fail a chat completion and only add latency.
 */
export function isChatCapableFreeModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.includes('lyria')) return false; // music generation
  if (lower.includes('content-safety')) return false; // classifier
  if (lower.includes('image')) return false; // image generation
  return true;
}
export const DEFAULT_BASE_URL = 'http://127.0.0.1:7863/v1';
export const DEFAULT_API_KEY = 'wb2api-dsh-key';
export const PROVIDER = 'xuedinerAPI';
export const CODEARTS_API_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions';
/**
 * Directory holding CodeArts credential files (codearts-*.json).
 *
 * Resolution order (paths only — no credentials are bundled with this repo):
 *   1. XUEDINER_GATEWAY_DIR / WORKBUDDY_GATEWAY_DIR + '/auths' (explicit install dir)
 *   2. <repo>/gateway/auths (bundled gateway checkout, dev layout)
 *   3. ~/.dsh/xuediner-gateway/auths (per-user data dir)
 */
function resolveCodeArtsAuthsDir(): string {
  const explicit = process.env.XUEDINER_GATEWAY_DIR ?? process.env.WORKBUDDY_GATEWAY_DIR;
  if (explicit && explicit.length > 0) return path.join(explicit, 'auths');
  const bundled = path.resolve('gateway', 'auths');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(os.homedir(), '.dsh', 'xuediner-gateway', 'auths');
}
const CODEARTS_AUTHS_DIR = resolveCodeArtsAuthsDir();

function resolveDebugLogPath(): string | undefined {
  const debug = process.env.XUEDINER_DEBUG_LOG;
  if (debug && debug.length > 0) return debug;
  if (process.env.XUEDINER_DEBUG === '1') {
    return path.join(path.dirname(CODEARTS_AUTHS_DIR), 'data', 'adapter-debug.log');
  }
  return undefined;
}

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function logDebug(msg: string): void {
  try {
    const logPath = resolveDebugLogPath();
    if (!logPath) return;
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {}
}

/** Bridge that turns one attachment reference into raw image bytes. */
export type ReadImage = (
  attachment: unknown,
) => Promise<{ data: Uint8Array; mediaType: string } | undefined>;

const HEADER_TIMEOUT_MS = envInt('XUEDINER_HEADER_TIMEOUT_MS', 120_000);
const FIRST_TOKEN_TIMEOUT_MS = envInt('XUEDINER_FIRST_TOKEN_TIMEOUT_MS', 120_000);
const CHUNK_IDLE_TIMEOUT_MS = envInt('XUEDINER_CHUNK_IDLE_TIMEOUT_MS', 180_000);
const REFRESH_LEAD_MS = 10 * 60_000;

export interface CodeArtsCred {
  access_key_id: string;
  secret_access_key: string;
  security_token: string;
  expires_at?: string;
  refresh_token?: string;
  code_verifier?: string;
  dpop_private_key_jwk?: DpopPrivateJwk;
}

interface StoredCred {
  cred: CodeArtsCred;
  file: string;
}

/** refresh_token 已经判定失效的账号（本次进程内不再尝试）。 */
const refreshDead = new Set<string>();

function listCodeArtsFiles(): string[] {
  try {
    if (!fs.existsSync(CODEARTS_AUTHS_DIR)) return [];
    return fs.readdirSync(CODEARTS_DIR_SAFE())
      .filter((f) => f.startsWith('codearts-') && f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

// helper kept trivial so the literal above stays obvious
function CODEARTS_DIR_SAFE(): string {
  return CODEARTS_AUTHS_DIR;
}

/** Load all CodeArts credentials, deduped by access_key_id, with their source files. */
export function loadCodeArtsCredentials(): StoredCred[] {
  const out: StoredCred[] = [];
  const seen = new Set<string>();
  for (const file of listCodeArtsFiles()) {
    const full = path.join(CODEARTS_AUTHS_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8')) as CodeArtsCred;
      if (data.access_key_id && data.secret_access_key && data.security_token && !seen.has(data.access_key_id)) {
        seen.add(data.access_key_id);
        out.push({ cred: data, file: full });
      }
    } catch {
      // skip unreadable file
    }
  }
  return out;
}

/**
 * Refresh one stored credential when it is near expiry.
 * Writes the renewed credential back to its source file on success.
 * Never throws: on failure returns the original credential (the call itself
 * will fail fast and routing falls through to the next account / gateway).
 */
export async function refreshCodeArtsCredential(stored: StoredCred, force = false): Promise<CodeArtsCred> {
  const cred = stored.cred;
  const ak = cred.access_key_id;
  if (refreshDead.has(ak)) return cred;
  const canRefresh = cred.refresh_token && cred.code_verifier && cred.dpop_private_key_jwk;
  if (!canRefresh) return cred;

  const exp = Date.parse(cred.expires_at ?? '');
  if (!force && Number.isFinite(exp) && Date.now() < exp - REFRESH_LEAD_MS) {
    return cred; // still fresh
  }

  try {
    const keyPair = keyPairFromStoredJwk(cred.dpop_private_key_jwk!);
    const token = await exchangeRefreshToken(cred.refresh_token!, cred.code_verifier!, keyPair);
    const updated: CodeArtsCred = {
      ...cred,
      access_key_id: token.credentials?.access_key_id ?? cred.access_key_id,
      secret_access_key: token.credentials?.secret_access_key ?? cred.secret_access_key,
      security_token: token.credentials?.security_token ?? cred.security_token,
      expires_at: token.credentials?.expiration ?? cred.expires_at,
      ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
    };
    try {
      fs.writeFileSync(stored.file, JSON.stringify(updated, null, 2), 'utf8');
    } catch (writeErr) {
      console.warn('[xuedinerAPI] refreshed credential write-back failed (using in-memory value):', writeErr);
    }
    return updated;
  } catch (error) {
    if ((error as { fatal?: boolean }).fatal) refreshDead.add(ak);
    console.warn(`[xuedinerAPI] CodeArts refresh failed (${ak.slice(0, 8)}):`, error);
    return cred;
  }
}

/** Flatten harness content blocks into plain text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('');
}

/** Keep only tool calls that have a matching tool result and vice versa. */
function resolveToolPairing(messages: readonly Message[]): { keepCallIds: Set<string>; keepResultIds: Set<string> } {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      if ((block as { type?: string }).type === 'tool-call') {
        callIds.add(String((block as { id?: unknown }).id ?? ''));
      }
      if ((block as { type?: string }).type === 'tool-result') {
        resultIds.add(String((block as { toolCallId?: unknown }).toolCallId ?? ''));
      }
    }
  }
  const keepCallIds = new Set<string>();
  const keepResultIds = new Set<string>();
  for (const id of callIds) if (resultIds.has(id)) keepCallIds.add(id);
  for (const id of resultIds) if (callIds.has(id)) keepResultIds.add(id);
  return { keepCallIds, keepResultIds };
}

function normalizeToolArguments(raw: string): string {
  if (typeof raw !== 'string') return '{}';
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '{}') return '{}';
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed ?? {});
  } catch {
    return trimmed;
  }
}

/** Collect image attachment refs from user content (deduped by attachment id). */
function collectImageRefs(messages: readonly Message[]): Map<string, unknown> {
  const refs = new Map<string, unknown>();
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      if ((block as { type?: string }).type !== 'image') continue;
      const attachment = (block as { attachment?: unknown }).attachment;
      if (attachment === undefined || attachment === null) continue;
      const key = String((attachment as { id?: unknown }).id ?? refs.size);
      if (!refs.has(key)) refs.set(key, attachment);
    }
  }
  return refs;
}

/** Build OpenAI multimodal parts for one user message, when it carries images. */
function userContentParts(
  content: readonly unknown[],
  imageUrls: Map<string, string>,
): Array<Record<string, unknown>> | undefined {
  let hasImage = false;
  const parts: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const type = (block as { type?: string }).type;
    if (type === 'text') {
      const text = String((block as { text?: unknown }).text ?? '');
      if (text.length > 0) parts.push({ type: 'text', text });
      continue;
    }
    if (type === 'image') {
      hasImage = true;
      const attachment = (block as { attachment?: unknown }).attachment;
      const key = String((attachment as { id?: unknown }).id ?? '');
      const url = imageUrls.get(key);
      // Keep a visible placeholder when bytes could not be read, rather than
      // silently dropping the image and letting the model answer blind.
      parts.push(url === undefined ? { type: 'text', text: '[image unavailable]' } : { type: 'image_url', image_url: { url } });
    }
  }
  return hasImage && parts.length > 0 ? parts : undefined;
}

/** Serialize harness messages into OpenAI chat-completions wire format. */
function serializeMessages(
  messages: readonly Message[],
  imageUrls?: Map<string, string>,
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = [];
  const { keepCallIds, keepResultIds } = resolveToolPairing(messages);
  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      const toolCallBlocks = content
        .filter((block) => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool-call')
        .filter((block) => keepCallIds.has(String((block as { id?: unknown }).id ?? '')));
      const toolCalls = toolCallBlocks.map((block) => ({
        id: String((block as { id?: unknown }).id ?? ''),
        type: 'function',
        function: {
          name: String((block as { name?: unknown }).name ?? ''),
          arguments: normalizeToolArguments(String((block as { arguments?: unknown }).arguments ?? '')),
        },
      }));
      const reasoning = content
        .filter((block) => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'reasoning')
        .map((block) => String((block as { text?: unknown }).text ?? ''))
        .join('');
      const text = contentToText(content);
      wire.push({
        role: 'assistant',
        content: text,
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (message.role === 'system') {
      wire.push({ role: 'system', content: contentToText(message.content) });
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const toolResults = content.filter(
      (block) => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool-result',
    );
    const text = contentToText(message.content);
    // Always emit tool results FIRST so they directly follow the preceding assistant tool-calls
    for (const result of toolResults) {
      const callId = String((result as { toolCallId?: unknown }).toolCallId ?? '');
      if (!keepResultIds.has(callId)) continue;
      wire.push({
        role: 'tool',
        tool_call_id: callId,
        content: contentToText((result as { content?: unknown }).content) || '(no output)',
      });
    }
    // When the message carries images, upgrade to OpenAI multimodal parts so the
    // model actually receives them; otherwise keep the plain-string form, which
    // every upstream accepts.
    const parts =
      imageUrls === undefined || imageUrls.size === 0 ? undefined : userContentParts(content, imageUrls);
    if (parts !== undefined) {
      wire.push({ role: 'user', content: parts });
    } else if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text });
    }
  }
  return sanitizeOpenAiWireMessages(wire);
}

/**
 * Convert harness messages into CommandCode's own parts format.
 *
 * CommandCode does not accept OpenAI `tool_calls` / `tool_call_id`; it expects
 * typed content parts: assistant turns carry `text` / `reasoning` / `tool-call`
 * parts, tool results arrive as `tool-result` parts on a `tool` role, and user
 * turns carry `text` / `image` parts.
 *
 * Returns the wire messages plus a call-id -> tool-name map, because tool
 * results identify their call by id only.
 */
function commandCodeMessages(
  messages: readonly Message[],
  imageUrls?: Map<string, string>,
): { messages: Array<Record<string, unknown>>; toolNames: Map<string, string> } {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      if ((block as { type?: string }).type === 'tool-call') {
        const id = String((block as { id?: unknown }).id ?? '');
        const name = String((block as { name?: unknown }).name ?? '');
        if (id !== '') toolNames.set(id, name);
      }
    }
  }

  const wire: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    // The system prompt travels in params.system, not as a message.
    if (message.role === 'system') continue;

    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      const parts: Array<Record<string, unknown>> = [];
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const type = (block as { type?: string }).type;
        if (type === 'text') {
          const text = String((block as { text?: unknown }).text ?? '');
          if (text.length > 0) parts.push({ type: 'text', text });
        } else if (type === 'reasoning') {
          const text = String((block as { text?: unknown }).text ?? '');
          if (text.length > 0) parts.push({ type: 'reasoning', text });
        } else if (type === 'tool-call') {
          const raw = String((block as { arguments?: unknown }).arguments ?? '');
          let input: unknown = {};
          try {
            input = raw.trim() === '' ? {} : JSON.parse(raw);
          } catch {
            input = {};
          }
          parts.push({
            type: 'tool-call',
            toolCallId: String((block as { id?: unknown }).id ?? ''),
            toolName: String((block as { name?: unknown }).name ?? ''),
            input,
          });
        }
      }
      if (parts.length > 0) wire.push({ role: 'assistant', content: parts });
      continue;
    }

    const content = Array.isArray(message.content) ? message.content : [];
    const toolResults = content.filter(
      (block) => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool-result',
    );
    for (const result of toolResults) {
      const callId = String((result as { toolCallId?: unknown }).toolCallId ?? '');
      const isError = (result as { isError?: unknown }).isError === true;
      const value = contentToText((result as { content?: unknown }).content);
      wire.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
            toolName: toolNames.get(callId) ?? 'tool',
            output: { type: isError ? 'error-text' : 'text', value: value || '(empty result)' },
          },
        ],
      });
    }

    const parts = userContentParts(content, imageUrls ?? new Map());
    if (parts !== undefined) {
      wire.push({ role: 'user', content: parts });
    } else {
      const text = contentToText(message.content);
      if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text });
    }
  }
  return { messages: wire, toolNames };
}

/**
 * Enforce OpenAI / Qoder tool-call grammar on the final wire messages:
 * 1. Every message with role 'tool' MUST directly follow an assistant message with tool_calls (or another tool message).
 * 2. If any orphan tool message appears, rewrite its role to 'user' so Qoder does not reject with 400.
 * 3. If an assistant message called tools that were not answered before the next turn, close them cleanly.
 */
function sanitizeOpenAiWireMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let pendingToolCallIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role;

    if (role === 'tool') {
      const callId = String(msg.tool_call_id ?? '');
      if (callId && pendingToolCallIds.has(callId)) {
        pendingToolCallIds.delete(callId);
        out.push(msg);
      } else {
        // Orphan tool message: preceded by a user or non-matching message.
        // Rewriting to 'user' preserves context and satisfies upstream grammar.
        out.push({
          role: 'user',
          content: `[Tool result for ${callId || 'unknown'}]: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')}`,
        });
        pendingToolCallIds.clear();
      }
      continue;
    }

    // A non-tool message arrived while previous tool-calls were still pending response:
    if (pendingToolCallIds.size > 0) {
      for (const missingId of pendingToolCallIds) {
        out.push({
          role: 'tool',
          tool_call_id: missingId,
          content: '(tool execution interrupted)',
        });
      }
      pendingToolCallIds.clear();
    }

    if (role === 'assistant') {
      if (msg.content === null || msg.content === undefined) msg.content = '';
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined;
      if (toolCalls && toolCalls.length > 0) {
        pendingToolCallIds = new Set(
          toolCalls.map((tc: any) => String(tc?.id ?? '')).filter(Boolean),
        );
      } else {
        pendingToolCallIds.clear();
      }
      out.push(msg);
      continue;
    }

    // user or system message
    pendingToolCallIds.clear();
    out.push(msg);
  }

  if (pendingToolCallIds.size > 0) {
    for (const missingId of pendingToolCallIds) {
      out.push({
        role: 'tool',
        tool_call_id: missingId,
        content: '(tool execution interrupted)',
      });
    }
  }

  return out;
}

/**
 * Protect Qoder from First Token Timeout (TTFT):
 * Qoder's edge gateway has a hard ~60s timeout on first token generation.
 * When conversation history reaches hundreds of thousands of tokens, Qwen's prefill
 * exceeds 60s and Qoder aborts with "First Token Timeout or Upstream Timeout".
 * This prunes overlong histories to a safe budget while preserving system prompt
 * and all recent tool-call / tool-result pairs.
 */
function pruneMessagesForQoder(
  messages: Array<Record<string, unknown>>,
  maxTokens = 60_000,
): Array<Record<string, unknown>> {
  if (messages.length <= 20) return messages;

  let estTokens = 0;
  for (const m of messages) {
    estTokens += Math.ceil(JSON.stringify(m).length / 3);
  }
  if (estTokens <= maxTokens && messages.length <= 40) return messages;

  const systemMsg = messages[0]?.role === 'system' ? messages[0] : undefined;
  const pool = systemMsg ? messages.slice(1) : messages;

  const slice: Array<Record<string, unknown>> = [];
  let budgetTokens = systemMsg ? maxTokens - Math.ceil(JSON.stringify(systemMsg).length / 3) : maxTokens;

  for (let i = pool.length - 1; i >= 0; i--) {
    const msg = pool[i];
    const cost = Math.ceil(JSON.stringify(msg).length / 3);
    if (slice.length >= 10 && (budgetTokens - cost < 0 || slice.length >= 35)) {
      break;
    }
    slice.unshift(msg);
    budgetTokens -= cost;
  }

  while (slice.length > 0 && slice[0].role === 'tool') {
    slice.shift();
  }

  const result = systemMsg ? [systemMsg, ...slice] : slice;
  return sanitizeOpenAiWireMessages(result);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as {
      error?: {
        code?: string | number;
        type?: string;
        message?: string;
        // codebuddy.ai nests the real business error one level deeper:
        // {"error":{"data":{"code":14018,"msg":"Credits exhausted..."}}}
        data?: { code?: string | number; msg?: string; message?: string };
      };
      message?: string;
      msg?: string;
    };
    const nested = data.error?.data;
    const parts = [
      data.error?.code !== undefined ? String(data.error.code) : undefined,
      typeof data.error?.type === 'string' ? data.error.type : undefined,
      typeof data.error?.message === 'string' ? data.error.message : undefined,
      nested?.code !== undefined ? String(nested.code) : undefined,
      typeof nested?.msg === 'string' ? nested.msg : undefined,
      typeof nested?.message === 'string' ? nested.message : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      typeof data.msg === 'string' ? data.msg : undefined,
    ].filter((value): value is string => value !== undefined);
    if (parts.length > 0) return parts.join(' ');
  } catch {
    // non-JSON
  }
  if (body.includes('<title>405</title>') || body.includes('405 Method Not Allowed')) {
    return '请求频次过高被阿里云 WAF 拦截 (HTTP 405)，请稍候片刻重试';
  }
  if (body.startsWith('<!doctype') || body.startsWith('<html') || body.includes('<html')) {
    const titleMatch = body.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '网关异常';
    return `上游网关拦截 (${title})，请稍候重试`;
  }
  return body.slice(0, 400);
}

/**
 * Context-overflow detection: upstreams report window overflows in their own
 * dialects — Tencent code 11115 ("prompt is too long: N tokens > M maximum"),
 * OpenAI-style context_length_exceeded, gateway request_body_too_large, and
 * the zh display text "超出模型长度上限". Session-e456a8e9 forensics
 * (2026-09-17): these envelopes surfaced as generic SERVER/503 through the
 * pool, so the harness retried 116 times instead of compacting and the
 * session went unresponsive. Classifying them as CONTEXT_WINDOW_EXCEEDED is
 * what arms the official compaction recovery path.
 */
export function isContextOverflow(body: string, detail = ''): boolean {
  const hay = `${detail}\n${body}`;
  if (hay.includes('11115')) return true;
  if (/prompt is too long/i.test(hay)) return true;
  if (/context_length_exceeded/i.test(hay)) return true;
  if (/maximum context/i.test(hay)) return true;
  if (/exceeds the model context limit/i.test(hay)) return true;
  if (/超出模型长度上限/.test(hay)) return true;
  if (/request_body_too_large/i.test(hay)) return true;
  if (/tokens\s*>\s*[\d,]+\s*maximum/i.test(hay)) return true;
  return false;
}

function httpErrorCode(status: number, body = ''): string {
  const detail = body ? errorDetail(body) : '';
  // 14018 is credits exhausted, even when the envelope is HTTP 429.
  if (detail.includes('14018') || body.includes('14018') || isCreditsExhausted(detail) || isCreditsExhausted(body)) {
    return 'QUOTA';
  }
  // Context overflow must classify as CONTEXT_WINDOW_EXCEEDED so the official
  // compaction overflow-recovery listener fires instead of futile retries.
  // Checked before status mapping: pool/gateway wrappers bury the upstream
  // overflow detail inside a 503 envelope.
  if (isContextOverflow(body, detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) return 'INVALID_REQUEST';
  if (status >= 500) return 'SERVER';
  return `HTTP_${status}`;
}

/**
 * Detect the international pool's "credits exhausted" signal.
 * codebuddy.ai returns code 14018 ("Credits exhausted") — sometimes wrapped in
 * an `error.data` envelope, sometimes as flat fields — so match on the code and
 * the message text rather than trusting one shape.
 */
export function isCreditsExhausted(error: unknown): boolean {
  const message = errorMessage(error);
  if (message.includes('14018')) return true;
  if (/credits?\s+exhausted/i.test(message)) return true;
  if (/insufficient/i.test(message) && /credit/i.test(message)) return true;
  return false;
}

type Reader = ReadableStreamDefaultReader<Uint8Array>;

/** Bounded SSE read: rejects after ms of silence and cancels the reader. */
async function readWithTimeout(reader: Reader, ms: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`SSE timeout after ${ms}ms`)), ms);
      }),
    ]);
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // ignore cancel errors
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class XuedinerApiAdapter extends LlmAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  /** Bridge to the attachment service, used to inline images as data URLs. */
  private readonly readImage?: ReadImage;
  private codeartsIndex = 0;
  /** Rotation cursor for the "Free" virtual model. */
  private freeIndex = 0;
  /**
   * Recently failed free targets with a cooldown deadline (epoch ms).
   * Without this, every request would re-walk the same dead upstreams and pay
   * their timeouts again (observed: a 9s delay when Groq+Zhipu were down).
   */
  private freeCooldown = new Map<string, number>();
  /** How long a failed free target is skipped before retrying it. */
  private readonly freeCooldownMs = 60_000;
  /** Live OpenRouter free catalog; empty until first successful fetch. */
  private openRouterFree: readonly import('./openrouter.js').OpenRouterModel[] = [];
  private openRouterLoaded = false;
  /** Live 9Router catalog; empty until first successful fetch (or on failure). */
  private nineRouterModels: readonly NineRouterModel[] = [];
  private nineRouterLoaded = false;
  /** Rotation cursor for the dedicated 9Router entry (independent of Free). */
  private nineRouterIndex = 0;
  /** Recently failed 9Router targets with a cooldown deadline (epoch ms). */
  private nineRouterCooldown = new Map<string, number>();
  /** Live zcode-proxy catalog; empty until first successful fetch (or on failure). */
  private zcodeModels: readonly ZcodeModel[] = [];
  private zcodeLoaded = false;
  /** Cooldown deadlines for the two glm-5.3-flash sources (epoch ms). */
  private glmFlashCooldown = new Map<string, number>();
  /** Codex pool rotation cursor. */
  private codexIndex = 0;
  /** Recently failed Codex accounts with a cooldown deadline (epoch ms). */
  private codexCooldown = new Map<string, number>();
  /** Account the last successful Codex call used (session stickiness). */
  private codexSticky: string | undefined;

  /** Load the OpenRouter free catalog once; safe to call repeatedly. */
  private async ensureOpenRouterCatalog(): Promise<void> {
    if (this.openRouterLoaded) return;
    this.openRouterLoaded = true;
    const models = await fetchOpenRouterFreeModels(this.fetchImpl);
    if (models.length > 0) this.openRouterFree = models;
  }

  /**
   * Load the 9Router catalog once; safe to call repeatedly.
   *
   * A stopped or unconfigured 9Router yields an empty catalog, which only means
   * its models stay out of the picker — every other upstream keeps working.
   */
  private async ensureNineRouterCatalog(): Promise<void> {
    if (this.nineRouterLoaded) return;
    this.nineRouterLoaded = true;
    const models = await fetchNineRouterModels(resolveNineRouterConfig(), this.fetchImpl);
    if (models.length > 0) this.nineRouterModels = models;
  }

  /**
   * Load the zcode-proxy catalog once; safe to call repeatedly.
   *
   * A stopped proxy yields an empty catalog, which only means its models stay
   * out of the picker — every other upstream keeps working.
   */
  private async ensureZcodeCatalog(): Promise<void> {
    if (this.zcodeLoaded) return;
    this.zcodeLoaded = true;
    const models = await fetchZcodeModels(resolveZcodeConfig(), this.fetchImpl);
    if (models.length > 0) this.zcodeModels = models;
  }

  constructor(
    options: {
      baseUrl?: string;
      apiKey?: string;
      fetchImpl?: typeof fetch;
      /** Bridge to ctx.attachments.readImage; required for image input. */
      readImage?: ReadImage;
    } = {},
  ) {
    super();
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKey = options.apiKey ?? DEFAULT_API_KEY;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readImage = options.readImage;
  }

  /**
   * Resolve every image referenced by the messages into a data URL.
   * Returns undefined when there are no images; throws UNSUPPORTED_CONTENT when
   * images are present but cannot be read (never silently drops them).
   */
  private async resolveImageUrls(messages: readonly Message[]): Promise<Map<string, string> | undefined> {
    const refs = collectImageRefs(messages);
    if (refs.size === 0) return undefined;
    if (this.readImage === undefined) {
      throw new LlmError(
        'xuedinerAPI: 图片输入需要附件服务（attachments），当前不可用。',
        'UNSUPPORTED_CONTENT',
      );
    }
    const urls = new Map<string, string>();
    for (const [id, ref] of refs) {
      const image = await this.readImage(ref);
      if (image === undefined) continue;
      urls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`);
    }
    if (urls.size === 0) {
      throw new LlmError('xuedinerAPI: 无法读取图片内容。', 'UNSUPPORTED_CONTENT');
    }
    return urls;
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : PROVIDER;
    return { id, name: 'xuedinerAPI' };
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ensureOpenRouterCatalog();
    await this.ensureNineRouterCatalog();
    await this.ensureZcodeCatalog();
    // Qoder is direct, so its availability depends on a resolvable credential
    // rather than on 9Router being up.
    const qoderCredentialAvailable = (await resolveQoderCredential()) !== undefined;
    const commandCodeCredentialAvailable = resolveCommandCodeKey() !== undefined;
    const native: LlmModelInfo[] = [
      {
        provider: PROVIDER,
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1',
        description: 'DeepSeek V4.1（1M 上下文；华为云多账号优先，腾讯号池兜底）',
        // Text only: the Huawei CodeArts upstream rejects images outright
        // ("The request model is not multimodal"), and CodeArts is this route's
        // primary target. Declaring image input would promise what the
        // primary upstream cannot deliver.
        inputModalities: ['text'],
      },
      {
        provider: PROVIDER,
        id: 'hy4-preview',
        name: 'Hy4 Preview',
        description: 'Hunyuan 4 Preview（1M 上下文；腾讯多账号池）',
        // Text only: this route goes through the Tencent gateway, whose image
        // handling has not been verified for Hy4.
        inputModalities: ['text'],
      },
      {
        provider: PROVIDER,
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        description: 'Claude Opus 5（腾讯国际版直连 https://www.codebuddy.ai）',
        inputModalities: ['text', 'image'],
      },
      {
        provider: PROVIDER,
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        description: 'GPT-6 Astra（国际池优先，Codex 号池兜底，多供应商自动轮询）',
        inputModalities: ['text', 'image'],
      },
      {
        provider: PROVIDER,
        id: 'gpt-6-sol',
        name: 'GPT-6 Sol',
        description: 'GPT-6 Sol（ChatGPT 订阅号池；多账号自动轮询）',
        inputModalities: ['text', 'image'],
      },
      {
        provider: PROVIDER,
        id: GLM_FLASH_MODEL_ID,
        name: 'GLM-5.3-Flash',
        description: 'GLM-5.3-Flash（1M 上下文；ZCode 订阅优先，号池兜底，单个失败自动切换）',
        // Text only: this route goes through the local pool gateway, whose
        // image handling for GLM has not been verified.
        inputModalities: ['text'],
      },
      {
        provider: PROVIDER,
        id: 'Free',
        name: 'Free',
        description:
          `免费号池自动轮询（${this.freeTargets().length} 条上游：OpenRouter / Groq / 智谱 / LLM7；`
          + '单个失败自动切换下一个）',
        // Only text is claimed: the rotating pool mixes text-only upstreams,
        // so declaring image input would over-promise for some rotation targets.
        inputModalities: ['text'],
      },
    ];

    // Xiaomi MiMo was removed on 2026-09-22 at the user's request (both the
    // picker entries and the pool-panel quota block). Its module is kept in the
    // tree but is no longer imported, so nothing here can advertise it.

    // Qoder's Qwen models, connected DIRECTLY (COSY-signed, no 9Router in the
    // path) so they stay available whenever the DSH host runs. Advertised only
    // when a credential resolves, so a logged-out state leaves no dead entry.
    const qoderModels: LlmModelInfo[] =
      qoderCredentialAvailable
        ? QODER_ENTRIES.map((e) => ({
            provider: PROVIDER,
            id: e.id,
            name: e.name,
            description: e.description,
            inputModalities: ['text', 'image'] as const,
          }))
        : [];

    // Command Code Go: a subscription plan behind its own `/alpha/generate`
    // protocol. Advertised only when a credential resolves, so a logged-out
    // state leaves no dead entry in the picker.
    const commandCodeModels: LlmModelInfo[] =
      commandCodeCredentialAvailable
        ? COMMANDCODE_MODELS.map((m) => ({
            provider: PROVIDER,
            id: `${COMMANDCODE_PREFIX}${m.id}`,
            name: m.name,
            description: m.description,
            inputModalities: m.supportsImage ? (['text', 'image'] as const) : (['text'] as const),
          }))
        : [];

    // Z.AI / BigModel coding-plan models, served through the LOCAL zcode-proxy
    // (TriDefender/zcode-api). The plan quota is not reachable via the public
    // API hosts — they answer `1113 Insufficient balance` even with the plan's
    // own key — so the client-shaped proxy is the only working path.
    //
    // The per-model `zcode/*` rows are no longer advertised (removed at the
    // user's request on 2026-09-21, see ZCODE_ADVERTISE_MODELS). The transport
    // stays wired up because the unified glm-5.3-flash entry still uses it as
    // its first-priority source, so this only affects the picker listing.
    const zcodeModels: LlmModelInfo[] =
      !ZCODE_ADVERTISE_MODELS || this.zcodeModels.length === 0
        ? []
        : this.zcodeModels
            // glm-5.3-flash is served by the unified entry below, which
            // rotates ZCode -> pool; listing it here would duplicate it.
            .filter((m) => !ZCODE_HIDDEN_UPSTREAMS.includes(m.id))
            .map((m) => ({
              provider: PROVIDER,
              id: `${ZCODE_PREFIX}${m.id}`,
              name: `${m.name} (ZCode)`,
              description: `ZCode 订阅（Z.AI 编码套餐经本机代理 ${m.id}）`,
              // The proxy fronts Z.AI's GLM family; images are only claimed when
              // the catalog actually reports vision for this exact model.
              inputModalities: m.supportsImage ? (['text', 'image'] as const) : (['text'] as const),
            }));

    // 9Router (local multi-provider gateway). Listed from its live catalog so a
    // reconfigured 9Router instance shows up without touching this file; a
    // stopped instance contributes nothing rather than a stale hard-coded list.
    // Only advertised when the catalog actually resolved, so an offline
    // 9Router never leaves a dead entry in the picker.
    const nineRouterModels: LlmModelInfo[] =
      this.nineRouterModels.length === 0
        ? []
        : [
            {
              provider: PROVIDER,
              id: NINE_ROUTER_AGGREGATE_ID,
              name: '9Router（自动轮询）',
              description:
                `9Router 独立号池自动轮询（${this.nineRouterModels.length} 个模型，`
                + '单个失败自动切换下一个；独立于 Free 免费池）',
              // Mixed upstreams behind one gateway, so image input is not claimed.
              inputModalities: ['text'],
            },
            // Qoder's models are reached directly, so their 9Router ids are
            // omitted here — otherwise one upstream would show up twice.
            ...this.nineRouterModels
              .filter((m) => !QODER_HIDDEN_UPSTREAMS.includes(m.id))
              .map((m) => ({
                provider: PROVIDER,
                id: `${NINE_ROUTER_PREFIX}${m.id}`,
                name: `${m.name} (9Router)`,
                description: `9Router 中转：${m.id}`,
                // Only claim images when 9Router reports vision for this exact
                // model; its catalog mixes text-only and multimodal upstreams.
                inputModalities: m.supportsImage ? (['text', 'image'] as const) : (['text'] as const),
              })),
          ];

    return [...native, ...qoderModels, ...commandCodeModels, ...zcodeModels, ...nineRouterModels];
  }

  /**
   * Ordered free-tier targets for the "Free" virtual model.
   * Fastest and most reliable first; each entry is tried in turn until one
   * produces output, so a single upstream failure never fails the request.
   */
  private freeTargets(): string[] {
    const out: string[] = [];
    // Verified-stable performers first: these produced real output in testing.
    out.push(`${GROQ_PREFIX}openai/gpt-oss-20b`);
    out.push(`${GROQ_PREFIX}qwen/qwen3.8-27b`);
    out.push(`${ZHIPU_PREFIX}glm-4-flash`);
    out.push(`${OPENROUTER_PREFIX}cohere/north-mini-code:free`);
    out.push(`${LLM7_PREFIX}default`);
    // Then the remaining Groq models.
    for (const m of GROQ_MODELS) {
      const id = `${GROQ_PREFIX}${m.id}`;
      if (!out.includes(id)) out.push(id);
    }
    // Then the remaining Zhipu models.
    for (const m of ZHIPU_MODELS) {
      const id = `${ZHIPU_PREFIX}${m.id}`;
      if (!out.includes(id)) out.push(id);
    }
    // Then the remaining OpenRouter free catalog (chat-capable only).
    const free = this.openRouterFree.length > 0 ? this.openRouterFree : FALLBACK_FREE_MODELS;
    for (const m of free) {
      if (!isChatCapableFreeModel(m.id)) continue;
      const id = `${OPENROUTER_PREFIX}${m.id}`;
      if (!out.includes(id)) out.push(id);
    }
    // LLM7 aliases last (smallest daily allowance).
    for (const alias of LLM7_ALIASES) {
      const id = `${LLM7_PREFIX}${alias}`;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // The merged free-tier model rotates across all free upstreams.
    if (model === FREE_MODEL_ID) {
      await this.ensureOpenRouterCatalog();
      return {
        provider: provider || PROVIDER,
        id: FREE_MODEL_ID,
        name: 'Free',
        description: `免费号池自动轮询（${this.freeTargets().length} 条上游，失败自动切换）`,
        inputModalities: ['text'],
        context: { contextWindow: 200_000 },
        defaultMaxTokens: 32_000,
      };
    }

    // Free-tier upstreams carry their own metadata.
    if (isOpenRouterModel(model)) {
      const free = this.openRouterFree.length > 0 ? this.openRouterFree : FALLBACK_FREE_MODELS;
      const upstream = openRouterUpstreamId(model);
      const meta = free.find((m) => m.id === upstream);
      return {
        provider: provider || PROVIDER,
        id: model,
        name: `[Free] ${meta?.name ?? upstream}`,
        description: `OpenRouter 免费档：${upstream}`,
        inputModalities: ['text'],
        context: { contextWindow: meta?.contextLength && meta.contextLength > 0 ? meta.contextLength : 128_000 },
        defaultMaxTokens: 32_000,
      };
    }
    if (isLlm7Model(model)) {
      const alias = model.slice(LLM7_PREFIX.length);
      return {
        provider: provider || PROVIDER,
        id: model,
        name: `[Free] LLM7 ${alias}`,
        description: `LLM7.io 免费档（别名 ${alias}）`,
        inputModalities: ['text'],
        context: { contextWindow: 256_000 },
        defaultMaxTokens: 32_000,
      };
    }
    if (isGroqModel(model)) {
      const upstream = model.slice(GROQ_PREFIX.length);
      const meta = GROQ_MODELS.find((m) => m.id === upstream);
      return {
        provider: provider || PROVIDER,
        id: model,
        name: `[Free] ${meta?.name ?? upstream}`,
        description: `Groq 免费档：${upstream}`,
        inputModalities: ['text'],
        context: { contextWindow: meta?.contextLength ?? 131_072 },
        defaultMaxTokens: 32_000,
      };
    }
    if (isZhipuModel(model)) {
      const upstream = model.slice(ZHIPU_PREFIX.length);
      const meta = ZHIPU_MODELS.find((m) => m.id === upstream);
      return {
        provider: provider || PROVIDER,
        id: model,
        name: `[Free] ${meta?.name ?? upstream}`,
        description: `智谱免费档：${upstream}`,
        inputModalities: ['text'],
        context: { contextWindow: meta?.contextLength ?? 131_072 },
        defaultMaxTokens: 32_000,
      };
    }

    // Qoder's Qwen models: first-class entries over the DIRECT Qoder transport.
    const qoderDirect = qoderDirectModel(model);
    if (qoderDirect !== undefined) {
      const entry = QODER_ENTRIES.find((e) => e.id === model);
      return {
        provider: provider || PROVIDER,
        id: model,
        name: entry?.name ?? model,
        description: entry?.description ?? 'Qoder 订阅直连',
        inputModalities: ['text', 'image'],
        // Set to 128K: Qoder's edge gateway has a hard ~60s first-token timeout, so
        // prompts > 100K-128K exceed TTFT and fail with "First Token Timeout or Upstream Timeout".
        context: { contextWindow: 128_000 },
        // Upstream hard cap measured on both 3.8 entries (2026-09-19):
        // max_tokens=32768 is accepted, 32769 is rejected in-band with
        // "<400> InternalError.Algo.InvalidParameter: Range of max_tokens
        // should be [1, 32768]". Declaring 65536 here made every request
        // exceed the real ceiling. Keep this at the measured maximum.
        defaultMaxTokens: 32_768,
        // Qoder's own UI exposes an effort selector on these models, and its
        // runtime forwards `parameters.reasoning_effort`
        // (none/low/medium/high/xhigh/max — verified in the client bundle).
        // Declare the same ladder and forward it in qoderStream.
        reasoning: {
          efforts: ['low', 'medium', 'high', 'xhigh'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
          defaultEffort: ReasoningEffortId('high'),
        },
      };
    }

    // Command Code Go: first-class entries over the `/alpha/generate` protocol.
    if (isCommandCodeModel(model)) {
      const hit = findCommandCodeModel(commandCodeUpstreamId(model));
      return {
        provider: provider || PROVIDER,
        id: model,
        name: hit.name,
        description: hit.description,
        inputModalities: hit.supportsImage ? ['text', 'image'] : ['text'],
        context: { contextWindow: hit.contextWindow },
        defaultMaxTokens: hit.maxTokens,
        // The plan accepts its own effort ladder (verified in dsh-subs-hub).
        reasoning: {
          efforts: hit.efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })),
          defaultEffort: ReasoningEffortId(hit.defaultEffort),
        },
      };
    }

    // GLM-5.3-Flash: unified entry rotating the Z.AI coding-plan quota
    // (zcode-proxy) with the local pool gateway. See glmFlashPoolStream.
    if (model === GLM_FLASH_MODEL_ID) {
      return {
        provider: provider || PROVIDER,
        id: GLM_FLASH_MODEL_ID,
        name: 'GLM-5.3-Flash',
        description: 'GLM-5.3-Flash（1M 上下文；ZCode 订阅优先，号池兜底，单个失败自动切换）',
        inputModalities: ['text'],
        context: { contextWindow: 1_000_000 },
        defaultMaxTokens: 32_000,
        // The pool reports reasoning tokens for this model, so expose the effort.
        reasoning: {
          efforts: [{ id: ReasoningEffortId('high'), name: 'high' }],
          defaultEffort: ReasoningEffortId('high'),
        },
      };
    }

    // Codex pool: ChatGPT-subscription account pool over the Responses API.
    // Clean canonical IDs ('gpt-6-sol', 'gpt-6-astra') as well as legacy 'GPT/*' IDs.
    if (model === 'gpt-6-sol' || model === `${CODEX_POOL_ID}/gpt-6-sol`) {
      return {
        provider: provider || PROVIDER,
        id: model,
        name: 'GPT-6 Sol',
        description: 'GPT-6 Sol（ChatGPT 订阅号池；多账号自动轮询）',
        inputModalities: ['text', 'image'],
        context: { contextWindow: 272_000 },
        defaultMaxTokens: 64_000,
        reasoning: {
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
          defaultEffort: ReasoningEffortId('medium'),
        },
      };
    }
    if (model.startsWith(`${CODEX_POOL_ID}/`)) {
      const explicit = model.slice(CODEX_POOL_ID.length + 1);
      const meta = CODEX_MODELS.find((m) => m.id === explicit);
      return {
        provider: provider || PROVIDER,
        id: model,
        name: meta ? meta.name : explicit,
        description: meta
          ? meta.description
          : `ChatGPT 订阅号池：${explicit}`,
        inputModalities: ['text', 'image'],
        context: { contextWindow: 272_000 },
        defaultMaxTokens: 32_000,
        // The Responses payload carries reasoning.effort and the CLI exposes
        // low..xhigh; declare exactly what is forwarded (nothing invented).
        reasoning: {
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
          defaultEffort: ReasoningEffortId('medium'),
        },
      };
    }

    // ZCode (local zcode-proxy -> Z.AI coding plan).
    if (isZcodeModel(model)) {
      await this.ensureZcodeCatalog();
      const upstream = zcodeUpstreamId(model);
      const meta = this.zcodeModels.find((m) => m.id === upstream);
      return {
        provider: provider || PROVIDER,
        id: model,
        name: meta ? `${meta.name} (ZCode)` : upstream,
        description: `ZCode 订阅（Z.AI 编码套餐经本机代理）：${upstream}`,
        inputModalities: meta?.supportsImage ? ['text', 'image'] : ['text'],
        // GLM-5.3 family is 1M-context upstream; fall back to the documented
        // window when the catalog omits it.
        context: { contextWindow: meta?.contextLength && meta.contextLength > 0 ? meta.contextLength : 1_000_000 },
        defaultMaxTokens: meta?.maxOutput && meta.maxOutput > 0 ? meta.maxOutput : 128_000,
        // reasoning_effort accepted live on this route (2026-09-20).
        reasoning: {
          efforts: ['low', 'medium', 'high', 'xhigh'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
          defaultEffort: ReasoningEffortId('high'),
        },
      };
    }

    // Dedicated 9Router rotation entry (its own pool, not part of "Free").
    if (model === NINE_ROUTER_AGGREGATE_ID) {
      await this.ensureNineRouterCatalog();
      return {
        provider: provider || PROVIDER,
        id: NINE_ROUTER_AGGREGATE_ID,
        name: '9Router（自动轮询）',
        description: `9Router 独立号池自动轮询（${this.nineRouterModels.length} 个模型，失败自动切换）`,
        inputModalities: ['text'],
        context: { contextWindow: 200_000 },
        defaultMaxTokens: 32_000,
      };
    }

    // 9Router models: metadata comes from its live catalog when available.
    if (isNineRouterModel(model)) {
      await this.ensureNineRouterCatalog();
      const upstream = nineRouterUpstreamId(model);
      const meta = this.nineRouterModels.find((m) => m.id === upstream);
      return {
        provider: provider || PROVIDER,
        id: model,
        name: `${meta?.name ?? upstream} (9Router)`,
        description: `9Router 中转：${upstream}`,
        inputModalities: meta?.supportsImage === true ? ['text', 'image'] : ['text'],
        context: { contextWindow: meta?.contextLength && meta.contextLength > 0 ? meta.contextLength : 128_000 },
        defaultMaxTokens: meta?.maxOutput && meta.maxOutput > 0 ? meta.maxOutput : 32_000,
      };
    }

    // Xiaomi MiMo was removed on 2026-09-22 at the user's request; its
    // resolveModel entry, dispatch route and stream implementation are gone.

    const name =
      model === 'hy4-preview'
        ? 'Hy4 Preview'
        : model === 'claude-opus-5'
          ? 'Claude Opus 5'
          : model === 'gpt-6-astra'
            ? 'GPT-6 Astra'
            : 'DeepSeek V4.1';
    const isHy4 = model === 'hy4-preview';
    // Image support is decided per upstream, not per model family:
    //  - 腾讯国际版 (Opus 5 / GPT-6) accepts images as data URLs.
    //  - 华为云 CodeArts (DeepSeek V4.1's primary target) rejects them with
    //    "The request model is not multimodal".
    const acceptsImages = model === 'claude-opus-5' || model === 'gpt-6-astra';
    const isIntl = acceptsImages;
    return {
      provider: provider || PROVIDER,
      id: model,
      name,
      description: `${name} via xuedinerAPI`,
      inputModalities: acceptsImages ? ['text', 'image'] : ['text'],
      // hy4-preview's real upstream cap is 100K prompt tokens — measured via
      // Tencent code 11115 "100001 tokens > 100000 maximum" (session-e456a8e9,
      // 2026-09-17). The previous 1M declaration let pressure grow 10x past
      // the real window before any threshold fired.
      context: { contextWindow: isHy4 ? 100_000 : 1_000_000 },
      defaultMaxTokens: isHy4 ? 64_000 : 128_000,
      // 只声明上游实际验证过的档位；不虚构。Intl (Opus 5 / Astra) forwards
      // reasoning_effort through the OpenAI-compatible surface, so it exposes
      // the full ladder; DeepSeek/Hy4 verified on high only.
      reasoning: isIntl
        ? {
            efforts: ['low', 'medium', 'high', 'xhigh'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
            defaultEffort: ReasoningEffortId('high'),
          }
        : {
            efforts: [{ id: ReasoningEffortId('high'), name: 'high' }],
            defaultEffort: ReasoningEffortId('high'),
          },
    };
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    logDebug(`prepareCall: provider=${provider}, model=${model}`);
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  /**
   * Hybrid dispatch with bounded timeouts and pre-output-only fallback.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    logDebug(`stream: model=${options.model}, messages=${options.messages?.length ?? 0}, tools=${options.tools?.length ?? 0}`);

    // Route 0a: the "Free" virtual model — round-robin across every free upstream.
    if (options.model === FREE_MODEL_ID) {
      yield* this.freePoolStream(options);
      return;
    }

    // Route 0b: explicit free-tier upstream selected by id prefix.
    if (isOpenRouterModel(options.model)) {
      yield* this.openRouterStream(options);
      return;
    }
    if (isLlm7Model(options.model)) {
      yield* this.llm7Stream(options);
      return;
    }
    if (isGroqModel(options.model)) {
      yield* this.groqStream(options);
      return;
    }
    if (isZhipuModel(options.model)) {
      yield* this.zhipuStream(options);
      return;
    }

    // Route 0b-1c: Command Code Go (subscription; own /alpha/generate protocol).
    if (isCommandCodeModel(options.model)) {
      yield* this.commandCodeStream(options);
      return;
    }

    // Route 0b-2: the dedicated 9Router rotation entry (its own pool).
    if (options.model === NINE_ROUTER_AGGREGATE_ID) {
      yield* this.nineRouterPoolStream(options);
      return;
    }

    // Route 0b-3: one explicit 9Router model, by id prefix.
    if (isNineRouterModel(options.model)) {
      yield* this.nineRouterStream(options);
      return;
    }

    // Route 0b-3b: ZCode (local zcode-proxy -> Z.AI coding plan).
    if (isZcodeModel(options.model)) {
      yield* this.zcodeStream(options);
      return;
    }

    // Route 0b-4: Qoder's Qwen models — direct COSY-signed connection.
    if (qoderDirectModel(options.model) !== undefined) {
      yield* this.qoderStream(options, qoderDirectModel(options.model) as string);
      return;
    }

    // Route 0b-5: GLM-5.3-Flash, served by two sources in priority order —
    // the Z.AI coding-plan quota (via zcode-proxy) first, then the local pool
    // gateway. Both speak the same upstream model id, so the picker keeps a
    // single entry and callers never choose a source.
    if (options.model === GLM_FLASH_MODEL_ID) {
      yield* this.glmFlashPoolStream(options);
      return;
    }

    // Route 0b-6: gpt-6-sol (Codex ChatGPT account pool)
    if (options.model === 'gpt-6-sol' || options.model === `${CODEX_POOL_ID}/gpt-6-sol`) {
      yield* this.codexPoolStream({ ...options, model: `${CODEX_POOL_ID}/gpt-6-sol` });
      return;
    }

    // Route 0b-6b: the Codex account pool (legacy GPT/* prefix).
    if (options.model.startsWith(`${CODEX_POOL_ID}/`)) {
      yield* this.codexPoolStream(options);
      return;
    }

    // Route 0c (Xiaomi MiMo) was removed on 2026-09-22 at the user's request.

    // Route 1: international pool (Claude Opus 5 / GPT-6) — direct to codebuddy.ai.
    // gpt-6-astra is a unified rotation (intl -> Codex), handled separately.
    if (options.model === 'gpt-6-astra') {
      yield* this.astraPoolStream(options);
      return;
    }
    if (isIntlModel(options.model)) {
      const accounts = loadIntlAccounts();
      // gpt-6-astra intermittently returns 500 rate_limit_exceeded from the
      // upstream provider (observed ~1 success in 4 attempts), so retry the
      // same account a few times before concluding the pool is unavailable.
      const attemptsPerAccount = 3;
      let lastError: unknown;
      let creditsExhausted = false;
      for (const account of accounts) {
        for (let attempt = 0; attempt < attemptsPerAccount; attempt++) {
          let emitted = false;
          try {
            options.signal?.throwIfAborted();
            const iter = await this.tryIntlStream(options, account);
            for await (const chunk of iter) {
              emitted = true;
              yield chunk;
            }
            return;
          } catch (error) {
            if (options.signal?.aborted) throw error;
            if (emitted) throw error;
            lastError = error;
            // Credits exhausted is terminal: retrying cannot help, so stop and
            // let the caller fall back to a pool that still has quota.
            // 14018 often arrives in a 429 envelope — do not treat it as rate-limit.
            const errCode = (error as { code?: string }).code;
            if (isCreditsExhausted(error) || errCode === 'QUOTA') {
              creditsExhausted = true;
              console.warn(
                `[xuedinerAPI] intl (${account.uid.slice(0, 8)}) credits exhausted; falling back to the Tencent pool`,
              );
              break;
            }
            const status = (error as { status?: number }).status;
            const retriable =
              (status === 500 || status === 502 || status === 503 || status === 504 || status === 429)
              && errCode !== 'QUOTA';
            if (!retriable) break;
            console.warn(
              `[xuedinerAPI] intl (${account.uid.slice(0, 8)}) attempt ${attempt + 1}/${attemptsPerAccount} failed, retrying:`,
              errorMessage(error),
            );
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
        if (creditsExhausted) break;
      }

      if (creditsExhausted) {
        // Be explicit: the requested model is unavailable and the answer comes
        // from a different one. Silently swapping models would mislead the user.
        const notice =
          `> ⚠️ 国际版额度已耗尽，**${options.model}** 暂时不可用。\n`
          + '> 已自动切换到腾讯号池（DeepSeek V4.1）继续回答。\n'
          + '> 充值入口：https://www.codebuddy.ai/profile/usage\n\n';
        yield* this.fallbackWithNotice(notice, { ...options, model: 'deepseek-v4.1-flash' });
        return;
      }

      throw new LlmError(
        `xuedinerAPI: no international account could serve ${options.model}: ${errorMessage(lastError)}`,
        'NO_UPSTREAM',
      );
    }

    // Route 2: DeepSeek -> 国际版 (codebuddy.ai) → 华为云 CodeArts → 腾讯 WorkBuddy 网关。
    const isDeepSeek = options.model.toLowerCase().includes('deepseek');

    // (1) International pool first. When its credits are exhausted it answers
    // 14018 and we fall through to CodeArts; the user asked for this order.
    if (isDeepSeek) {
      const intlAccounts = loadIntlAccounts();
      for (const account of intlAccounts) {
        let emitted = false;
        try {
          options.signal?.throwIfAborted();
          const iter = await this.tryIntlStream(options, account);
          for await (const chunk of iter) {
            emitted = true;
            yield chunk;
          }
          return;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (emitted) throw error;
          console.warn(
            `[xuedinerAPI] intl (${account.uid.slice(0, 8)}) cannot serve DeepSeek, falling through:`,
            errorMessage(error).slice(0, 110),
          );
        }
      }
    }

    // (2) Huawei Cloud CodeArts.
    const creds = isDeepSeek ? loadCodeArtsCredentials() : [];

    if (creds.length > 0) {
      const startIndex = this.codeartsIndex++ % creds.length;
      for (let i = 0; i < creds.length; i++) {
        const stored = creds[(startIndex + i) % creds.length];
        let emitted = false;
        try {
          options.signal?.throwIfAborted();
          const cred = await refreshCodeArtsCredential(stored);
          const iter = await this.tryCodeArtsStream(options, cred);
          for await (const chunk of iter) {
            emitted = true;
            yield chunk;
          }
          return;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (emitted) throw error;
          console.warn(
            `[xuedinerAPI] CodeArts (${stored.cred.access_key_id.slice(0, 8)}) failed before output, trying next:`,
            errorMessage(error),
          );
        }
      }
    }

    // (3) Qoder's DeepSeek-V4-Flash — direct COSY-signed connection.
    // Qoder serves the same upstream model (deepseek-v4-flash), so it joins this
    // chain rather than getting its own picker entry: a request for DeepSeek V4.1
    // may now be served by any pool that still has quota. Switching only happens
    // BEFORE any output, so two models' answers are never stitched together.
    if (isDeepSeek) {
      let emitted = false;
      try {
        options.signal?.throwIfAborted();
        const iter = this.qoderStream(options, QODER_MODEL_DEEPSEEK_FLASH);
        for await (const chunk of iter) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (emitted) throw error;
        console.warn(
          '[xuedinerAPI] Qoder DeepSeek cannot serve this request, falling through:',
          errorMessage(error).slice(0, 110),
        );
      }
    }

    // Final fallback: local WorkBuddy gateway (3-account pool).
    yield* this.workbuddyGatewayStream(options);
  }

  /**
   * LLM7 free-tier route (selector aliases).
   * A free-token key is required; concrete model ids return 402 on this tier.
   */
  private async *llm7Stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = resolveLlm7Key();
    if (!apiKey) {
      throw new LlmError(
        'xuedinerAPI: LLM7 未配置。请把 LLM7_API_KEY 写入 ~/.dsh/.credentials.yaml。',
        'MISSING_CREDENTIAL',
      );
    }

    const alias = options.model.slice(LLM7_PREFIX.length);
    const messages = serializeMessages(options.messages);
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system });
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    let response: Response;
    try {
      response = await llm7Chat(
        apiKey,
        {
          model: alias,
          messages,
          ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        this.fetchImpl,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LlmError(`xuedinerAPI: LLM7 transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const error = new LlmError(`xuedinerAPI: LLM7 ${errorDetail(errText)}`, httpErrorCode(response.status, errText), {
        status: response.status,
      });
      (error as { status?: number }).status = response.status;
      throw error;
    }

    yield* this.consumeSse(response, options);
  }

  /** Groq free-tier route (1000 requests/day per model). */
  private async *groqStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = resolveGroqKey();
    if (!apiKey) {
      throw new LlmError(
        'xuedinerAPI: Groq 未配置。请把 GROQ_API_KEY 写入 ~/.dsh/.credentials.yaml。',
        'MISSING_CREDENTIAL',
      );
    }

    const upstream = options.model.slice(GROQ_PREFIX.length);
    const messages = serializeMessages(options.messages);
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system });
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    let response: Response;
    try {
      response = await groqChat(
        apiKey,
        {
          model: upstream,
          messages,
          ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        this.fetchImpl,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LlmError(`xuedinerAPI: Groq transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let payload: { error?: { message?: string } } = {};
      try {
        payload = JSON.parse(errText);
      } catch {
        // keep raw text
      }
      const resetsIn = /try again in ([\d.]+)s/i.exec(payload.error?.message ?? '');
      const error = new LlmError(
        `xuedinerAPI: Groq ${payload.error?.message ?? errorDetail(errText)}`,
        httpErrorCode(response.status, errText),
        {
          status: response.status,
          ...(resetsIn ? { providerRetryAfterMs: Math.ceil(Number.parseFloat(resetsIn[1]) * 1000) } : {}),
        },
      );
      (error as { status?: number }).status = response.status;
      throw error;
    }

    yield* this.consumeSse(response, options);
  }

  /** Zhipu free-tier route (Flash family; congestion returns retryable 429). */
  private async *zhipuStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = resolveZhipuKey();
    if (!apiKey) {
      throw new LlmError(
        'xuedinerAPI: 智谱未配置。请把 ZHIPU_API_KEY 写入 ~/.dsh/.credentials.yaml。',
        'MISSING_CREDENTIAL',
      );
    }

    const upstream = options.model.slice(ZHIPU_PREFIX.length);
    const messages = serializeMessages(options.messages);
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system });
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    let response: Response;
    try {
      response = await zhipuChat(
        apiKey,
        {
          model: upstream,
          messages,
          ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        this.fetchImpl,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LlmError(`xuedinerAPI: 智谱 transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let detail = errorDetail(errText);
      // Zhipu reports business errors inside a 429 envelope; surface the message.
      try {
        const parsed = JSON.parse(errText) as { error?: { message?: string; code?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // keep raw text
      }
      const error = new LlmError(`xuedinerAPI: 智谱 ${detail}`, httpErrorCode(response.status, errText), {
        status: response.status,
      });
      (error as { status?: number }).status = response.status;
      throw error;
    }

    yield* this.consumeSse(response, options);
  }

  /**
   * Command Code Go route.
   *
   * Not OpenAI-shaped: messages go out in CommandCode's own parts format and
   * the response is a custom event stream, so this route converts both ways.
   * The transport lives in commandcode.ts.
   */
  private async *commandCodeStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = resolveCommandCodeKey();
    if (!apiKey) {
      throw new LlmError(
        'xuedinerAPI: Command Code Go 未登录。请先执行 `commandcode` CLI 登录，'
        + '或把 COMMANDCODE_API_KEY 写入环境变量 / ~/.dsh/.credentials.yaml。',
        'MISSING_CREDENTIAL',
      );
    }

    const upstream = findCommandCodeModel(commandCodeUpstreamId(options.model));
    const imageUrls = await this.resolveImageUrls(options.messages);
    const { messages, toolNames } = commandCodeMessages(options.messages, imageUrls);
    const tools: CommandCodeTool[] | undefined = options.tools?.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      input_schema: (tool.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    }));

    logDebug(`commandCodeStream: model=${upstream.id} (ui=${options.model}) messages=${messages.length}`);

    let response: Response;
    try {
      response = await commandCodeChat(
        apiKey,
        {
          model: upstream.id,
          messages,
          system: options.system ?? '',
          ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
          threadId: randomUUID(),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        this.fetchImpl,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LlmError(`xuedinerAPI: Command Code Go transport error: ${errorMessage(error)}`, 'TRANSPORT', {
        cause: error,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const error = new LlmError(
        `xuedinerAPI: Command Code Go ${errorDetail(errText)}`,
        response.status === 401 || response.status === 403
          ? 'INVALID_CREDENTIAL'
          : httpErrorCode(response.status, errText),
        { status: response.status },
      );
      (error as { status?: number }).status = response.status;
      throw error;
    }

    yield* this.consumeCommandCodeSse(response, toolNames);
  }

  /**
   * Consume CommandCode's own SSE event stream and translate it into harness
   * chunks.
   *
   * Events handled (observed shape): `text-delta`, `reasoning-delta`,
   * `tool-input-start`, `tool-input-delta`, `tool-call`, `finish-step`
   * (usage), `finish` (stop reason). Tool-call blocks are opened lazily and
   * closed exactly once; a call whose deltas never arrived is still closed
   * from the final `tool-call` event, and anything still open at end-of-stream
   * is closed so the harness never sees a dangling block.
   */
  private async *consumeCommandCodeSse(
    response: Response,
    toolNames: Map<string, string>,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('xuedinerAPI: empty Command Code response body', 'EMPTY_RESPONSE');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstTokenReceived = false;
    let textIndex = -1;
    let text = '';
    let reasoningIndex = -1;
    let reasoning = '';
    let nextIndex = 0;
    let finishReason: string | undefined;
    let sawToolCall = false;
    const openBlocks = new Map<string, { index: number; name: string; args: string }>();
    const closed = new Set<string>();

    const alloc = (id: string, name: string): { index: number; name: string; args: string } => {
      const known = openBlocks.get(id);
      if (known !== undefined) return known;
      const block = { index: nextIndex++, name, args: '' };
      openBlocks.set(id, block);
      return block;
    };

    try {
      for (;;) {
        const result = await readWithTimeout(
          reader,
          firstTokenReceived ? CHUNK_IDLE_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS,
        );
        if (result.done) break;
        firstTokenReceived = true;
        buffer += decoder.decode(result.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
          buffer = buffer.slice(newline + 1);
          if (line === '' || line.startsWith(':') || line.startsWith('event:')) continue;
          const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
          if (payload === '' || payload === '[DONE]') continue;
          let ev: {
            type?: string;
            text?: string;
            delta?: string;
            id?: string;
            toolName?: string;
            toolCallId?: string;
            input?: unknown;
            finishReason?: string;
            usage?: {
              inputTokens?: number;
              outputTokens?: number;
              cachedInputTokens?: number;
              reasoningTokens?: number;
            };
          };
          try {
            ev = JSON.parse(payload);
          } catch {
            continue;
          }

          if (ev.type === 'text-delta' && typeof ev.text === 'string') {
            if (textIndex === -1) {
              textIndex = nextIndex++;
              yield { type: 'block-start', index: textIndex, blockType: 'text' };
            }
            text += ev.text;
            yield { type: 'text-delta', index: textIndex, text: ev.text };
            continue;
          }

          if (ev.type === 'reasoning-delta' && typeof ev.text === 'string') {
            if (reasoningIndex === -1) {
              reasoningIndex = nextIndex++;
              yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' };
            }
            reasoning += ev.text;
            yield { type: 'reasoning-delta', index: reasoningIndex, text: ev.text };
            continue;
          }

          if (ev.type === 'tool-input-start') {
            const id = typeof ev.id === 'string' && ev.id.length > 0 ? ev.id : `call_${Date.now().toString(36)}`;
            const name = typeof ev.toolName === 'string' ? ev.toolName : (toolNames.get(id) ?? '');
            const block = alloc(id, name);
            sawToolCall = true;
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
            if (name.length > 0) {
              yield { type: 'tool-call-delta', index: block.index, id: ToolCallId(id), name, argumentsDelta: '' };
            }
            continue;
          }

          if (ev.type === 'tool-input-delta' && typeof ev.delta === 'string') {
            const id = typeof ev.id === 'string' ? ev.id : '';
            if (id === '') continue;
            const block = alloc(id, toolNames.get(id) ?? '');
            sawToolCall = true;
            block.args += ev.delta;
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(id),
              ...(block.name.length > 0 ? { name: block.name } : {}),
              argumentsDelta: ev.delta,
            };
            continue;
          }

          if (ev.type === 'tool-call') {
            const id = typeof ev.toolCallId === 'string' && ev.toolCallId.length > 0
              ? ev.toolCallId
              : `call_${Date.now().toString(36)}`;
            const name = typeof ev.toolName === 'string' ? ev.toolName : (toolNames.get(id) ?? '');
            const args = JSON.stringify(ev.input ?? {});
            const block = alloc(id, name);
            sawToolCall = true;
            // Only emit the deltas when this call never streamed its input.
            if (!closed.has(id) && block.args === '') {
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: ToolCallId(id),
                ...(name.length > 0 ? { name } : {}),
                argumentsDelta: args,
              };
            }
            if (!closed.has(id)) {
              closed.add(id);
              yield {
                type: 'block-end',
                index: block.index,
                block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args },
              };
            }
            continue;
          }

          if (ev.type === 'finish-step' && ev.usage !== undefined && typeof ev.usage === 'object') {
            const usage = ev.usage;
            const input = Number(usage.inputTokens ?? 0);
            const cached = Number(usage.cachedInputTokens ?? 0);
            const reasoningTokens = Number(usage.reasoningTokens ?? 0);
            yield {
              type: 'usage',
              usage: {
                inputTokens: cached > 0 ? Math.max(0, input - cached) : input,
                outputTokens: Number(usage.outputTokens ?? 0),
                ...(cached > 0 ? { cacheReadTokens: cached } : {}),
                ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
              },
            };
            continue;
          }

          if (ev.type === 'finish') {
            finishReason = ev.finishReason;
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (textIndex !== -1) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text } };
    }
    if (reasoningIndex !== -1 && reasoning !== '') {
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } };
    }
    for (const [id, block] of openBlocks) {
      if (closed.has(id)) continue;
      closed.add(id);
      yield {
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: ToolCallId(id),
          name: block.name,
          arguments: normalizeToolArguments(block.args),
        },
      };
    }

    const reason =
      finishReason === 'length'
        ? ({ kind: 'max-tokens' } as const)
        : finishReason === 'tool-calls' || finishReason === 'tool_calls' || sawToolCall
          ? ({ kind: 'tool-calls' } as const)
          : ({ kind: 'stop' } as const);
    yield { type: 'finish', reason };
  }

  /**
   * 9Router route: one local multi-provider gateway speaking OpenAI SSE.
   *
   * No credential is strictly required — a loopback 9Router may run with auth
   * disabled — so a missing key is not an error here, unlike Groq/Zhipu. An
   * unreachable instance surfaces as TRANSPORT and the caller may fall back.
   */
  private async *nineRouterStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.nineRouterStreamFor(options, nineRouterUpstreamId(options.model));
  }

  /**
   * ZCode route: the local zcode-proxy, which bridges the Z.AI / BigModel
   * coding-plan quota (the public API hosts reject it with `1113`).
   *
   * The proxy speaks plain OpenAI SSE, so the shared consumer handles it. A
   * stopped proxy surfaces as TRANSPORT with an actionable message rather than
   * a bare connection error.
   */
  private async *zcodeStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const config = resolveZcodeConfig();
    const upstream = zcodeUpstreamId(options.model);

    const messages = serializeMessages(options.messages);
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system });
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    logDebug(`zcodeStream: ${config.baseUrl} model=${upstream} (ui=${options.model})`);
    let response: Response;
    try {
      response = await zcodeChat(
        config,
        {
          model: upstream,
          messages,
          ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        this.fetchImpl,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LlmError(
        `xuedinerAPI: ZCode 代理连接失败（${config.baseUrl}）：${errorMessage(error)}`
        + '。请确认 zcode-proxy 已启动（zcode-proxy serve）。',
        'TRANSPORT',
        { cause: error },
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let detail = errorDetail(errText);
      try {
        const parsed = JSON.parse(errText) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // keep raw text
      }
      const error = new LlmError(`xuedinerAPI: ZCode ${detail}`, httpErrorCode(response.status, errText), {
        status: response.status,
      });
      (error as { status?: number }).status = response.status;
      throw error;
    }

    yield* this.consumeSse(response, options);
  }

  /**
   * Qoder route: direct COSY-signed connection, no 9Router in the path.
   *
   * Qoder wraps each SSE event as `{headers, body, statusCode}` where `body` is
   * a JSON string, so events are unwrapped before being fed to the shared SSE
   * consumer. The credential is resolved per call so a re-login is picked up
   * without restarting DSH.
   */
  private async *qoderStream(
    options: GenerateOptions,
    upstream: string,
  ): AsyncIterable<StreamChunk> {
    const cred = await resolveQoderCredential();
    if (cred === undefined) {
      throw new LlmError(
        'xuedinerAPI: Qoder 未登录。请在 9Router 面板完成 Qoder 授权，'
        + '或把 QODER_ACCESS_TOKEN / QODER_USER_ID 写入 ~/.dsh/.credentials.yaml。',
        'MISSING_CREDENTIAL',
      );
    }

    const rawMessages = serializeMessages(options.messages, await this.resolveImageUrls(options.messages));
    if (options.system !== undefined && options.system.length > 0) {
      rawMessages.unshift({ role: 'system', content: options.system });
    }
    const messages = pruneMessagesForQoder(rawMessages);
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    logDebug(`qoderStream: model=${upstream} (ui=${options.model}) user=${cred.userId.slice(0, 8)}`);
    const primary = selectOrigin(cred.accessToken);
    const fallback = primary === QODER_ORIGIN ? QODER_JOB_ORIGIN : QODER_ORIGIN;
    const origins = [primary, fallback];

    let response: Response | undefined;
    let lastError: unknown;

    for (const origin of origins) {
      try {
        response = await qoderChat(
          cred,
          {
            model: upstream,
            messages,
            ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          },
          this.fetchImpl,
          origin,
        );
        // If this origin returned 405 (WAF block), 429 (rate limit), or 5xx, fail over to the secondary origin
        if (
          (response.status === 405 || response.status === 429 || response.status >= 500) &&
          origin !== origins[origins.length - 1]
        ) {
          logDebug(`qoderStream: origin ${origin} returned ${response.status}, failing over to ${origins[1]}`);
          continue;
        }
        break;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        lastError = error;
        logDebug(`qoderStream: origin ${origin} connect failed (${errorMessage(error)}), trying next origin`);
      }
    }

    if (response === undefined) {
      throw new LlmError(`xuedinerAPI: Qoder transport error: ${errorMessage(lastError)}`, 'TRANSPORT', {
        cause: lastError,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const error = new LlmError(
        `xuedinerAPI: Qoder ${errorDetail(errText)}`,
        httpErrorCode(response.status, errText),
        { status: response.status },
      );
      (error as { status?: number }).status = response.status;
      throw error;
    }

    yield* this.consumeQoderSse(response, options);
  }

  /**
   * Consume Qoder's wrapped SSE into StreamChunks.
   *
   * Separate from {@link consumeSse} because Qoder nests the OpenAI-shaped chunk
   * inside an envelope string; an in-band error (HTTP 200 + error body) is also
   * common here and must surface as a typed error rather than an empty answer.
   */
  private async *consumeQoderSse(
    response: Response,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('xuedinerAPI: empty Qoder response body', 'EMPTY_RESPONSE');

    const blocks: Array<{ index: number; kind: 'text' | 'reasoning'; text: string }> = [];
    const toolCalls = new Map<number, { index: number; text: string; callId: string; name?: string }>();
    const toolOrder: number[] = [];
    const toolIds = new Map<number, string>();
    let nextIndex = 0;
    let buffer = '';
    let firstTokenReceived = false;
    let finishReason: string | undefined;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const result = await readWithTimeout(
          reader,
          firstTokenReceived ? CHUNK_IDLE_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS,
        );
        if (result.done) break;
        firstTokenReceived = true;
        buffer += decoder.decode(result.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' ) continue;
          const event = unwrapQoderEvent(payload) as
            | {
                error?: { message?: string };
                code?: string | number;
                message?: string;
                choices?: Array<{
                  finish_reason?: string;
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                }>;
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  completion_tokens_details?: { reasoning_tokens?: number };
                };
              }
            | undefined;
          if (event === undefined) continue;

          // Qoder reports business failures inside a 200 SSE stream.
          if (event.error !== undefined || (event.code !== undefined && event.choices === undefined)) {
            const message = event.error?.message ?? event.message ?? String(event.code);
            throw new LlmError(`xuedinerAPI: Qoder ${message}`, 'SERVER');
          }

          const choice = event.choices?.[0];
          const delta = choice?.delta;
          if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
          if (delta?.content) {
            let block = blocks.find((c) => c.kind === 'text');
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'text', text: '' };
              blocks.push(block);
              yield { type: 'block-start', index: block.index, blockType: 'text' };
            }
            block.text += delta.content;
            yield { type: 'text-delta', index: block.index, text: delta.content };
          }
          if (delta?.reasoning_content) {
            let block = blocks.find((c) => c.kind === 'reasoning');
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'reasoning', text: '' };
              blocks.push(block);
              yield { type: 'block-start', index: block.index, blockType: 'reasoning' };
            }
            block.text += delta.reasoning_content;
            yield { type: 'reasoning-delta', index: block.index, text: delta.reasoning_content };
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0;
            if (typeof call.id === 'string' && call.id.length > 0) toolIds.set(wireIndex, call.id);
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`;
            let block = toolCalls.get(wireIndex);
            if (block === undefined) {
              block = { index: nextIndex++, text: '', callId };
              toolCalls.set(wireIndex, block);
              toolOrder.push(block.index);
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
            }
            block.callId = callId;
            if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
              block.name = call.function.name;
            }
            const fragment = call.function?.arguments ?? '';
            block.text += fragment;
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(callId),
              ...(block.name !== undefined ? { name: block.name } : {}),
              argumentsDelta: fragment,
            };
          }
          if (event.usage) {
            const reasoningTokens = event.usage.completion_tokens_details?.reasoning_tokens;
            yield {
              type: 'usage',
              usage: {
                inputTokens: event.usage.prompt_tokens ?? 0,
                outputTokens: event.usage.completion_tokens ?? 0,
                ...(reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {}),
              },
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find((c) => c.index === index);
      if (!block) continue;
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(block.callId ?? ''),
          name: block.name ?? '',
          arguments: normalizeToolArguments(block.text),
        },
      };
    }
    const textBlock = blocks.find((b) => b.kind === 'text');
    if (textBlock !== undefined) {
      yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } };
    }
    const reasoningBlock = blocks.find((b) => b.kind === 'reasoning');
    if (reasoningBlock !== undefined && reasoningBlock.text !== '') {
      yield {
        type: 'block-end',
        index: reasoningBlock.index,
        block: { type: 'reasoning', text: reasoningBlock.text },
      };
    }
    const reason =
      finishReason === 'length'
        ? ({ kind: 'max-tokens' } as const)
        : finishReason === 'tool_calls' || toolOrder.length > 0
          ? ({ kind: 'tool-calls' } as const)
          : ({ kind: 'stop' } as const);
    yield { type: 'finish', reason };
  }

  /**
   * Stream one 9Router upstream model, given the upstream id explicitly.
   *
   * Split out so first-class picker entries (Qoder's Qwen models) can reuse the
   * transport while sending their own upstream id instead of the `9r/`-stripped
   * picker id.
   */
  private async *nineRouterStreamFor(
    options: GenerateOptions,
    upstream: string,
  ): AsyncIterable<StreamChunk> {
    const config = resolveNineRouterConfig();

    const messages = serializeMessages(options.messages);
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system });
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    logDebug(`nineRouterStream: ${config.baseUrl} model=${upstream} (ui=${options.model})`);
    let response: Response;
    try {
      response = await nineRouterChat(
        config,
        {
          model: upstream,
          messages,
          ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        this.fetchImpl,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LlmError(
        `xuedinerAPI: 9Router 连接失败（${config.baseUrl}）：${errorMessage(error)}`
        + '。请确认 9router 已启动。',
        'TRANSPORT',
        { cause: error },
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let detail = errorDetail(errText);
      try {
        const parsed = JSON.parse(errText) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // keep raw text
      }
      const error = new LlmError(`xuedinerAPI: 9Router ${detail}`, httpErrorCode(response.status, errText), {
        status: response.status,
      });
      (error as { status?: number }).status = response.status;
      throw error;
    }

    yield* this.consumeSse(response, options);
  }

  /**
   * Emit a notice, then stream a different model's answer after it.
   *
   * The notice occupies block 0; every block the fallback produces is shifted
   * up by one so the two never collide in the assembled message.
   */
  private async *fallbackWithNotice(
    notice: string,
    fallback: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    const NOTICE_INDEX = 0;
    const SHIFT = 1;

    yield { type: 'block-start', index: NOTICE_INDEX, blockType: 'text' };
    yield { type: 'text-delta', index: NOTICE_INDEX, text: notice };
    yield { type: 'block-end', index: NOTICE_INDEX, block: { type: 'text', text: notice } };

    for await (const chunk of this.stream(fallback)) {
      switch (chunk.type) {
        case 'block-start':
          yield { ...chunk, index: chunk.index + SHIFT };
          break;
        case 'text-delta':
        case 'reasoning-delta':
          yield { ...chunk, index: chunk.index + SHIFT };
          break;
        case 'tool-call-delta':
          yield { ...chunk, index: chunk.index + SHIFT };
          break;
        case 'block-end':
          yield { ...chunk, index: chunk.index + SHIFT };
          break;
        default:
          yield chunk;
      }
    }
  }

  /**
   * OpenRouter free-tier route.
   * Requires an API key from the harness credential store or the subscription
   * hub's OAuth login; without one we fail with an actionable message.
   */
  private async *openRouterStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = resolveOpenRouterKey();
    if (!apiKey) {
      throw new LlmError(
        'xuedinerAPI: OpenRouter 未登录。请在「设置 → 订阅中心」登录 OpenRouter，'
          + '或把 OPENROUTER_API_KEY 写入 ~/.dsh/.credentials.yaml。',
        'MISSING_CREDENTIAL',
      );
    }

    const upstreamId = openRouterUpstreamId(options.model);
    const messages = serializeMessages(options.messages);
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system });
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    let response: Response;
    try {
      response = await openRouterChat(
        apiKey,
        {
          model: upstreamId,
          messages,
          ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        this.fetchImpl,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LlmError(`xuedinerAPI: OpenRouter transport error: ${errorMessage(error)}`, 'TRANSPORT', {
        cause: error,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const error = new LlmError(
        `xuedinerAPI: OpenRouter ${errorDetail(errText)}`,
        httpErrorCode(response.status, errText),
        { status: response.status },
      );
      (error as { status?: number }).status = response.status;
      throw error;
    }

    yield* this.consumeSse(response, options);
  }

  /**
   * The "Free" virtual model: try each free upstream in rotation until one
   * produces output. Switching only happens BEFORE the first chunk is emitted,
   * so a failed attempt can never leave two models' answers stitched together.
   * The rotation cursor persists across calls so load spreads evenly.
   */
  private async *freePoolStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.ensureOpenRouterCatalog();
    const targets = this.freeTargets();
    if (targets.length === 0) {
      throw new LlmError('xuedinerAPI: 免费号池为空（无可用上游）', 'NO_UPSTREAM');
    }

    const failures: string[] = [];
    const now = Date.now();

    // Prefer targets outside their cooldown; only fall back to cooling targets
    // if every one of them is currently penalised.
    const fresh = targets.filter((t) => (this.freeCooldown.get(t) ?? 0) <= now);
    const ordered = fresh.length > 0 ? fresh : targets;
    // Rotate within the *filtered* list so the cursor indexes the list we use.
    const start = this.freeIndex++ % ordered.length;
    logDebug(`free pool: ${ordered.length}/${targets.length} candidates, start=${start}`);

    // Cap the walk: with dozens of free models, exhausting every candidate on a
    // bad day would stall the turn for minutes. Six distinct upstreams is enough
    // to bridge a normal outage while keeping worst-case latency bounded.
    const maxAttempts = Math.min(ordered.length, 10);

    for (let i = 0; i < maxAttempts; i++) {
      const target = ordered[(start + i) % ordered.length];
      const inner: GenerateOptions = { ...options, model: target };
      const label = target.replace(/^(or|groq|l7|zp)\//, '');
      // Buffer this attempt so an empty or failed response can be discarded
      // whole and retried on the next upstream without partial leakage.
      const buffered: StreamChunk[] = [];
      let sawOutput = false;
      let attemptError: unknown;

      try {
        options.signal?.throwIfAborted();
        for await (const chunk of this.stream(inner)) {
          buffered.push(chunk);
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
            sawOutput = true;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        attemptError = error;
      }

      // Success requires actual output; an "OK but empty" reply is a failure
      // worth retrying elsewhere (observed on several free providers).
      if (attemptError === undefined && sawOutput) {
        this.freeCooldown.delete(target);
        for (const chunk of buffered) yield chunk;
        return;
      }

      const reason = attemptError !== undefined ? errorMessage(attemptError) : '空响应（无内容输出）';
      failures.push(`${label}: ${reason.slice(0, 80)}`);
      this.freeCooldown.set(target, now + this.freeCooldownMs);
      logDebug(`free pool: ${target} unusable (${reason.slice(0, 60)}), trying next`);
    }

    throw new LlmError(
      `xuedinerAPI: 免费号池尝试 ${maxAttempts} 条上游均失败。`
        + `最近失败：${failures.slice(-3).join(' | ')}`,
      'NO_UPSTREAM',
    );
  }

  /**
   * The dedicated 9Router entry: rotate only across 9Router's own catalog.
   *
   * Kept separate from {@link freePoolStream} on purpose — 9Router fronts
   * subscription and paid upstreams, so mixing it into the free rotation would
   * misreport both cost and availability, and a stopped 9Router would add its
   * connection timeout to every Free request.
   *
   * Same reliability contract as the free pool: switching happens only BEFORE
   * the first chunk, so two models' answers are never stitched together.
   */
  private async *nineRouterPoolStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.ensureNineRouterCatalog();
    const config = resolveNineRouterConfig();
    const targets = this.nineRouterModels.map((m) => `${NINE_ROUTER_PREFIX}${m.id}`);
    if (targets.length === 0) {
      throw new LlmError(
        `xuedinerAPI: 9Router 号池为空（${config.baseUrl} 未返回任何模型）。`
          + '请确认 9router 已启动，或检查 NINE_ROUTER_API_KEY 是否正确。',
        'NO_UPSTREAM',
      );
    }

    const failures: string[] = [];
    const now = Date.now();
    const fresh = targets.filter((t) => (this.nineRouterCooldown.get(t) ?? 0) <= now);
    const ordered = fresh.length > 0 ? fresh : targets;
    const start = this.nineRouterIndex++ % ordered.length;
    logDebug(`9router pool: ${ordered.length}/${targets.length} candidates, start=${start}`);

    const maxAttempts = Math.min(ordered.length, 8);

    for (let i = 0; i < maxAttempts; i++) {
      const target = ordered[(start + i) % ordered.length];
      const label = target.slice(NINE_ROUTER_PREFIX.length);
      const buffered: StreamChunk[] = [];
      let sawOutput = false;
      let attemptError: unknown;

      try {
        options.signal?.throwIfAborted();
        for await (const chunk of this.stream({ ...options, model: target })) {
          buffered.push(chunk);
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
            sawOutput = true;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        attemptError = error;
      }

      if (attemptError === undefined && sawOutput) {
        this.nineRouterCooldown.delete(target);
        for (const chunk of buffered) yield chunk;
        return;
      }

      const reason = attemptError !== undefined ? errorMessage(attemptError) : '空响应（无内容输出）';
      failures.push(`${label}: ${reason.slice(0, 80)}`);
      this.nineRouterCooldown.set(target, now + this.freeCooldownMs);
      logDebug(`9router pool: ${target} unusable (${reason.slice(0, 60)}), trying next`);
    }

    throw new LlmError(
      `xuedinerAPI: 9Router 号池尝试 ${maxAttempts} 个模型均失败。`
        + `最近失败：${failures.slice(-3).join(' | ')}`,
      'NO_UPSTREAM',
    );
  }

  /**
   * GLM-5.3-Flash served by TWO sources, tried in a fixed priority order:
   *
   *   1. `zcode/glm-5.3-flash` — the local zcode-proxy, i.e. the Z.AI coding
   *      plan quota (subscription, already paid for).
   *   2. `glm-5.3-flash`       — the local workbuddy pool gateway (metered
   *      credits).
   *
   * The plan quota is consumed first because it is a sunk subscription cost,
   * while the pool spends finite credits. A source that fails is put on
   * cooldown so a broken/quota-exhausted source is not retried on every call.
   *
   * Switching happens only BEFORE the first chunk is emitted (each attempt is
   * buffered), so a failure can never stitch two sources' answers together.
   */
  private async *glmFlashPoolStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const now = Date.now();
    const sources: Array<{ key: string; model: string }> = [
      { key: 'zcode', model: `${ZCODE_PREFIX}${GLM_FLASH_MODEL_ID}` },
      { key: 'pool', model: GLM_FLASH_MODEL_ID },
    ];

    const fresh = sources.filter((s) => (this.glmFlashCooldown.get(s.key) ?? 0) <= now);
    // If every source is cooling down, still try them in priority order rather
    // than failing outright — a cooldown is a hint, not a hard block.
    const ordered = fresh.length > 0 ? fresh : sources;
    logDebug(`glm-flash: ${ordered.length}/${sources.length} sources available, order=${ordered.map((s) => s.key).join('>')}`);

    const failures: string[] = [];

    for (const source of ordered) {
      const buffered: StreamChunk[] = [];
      let sawOutput = false;
      let attemptError: unknown;

      try {
        options.signal?.throwIfAborted();
        const inner = source.key === 'zcode'
          ? this.zcodeStream({ ...options, model: source.model })
          : this.workbuddyGatewayStream({ ...options, model: source.model });
        for await (const chunk of inner) {
          buffered.push(chunk);
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
            sawOutput = true;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        attemptError = error;
      }

      // Success requires actual output; an "OK but empty" reply is a failure
      // worth trying on the other source.
      if (attemptError === undefined && sawOutput) {
        this.glmFlashCooldown.delete(source.key);
        logDebug(`glm-flash: served by ${source.key}`);
        for (const chunk of buffered) yield chunk;
        return;
      }

      const reason = attemptError !== undefined ? errorMessage(attemptError) : '空响应（无内容输出）';
      failures.push(`${source.key}: ${reason.slice(0, 90)}`);
      this.glmFlashCooldown.set(source.key, now + this.freeCooldownMs);
      logDebug(`glm-flash: ${source.key} unusable (${reason.slice(0, 70)}), trying next`);
    }

    throw new LlmError(
      `xuedinerAPI: GLM-5.3-Flash 两个来源均失败（ZCode 代理 → 号池）。`
        + `详情：${failures.join(' | ')}`,
      'NO_UPSTREAM',
    );
  }

  /**
   * The intl pool as a pure rotation source (no model-swapping fallback).
   *
   * Extracted from Route 1 so the unified gpt-6-astra entry can use the intl
   * accounts as its first source: every account gets bounded retries, and any
   * final failure (including credits exhausted) propagates to the caller, which
   * then tries the next source in its own chain. This differs from Route 1's
   * inline behavior, which degrades to deepseek-v4.1-flash with a notice.
   */
  private async *intlPoolStreamFor(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const accounts = loadIntlAccounts();
    if (accounts.length === 0) {
      throw new LlmError('xuedinerAPI: 国际池没有可用账号。', 'NO_UPSTREAM');
    }
    const attemptsPerAccount = 3;
    let lastError: unknown;
    for (const account of accounts) {
      for (let attempt = 0; attempt < attemptsPerAccount; attempt++) {
        let emitted = false;
        try {
          options.signal?.throwIfAborted();
          const iter = await this.tryIntlStream(options, account);
          for await (const chunk of iter) {
            emitted = true;
            yield chunk;
          }
          return;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (emitted) throw error;
          lastError = error;
          const errCode = (error as { code?: string }).code;
          // Credits exhausted is terminal for this account: no retry helps.
          if (isCreditsExhausted(error) || errCode === 'QUOTA') break;
          const status = (error as { status?: number }).status;
          const retriable =
            (status === 500 || status === 502 || status === 503 || status === 504 || status === 429)
            && errCode !== 'QUOTA';
          if (!retriable) break;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
    throw new LlmError(
      `xuedinerAPI: no international account could serve ${options.model}: ${errorMessage(lastError)}`,
      'NO_UPSTREAM',
    );
  }

  /**
   * The Codex account pool: rotate across every valid ChatGPT-subscription
   * account until one produces output.
   *
   * Rotation rules:
   *  - accounts with a failed (non-quota) error go on cooldown;
   *  - `usage_limit_reached` (429) also cools the account until its documented
   *    `resets_at`, so a spent window is not retried every call;
   *  - the last account that served a successful call is tried first (session
   *    stickiness), which keeps conversation cache locality on one account.
   *
   * Switching happens only BEFORE the first chunk (attempts are buffered), so
   * two accounts' answers are never stitched together.
   */
  private async *codexPoolStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const accounts = listCodexAccounts();
    if (accounts.length === 0) {
      throw new LlmError(
        'xuedinerAPI: Codex 号池为空（没有任何有效的 ChatGPT 登录）。'
        + '请先完成账号登录（~/.codex 或 ~/.codex-pool-b）。',
        'NO_UPSTREAM',
      );
    }

    const now = Date.now();
    const fresh = accounts.filter((a) => (this.codexCooldown.get(a.key) ?? 0) <= now);
    // Sticky-first: the account that last served a call keeps the conversation
    // cache warm; otherwise keep the documented order (a, then b).
    const ordered =
      fresh.length > 0
        ? [...fresh].sort((x, y) =>
            (x.key === this.codexSticky ? -1 : 0) - (y.key === this.codexSticky ? -1 : 0))
        : accounts;
    logDebug(`codex pool: ${ordered.length}/${accounts.length} accounts, sticky=${this.codexSticky ?? '(none)'}`);

    const failures: string[] = [];
    let maxResetsAt = 0;

    for (const acct of ordered) {
      const buffered: StreamChunk[] = [];
      let sawOutput = false;
      let attemptError: unknown;

      try {
        options.signal?.throwIfAborted();
        for await (const chunk of this.codexAccountStream(options, acct)) {
          buffered.push(chunk);
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
            sawOutput = true;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        attemptError = error;
      }

      if (attemptError === undefined && sawOutput) {
        this.codexCooldown.delete(acct.key);
        this.codexSticky = acct.key;
        logDebug(`codex pool: served by account ${acct.key}`);
        for (const chunk of buffered) yield chunk;
        return;
      }

      const reason = attemptError !== undefined ? errorMessage(attemptError) : '空响应（无内容输出）';
      failures.push(`${acct.key}: ${reason.slice(0, 90)}`);

      // Quota-window errors cool the account until the documented reset. The
      // reset epoch rides on the error object (quotaResetsAt) when the
      // upstream reported it; otherwise fall back to the generic cooldown.
      const quotaResetsAt = (attemptError as { quotaResetsAt?: number } | undefined)?.quotaResetsAt;
      const resetMatch = reason.match(/resets_at[":\s]+(\d{10,})/);
      const resetsAt = quotaResetsAt
        ?? (resetMatch ? Number(resetMatch[1]) * 1000 : now + this.freeCooldownMs);
      maxResetsAt = Math.max(maxResetsAt, resetsAt);
      this.codexCooldown.set(acct.key, resetsAt);
      logDebug(`codex pool: account ${acct.key} unusable (${reason.slice(0, 70)}), cooldown until ${new Date(resetsAt).toISOString()}`);
    }

    const waitMin = Math.max(0, Math.ceil((maxResetsAt - Date.now()) / 60_000));
    throw new LlmError(
      `xuedinerAPI: Codex 号池 ${ordered.length} 个账号均不可用。`
        + `最近失败：${failures.slice(-2).join(' | ')}`
        + (waitMin > 0 ? `（额度窗口约 ${waitMin} 分钟后重置）` : ''),
      'NO_UPSTREAM',
    );
  }

  /**
   * Unified `gpt-6-astra` entry: the Tencent intl pool first (its astra is a
   * different upstream with separate credits), then the Codex ChatGPT pool.
   *
   * The user asked for this order: the intl pool's credits are effectively the
   * cheap metered resource here, while the ChatGPT subscription windows are
   * the scarce 5h quota — so Codex is the fallback, not the primary.
   *
   * Same reliability contract as glmFlashPoolStream: attempts are buffered and
   * switching happens only before the first chunk.
   */
  private async *astraPoolStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const now = Date.now();
    const sources: Array<{ key: string; run: () => AsyncIterable<StreamChunk> }> = [
      {
        key: 'intl',
        run: () => this.intlPoolStreamFor(options),
      },
      {
        key: 'codex',
        run: () => this.codexPoolStream({ ...options, model: `${CODEX_POOL_ID}/gpt-6-astra` }),
      },
    ];

    const fresh = sources.filter((s) => (this.glmFlashCooldown.get(`astra-${s.key}`) ?? 0) <= now);
    const ordered = fresh.length > 0 ? fresh : sources;
    logDebug(`astra: ${ordered.length}/${sources.length} sources available, order=${ordered.map((s) => s.key).join('>')}`);

    const failures: string[] = [];

    for (const source of ordered) {
      const buffered: StreamChunk[] = [];
      let sawOutput = false;
      let attemptError: unknown;

      try {
        options.signal?.throwIfAborted();
        for await (const chunk of source.run()) {
          buffered.push(chunk);
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
            sawOutput = true;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        attemptError = error;
      }

      if (attemptError === undefined && sawOutput) {
        this.glmFlashCooldown.delete(`astra-${source.key}`);
        logDebug(`astra: served by ${source.key}`);
        for (const chunk of buffered) yield chunk;
        return;
      }

      const reason = attemptError !== undefined ? errorMessage(attemptError) : '空响应（无内容输出）';
      failures.push(`${source.key}: ${reason.slice(0, 90)}`);
      this.glmFlashCooldown.set(`astra-${source.key}`, now + this.freeCooldownMs);
      logDebug(`astra: ${source.key} unusable (${reason.slice(0, 70)}), trying next`);
    }

    throw new LlmError(
      `xuedinerAPI: gpt-6-astra 两个来源均失败（国际池 → Codex）。`
        + `详情：${failures.join(' | ')}`,
      'NO_UPSTREAM',
    );
  }

  /** Stream one Codex account: Responses-API request + dedicated SSE consumer. */
  private async *codexAccountStream(
    options: GenerateOptions,
    acct: CodexAccount,
  ): AsyncIterable<StreamChunk> {
    const messages = serializeMessages(options.messages);
    let system = options.system ?? '';
    if (system.length === 0) {
      const sys = messages.find((m) => m.role === 'system');
      if (sys) {
        system = typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content);
      }
    }
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    const upstreamModel = options.model.startsWith(`${CODEX_POOL_ID}/`)
      ? options.model.slice(CODEX_POOL_ID.length + 1)
      : options.model;
    logDebug(`codexAccountStream[${acct.key}]: model=${upstreamModel}`);
    let response: Response;
    try {
      response = await codexChat(
        acct,
        {
          model: upstreamModel,
          messages: nonSystem,
          ...(system.length > 0 ? { system } : {}),
          ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
          ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        this.fetchImpl,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LlmError(`xuedinerAPI: Codex transport error: ${errorMessage(error)}`, 'TRANSPORT', {
        cause: error,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      // Keep machine-readable quota metadata on the error: errorDetail() only
      // extracts human text, which would drop the `resets_at` epoch the pool
      // uses to cool the account until its window resets.
      let quotaResetsAt: number | undefined;
      try {
        const parsed = JSON.parse(errText) as { error?: { resets_at?: number; type?: string } };
        if (typeof parsed.error?.resets_at === 'number') quotaResetsAt = parsed.error.resets_at;
      } catch {
        // non-JSON error body
      }
      const err = new LlmError(
        `xuedinerAPI: Codex ${errorDetail(errText)}`,
        httpErrorCode(response.status, errText),
        { status: response.status },
      );
      (err as { quotaResetsAt?: number }).quotaResetsAt = quotaResetsAt;
      (err as { rawBody?: string }).rawBody = errText.slice(0, 2000);
      throw err;
    }

    yield* this.consumeCodexResponsesSse(response, options);
  }

  /**
   * Consume a Responses-API SSE stream into StreamChunks.
   *
   * Unlike chat-completions, the Responses stream is a series of typed events
   * (`response.output_text.delta`, reasoning deltas, function-call items, ...),
   * each on its own `data:` line carrying `{type, ...}` JSON.
   */
  private async *consumeCodexResponsesSse(
    response: Response,
    _options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('xuedinerAPI: empty Codex response body', 'EMPTY_RESPONSE');

    let textStarted = false;
    let reasoningIndex = -1;
    let nextReasoningIndex = 1;
    const toolCalls: Array<{ callId: string; name: string; args: string }> = [];
    let buffer = '';
    let firstTokenReceived = false;
    let finishReason: string | undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const result = await readWithTimeout(
          reader,
          firstTokenReceived ? CHUNK_IDLE_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS,
        );
        if (result.done) break;
        firstTokenReceived = true;
        buffer += decoder.decode(result.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          let ev: {
            type?: string;
            item?: { type?: string; call_id?: string; name?: string; id?: string };
            delta?: string;
            response?: { usage?: { input_tokens?: number; output_tokens?: number } };
            error?: { message?: string; code?: string };
            code?: string;
            message?: string;
          };
          try { ev = JSON.parse(payload); } catch { continue; }
          const type = ev.type ?? '';

          if (type === 'response.output_text.delta') {
            if (!textStarted) {
              textStarted = true;
              yield { type: 'block-start', index: 0, blockType: 'text' };
            }
            yield { type: 'text-delta', index: 0, text: ev.delta ?? '' };
            continue;
          }
          if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
            if (reasoningIndex === -1) {
              reasoningIndex = nextReasoningIndex++;
              yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' };
            }
            yield { type: 'reasoning-delta', index: reasoningIndex, text: ev.delta ?? '' };
            continue;
          }
          if (type === 'response.output_item.added' && ev.item?.type === 'function_call') {
            toolCalls.push({
              callId: String(ev.item.call_id ?? ev.item.id ?? ''),
              name: String(ev.item.name ?? ''),
              args: '',
            });
            continue;
          }
          if (type === 'response.function_call_arguments.delta') {
            const last = toolCalls.at(-1);
            if (last) last.args += ev.delta ?? '';
            continue;
          }
          if (type === 'response.failed' || type === 'error') {
            const msg = ev.error?.message ?? ev.message ?? ev.code ?? type;
            throw new LlmError(`xuedinerAPI: Codex ${msg}`, 'SERVER');
          }
          if (type === 'response.completed') {
            const usage = ev.response?.usage;
            if (usage) {
              yield {
                type: 'usage',
                usage: {
                  inputTokens: usage.input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                },
              };
            }
            finishReason = 'stop';
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    // Emit accumulated tool calls before finishing.
    for (const tc of toolCalls) {
      if (tc.callId.length === 0) continue;
      yield {
        type: 'tool-call-delta',
        index: 10 + toolCalls.indexOf(tc),
        id: ToolCallId(tc.callId),
        name: tc.name,
        argumentsDelta: tc.args,
      };
    }

    yield { type: 'finish', reason: toolCalls.length > 0 ? ({ kind: 'tool-calls' } as const) : ({ kind: 'stop' } as const) };
  }

  /** Call the international pool directly (Bearer access_token, codebuddy.ai). */
  private async tryIntlStream(
    options: GenerateOptions,
    account: import('./intl-direct.js').IntlAccount,
  ): Promise<AsyncIterable<StreamChunk>> {
    const messages = serializeMessages(options.messages);
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system });
    } else {
      // The intl pool rejects any request whose first message is not a system
      // prompt ("first message is not system prompt"), so guarantee one.
      messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    const response = await intlChat(
      account,
      {
        model: options.model,
        messages,
        ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: String(options.reasoningEffort) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      this.fetchImpl,
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const error = new LlmError(`xuedinerAPI intl: ${errorDetail(errText)}`, httpErrorCode(response.status, errText), {
        status: response.status,
      });
      // Carry the HTTP status so the caller can decide whether to retry.
      (error as { status?: number }).status = response.status;
      throw error;
    }
    return this.consumeSse(response, options);
  }

  /** POST with a hard header timeout so a half-open connection can never hang a call. */
  private async fetchWithHeaderTimeout(
    url: string,
    init: { method: string; headers: Record<string, string>; body: BodyInit },
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(
      () => controller.abort(new Error(`header timeout after ${HEADER_TIMEOUT_MS}ms`)),
      HEADER_TIMEOUT_MS,
    );
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Call Huawei Cloud CodeArts (HMAC-SHA256 signed, one 401-refresh-retry). */
  private async *tryCodeArtsStream(
    options: GenerateOptions,
    cred: CodeArtsCred,
  ): AsyncIterable<StreamChunk> {
    const send = async (active: CodeArtsCred): Promise<Response> => {
      const messages = serializeMessages(options.messages, await this.resolveImageUrls(options.messages));
      if (options.system !== undefined && options.system.length > 0) {
        messages.unshift({ role: 'system', content: options.system });
      }
      const tools = options.tools?.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));

      const bodyObj: Record<string, unknown> = {
        model: 'deepseek-v4-flash',
        messages,
        stream: true,
      };
      if (tools !== undefined && tools.length > 0) bodyObj.tools = tools;
      if (options.temperature !== undefined) bodyObj.temperature = options.temperature;
      if (options.maxTokens !== undefined) bodyObj.max_tokens = options.maxTokens;
      if (options.stop !== undefined && options.stop.length > 0) bodyObj.stop = options.stop;

      const bodyBytes = new TextEncoder().encode(JSON.stringify(bodyObj));
      const signed = await signRequestHuawei(
        active.access_key_id,
        active.secret_access_key,
        active.security_token,
        'POST',
        CODEARTS_API_URL,
        bodyBytes,
      );
      const headers: Record<string, string> = {};
      signed.forEach((v, k) => {
        headers[k] = v;
      });
      headers['Accept'] = 'text/event-stream';
      headers['content-type'] = 'application/json';
      const sess = (options.sessionId ? String(options.sessionId) : 'xuediner-sess').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
      headers['Session-Id'] = sess || 'xuediner0001';
      headers['Chat-Id'] = crypto.randomUUID().replace(/-/g, '');
      headers['lang'] = 'en';

      logDebug(`tryCodeArtsStream: dispatching to ${CODEARTS_API_URL} with model deepseek-v4-flash`);
      return this.fetchWithHeaderTimeout(
        CODEARTS_API_URL,
        { method: 'POST', headers, body: bodyBytes },
        options.signal,
      );
    };

    let response = await send(cred);
    logDebug(`tryCodeArtsStream: HTTP ${response.status}`);
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      // Token可能刚好过期：强制续期一次后重试（仅在输出前，安全）。
      const stored = loadCodeArtsCredentials().find((s) => s.cred.access_key_id === cred.access_key_id);
      if (stored) {
        const renewed = await refreshCodeArtsCredential(stored, true);
        if (renewed !== cred) response = await send(renewed);
      }
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw Object.assign(new Error(`CodeArts HTTP ${response.status}: ${errorDetail(errText)}`), {
        status: response.status,
      });
    }
    const rawStream = this.consumeSse(response, options);
    for await (const chunk of rawStream) {
      if (chunk.type === 'usage') {
        const inp = chunk.usage.inputTokens ?? 0;
        const out = chunk.usage.outputTokens ?? 0;
        const total = chunk.usage.totalTokens ?? (inp + out);
        recordCodeArtsUsage(cred.access_key_id, inp, out, total);
      }
      yield chunk;
    }
  }

  /** Local gateway path (OpenAI-compatible, Bearer api_key). */
  private async *workbuddyGatewayStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = serializeMessages(options.messages);
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system });
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    const gatewayModel = workbuddyUpstreamModel(options.model);
    const bodyObj: Record<string, unknown> = {
      model: gatewayModel,
      messages,
      stream: true,
    };
    if (tools !== undefined && tools.length > 0) bodyObj.tools = tools;
    if (options.temperature !== undefined) bodyObj.temperature = options.temperature;
    if (options.maxTokens !== undefined) bodyObj.max_tokens = options.maxTokens;
    if (options.stop !== undefined && options.stop.length > 0) bodyObj.stop = options.stop;
    if (options.reasoningEffort !== undefined) bodyObj.reasoning_effort = options.reasoningEffort;

    logDebug(
      `workbuddyGatewayStream: dispatching to ${this.baseUrl}/chat/completions with model ${gatewayModel} (ui=${options.model})`,
    );
    let response: Response;
    try {
      response = await this.fetchWithHeaderTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(bodyObj),
        },
        options.signal,
      );
      logDebug(`workbuddyGatewayStream: HTTP ${response.status}`);
    } catch (error) {
      logDebug(`workbuddyGatewayStream error: ${errorMessage(error)}`);
      if (options.signal?.aborted) throw error;
      throw new LlmError(`xuedinerAPI: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error });
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new LlmError(`xuedinerAPI: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), {
        status: response.status,
      });
    }

    yield* this.consumeSse(response, options);
  }

  /** Consume an OpenAI-style SSE response into StreamChunks with idle timeouts. */
  private async *consumeSse(response: Response, options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('xuedinerAPI: empty model response body', 'EMPTY_RESPONSE');
    const blocks: Array<{ index: number; kind: 'text' | 'reasoning'; text: string }> = [];
    const toolCalls = new Map<number, { index: number; text: string; callId: string; name?: string }>();
    const toolOrder: number[] = [];
    const toolIds = new Map<number, string>();
    let nextIndex = 0;
    let buffer = '';
    let streamEnded = false;
    let finishReason: string | undefined;
    let firstTokenReceived = false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        if (streamEnded) break;
        const result = await readWithTimeout(
          reader,
          firstTokenReceived ? CHUNK_IDLE_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS,
        );
        if (result.done) break;
        firstTokenReceived = true;
        buffer += decoder.decode(result.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            streamEnded = true;
            break;
          }
          let data: {
            error?: { message?: string };
            error_code?: string;
            error_msg?: string;
            choices?: Array<{
              finish_reason?: string;
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
              completion_tokens_details?: { reasoning_tokens?: number };
              prompt_cache_hit_tokens?: number;
            };
          };
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          // CodeArts 有时以 HTTP 200 + SSE 内嵌错误事件返回排队/限流。
          if (data.error_code !== undefined || data.error_msg !== undefined) {
            throw new Error(`CodeArts SSE error ${data.error_code ?? ''}: ${data.error_msg ?? ''}`);
          }
          if (data.error !== undefined) {
            const message = typeof data.error === 'object' && data.error !== null ? data.error.message : String(data.error);
            const detail = typeof data.error === 'object' && data.error !== null ? JSON.stringify(data.error) : String(data.error);
            // In-band SSE errors can also carry context overflow; classify so
            // the official compaction recovery path fires instead of SERVER retry.
            const code = isContextOverflow(detail, message ?? '') ? CONTEXT_WINDOW_EXCEEDED_CODE : 'SERVER';
            throw new LlmError(`xuedinerAPI: ${message ?? 'unknown error'}`, code);
          }
          const choice = data.choices?.[0];
          const delta = choice?.delta;
          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason;
          }
          if (delta?.content) {
            let block = blocks.find((candidate) => candidate.kind === 'text');
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'text', text: '' };
              blocks.push(block);
              yield { type: 'block-start', index: block.index, blockType: 'text' };
            }
            block.text += delta.content;
            yield { type: 'text-delta', index: block.index, text: delta.content };
          }
          if (delta?.reasoning_content) {
            let block = blocks.find((candidate) => candidate.kind === 'reasoning');
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'reasoning', text: '' };
              blocks.push(block);
              yield { type: 'block-start', index: block.index, blockType: 'reasoning' };
            }
            block.text += delta.reasoning_content;
            yield { type: 'reasoning-delta', index: block.index, text: delta.reasoning_content };
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0;
            if (typeof call.id === 'string' && call.id.length > 0) {
              toolIds.set(wireIndex, call.id);
            }
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`;
            let block = toolCalls.get(wireIndex);
            if (block === undefined) {
              block = { index: nextIndex++, text: '', callId };
              toolCalls.set(wireIndex, block);
              toolOrder.push(block.index);
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
            }
            block.callId = callId;
            if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
              block.name = call.function.name;
            }
            const fragment = call.function?.arguments ?? '';
            block.text += fragment;
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(callId),
              ...(block.name !== undefined ? { name: block.name } : {}),
              argumentsDelta: fragment,
            };
          }
          if (data.usage) {
            const promptTokens = data.usage.prompt_tokens ?? 0;
            const cachedTokens =
              data.usage.prompt_tokens_details?.cached_tokens ?? data.usage.prompt_cache_hit_tokens ?? 0;
            const cacheWriteTokens = data.usage.prompt_tokens_details?.cache_write_tokens;
            const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
            yield {
              type: 'usage',
              usage: {
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
                ...(cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
                ...(reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {}),
              },
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const textBlock = blocks.find((block) => block.kind === 'text');
    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find((candidate) => candidate.index === index);
      if (!block) continue;
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(block.callId ?? ''),
          name: block.name ?? '',
          arguments: normalizeToolArguments(block.text),
        },
      };
    }
    if (textBlock !== undefined) {
      yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } };
    }
    const reasoningBlock = blocks.find((block) => block.kind === 'reasoning');
    if (reasoningBlock !== undefined && reasoningBlock.text !== '') {
      yield {
        type: 'block-end',
        index: reasoningBlock.index,
        block: { type: 'reasoning', text: reasoningBlock.text },
      };
    }
    const reason =
      finishReason === 'length'
        ? ({ kind: 'max-tokens' } as const)
        : finishReason === 'tool_calls' || toolOrder.length > 0
          ? ({ kind: 'tool-calls' } as const)
          : ({ kind: 'stop' } as const);
    yield { type: 'finish', reason };
  }
}
