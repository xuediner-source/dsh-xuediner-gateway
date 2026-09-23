/**
 * Codex (ChatGPT subscription) upstream — direct Responses-API client.
 *
 * Talks to the same backend the Codex CLI itself uses
 * (`chatgpt.com/backend-api/codex/responses`, Responses wire format, OAuth
 * access token + account id). Verified 2026-09-20 with the local CLI's own
 * credentials: an unauthenticated probe gets 401, an authenticated probe with
 * an exhausted window gets 429 usage_limit_reached — both prove the transport
 * shape is right; the quota state is the only variable.
 *
 * Why direct instead of a proxy: unlike the Z.AI coding plan (which refuses
 * public endpoints entirely), the Codex backend accepts the OAuth token from
 * any client that presents it correctly. The CLI's `auth.json` holds everything
 * needed: access_token + account_id.
 *
 * MULTI-ACCOUNT POOL: each account lives in its own CODEX_HOME directory with
 * its own auth.json. Account A is the stock `~/.codex`; account B is
 * `~/.codex-pool-b` (logged in via `CODEX_HOME=... codex login`). The pool
 * rotates across every account with a valid (non-expired) token, cooling down
 * accounts that fail until their window resets.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Picker prefix for the virtual pooled entry. */
export const CODEX_POOL_ID = 'GPT';

/** Directory holding the stock Codex CLI login (account A). */
export const CODEX_HOME_A = path.join(os.homedir(), '.codex');
/** Directory for the second pool account (account B). */
export const CODEX_HOME_B = path.join(os.homedir(), '.codex-pool-b');

/** Responses-API endpoint (what the Codex CLI itself posts to). */
export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

/**
 * Explicit models surfaced under the pool, selected by name in the picker.
 *
 * Each is its own first-class picker entry (`GPT/<id>`) dispatched through the
 * same account rotation. Only models present in the account's own
 * models_cache are listed (verified 2026-09-20: gpt-5.6-sol, gpt-5.6-terra,
 * gpt-5.6-luna, gpt-5.5, gpt-6-astra, gpt-reserve).
 */
export const CODEX_MODELS = [
  { id: 'gpt-6-sol', name: 'GPT-6-Sol', description: 'GPT-6-Sol（ChatGPT 订阅号池；通用工作型）' },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'GPT-6-Astra（ChatGPT 订阅号池；最强档）' },
] as const;

/** Header timeout for one chat request. */
const HEADER_TIMEOUT_MS = 30_000;

/** Decode a JWT payload without verifying the signature. */
function jwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function jwtExp(token: string): number | undefined {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === 'number' ? exp : undefined;
}

/** Email, display name, and subscription end from an id_token. Never returns the token. */
export function identityFromIdToken(idToken: string | undefined): {
  email?: string;
  name?: string;
  plan?: string;
  /** ISO timestamp when the ChatGPT subscription period ends. */
  subscriptionUntil?: string;
} {
  if (!idToken) return {};
  const payload = jwtPayload(idToken);
  if (!payload) return {};
  const email = typeof payload.email === 'string' && payload.email.includes('@') ? payload.email : undefined;
  const name = typeof payload.name === 'string' && payload.name.trim().length > 0 ? payload.name.trim() : undefined;
  const auth = payload['https://api.openai.com/auth'];
  const authObj = typeof auth === 'object' && auth !== null ? auth as Record<string, unknown> : undefined;
  const plan = typeof authObj?.chatgpt_plan_type === 'string' ? authObj.chatgpt_plan_type : undefined;
  const untilRaw = authObj?.chatgpt_subscription_active_until;
  const untilMs = typeof untilRaw === 'string' ? Date.parse(untilRaw) : Number.NaN;
  return {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(plan ? { plan } : {}),
    ...(Number.isFinite(untilMs) ? { subscriptionUntil: new Date(untilMs).toISOString() } : {}),
  };
}

/** One poolable Codex account resolved from an auth.json. */
export interface CodexAccount {
  /** Stable key used for cooldown bookkeeping ("a" / "b"). */
  key: string;
  accessToken: string;
  accountId: string;
  /** Epoch seconds when the access token expires; 0 = unknown. */
  expiresAt: number;
  /** Refresh token when present; the caller is responsible for rotation. */
  refreshToken?: string;
  /** ChatGPT plan type from the JWT, when decodable ("plus", "pro", ...). */
  plan?: string;
  /** Account email from the id_token. Display only; not sent upstream. */
  email?: string;
  /** Display name from the id_token, used when email is absent. */
  name?: string;
  /** ChatGPT subscription period end (ISO), from the id_token. */
  subscriptionUntil?: string;
}

