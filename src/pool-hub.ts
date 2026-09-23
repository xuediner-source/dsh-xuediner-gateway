/**
 * Pool HUB server side.
 *
 * Registers GET /api/pool-hub and returns a JSON snapshot of the whole
 * xuedinerAPI account pool:
 *   - Huawei Cloud CodeArts accounts (from their credential files)
 *   - Tencent WorkBuddy/CodeBuddy accounts (from the local gateway /status)
 *   - ZCode proxy health, Codex account windows
 *
 * Xiaomi MiMo was dropped from this snapshot on 2026-09-22 at the user's request.
 *
 * Also keeps the /pool text command for quick checks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import { loadCodeArtsCredentials, refreshCodeArtsCredential } from './adapter.js';
import { getAccountTodayUsage, CODEARTS_DAILY_QUOTA } from './codearts-usage.js';
import { resolveZcodeConfig } from './zcode.js';
import { readCodexAccount, CODEX_HOME_A, CODEX_HOME_B } from './codex.js';

const execFileAsync = promisify(execFile);

/** Resolve the gateway base URL (env wins; default is the local gateway port). */
function resolveGatewayBase(): string {
  const explicit = process.env.XUEDINER_GATEWAY_URL ?? process.env.WORKBUDDY_GATEWAY_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, '');
  return 'http://127.0.0.1:7863';
}
/** Resolve the gateway API key (env wins; default matches config.example.json). */
function resolveGatewayApiKey(): string {
  return process.env.XUEDINER_API_KEY
    ?? process.env.XUEDINER_GATEWAY_API_KEY
    ?? process.env.WORKBUDDY_GATEWAY_API_KEY
    ?? 'wb2api-dsh-key';
}
export const GATEWAY_BASE = resolveGatewayBase();
export const GATEWAY_STATUS_URL = `${GATEWAY_BASE}/status`;
export const GATEWAY_API_KEY = resolveGatewayApiKey();
export const ROUTE_PATH = '/api/pool-hub';
/** POST here to silently renew one or all CodeArts credentials. */
export const REFRESH_ROUTE_PATH = '/api/pool-hub/codearts/refresh';
/** POST here to begin adding an account (returns the OAuth URL). */
export const LOGIN_START_ROUTE_PATH = '/api/pool-hub/login/start';
/** GET here to poll an in-progress account addition. */
export const LOGIN_POLL_ROUTE_PATH = '/api/pool-hub/login/poll';
/** POST here to run the daily task/credit routine on every account. */
export const TASKS_RUN_ROUTE_PATH = '/api/pool-hub/tasks/run';
/** GET here for per-account task status. */
export const TASKS_STATUS_ROUTE_PATH = '/api/pool-hub/tasks/status';
/** POST here to begin adding an INTERNATIONAL account (codebuddy.ai). */
export const INTL_LOGIN_START_ROUTE_PATH = '/api/pool-hub/login/intl/start';
/** GET here to poll an in-progress international account addition. */
export const INTL_LOGIN_POLL_ROUTE_PATH = '/api/pool-hub/login/intl/poll';
/** POST here to begin adding a ChatGPT/Codex account (device-code login). */
export const GPT_LOGIN_START_ROUTE_PATH = '/api/pool-hub/login/gpt/start';
/** GET here to poll an in-progress ChatGPT/Codex account addition. */
export const GPT_LOGIN_POLL_ROUTE_PATH = '/api/pool-hub/login/gpt/poll';
/**
 * Credential directory (paths only — files stay on the user's machine).
 * XUEDINER_GATEWAY_DIR wins, then the bundled ./gateway checkout, then the
 * per-user data dir.
 */
function resolveAuthsDir(): string {
  const explicit = process.env.XUEDINER_GATEWAY_DIR ?? process.env.WORKBUDDY_GATEWAY_DIR;
  if (explicit && explicit.length > 0) return path.join(explicit, 'auths');
  const bundled = path.resolve('gateway', 'auths');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(os.homedir(), '.dsh', 'xuediner-gateway', 'auths');
}
const CODEARTS_AUTHS_DIR = resolveAuthsDir();
/**
 * Gateway install directory; hosts the login helper for the intl flow.
 * Falls back to the bundled ./gateway checkout when unset.
 */
function resolveGatewayDir(): string {
  const explicit = process.env.XUEDINER_GATEWAY_DIR ?? process.env.WORKBUDDY_GATEWAY_DIR;
  if (explicit && explicit.length > 0) return explicit;
  const bundled = path.resolve('gateway');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(os.homedir(), '.dsh', 'xuediner-gateway');
}
const GATEWAY_DIR = resolveGatewayDir();

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

interface GatewayAccount {
  uid?: string;
  nickname?: string;
  credits?: number;
  credits_total?: number;
  cooling?: boolean;
  until?: string;
  disabled?: boolean;
  disabled_reason?: string;
  in_flight?: number;
  breaker_fails?: number;
  breaker_until?: string;
  success_count?: number;
  last_success?: string;
  last_err?: string;
}

interface CodeArtsFile {
  access_key_id?: string;
  secret_access_key?: string;
  security_token?: string;
  expires_at?: string;
  refresh_token?: string;
}

