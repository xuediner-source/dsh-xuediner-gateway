/**
 * Qoder direct upstream (COSY-signed protocol).
 *
 * Connects to Qoder's own chat endpoint without going through a local 9Router
 * instance, so the Qoder models stay available whenever the DSH host runs —
 * the same durability the other xuedinerAPI routes have.
 *
 * Protocol (reverse-engineered from the Qoder CLI wire format):
 *   - OAuth access token is `dt-...`; a Personal Access Token is `pt-...` and
 *     must first be exchanged for a short-lived job token (`jt-...`).
 *   - Each request carries a COSY signature block: an RSA-encrypted AES key
 *     plus an MD5 digest over
 *       `<base64(info)> <cosyKey> <unixSeconds> <bodyDigest> <sigPath>`
 *     where `info` is an AES-128-CBC encryption of the identity JSON.
 *
 * Credentials are read from the 9Router database when present (that is where
 * the OAuth login landed), and fall back to QODER_ACCESS_TOKEN /
 * QODER_USER_ID in ~/.dsh/.credentials.yaml.
 *
 * Docs: https://qoder.com  ·  endpoint: https://api3.qoder.sh
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Chat endpoint (SSE).
 *
 * The `/algo` segment is part of the real path, not a local prefix: dropping it
 * yields 404, while keeping it reaches the streaming handler. `jt-` job tokens
 * must use api2 instead of api3 — see {@link selectOrigin}.
 */
export const QODER_CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';
export const QODER_ORIGIN = 'https://api3.qoder.sh';
export const QODER_JOB_ORIGIN = 'https://api2.qoder.sh';
export const QODER_OPENAPI = 'https://openapi.qoder.sh';

/** Qoder upstream model keys (its own vocabulary, not OpenAI ids).
 *
 * `qfmodel` / `qmodel_38max` are the two Qwen3.8 keys Qoder itself reports in
 * its config-service `auto_compact_model_threshold_caps` payload
 * (`{ qfmodel: 600000, qmodel_38max: 600000 }`), so they are the current
 * 3.8-Flash / 3.8-Max pair. The older `qmodel_latest` alias is gone: it no
 * longer resolves to the 3.8 generation upstream.
 */
export const QODER_MODEL_QWEN_FLASH = 'qfmodel';
export const QODER_MODEL_QWEN_MAX = 'qmodel_38max';
export const QODER_MODEL_DEEPSEEK_FLASH = 'dfmodel';

/**
 * 9Router catalog ids for the models reached directly instead.
 *
 * These are hidden from the generic `9r/` list: Qoder is now connected directly,
 * so listing its 9Router ids too would advertise one upstream twice.
 */
export const QODER_HIDDEN_UPSTREAMS: readonly string[] = [
  `qd/${QODER_MODEL_QWEN_FLASH}`,
  `qd/${QODER_MODEL_QWEN_MAX}`,
  `qd/${QODER_MODEL_DEEPSEEK_FLASH}`,
];

/** Picker ids for the Qoder models surfaced as first-class entries.
 *
 * Both are the Qwen3.8 generation: the previous `qwen3.7-max` picker id was
 * removed together with its `qmodel_latest` upstream alias.
 */
export const QODER_QWEN_FLASH_ID = 'qwen3.8-flash';
export const QODER_QWEN_MAX_ID = 'qwen3.8-max';

/**
 * Map a first-class picker id to the Qoder upstream model key.
 * Returns undefined for every other model, so callers can use it as a guard.
 */
export function qoderDirectModel(uiModel: string): string | undefined {
  if (uiModel === QODER_QWEN_FLASH_ID) return QODER_MODEL_QWEN_FLASH;
  if (uiModel === QODER_QWEN_MAX_ID) return QODER_MODEL_QWEN_MAX;
  return undefined;
}

/**
 * Display metadata for the first-class Qoder entries.
 * Kept next to the transport so id, upstream key, and label cannot drift apart.
 */
export const QODER_ENTRIES: ReadonlyArray<{
  id: string;
  upstream: string;
  name: string;
  description: string;
}> = [
  {
    id: QODER_QWEN_FLASH_ID,
    upstream: QODER_MODEL_QWEN_FLASH,
    name: 'Qwen3.8-Flash (Qoder)',
    description: 'Qwen3.8-Flash · 1M 上下文 · 支持图片（Qoder 订阅直连）',
  },
  {
    id: QODER_QWEN_MAX_ID,
    upstream: QODER_MODEL_QWEN_MAX,
    name: 'Qwen3.8-Max (Qoder)',
    description: 'Qwen3.8-Max · 1M 上下文 · 支持图片（Qoder 订阅直连）',
  },
];

