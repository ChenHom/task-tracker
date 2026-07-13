import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROVIDERS = ['codex', 'claude', 'agy'] as const;
const WINDOW_NAMES = ['five_hour', 'seven_day'] as const;

export type QuotaProvider = (typeof PROVIDERS)[number];
export type QuotaWindowName = (typeof WINDOW_NAMES)[number];

export interface QuotaWindow {
  window: QuotaWindowName;
  remaining: string | null;
  resetAt: string | null;
  available: boolean;
}

export interface QuotaStatus {
  provider: QuotaProvider;
  remaining: string | null;
  resetAt: string | null;
  source: string;
  unavailable: boolean;
  stale: boolean;
  windows: QuotaWindow[];
}

export interface QuotaSnapshot {
  cachedAt: string;
  providers: QuotaStatus[];
}

export interface QuotaDeps {
  stateFile?: string;
  now?: () => number;
}

type JsonObject = Record<string, unknown>;

export async function getQuotaSnapshot(deps: QuotaDeps = {}): Promise<QuotaSnapshot> {
  const stateFile = deps.stateFile
    ?? process.env.AI_QUOTA_STATE_PATH
    ?? join(homedir(), '.local', 'state', 'ai-quota', 'quota.json');
  const parsed = await readAiQuotaSnapshot(stateFile);
  if (!parsed) return unavailableSnapshot(deps.now?.() ?? Date.now());

  const providers = ['codex', 'claude'].map((provider) => (
    mapProvider(provider as QuotaProvider, parsed.providers[provider] as JsonObject)
  ));
  const rawAgy = asObject(parsed.providers.agy);
  const agyValid = rawAgy && rawAgy.provider === 'agy' && typeof rawAgy.status === 'string' && asObject(rawAgy.windows);
  providers.push(agyValid ? mapProvider('agy', rawAgy) : unavailableQuota('agy', 'ai-quota-agy-missing'));
  return { cachedAt: parsed.generatedAt, providers };
}

async function readAiQuotaSnapshot(stateFile: string): Promise<{
  generatedAt: string;
  providers: JsonObject;
} | null> {
  try {
    const root = asObject(JSON.parse(await readFile(stateFile, 'utf8')));
    const providers = asObject(root?.providers);
    if (root?.schemaVersion !== 1 || typeof root.generatedAt !== 'string' || !providers) return null;
    for (const provider of ['codex', 'claude']) {
      const item = asObject(providers[provider]);
      if (!item || item.provider !== provider || typeof item.status !== 'string' || !asObject(item.windows)) {
        return null;
      }
    }
    return { generatedAt: root.generatedAt, providers };
  } catch {
    return null;
  }
}

function mapProvider(provider: QuotaProvider, raw: JsonObject): QuotaStatus {
  const rawWindows = asObject(raw.windows);
  const windows = WINDOW_NAMES.map((window) => mapWindow(window, rawWindows?.[window]));
  const selected = windows.find((window) => window.window === 'five_hour' && window.available)
    ?? windows.find((window) => window.window === 'seven_day' && window.available)
    ?? null;
  const stale = raw.status !== 'ok';

  return {
    provider,
    remaining: selected?.remaining ?? null,
    resetAt: selected?.resetAt ?? null,
    source: typeof raw.source === 'string' ? raw.source : `${provider}-source-unknown`,
    unavailable: selected === null,
    stale,
    windows,
  };
}

function mapWindow(window: QuotaWindowName, value: unknown): QuotaWindow {
  const raw = asObject(value);
  const remainingPercent = raw && typeof raw.remainingPercent === 'number' && Number.isFinite(raw.remainingPercent)
    ? Math.max(0, Math.min(100, raw.remainingPercent))
    : null;
  if (remainingPercent === null) {
    return { window, remaining: null, resetAt: null, available: false };
  }
  return {
    window,
    remaining: `${Math.round(remainingPercent * 100) / 100}%`,
    resetAt: typeof raw?.resetsAt === 'string' ? raw.resetsAt : null,
    available: true,
  };
}

function unavailableSnapshot(timestamp: number): QuotaSnapshot {
  return {
    cachedAt: new Date(timestamp).toISOString(),
    providers: [
      unavailableQuota('codex', 'ai-quota-state-unavailable'),
      unavailableQuota('claude', 'ai-quota-state-unavailable'),
      unavailableQuota('agy', 'ai-quota-state-unavailable'),
    ],
  };
}

function unavailableQuota(provider: QuotaProvider, source: string): QuotaStatus {
  return {
    provider,
    remaining: null,
    resetAt: null,
    source,
    unavailable: true,
    stale: true,
    windows: WINDOW_NAMES.map((window) => ({
      window,
      remaining: null,
      resetAt: null,
      available: false,
    })),
  };
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}