export interface PoolHubSnapshot {
  ok: boolean;
  generatedAt: string;
  codearts: {
    count: number;
    accounts: Array<{
      id: string;
      expiresAt: string | null;
      minutesLeft: number | null;
      refreshable: boolean;
      usageToday?: {
        totalTokens: number;
        promptTokens: number;
        completionTokens: number;
        requests: number;
        quota: number;
        percent: number;
      };
    }>;
  };
  tencent: {
    reachable: boolean;
    error?: string;
    count: number;
    healthy: number;
    cooling: number;
    disabled: number;
    stickySessions: number;
    accounts: Array<{
      id: string;
      nickname: string;
      state: 'ok' | 'cooling' | 'disabled';
      detail: string;
      credits: number | null;
      inFlight: number;
      successCount: number;
      lastSuccess: string | null;
    }>;
  };
  /** Z.AI coding-plan quota served through the local zcode-proxy. */
  zcode: {
    reachable: boolean;
    error?: string;
    models: number;
  };
  /** ChatGPT-subscription Codex account pool. */
  codex: {
    accounts: Array<{
      key: string;
      valid: boolean;
      plan?: string;
      /** Email, else display name. Slot keys stay internal. */
      label?: string;
      /** ChatGPT subscription period end (ISO). */
      subscriptionUntil?: string;
      /** Access-token expiry (ISO), or null when unknown. */
      tokenExpiresAt: string | null;
      /** 5h window from wham/usage. */
      window: { usedPercent: number; resetsAt: string } | null;
      /** Weekly window from wham/usage, when the plan exposes one. */
      weekly: { usedPercent: number; resetsAt: string } | null;
      error?: string;
    }>;
  };
  routing: string;
}

function isZeroTime(value: string | undefined): boolean {
  return !value || value.startsWith('0001-01-01');
}

function minutesUntil(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms - Date.now()) / 60_000);
}

export function readCodeArtsFiles(): Array<{ file: string; cred: CodeArtsFile }> {
  const out: Array<{ file: string; cred: CodeArtsFile }> = [];
  try {
    if (!fs.existsSync(CODEARTS_AUTHS_DIR)) return out;
    for (const name of fs.readdirSync(CODEARTS_AUTHS_DIR).sort()) {
      if (!name.startsWith('codearts-') || !name.endsWith('.json')) continue;
      try {
        const cred = JSON.parse(fs.readFileSync(path.join(CODEARTS_AUTHS_DIR, name), 'utf8')) as CodeArtsFile;
        if (cred.access_key_id && cred.security_token) out.push({ file: path.join(CODEARTS_AUTHS_DIR, name), cred });
      } catch {
        // skip unreadable
      }
    }
  } catch {
    // directory missing
  }
  return out;
}

