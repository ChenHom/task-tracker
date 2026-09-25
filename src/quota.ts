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
  account: string;
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

  // ai-quota schema v2: each provider is an array of per-account snapshots.
  const providers = ['codex', 'claude'].flatMap((provider) => (
    (parsed.providers[provider] as JsonObject[]).map((raw) => mapProvider(provider as QuotaProvider, raw))
  ));
  const rawAgy = validAccounts('agy', parsed.providers.agy);
  providers.push(...(rawAgy?.length
    ? rawAgy.map((raw) => mapProvider('agy', raw))
    : [unavailableQuota('agy', 'ai-quota-agy-missing')]));
  return { cachedAt: parsed.generatedAt, providers };
}

function validAccounts(provider: string, value: unknown): JsonObject[] | null {
  if (!Array.isArray(value)) return null;
  const accounts: JsonObject[] = [];
  for (const entry of value) {
    const item = asObject(entry);
    if (!item || item.provider !== provider || typeof item.account !== 'string' || !item.account
      || typeof item.status !== 'string' || !asObject(item.windows)) {
      return null;
    }
    accounts.push(item);
  }
  return accounts;
}

async function readAiQuotaSnapshot(stateFile: string): Promise<{
  generatedAt: string;
  providers: JsonObject;
} | null> {
  try {
    const root = asObject(JSON.parse(await readFile(stateFile, 'utf8')));
    const providers = asObject(root?.providers);
    if (root?.schemaVersion !== 2 || typeof root.generatedAt !== 'string' || !providers) return null;
    for (const provider of ['codex', 'claude']) {
      if (!validAccounts(provider, providers[provider])?.length) return null;
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
    account: raw.account as string,
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
    account: 'main',
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
