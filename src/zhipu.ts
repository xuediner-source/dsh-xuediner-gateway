/**
 * Zhipu (BigModel / 智谱) upstream — free-tier models.
 *
 * Verified 2026-09-14 with a personal API key:
 *   glm-4-flash     -> OK
 *   glm-4.5-flash   -> OK
 *   glm-4.7-flash   -> HTTP 429 "该模型当前访问量过大" (free model, currently congested)
 *   glm-4.6 / glm-5.3 / glm-4.5-air -> HTTP 1113 "余额不足或无可用资源包"
 *
 * So only the Flash family is reachable on this key; the paid tiers need a
 * resource pack. 429 congestion is retryable and handled by the caller.
 */
import fs from 'node:fs';
import path from 'node:path';

export const ZHIPU_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';
export const ZHIPU_CHAT_URL = `${ZHIPU_API_BASE}/chat/completions`;

const HEADER_TIMEOUT_MS = 20_000;

/** Free-tier models reachable with a standard personal key. */
export const ZHIPU_MODELS = [
  { id: 'glm-4.7-flash', name: 'GLM-4.7 Flash (智谱)', contextLength: 200_000 },
  { id: 'glm-4.5-flash', name: 'GLM-4.5 Flash (智谱)', contextLength: 131_072 },
  { id: 'glm-4-flash', name: 'GLM-4 Flash (智谱)', contextLength: 131_072 },
] as const;

export type ZhipuModelId = (typeof ZHIPU_MODELS)[number]['id'];

/** Resolve the Zhipu API key from the harness credential store. */
export function resolveZhipuKey(): string | undefined {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  try {
    const credPath = path.join(home, '.credentials.yaml');
    if (!fs.existsSync(credPath)) return undefined;
    const text = fs.readFileSync(credPath, 'utf8');
    const m = text.match(/^\s*ZHIPU_API_KEY:\s*(.+)$/m);
    if (!m) return undefined;
    const value = m[1].trim().replace(/^['"]|['"]$/g, '');
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface ZhipuChatRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
}

/** POST one streamed chat request to Zhipu with a header timeout. */
export async function zhipuChat(
  apiKey: string,
  req: ZhipuChatRequest,
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
    () => controller.abort(new Error(`zhipu header timeout after ${HEADER_TIMEOUT_MS}ms`)),
    HEADER_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(ZHIPU_CHAT_URL, {
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
