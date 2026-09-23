/**
 * dsh-xuediner-gateway -> xuedinerAPI
 *
 * Registers the single unified provider "xuedinerAPI" in DeepSeek Harness.
 * Upstreams: Huawei Cloud CodeArts, Tencent WorkBuddy/CodeBuddy pool (via the
 * bundled ./gateway), ZCode proxy, Qoder direct, Codex pool, plus generic
 * key-based upstreams (OpenRouter / LLM7 / Groq / Zhipu / 9Router).
 */
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import {
  DEFAULT_API_KEY,
  DEFAULT_BASE_URL,
  PROVIDER,
  XuedinerApiAdapter,
} from './adapter.js';
import { registerPoolHub } from './pool-hub.js';

export const name = 'xuediner-api';
export const inject = ['llm', 'settings', 'commands'];

const providerSettingsSchema = Schema.object({
  providers: Schema.dict(Schema.any()).default({}),
});

function registerProviderSettings(ctx: Context, namespace: string): void {
  const settings = ctx.get('settings') as { register?: (ns: string, schema: unknown) => unknown } | undefined;
  if (!settings || typeof settings.register !== 'function') {
    return;
  }
  try {
    settings.register(namespace, providerSettingsSchema);
  } catch (error) {
    ctx.logger.warn(`[xuedinerAPI] settings namespace "${namespace}" registration failed: ${String(error)}`);
  }
}

function readConfiguredValue(ctx: Context, key: string): string | undefined {
  try {
    const settings = ctx.get('settings') as {
      get?: (ns: string, ...path: unknown[]) => unknown;
    } | undefined;
    if (settings && typeof settings.get === 'function') {
      const value = settings.get('llm-xuedinerapi', 'providers', PROVIDER, key);
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch {
    // fall through to defaults
  }
  return undefined;
}

export function apply(ctx: Context): void {
  registerProviderSettings(ctx, 'llm-xuedinerapi');

  const baseUrl =
    process.env.XUEDINER_API_BASE_URL ??
    process.env.XUEDINER_GATEWAY_URL ??
    process.env.WORKBUDDY_GATEWAY_BASE_URL ??
    process.env.WORKBUDDY_GATEWAY_URL ??
    readConfiguredValue(ctx, 'baseUrl') ??
    DEFAULT_BASE_URL;
  const apiKey =
    process.env.XUEDINER_API_KEY ??
    process.env.XUEDINER_GATEWAY_API_KEY ??
    process.env.WORKBUDDY_GATEWAY_API_KEY ??
    readConfiguredValue(ctx, 'apiKey') ??
    DEFAULT_API_KEY;

  // Image bridge: read attachment bytes through the attachment service so
  // native image-capable models receive real image content. Resolved at call
  // time via ctx.get (not inject) so a missing service degrades to a clear
  // UNSUPPORTED_CONTENT error instead of blocking plugin load.
  const readImage = async (
    attachment: unknown,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> => {
    const attachments = ctx.get('attachments') as
      | { readImage?: (ref: unknown) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> }
      | undefined;
    if (attachments?.readImage === undefined) return undefined;
    try {
      const stored = await attachments.readImage(attachment);
      return { data: stored.data, mediaType: stored.ref.mediaType };
    } catch {
      return undefined;
    }
  };

  const adapter = new XuedinerApiAdapter({ baseUrl, apiKey, readImage });

  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'xuedinerAPI',
      settingsNs: 'llm-xuedinerapi',
      settingsPath: [],
    },
  ]);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.logger.info(`[xuedinerAPI] provider "${PROVIDER}" registered -> ${baseUrl}`);

  // Account-pool HUB: /pool command for observing account health from DSH.
  registerPoolHub(ctx);
}
