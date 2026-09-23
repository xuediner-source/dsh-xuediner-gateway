/**
 * Direct Tencent CodeBuddy / WorkBuddy international upstream.
 *
 * Calls https://www.codebuddy.ai/v2/chat/completions with the intl account's
 * Bearer access_token, so Claude / GPT models on that pool can be routed
 * through xuedinerAPI without going via the local gateway.
 *
 * Verified live (2026-09-14) on the intl pool:
 *   claude-opus-5   -> available
 *   gpt-6-astra     -> present (provider intermittently returns 500)
 *   claude-sonnet-5 / claude-fable-5 / claude-fable-5.1 -> NOT registered upstream
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const INTL_ENDPOINT = 'https://www.codebuddy.ai';
export const INTL_DOMAIN = 'www.codebuddy.ai';
/**
 * Directory holding `workbuddy-intl-*.json` credentials (path only;
 * credentials live on the user's machine and are never bundled).
 */
function resolveIntlAuthsDir(): string {
  const explicit = process.env.XUEDINER_GATEWAY_DIR ?? process.env.WORKBUDDY_GATEWAY_DIR;
  if (explicit && explicit.length > 0) return path.join(explicit, 'auths');
  const bundled = path.resolve('gateway', 'auths');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(os.homedir(), '.dsh', 'xuediner-gateway', 'auths');
}
export const INTL_AUTHS_DIR = resolveIntlAuthsDir();

/** Models this route may serve. Only ones confirmed on the intl pool. */
export const INTL_MODELS = ['claude-opus-5', 'gpt-6-astra'] as const;
export type IntlModel = (typeof INTL_MODELS)[number];

export function isIntlModel(model: string): boolean {
  return (INTL_MODELS as readonly string[]).includes(model);
}

interface StoredAuth {
  auth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; domain?: string };
  account?: { uid?: string; nickname?: string };
}

export interface IntlAccount {
  file: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  uid: string;
  nickname: string;
}

/** Load every international (`workbuddy-intl-*.json`) credential. */
export function loadIntlAccounts(): IntlAccount[] {
  const out: IntlAccount[] = [];
  try {
    if (!fs.existsSync(INTL_AUTHS_DIR)) return out;
    for (const name of fs.readdirSync(INTL_AUTHS_DIR).sort()) {
      if (!name.startsWith('workbuddy-intl') || !name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(INTL_AUTHS_DIR, name), 'utf8')) as StoredAuth;
        const token = raw.auth?.accessToken;
        if (!token) continue;
        out.push({
          file: path.join(INTL_AUTHS_DIR, name),
          accessToken: token,
          ...(raw.auth?.refreshToken ? { refreshToken: raw.auth.refreshToken } : {}),
          ...(typeof raw.auth?.expiresAt === 'number' ? { expiresAt: raw.auth.expiresAt } : {}),
          uid: raw.account?.uid ?? '',
          nickname: raw.account?.nickname ?? '',
        });
      } catch {
        // skip unreadable file
      }
    }
  } catch {
    // directory missing
  }
  return out;
}

export interface IntlChatRequest {
  model: string;
  /** Wire messages; already serialized to OpenAI shape by the adapter. */
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  reasoningEffort?: string;
  signal?: AbortSignal;
}

const HEADER_TIMEOUT_MS = 120_000;

/**
 * POST one streamed chat request to the intl pool with a header timeout.
 * Throws on non-2xx so the caller can fall back to another route.
 */
export async function intlChat(
  account: IntlAccount,
  req: IntlChatRequest,
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
  // Intl pool accepts reasoning_effort on the OpenAI-compatible surface.
  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;

  const controller = new AbortController();
  const onAbort = () => controller.abort(req.signal?.reason);
  if (req.signal) {
    if (req.signal.aborted) controller.abort(req.signal.reason);
    else req.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`intl header timeout after ${HEADER_TIMEOUT_MS}ms`)),
    HEADER_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(`${INTL_ENDPOINT}/v2/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Domain': INTL_DOMAIN,
        'X-Product': 'SaaS',
        'X-Product-Code': 'codebuddy',
        'User-Agent': 'CodeBuddyIDE/1.106.1',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (req.signal) req.signal.removeEventListener('abort', onAbort);
  }
}