/** COSY protocol constants (mirrors the CLI's own values). */
const COSY_VERSION = '1.0.0';
const COSY_CLIENT_TYPE = '5';
const COSY_MACHINE_TYPE = '5';
const COSY_MACHINE_OS = 'x86_64_windows';
const COSY_DATA_POLICY = 'disagree';
const LOGIN_VERSION = 'v2';

/** RSA public key the CLI uses to wrap the per-request AES key. */
const COSY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** 9Router's database, where a completed Qoder login is stored. */
function nineRouterDbPath(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, '9router', 'db', 'data.sqlite');
}

/** One resolved Qoder identity. */
export interface QoderCredential {
  accessToken: string;
  userId: string;
  name?: string;
  email?: string;
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
    const m = text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'));
    if (!m) return undefined;
    const value = m[1].trim().replace(/^['"]|['"]$/g, '');
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the Qoder connection row from 9Router's SQLite database.
 *
 * Uses `node:sqlite` (built into Node 22+) so no native dependency is added.
 * The 9Router row is only a fallback source: QODER_ACCESS_TOKEN in the harness
 * credential store takes priority, so the plugin keeps working even if 9Router
 * is removed later.
 */
async function readFromNineRouterDb(): Promise<QoderCredential | undefined> {
  const db = nineRouterDbPath();
  if (!fs.existsSync(db)) return undefined;
  try {
    // Imported dynamically: this module is ESM, and `node:sqlite` is
    // experimental, so a missing driver must not break plugin load.
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): { get(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const handle = new DatabaseSync(db);
    try {
      const row = handle
        .prepare('SELECT data FROM providerConnections WHERE provider = ? LIMIT 1')
        .get('qoder') as { data?: unknown } | undefined;
      if (row?.data === undefined) return undefined;
      const parsed = (
        typeof row.data === 'string' ? JSON.parse(row.data) : row.data
      ) as Record<string, unknown>;
      const accessToken = typeof parsed.accessToken === 'string' ? parsed.accessToken : undefined;
      if (accessToken === undefined || accessToken.length === 0) return undefined;
      let userId = '';
      const psd = parsed.providerSpecificData;
      const psdObj = typeof psd === 'string' ? (JSON.parse(psd) as { userId?: unknown }) : psd;
      if (psdObj !== null && typeof psdObj === 'object') {
        const candidate = (psdObj as { userId?: unknown }).userId;
        if (typeof candidate === 'string') userId = candidate;
      }
      return {
        accessToken,
        userId,
        ...(typeof parsed.displayName === 'string' ? { name: parsed.displayName } : {}),
        ...(typeof parsed.email === 'string' && parsed.email.length > 0 ? { email: parsed.email } : {}),
      };
    } finally {
      handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Qoder credential.
 *
 * Priority: explicit env, then the harness credential store, then 9Router's
 * database (where the browser OAuth login wrote it).
 */
export async function resolveQoderCredential(): Promise<QoderCredential | undefined> {
  const envToken = process.env.QODER_ACCESS_TOKEN?.trim() || readCredential('QODER_ACCESS_TOKEN');
  const envUser = process.env.QODER_USER_ID?.trim() || readCredential('QODER_USER_ID');
  if (envToken !== undefined && envToken.length > 0 && envUser !== undefined && envUser.length > 0) {
    return { accessToken: envToken, userId: envUser };
  }
  const fromDb = await readFromNineRouterDb();
  if (fromDb !== undefined && fromDb.userId.length > 0) return fromDb;
  if (fromDb !== undefined && envUser !== undefined && envUser.length > 0) {
    return { ...fromDb, userId: envUser };
  }
  if (fromDb !== undefined && fromDb.userId.length === 0) {
    // A token without an identity cannot be signed; surface it as unusable
    // rather than sending requests that the upstream will reject.
    return undefined;
  }
  return undefined;
}

/** AES-128-CBC encrypt with PKCS-less zero padding, matching the CLI. */
function aesCbcEncrypt(plain: string, key16: Buffer): Buffer {
  const data = Buffer.from(plain, 'utf8');
  const pad = 16 - (data.length % 16);
  const padded = Buffer.alloc(data.length + pad, pad);
  data.copy(padded, 0);
  const cipher = crypto.createCipheriv('aes-128-cbc', key16.subarray(0, 16), key16.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

/** md5 hex digest. */
function md5(input: crypto.BinaryLike): string {
  return crypto.createHash('md5').update(input).digest('hex');
}

/** Path used inside the COSY signature (leading `/algo` stripped). */
function sigPath(url: string): string {
  try {
    const p = new URL(url).pathname || '';
    return p.startsWith('/algo') ? p.slice(5) : p;
  } catch {
    return '';
  }
}

/**
 * Build the COSY header block for one request body.
 *
 * @param body - exact bytes that will be sent (digest and length cover these).
 * @param cred - resolved Qoder identity.
 */
export function cosyHeaders(body: Buffer, cred: QoderCredential, url: string): Record<string, string> {
  // The CLI derives this key from a random *string* sliced to 16 chars, so the
  // bytes are always valid UTF-8 and exactly 16 long. Using raw random bytes
  // here can produce invalid UTF-8, and the upstream then decrypts a key whose
  // length does not match -> 403 "Signature invalid". Stay ASCII.
  const aesKey = Buffer.from(crypto.randomBytes(16).toString('hex').slice(0, 16), 'utf8');
  const identity = JSON.stringify({
    uid: cred.userId,
    security_oauth_token: cred.accessToken,
    name: cred.name ?? '',
    aid: '',
    email: cred.email ?? '',
  });
  const info = aesCbcEncrypt(identity, aesKey).toString('base64');
  const cosyKey = crypto
    .publicEncrypt(
      { key: COSY_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      aesKey,
    )
    .toString('base64');

  const seconds = String(Math.floor(Date.now() / 1000));
  const envelope = JSON.stringify({
    version: 'v1',
    requestId: crypto.randomUUID(),
    info,
    cosyVersion: COSY_VERSION,
    ideVersion: '',
  });
  const encoded = Buffer.from(envelope, 'utf8').toString('base64');
  const bodyDigest = md5(body);
  const path = sigPath(url);
  // The CLI joins these five fields with NEWLINES (not spaces); using a space
  // makes the upstream answer 403 "Signature invalid".
  const toSign = [
    encoded,
    cosyKey,
    seconds,
    body.toString('latin1'),
    path,
  ].join('\n');
  const sig = md5(Buffer.from(toSign, 'latin1'));

  // The CLI reuses one machine id for both headers.
  const machineId = crypto.randomUUID();

  return {
    Authorization: `Bearer COSY.${encoded}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': cred.userId,
    'Cosy-Date': seconds,
    'Cosy-Version': COSY_VERSION,
    'Cosy-Machineid': machineId,
    'Cosy-Machinetoken': machineId,
    'Cosy-Machinetype': COSY_MACHINE_TYPE,
    'Cosy-Machineos': COSY_MACHINE_OS,
    'Cosy-Clienttype': COSY_CLIENT_TYPE,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': bodyDigest,
    'Cosy-Bodylength': String(body.length),
    'Cosy-Sigpath': path,
    'Cosy-Data-Policy': COSY_DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': LOGIN_VERSION,
    'X-Request-Id': crypto.randomUUID(),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': 'qodercli/1.0.0',
  };
}

/**
 * Origin to use for a token.
 * `jt-` job tokens are only accepted by api2; `dt-`/`pt-` use api3.
 */
export function selectOrigin(accessToken: string): string {
  return accessToken.startsWith('jt-') ? QODER_JOB_ORIGIN : QODER_ORIGIN;
}

export interface QoderChatRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  maxTokens?: number;
  /**
   * Reasoning effort, forwarded as the CLI does: `parameters.reasoning_effort`
   * (values none/low/medium/high/xhigh/max, verified in the Qoder runtime
   * bundle). Qoder's own models expose an effort selector in its UI, so the
   * knob is real even though the older transport code ignored it.
   *
   * Effort alone does NOT switch thinking on — see {@link QODER_EFFORT_NONE}.
   * Omit it to use the model default (thinking enabled); pass `none` to disable
   * thinking for this request.
   */
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/**
 * Hard ceiling on `max_tokens` for every Qoder upstream model.
 *
 * Measured 2026-09-19 against all three Qoder keys (`qfmodel`, `qmodel_38max`,
 * `dfmodel`): 32768 is accepted, 32769 is rejected. Qoder reports that
 * rejection *inside* a 200 SSE stream as
 * `<400> InternalError.Algo.InvalidParameter: Range of max_tokens should be
 * [1, 32768]`, so an over-limit value surfaces as a mid-stream failure rather
 * than an HTTP error.
 *
 * Clamped here, at the single point where the payload is built, so every
 * caller (the two 3.8 picker entries and the DeepSeek fallback chain) is
 * covered and no future caller can reintroduce the over-limit request.
 */
export const QODER_MAX_TOKENS_CEILING = 32_768;

/** Default when a caller supplies no `maxTokens` at all. */
const QODER_DEFAULT_MAX_TOKENS = 32_000;

/**
 * The switch that actually turns thinking on, and why effort alone is not it.
 *
 * Measured 2026-09-21 on both 3.8 keys with identical prompts and
 * `reasoning_effort=high`:
 *
 * | parameters sent                        | reasoning_content |
 * |----------------------------------------|-------------------|
 * | `reasoning_effort: high`               | **0 chars**       |
 * | `+ enable_thinking: true`              | 969–1076 chars    |
 *
 * i.e. `reasoning_effort` only *shapes* the budget once thinking is enabled;
 * on its own the upstream answers with no `reasoning_content` at all, which
 * DSH renders as an absent/short thinking chain. The official CLI never sends
 * effort without the switch: its request builder sets
 * `enable_thinking = effort !== 'none'` (and `false` for `none`, plus
 * `reasoning_budget_tokens` when a budget is given).
 *
 * So the gateway mirrors the CLI: thinking is ON by default for these models,
 * explicitly OFF when the caller picks `none`, and the flag is always sent
 * rather than left to an upstream default that produced no chain.
 */
const QODER_EFFORT_NONE = 'none';

/** Whether the caller asked for thinking to be switched off for this request. */
function thinkingDisabledByEffort(reasoningEffort: string | undefined): boolean {
  return reasoningEffort === QODER_EFFORT_NONE;
}

/**
 * Unwrap one Qoder SSE payload into an OpenAI-style chunk.
 *
 * Qoder wraps every event as `{ headers, body, statusCode }`, where `body` is a
 * JSON *string* (or the literal `[DONE]`). Callers need the inner chunk, so this
 * returns the decoded object or undefined when the event carries no payload.
 */
export function unwrapQoderEvent(payload: string): unknown {
  try {
    const outer = JSON.parse(payload) as { body?: unknown };
    if (outer === null || typeof outer !== 'object' || !('body' in outer)) return outer;
    const inner = outer.body;
    if (typeof inner !== 'string') return inner;
    if (inner === '[DONE]') return undefined;
    return JSON.parse(inner);
  } catch {
    return undefined;
  }
}

/**
 * POST one streamed chat request to Qoder with COSY signing.
 *
 * Qoder does NOT speak the OpenAI schema: it expects its own agent payload
 * (`chat_task` / `chat_context` / `business`). Sending OpenAI-shaped JSON gets
 * `400 flow nodes found for router agent_router`.
 *
 * The body is serialized once and reused for the digest, so the signature can
 * never drift from the bytes actually sent.
 */
export async function qoderChat(
  cred: QoderCredential,
  req: QoderChatRequest,
  fetchImpl: typeof fetch = fetch,
  targetOrigin?: string,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();

  // Qoder carries the conversation in `messages` and the final user turn in
  // `chat_context.text`; the CLI mirrors both.
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const promptText = typeof lastUser?.content === 'string' ? lastUser.content : '';

  // `is_reasoning` mirrors the CLI, which flips it off when thinking is
  // disabled (`0 === thinkingBudget || effort === 'none' || !enable_thinking`).
  const thinkingOff = thinkingDisabledByEffort(req.reasoningEffort);
  const modelConfig = { key: req.model, is_reasoning: !thinkingOff };

  // Clamp to the measured upstream ceiling: an over-limit value is rejected
  // in-band mid-stream (see QODER_MAX_TOKENS_CEILING).
  const requestedMaxTokens = req.maxTokens ?? QODER_DEFAULT_MAX_TOKENS;
  const effectiveMaxTokens = Math.min(requestedMaxTokens, QODER_MAX_TOKENS_CEILING);

  // Forward the effort knob exactly like the CLI: top-level parameters entry,
  // omitted when the caller did not pick one.
  //
  // `enable_thinking` must accompany it, otherwise the upstream returns no
  // reasoning_content at all — see QODER_EFFORT_NONE. The CLI always sends the
  // switch, so the gateway does too; picking effort `none` turns thinking off.
  const parameters: Record<string, unknown> = {
    max_tokens: effectiveMaxTokens,
    enable_thinking: !thinkingOff,
  };
  if (req.reasoningEffort) parameters.reasoning_effort = req.reasoningEffort;

  const payload: Record<string, unknown> = {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    messages: req.messages,
    tools: Array.isArray(req.tools) ? req.tools : [],
    parameters,
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig,
        originalContent: promptText,
      },
      features: [],
      text: promptText,
    },
    model_config: modelConfig,
    business: {
      product: 'cli',
      version: '1.0.0',
      type: 'agent',
      stage: 'start',
      id: requestId,
      name: promptText.slice(0, 30),
      begin_at: Date.now(),
    },
  };

  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const baseOrigin = targetOrigin ?? selectOrigin(cred.accessToken);
  const url = `${baseOrigin}${QODER_CHAT_PATH}`;
  const headers = cosyHeaders(raw, cred, url);

  return fetchImpl(url, {
    method: 'POST',
    headers,
    body: raw,
    ...(req.signal ? { signal: req.signal } : {}),
  });
}