/** Read one auth.json into a CodexAccount, or undefined when absent/unusable. */
export function readCodexAccount(key: string, home: string): CodexAccount | undefined {
  try {
    const file = path.join(home, 'auth.json');
    if (!fs.existsSync(file)) return undefined;
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      auth_mode?: string;
      tokens?: { access_token?: string; account_id?: string; refresh_token?: string; id_token?: string };
    };
    const accessToken = j.tokens?.access_token;
    const accountId = j.tokens?.account_id;
    if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined;
    if (typeof accountId !== 'string' || accountId.length === 0) return undefined;
    const exp = jwtExp(accessToken);
    const identity = identityFromIdToken(j.tokens?.id_token);
    return {
      key,
      accessToken,
      accountId,
      expiresAt: exp ?? 0,
      ...(typeof j.tokens?.refresh_token === 'string' ? { refreshToken: j.tokens.refresh_token } : {}),
      ...(j.auth_mode === 'chatgpt' && !identity.plan ? { plan: 'chatgpt' } : {}),
      ...identity,
    };
  } catch {
    return undefined;
  }
}

/** List every poolable account with a currently-valid token. */
export function listCodexAccounts(): CodexAccount[] {
  const out: CodexAccount[] = [];
  for (const [key, home] of [
    ['a', CODEX_HOME_A],
    ['b', CODEX_HOME_B],
  ] as const) {
    const acct = readCodexAccount(key, home);
    if (acct === undefined) continue;
    // Expired tokens are excluded up front: the upstream would 401 them and
    // burn a cooldown slot for nothing.
    if (acct.expiresAt > 0 && acct.expiresAt * 1000 <= Date.now()) continue;
    out.push(acct);
  }
  return out;
}

/** Build the request headers shared by every Codex backend call. */
export function codexHeaders(acct: CodexAccount): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${acct.accessToken}`,
    'chatgpt-account-id': acct.accountId,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/0.55.0',
  };
}

export interface CodexChatRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  /** System prompt (Responses `instructions`). */
  system?: string;
  tools?: Array<Record<string, unknown>>;
  reasoningEffort?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Translate DSH messages into Responses `input` items.
 *
 * The Responses wire format is not OpenAI-chat: user/assistant turns are
 * `message` items with typed content parts, and tool results are `function_call_output`
 * items. Only the shapes DSH actually emits are handled.
 */
export function toResponsesInput(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    const role = String(m.role ?? 'user');
    const content = m.content;
    if (role === 'tool') {
      out.push({
        type: 'function_call_output',
        call_id: String(m.tool_call_id ?? ''),
        output: typeof content === 'string' ? content : JSON.stringify(content),
      });
      continue;
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
        out.push({
          type: 'function_call',
          call_id: String(tc.id ?? ''),
          name: String(tc.function?.name ?? ''),
          arguments: String(tc.function?.arguments ?? '{}'),
        });
      }
      // Text attached to an assistant tool-call turn still needs to reach the model.
      if (typeof content === 'string' && content.length > 0) {
        out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] });
      }
      continue;
    }
    // Plain text turn (user / assistant / system folded in by the caller).
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    const partType = role === 'assistant' ? 'output_text' : 'input_text';
    out.push({
      type: 'message',
      role: role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: partType, text }],
    });
  }
  return out;
}

/**
 * POST one streamed Responses request for a specific account.
 *
 * Returns the raw Response; callers consume the SSE themselves (the Responses
 * event stream differs from chat-completions chunks and has its own consumer).
 */
export async function codexChat(
  acct: CodexAccount,
  req: CodexChatRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.system ?? '',
    input: toResponsesInput(req.messages),
    stream: true,
    store: false,
  };
  if (req.tools && req.tools.length > 0) body.tools = req.tools;
  const effort = req.reasoningEffort ?? 'medium';
  body.reasoning = { effort, summary: 'auto' };

  const controller = new AbortController();
  const onAbort = () => controller.abort(req.signal?.reason);
  if (req.signal) {
    if (req.signal.aborted) controller.abort(req.signal.reason);
    else req.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`codex header timeout after ${HEADER_TIMEOUT_MS}ms`)),
    HEADER_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: codexHeaders(acct),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (req.signal) req.signal.removeEventListener('abort', onAbort);
  }
}
