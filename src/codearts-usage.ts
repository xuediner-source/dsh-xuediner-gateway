/**
 * Local usage tracking for Huawei Cloud CodeArts accounts.
 *
 * Huawei Cloud CodeArts provides 10,000,000 free tokens per day per account,
 * resetting at 00:00 local time. Because CodeArts does not provide a public
 * "remaining quota" API, this module accumulates live usage facts from each
 * successful chat completion and persists them per account.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEARTS_DAILY_QUOTA = 10_000_000;
/**
 * Local usage ledger path (derived counts only — never a credential).
 * Override with XUEDINER_USAGE_FILE.
 */
function resolveUsageFile(): string {
  const explicit = process.env.XUEDINER_USAGE_FILE;
  if (explicit && explicit.length > 0) return explicit;
  const gwDir = process.env.XUEDINER_GATEWAY_DIR ?? process.env.WORKBUDDY_GATEWAY_DIR;
  if (gwDir && gwDir.length > 0) return path.join(gwDir, 'data', 'codearts-usage.json');
  const bundled = path.resolve('gateway', 'data', 'codearts-usage.json');
  if (fs.existsSync(path.dirname(bundled))) return bundled;
  return path.join(os.homedir(), '.dsh', 'xuediner-gateway', 'codearts-usage.json');
}
export const CODEARTS_USAGE_FILE = resolveUsageFile();

export interface CodeArtsAccountUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  lastUsed: string;
}

export interface CodeArtsUsageReport {
  date: string; // YYYY-MM-DD
  accounts: Record<string, CodeArtsAccountUsage>;
}

function getTodayString(): string {
  // Local Beijing time date YYYY-MM-DD
  const now = new Date();
  const offsetMs = 8 * 3600 * 1000; // UTC+8
  const beijing = new Date(now.getTime() + offsetMs);
  return beijing.toISOString().slice(0, 10);
}

export function loadCodeArtsUsage(): CodeArtsUsageReport {
  const today = getTodayString();
  try {
    if (fs.existsSync(CODEARTS_USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CODEARTS_USAGE_FILE, 'utf8')) as CodeArtsUsageReport;
      if (data.date === today && typeof data.accounts === 'object' && data.accounts !== null) {
        return data;
      }
      // New day -> automatically reset counters
      return { date: today, accounts: {} };
    }
  } catch {}
  return { date: today, accounts: {} };
}

export function recordCodeArtsUsage(
  ak: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens?: number,
): void {
  const akId = ak.slice(0, 8);
  const report = loadCodeArtsUsage();
  if (!report.accounts[akId]) {
    report.accounts[akId] = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requests: 0,
      lastUsed: '',
    };
  }

  const entry = report.accounts[akId];
  const actualTotal = typeof totalTokens === 'number' && totalTokens > 0
    ? totalTokens
    : promptTokens + completionTokens;

  entry.promptTokens += promptTokens;
  entry.completionTokens += completionTokens;
  entry.totalTokens += actualTotal;
  entry.requests += 1;
  entry.lastUsed = new Date().toISOString();

  try {
    const dir = path.dirname(CODEARTS_USAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CODEARTS_USAGE_FILE, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    console.warn('[xuedinerAPI] Failed to record CodeArts usage:', err);
  }
}

export function getAccountTodayUsage(ak: string): CodeArtsAccountUsage | null {
  const akId = ak.slice(0, 8);
  const report = loadCodeArtsUsage();
  return report.accounts[akId] ?? null;
}