async function fetchGatewayStatus(): Promise<{ status: any | null; error?: string }> {
  try {
    const response = await fetch(GATEWAY_STATUS_URL, {
      headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return { status: null, error: `HTTP ${response.status}` };
    return { status: await response.json() };
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Build the full pool snapshot consumed by the client overlay. */
export async function buildPoolSnapshot(): Promise<PoolHubSnapshot> {
  const codeartsFiles = readCodeArtsFiles();
  const { status, error } = await fetchGatewayStatus();
  const accounts: GatewayAccount[] = Array.isArray(status?.accounts) ? status.accounts : [];

  const mapped = accounts.map((a) => {
    let state: 'ok' | 'cooling' | 'disabled' = 'ok';
    let detail = '';
    if (a.disabled) {
      state = 'disabled';
      detail = a.disabled_reason ?? '已禁用';
    } else if (a.cooling) {
      state = 'cooling';
      detail = isZeroTime(a.until) ? '冷却中' : `冷却至 ${a.until}`;
    } else if ((a.breaker_fails ?? 0) > 0) {
      detail = `熔断计数 ${a.breaker_fails}`;
    }
    const credits = a.credits_total ?? a.credits;
    return {
      id: (a.uid ?? '').slice(0, 8),
      nickname: a.nickname ?? '',
      state,
      detail,
      credits: typeof credits === 'number' ? credits : null,
      inFlight: a.in_flight ?? 0,
      successCount: a.success_count ?? 0,
      lastSuccess: isZeroTime(a.last_success) ? null : (a.last_success ?? null),
    };
  });

  const healthy =
    typeof status?.healthy === 'number'
      ? status.healthy
      : mapped.filter((a) => a.state === 'ok').length;

  // Xiaomi MiMo quota was removed on 2026-09-22 at the user's request, together
  // with its picker entries — the panel no longer probes that account.

  // ZCode proxy health: a cheap /models probe (auth-protected).
  const zcodeCfg = resolveZcodeConfig();
  let zcode: PoolHubSnapshot['zcode'];
  try {
    const res = await fetch(`${zcodeCfg.baseUrl}/models`, {
      headers: zcodeCfg.apiKey ? { Authorization: `Bearer ${zcodeCfg.apiKey}` } : {},
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: unknown[] };
      zcode = { reachable: true, models: Array.isArray(body.data) ? body.data.length : 0 };
    } else {
      zcode = { reachable: false, models: 0, error: `HTTP ${res.status}` };
    }
  } catch (error) {
    zcode = {
      reachable: false,
      models: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Codex accounts: token validity locally, plus a live wham/usage probe per
  // account (5h + weekly windows). Failures degrade to a note.
  const codexHomes: Array<readonly [string, string]> = [
    ['a', CODEX_HOME_A],
    ['b', CODEX_HOME_B],
  ];
  const codexAccounts = await Promise.all(
    codexHomes.map(async ([key, home]) => {
      // readCodexAccount keeps expired tokens visible so the panel can say
      // "凭证过期" instead of hiding the slot. listCodexAccounts() still drops
      // them from the live rotation.
      const acct = readCodexAccount(key, home);
      if (!acct) {
        return { key, valid: false, plan: undefined, tokenExpiresAt: null, window: null, weekly: null };
      }
      const expired = acct.expiresAt > 0 && acct.expiresAt * 1000 <= Date.now();
      const base = {
        key,
        valid: !expired,
        ...(acct.plan ? { plan: acct.plan } : {}),
        ...(acct.email || acct.name ? { label: acct.email ?? acct.name } : {}),
        ...(acct.subscriptionUntil ? { subscriptionUntil: acct.subscriptionUntil } : {}),
        tokenExpiresAt: acct.expiresAt > 0 ? new Date(acct.expiresAt * 1000).toISOString() : null,
      };
      if (expired) {
        return { ...base, window: null, weekly: null, error: 'access token expired' };
      }
      try {
        const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
          headers: {
            authorization: `Bearer ${acct.accessToken}`,
            'chatgpt-account-id': acct.accountId,
            originator: 'codex_cli_rs',
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { ...base, window: null, weekly: null, error: `HTTP ${res.status}` };
        const body = (await res.json()) as {
          plan_type?: string;
          rate_limit?: {
            primary_window?: { used_percent?: number; reset_at?: number };
            secondary_window?: { used_percent?: number; reset_at?: number };
          };
        };
        const windowOf = (w: { used_percent?: number; reset_at?: number } | undefined) => {
          if (typeof w?.used_percent !== 'number') return null;
          const reset = typeof w.reset_at === 'number' && w.reset_at > 0 ? w.reset_at : 0;
          return {
            usedPercent: w.used_percent,
            resetsAt: new Date(reset * 1000).toISOString(),
          };
        };
        return {
          ...base,
          ...(typeof body.plan_type === 'string' ? { plan: body.plan_type } : {}),
          window: windowOf(body.rate_limit?.primary_window),
          weekly: windowOf(body.rate_limit?.secondary_window),
        };
      } catch (error) {
        return {
          ...base,
          window: null,
          weekly: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    codearts: {
      count: codeartsFiles.length,
      accounts: codeartsFiles.map(({ cred }) => {
        const akId = (cred.access_key_id ?? '').slice(0, 8);
        const usage = getAccountTodayUsage(akId);
        const used = usage?.totalTokens ?? 0;
        return {
          id: akId,
          expiresAt: cred.expires_at ?? null,
          minutesLeft: minutesUntil(cred.expires_at),
          refreshable: Boolean(cred.refresh_token),
          usageToday: {
            totalTokens: used,
            promptTokens: usage?.promptTokens ?? 0,
            completionTokens: usage?.completionTokens ?? 0,
            requests: usage?.requests ?? 0,
            quota: CODEARTS_DAILY_QUOTA,
            percent: Math.min(100, Math.round((used / CODEARTS_DAILY_QUOTA) * 10000) / 100),
          },
        };
      }),
    },
    tencent: {
      reachable: status !== null,
      ...(error ? { error } : {}),
      count: mapped.length,
      healthy,
      cooling: status?.cooling ?? 0,
      disabled: status?.disabled ?? 0,
      stickySessions: status?.sticky_sessions ?? 0,
      accounts: mapped,
    },
    zcode,
    codex: { accounts: codexAccounts },
    routing: 'DeepSeek V4.1 → 华为云优先（失败落腾讯池）；Hy4 Preview → 腾讯池；GLM-5.3-Flash → ZCode 优先；gpt-6-astra → 国际池优先，Codex 兜底',
  };
}

/** Plain-text report (used by the /pool command). */
export async function renderPoolReport(): Promise<string> {
  const snap = await buildPoolSnapshot();
  const lines: string[] = [];
  lines.push('xuedinerAPI 号池状态');
  lines.push('='.repeat(46));

  lines.push('');
  lines.push(`华为云 CodeArts（${snap.codearts.count} 个）`);
  if (snap.codearts.count === 0) {
    lines.push('  （无：DeepSeek V4.1 将直接使用腾讯号池）');
  }
  for (const a of snap.codearts.accounts) {
    const expiry =
      a.minutesLeft === null
        ? '有效期未知'
        : a.minutesLeft <= 0
          ? '已过期（下次调用会先续期）'
          : `剩余 ${a.minutesLeft} 分钟`;
    const usageStr = a.usageToday && a.usageToday.totalTokens > 0
      ? `今日已用 ${a.usageToday.totalTokens.toLocaleString()} / 10,000,000 (${a.usageToday.percent}%) · 调 ${a.usageToday.requests} 次`
      : '今日已用 0 / 10,000,000 (0%)';
    lines.push(`  ${a.id}  ${expiry}  ${usageStr}  ${a.refreshable ? '可自动续期' : '需重新登录'}`);
  }

  lines.push('');
  if (!snap.tencent.reachable) {
    lines.push('腾讯 WorkBuddy/CodeBuddy（网关未运行）');
    lines.push(`  网关无响应 ${GATEWAY_STATUS_URL}`);
    lines.push('  启动：gateway/start-gateway.ps1（或见 README 的网关章节）');
    lines.push('');
    lines.push('提示：Hy4 Preview 依赖腾讯网关；DeepSeek V4.1 仍可用华为云。');
    return lines.join('\n');
  }

  lines.push(`腾讯 WorkBuddy/CodeBuddy（${snap.tencent.count} 个，健康 ${snap.tencent.healthy}）`);
  for (const a of snap.tencent.accounts) {
    const state = a.state === 'ok' ? '正常' : a.state === 'cooling' ? `冷却中${a.detail ? ` ${a.detail}` : ''}` : `已禁用${a.detail ? `(${a.detail})` : ''}`;
    const credits = a.credits === null ? '积分未知' : `${a.credits} 分`;
    const inflight = a.inFlight ? ` 在途${a.inFlight}` : '';
    lines.push(`  ${a.id}  ${a.nickname}  ${state}  ${credits}${inflight}  成功 ${a.successCount} 次`);
  }
  lines.push('');
  lines.push(
    `汇总：总 ${snap.tencent.count}  健康 ${snap.tencent.healthy}  冷却 ${snap.tencent.cooling}  禁用 ${snap.tencent.disabled}  会话粘性 ${snap.tencent.stickySessions}`,
  );
  lines.push('');
  lines.push(`GPT / Codex 号池（${snap.codex.accounts.filter((a) => a.valid).length}/${snap.codex.accounts.length} 有效）`);
  for (const a of snap.codex.accounts) {
    const who = a.label ?? '未命名账号';
    if (!a.valid) {
      lines.push(`  ${who}  ${a.error ?? '未登录'}`);
      continue;
    }
    const win = (label: string, w: { usedPercent: number; resetsAt: string } | null) =>
      w ? `${label} ${Math.round(w.usedPercent * 10) / 10}%` : `${label} 未知`;
    const until = a.subscriptionUntil ? `到期 ${a.subscriptionUntil.slice(0, 10)}` : '到期未知';
    lines.push(
      `  ${who}  ${a.plan ?? 'chatgpt'}  ${until}  ${win('5h', a.window)}  ${win('周', a.weekly)}`,
    );
  }
  lines.push(`模型路由：${snap.routing}`);
  return lines.join('\n');
}

/** Renew CodeArts credentials. Pass an `id` to renew one, or omit to renew all. */
export async function refreshCodeArts(
  id?: string,
): Promise<{ ok: boolean; results: Array<{ id: string; ok: boolean; minutesLeft: number | null; message?: string }> }> {
  const stored = loadCodeArtsCredentials();
  const targets = id ? stored.filter((s) => s.cred.access_key_id.startsWith(id)) : stored;
  if (targets.length === 0) {
    return { ok: false, results: [{ id: id ?? '(all)', ok: false, minutesLeft: null, message: '未找到匹配的华为云账号' }] };
  }

  const results: Array<{ id: string; ok: boolean; minutesLeft: number | null; message?: string }> = [];
  for (const item of targets) {
    const before = item.cred.security_token;
    const beforeExpiry = item.cred.expires_at;
    try {
      // force=true so the click always performs a real renewal, not a no-op.
      const updated = await refreshCodeArtsCredential(item, true);
      const changed = updated.security_token !== before;
      results.push({
        id: updated.access_key_id.slice(0, 8),
        ok: changed,
        minutesLeft: minutesUntil(isoOf(updated.expires_at)),
        ...(changed
          ? {}
          : {
              message: beforeExpiry === updated.expires_at
                ? '未续期（refresh_token 可能已失效，需重新登录）'
                : '已续期但凭据未变化',
            }),
      });
    } catch (error) {
      results.push({
        id: item.cred.access_key_id.slice(0, 8),
        ok: false,
        minutesLeft: null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

function isoOf(value: string | undefined): string | undefined {
  return value;
}

/**
 * Begin adding a Tencent account.
 *
 * Delegates to the gateway's own panel login endpoint, which drives the
 * WorkBuddy OAuth flow, writes the credential file, hot-reloads the pool and
 * performs the daily check-in. The gateway API key stays server-side.
 */
export async function startAccountLogin(): Promise<{ ok: boolean; url?: string; state?: string; message?: string }> {
  try {
    const response = await fetch(`${GATEWAY_BASE}/panel/api/login/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GATEWAY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON
    }
    if (!response.ok || !body?.url) {
      return { ok: false, message: body?.message ?? body?.error ?? `HTTP ${response.status}` };
    }
    return { ok: true, url: String(body.url), state: String(body.state ?? '') };
  } catch (error) {
    return {
      ok: false,
      message: `网关未响应（${GATEWAY_BASE}）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Poll an in-progress account addition. */
export async function pollAccountLogin(state: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(
      `${GATEWAY_BASE}/panel/api/login/poll?state=${encodeURIComponent(state)}`,
      {
        headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await response.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON
    }
    if (!response.ok) {
      return { done: false, message: body?.message ?? body?.error ?? `HTTP ${response.status}` };
    }
    return body ?? { done: false, message: '空响应' };
  } catch (error) {
    return { done: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Run the daily task/credit routine across every account (async upstream). */
export async function runTasks(): Promise<{ ok: boolean; started?: boolean; message?: string }> {
  try {
    const response = await fetch(`${GATEWAY_BASE}/panel/api/school/run_all`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GATEWAY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON
    }
    if (!response.ok) {
      return { ok: false, message: body?.message ?? body?.error ?? `HTTP ${response.status}` };
    }
    return { ok: body?.ok === true, started: body?.started === true };
  } catch (error) {
    return {
      ok: false,
      message: `网关未响应（${GATEWAY_BASE}）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface TaskAccountStatus {
  id: string;
  nickname: string;
  inPeriod: boolean;
  /** Number of tasks already claimed. */
  claimed: number;
  /** Number of tasks still pending. */
  pending: number;
  total: number;
  chances: number;
  error?: string;
}

/** Summarise per-account task progress for the panel. */
export async function fetchTaskStatus(): Promise<{
  ok: boolean;
  accounts: TaskAccountStatus[];
  message?: string;
}> {
  try {
    const response = await fetch(`${GATEWAY_BASE}/panel/api/school/status`, {
      headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON
    }
    if (!response.ok || body?.ok !== true) {
      return { ok: false, accounts: [], message: body?.message ?? `HTTP ${response.status}` };
    }
    const rows = Array.isArray(body.accounts) ? body.accounts : [];
    const accounts: TaskAccountStatus[] = rows.map((a: any) => {
      const tasks = Array.isArray(a.tasks) ? a.tasks : [];
      const claimed = tasks.filter((t: any) => t.status === 'claimed').length;
      return {
        id: String(a.uid ?? '').slice(0, 8),
        nickname: String(a.nickname ?? ''),
        inPeriod: a.in_period === true,
        claimed,
        pending: tasks.length - claimed,
        total: tasks.length,
        chances: typeof a.chances === 'number' ? a.chances : 0,
        ...(a.error ? { error: String(a.error).slice(0, 120) } : {}),
      };
    });
    return { ok: true, accounts };
  } catch (error) {
    return {
      ok: false,
      accounts: [],
      message: `网关未响应（${GATEWAY_BASE}）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Resolve the gateway login helper binary (built from ./gateway/cmd/login;
 * see README — run gateway/build.ps1 or `go build ./cmd/login` first).
 * Honors XUEDINER_LOGIN_BIN; falls back to <gatewayDir>/workbuddy-login(.exe).
 */
function resolveLoginBin(): string {
  const explicit = process.env.XUEDINER_LOGIN_BIN;
  if (explicit && explicit.length > 0) return explicit;
  const exe = process.platform === 'win32' ? 'workbuddy-login.exe' : 'workbuddy-login';
  return path.join(GATEWAY_DIR, exe);
}
/**
 * Begin adding an INTERNATIONAL account.
 *
 * The intl pool (codebuddy.ai) is not covered by the gateway's panel login
 * endpoint, so this drives the login helper binary (see resolveLoginBin),
 * which shares the OAuth device flow but targets the international realm.
 */
export async function startIntlLogin(): Promise<{ ok: boolean; url?: string; message?: string }> {
  try {
    const { stdout } = await execFileAsync(resolveLoginBin(), ['url', 'intl'], {
      cwd: GATEWAY_DIR,
      timeout: 30_000,
      windowsHide: true,
    });
    const url = stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
    if (!url.startsWith('http')) {
      return { ok: false, message: `登录工具返回异常：${stdout.trim().slice(0, 160) || '(空)'}` };
    }
    return { ok: true, url };
  } catch (error) {
    return {
      ok: false,
      message: `调用登录工具失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Poll the international login and, on success, persist the credential file.
 *
 * Writes `workbuddy-intl-<uid>.json` in the same nested shape the gateway and
 * the adapter both read, then the caller reloads the pool snapshot.
 */
export async function pollIntlLogin(): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await execFileAsync(resolveLoginBin(), ['poll', 'intl'], {
      cwd: GATEWAY_DIR,
      timeout: 60_000,
      windowsHide: true,
    });
    const line = stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
    if (!line) {
      return { done: false, message: '登录未完成（等待浏览器授权）' };
    }
    const parsed = JSON.parse(line) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      domain?: string;
      uid?: string;
      enterprise_id?: string;
      nickname?: string;
    };
    if (!parsed.access_token || !parsed.uid) {
      return { done: false, message: '凭据不完整，请重试' };
    }

    const expiresAt = Math.floor(Date.now() / 1000) + (parsed.expires_in ?? 0);
    const doc = {
      account: {
        uid: parsed.uid,
        enterpriseId: parsed.enterprise_id ?? '',
        nickname: parsed.nickname ?? '',
      },
      auth: {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token ?? '',
        expiresAt,
        domain: parsed.domain || 'www.codebuddy.ai',
      },
    };
    if (!fs.existsSync(CODEARTS_AUTHS_DIR)) fs.mkdirSync(CODEARTS_AUTHS_DIR, { recursive: true });
    const file = path.join(CODEARTS_AUTHS_DIR, `workbuddy-intl-${parsed.uid}.json`);
    // UTF-8 without BOM: the Go gateway's JSON reader rejects a BOM.
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), { encoding: 'utf8' });

    return {
      done: true,
      uid: parsed.uid.slice(0, 8),
      nickname: parsed.nickname ?? '',
      file: path.basename(file),
    };
  } catch (error) {
    // A non-zero exit is the normal "not finished yet" signal.
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes('登录未完成') || text.includes('waiting for login')) {
      return { done: false, message: '登录未完成（等待浏览器授权）' };
    }
    return { done: false, message: text.slice(0, 200) };
  }
}

/**
 * ChatGPT/Codex device-code login, driven by the local `codex` CLI.
 *
 * The pool has two fixed homes (A = ~/.codex, B = ~/.codex-pool-b). A new
 * account lands in the first home that has no usable auth.json, so adding
 * never overwrites a live login. The CLI writes auth.json itself once the
 * user approves the device code in a browser.
 */
interface GptLoginSession {
  key: string;
  home: string;
  userCode: string;
  verificationUrl: string;
  startedAt: number;
  child: ReturnType<typeof execFile>;
  output: string;
  error?: string;
  done: boolean;
}

let gptLogin: GptLoginSession | null = null;

const GPT_LOGIN_TTL_MS = 10 * 60_000;

function codexHomes(): Array<readonly [string, string]> {
  return [
    ['a', CODEX_HOME_A],
    ['b', CODEX_HOME_B],
  ];
}

function parseDeviceAuth(text: string): { userCode?: string; verificationUrl?: string } {
  const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device[^\s)]*/)?.[0]
    ?? text.match(/https:\/\/[^\s)]*device[^\s)]*/)?.[0];
  const code = text.match(/\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/)?.[1]
    ?? text.match(/code[:\s]+([A-Z0-9-]{6,})/i)?.[1];
  return {
    ...(code ? { userCode: code } : {}),
    ...(url ? { verificationUrl: url } : {}),
  };
}

export async function startGptLogin(): Promise<{
  ok: boolean;
  key?: string;
  userCode?: string;
  verificationUrl?: string;
  message?: string;
}> {
  if (gptLogin && !gptLogin.done && Date.now() - gptLogin.startedAt < GPT_LOGIN_TTL_MS) {
    return {
      ok: true,
      key: gptLogin.key,
      userCode: gptLogin.userCode,
      verificationUrl: gptLogin.verificationUrl,
      message: '已有进行中的登录',
    };
  }
  if (gptLogin?.child && !gptLogin.child.killed) {
    gptLogin.child.kill();
  }
  gptLogin = null;

  const slot = codexHomes().find(([key, home]) => readCodexAccount(key, home) === undefined);
  if (!slot) {
    return { ok: false, message: 'A/B 两个槽都已登录。先退出一个再添加。' };
  }
  const [key, home] = slot;
  fs.mkdirSync(home, { recursive: true });

  const child = execFile(
    'codex',
    ['login', '--device-auth'],
    {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home },
      windowsHide: true,
      timeout: GPT_LOGIN_TTL_MS,
    },
    () => {
      // Completion is observed by pollGptLogin via auth.json, not the exit code.
    },
  );
  const session: GptLoginSession = {
    key,
    home,
    userCode: '',
    verificationUrl: '',
    startedAt: Date.now(),
    child,
    output: '',
    done: false,
  };
  const onData = (chunk: Buffer | string) => {
    session.output += String(chunk);
    const parsed = parseDeviceAuth(session.output);
    if (parsed.userCode) session.userCode = parsed.userCode;
    if (parsed.verificationUrl) session.verificationUrl = parsed.verificationUrl;
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', () => {
    if (!session.done && readCodexAccount(session.key, session.home) === undefined) {
      session.error = session.error ?? '登录进程已退出，但未写入凭证';
    }
  });
  gptLogin = session;

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && !session.userCode && !session.verificationUrl && !session.error) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!session.userCode && !session.verificationUrl) {
    return {
      ok: false,
      key,
      message: session.error ?? `未能从 codex login 读到设备码。输出：${session.output.slice(0, 180) || '(空)'}`,
    };
  }
  return {
    ok: true,
    key,
    userCode: session.userCode,
    verificationUrl: session.verificationUrl,
  };
}

export async function pollGptLogin(): Promise<Record<string, unknown>> {
  const session = gptLogin;
  if (!session) return { done: false, message: '没有进行中的 GPT 登录' };
  const acct = readCodexAccount(session.key, session.home);
  if (acct && !(acct.expiresAt > 0 && acct.expiresAt * 1000 <= Date.now())) {
    session.done = true;
    return { done: true, key: session.key, plan: acct.plan ?? 'chatgpt' };
  }
  if (Date.now() - session.startedAt > GPT_LOGIN_TTL_MS) {
    if (!session.child.killed) session.child.kill();
    return { done: false, message: '登录超时，请重新添加' };
  }
  return {
    done: false,
    key: session.key,
    userCode: session.userCode,
    verificationUrl: session.verificationUrl,
    ...(session.error ? { message: session.error } : { message: '等待浏览器授权' }),
  };
}

/** Register GET /api/pool-hub and POST /api/pool-hub/codearts/refresh. */
export function registerPoolRoute(ctx: Context): void {
  const webServer = ctx.get('webServer') as
    | {
        register?: (route: {
          kind: string;
          path: string;
          handler: (req: unknown, res: any) => Promise<void> | void;
        }) => unknown;
      }
    | undefined;
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger.warn('[xuedinerAPI] webServer service unavailable; /api/pool-hub not registered');
    return;
  }

  let cache: { expires: number; body: PoolHubSnapshot } | null = null;

  try {
    ctx.effect(() => {
      const disposeSnapshot = webServer.register!({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (_req, res) => {
          try {
            if (cache && cache.expires > Date.now()) {
              res.writeHead(200, JSON_HEADERS);
              res.end(JSON.stringify(cache.body));
              return;
            }
            const body = await buildPoolSnapshot();
            cache = { expires: Date.now() + 10_000, body };
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(body));
          } catch (error) {
            res.writeHead(500, JSON_HEADERS);
            res.end(
              JSON.stringify({
                ok: false,
                message: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        },
      });

      const disposeRefresh = webServer.register!({
        kind: 'exact',
        path: REFRESH_ROUTE_PATH,
        handler: async (req: any, res: any) => {
          try {
            if (req.method !== 'POST') {
              res.writeHead(405, JSON_HEADERS);
              res.end(JSON.stringify({ ok: false, message: 'POST only' }));
              return;
            }
            // Optional JSON body {"id": "HSTAXXXX"} renews a single account.
            let id: string | undefined;
            try {
              const chunks: Buffer[] = [];
              for await (const chunk of req) chunks.push(Buffer.from(chunk));
              const raw = Buffer.concat(chunks).toString('utf8').trim();
              if (raw.length > 0) {
                const parsed = JSON.parse(raw) as { id?: string };
                if (typeof parsed.id === 'string' && parsed.id.length > 0) id = parsed.id;
              }
            } catch {
              // Missing or malformed body means "renew everything".
            }

            const outcome = await refreshCodeArts(id);
            // Drop the snapshot cache so the panel re-reads fresh expiry.
            cache = null;
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(outcome));
          } catch (error) {
            res.writeHead(500, JSON_HEADERS);
            res.end(
              JSON.stringify({
                ok: false,
                results: [],
                message: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        },
      });

      const disposeLoginStart = webServer.register!({
        kind: 'exact',
        path: LOGIN_START_ROUTE_PATH,
        handler: async (req: any, res: any) => {
          try {
            if (req.method !== 'POST') {
              res.writeHead(405, JSON_HEADERS);
              res.end(JSON.stringify({ ok: false, message: 'POST only' }));
              return;
            }
            const outcome = await startAccountLogin();
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(outcome));
          } catch (error) {
            res.writeHead(500, JSON_HEADERS);
            res.end(
              JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
            );
          }
        },
      });

      const disposeLoginPoll = webServer.register!({
        kind: 'exact',
        path: LOGIN_POLL_ROUTE_PATH,
        handler: async (req: any, res: any) => {
          try {
            const url = new URL(req.url ?? '/', 'http://dsh.internal');
            const state = url.searchParams.get('state') ?? '';
            if (state.length === 0) {
              res.writeHead(400, JSON_HEADERS);
              res.end(JSON.stringify({ done: false, message: 'missing state' }));
              return;
            }
            const outcome = await pollAccountLogin(state);
            // A completed addition changes the pool, so drop the cache.
            if (outcome.done === true) cache = null;
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(outcome));
          } catch (error) {
            res.writeHead(500, JSON_HEADERS);
            res.end(
              JSON.stringify({ done: false, message: error instanceof Error ? error.message : String(error) }),
            );
          }
        },
      });

      const disposeTasksRun = webServer.register!({
        kind: 'exact',
        path: TASKS_RUN_ROUTE_PATH,
        handler: async (req: any, res: any) => {
          try {
            if (req.method !== 'POST') {
              res.writeHead(405, JSON_HEADERS);
              res.end(JSON.stringify({ ok: false, message: 'POST only' }));
              return;
            }
            const outcome = await runTasks();
            // Credits change once the run finishes; drop the cache so a manual
            // refresh right after shows the new totals.
            cache = null;
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(outcome));
          } catch (error) {
            res.writeHead(500, JSON_HEADERS);
            res.end(
              JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
            );
          }
        },
      });

      const disposeTasksStatus = webServer.register!({
        kind: 'exact',
        path: TASKS_STATUS_ROUTE_PATH,
        handler: async (_req: any, res: any) => {
          try {
            const outcome = await fetchTaskStatus();
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(outcome));
          } catch (error) {
            res.writeHead(500, JSON_HEADERS);
            res.end(
              JSON.stringify({ ok: false, accounts: [], message: error instanceof Error ? error.message : String(error) }),
            );
          }
        },
      });

      const disposeIntlStart = webServer.register!({
        kind: 'exact',
        path: INTL_LOGIN_START_ROUTE_PATH,
        handler: async (req: any, res: any) => {
          try {
            if (req.method !== 'POST') {
              res.writeHead(405, JSON_HEADERS);
              res.end(JSON.stringify({ ok: false, message: 'POST only' }));
              return;
            }
            const outcome = await startIntlLogin();
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(outcome));
          } catch (error) {
            res.writeHead(500, JSON_HEADERS);
            res.end(
              JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
            );
          }
        },
      });

      const disposeIntlPoll = webServer.register!({
        kind: 'exact',
        path: INTL_LOGIN_POLL_ROUTE_PATH,
        handler: async (_req: any, res: any) => {
          try {
            const outcome = await pollIntlLogin();
            if (outcome.done === true) cache = null;
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(outcome));
          } catch (error) {
            res.writeHead(500, JSON_HEADERS);
            res.end(
              JSON.stringify({ done: false, message: error instanceof Error ? error.message : String(error) }),
            );
          }
        },
      });

      const disposeGptStart = webServer.register!({
        kind: 'exact',
        path: GPT_LOGIN_START_ROUTE_PATH,
        handler: async (req: any, res: any) => {
          try {
            if (req.method !== 'POST') {
              res.writeHead(405, JSON_HEADERS);
              res.end(JSON.stringify({ ok: false, message: 'POST only' }));
              return;
            }
            const outcome = await startGptLogin();
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(outcome));
          } catch (error) {
            res.writeHead(500, JSON_HEADERS);
            res.end(
              JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
            );
          }
        },
      });

      const disposeGptPoll = webServer.register!({
        kind: 'exact',
        path: GPT_LOGIN_POLL_ROUTE_PATH,
        handler: async (_req: any, res: any) => {
          try {
            const outcome = await pollGptLogin();
            if (outcome.done === true) cache = null;
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(outcome));
          } catch (error) {
            res.writeHead(500, JSON_HEADERS);
            res.end(
              JSON.stringify({ done: false, message: error instanceof Error ? error.message : String(error) }),
            );
          }
        },
      });

      return () => {
        if (typeof disposeSnapshot === 'function') (disposeSnapshot as () => void)();
        if (typeof disposeRefresh === 'function') (disposeRefresh as () => void)();
        if (typeof disposeLoginStart === 'function') (disposeLoginStart as () => void)();
        if (typeof disposeLoginPoll === 'function') (disposeLoginPoll as () => void)();
        if (typeof disposeTasksRun === 'function') (disposeTasksRun as () => void)();
        if (typeof disposeTasksStatus === 'function') (disposeTasksStatus as () => void)();
        if (typeof disposeIntlStart === 'function') (disposeIntlStart as () => void)();
        if (typeof disposeIntlPoll === 'function') (disposeIntlPoll as () => void)();
        if (typeof disposeGptStart === 'function') (disposeGptStart as () => void)();
        if (typeof disposeGptPoll === 'function') (disposeGptPoll as () => void)();
      };
    }, 'xuediner-api.pool-hub-routes');

    ctx.logger.info(
      `[xuedinerAPI] pool hub routes registered: ${ROUTE_PATH}, ${REFRESH_ROUTE_PATH}, `
        + `${LOGIN_START_ROUTE_PATH}, ${LOGIN_POLL_ROUTE_PATH}, ${TASKS_RUN_ROUTE_PATH}, `
        + `${TASKS_STATUS_ROUTE_PATH}, ${INTL_LOGIN_START_ROUTE_PATH}, ${INTL_LOGIN_POLL_ROUTE_PATH}, `
        + `${GPT_LOGIN_START_ROUTE_PATH}, ${GPT_LOGIN_POLL_ROUTE_PATH}`,
    );
  } catch (error) {
    ctx.logger.warn(`[xuedinerAPI] pool hub route registration failed: ${String(error)}`);
  }
}

/** Register the /pool text command. */
export function registerPoolCommand(ctx: Context): void {
  const commands = ctx.get('commands') as
    | { register?: (cmd: { name: string; description: string; handler: () => Promise<unknown> }) => unknown }
    | undefined;
  if (!commands || typeof commands.register !== 'function') {
    ctx.logger.warn('[xuedinerAPI] commands service unavailable; /pool not registered');
    return;
  }
  try {
    commands.register({
      name: 'pool',
      description: '查看 xuedinerAPI 号池状态（华为云 CodeArts + 腾讯 WorkBuddy/CodeBuddy）',
      handler: async () => {
        try {
          return { kind: 'success', text: await renderPoolReport() };
        } catch (error) {
          return {
            kind: 'error',
            text: `号池状态读取失败: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    });
    ctx.logger.info('[xuedinerAPI] /pool command registered');
  } catch (error) {
    ctx.logger.warn(`[xuedinerAPI] /pool registration failed: ${String(error)}`);
  }
}

/** Wire up both the HTTP route and the text command. */
export function registerPoolHub(ctx: Context): void {
  registerPoolRoute(ctx);
  registerPoolCommand(ctx);
}
