import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const CACHE_TTL_MS = 3 * 60 * 1000;
const DEFAULT_CACHE_FILE = join(__dirname, '../.cache/quota.json');
const CODEX_AUTH_FILE = join(homedir(), '.codex', 'auth.json');
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const PROVIDERS = ['codex', 'claude', 'agy'] as const;

export type QuotaProvider = (typeof PROVIDERS)[number];

export interface QuotaStatus {
  provider: QuotaProvider;
  remaining: string | null;
  resetAt: string | null;
  source: string;
  unavailable: boolean;
}

export interface QuotaSnapshot {
  cachedAt: string;
  providers: QuotaStatus[];
}

type QuotaFetcher = () => Promise<QuotaStatus>;

export interface QuotaDeps {
  cacheFile?: string;
  now?: () => number;
  fetchers?: Partial<Record<QuotaProvider, QuotaFetcher>>;
}

type JsonObject = Record<string, unknown>;

export async function getQuotaSnapshot(deps: QuotaDeps = {}): Promise<QuotaSnapshot> {
  const cacheFile = deps.cacheFile ?? DEFAULT_CACHE_FILE;
  const now = deps.now ?? Date.now;
  const cached = await readQuotaCache(cacheFile);
  if (cached && now() - Date.parse(cached.cachedAt) < CACHE_TTL_MS) {
    return cached;
  }

  const fetchers = {
    codex: fetchCodexQuota,
    claude: fetchClaudeQuota,
    agy: fetchAgyQuota,
    ...deps.fetchers,
  } satisfies Record<QuotaProvider, QuotaFetcher>;

  const providers = await Promise.all(
    PROVIDERS.map(async (provider) => {
      try {
        return await fetchers[provider]();
      } catch {
        return unavailableQuota(provider, `${provider}-unavailable`);
      }
    }),
  );

  const snapshot = { cachedAt: new Date(now()).toISOString(), providers };
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(snapshot), 'utf8');
  return snapshot;
}

async function readQuotaCache(cacheFile: string): Promise<QuotaSnapshot | null> {
  try {
    const raw = await readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<QuotaSnapshot>;
    if (!parsed || typeof parsed.cachedAt !== 'string' || !Array.isArray(parsed.providers)) return null;
    if (!parsed.providers.every(isQuotaStatus)) return null;
    return { cachedAt: parsed.cachedAt, providers: parsed.providers };
  } catch {
    return null;
  }
}

function isQuotaStatus(value: unknown): value is QuotaStatus {
  if (!isObject(value)) return false;
  return typeof value.provider === 'string'
    && PROVIDERS.includes(value.provider as QuotaProvider)
    && (typeof value.remaining === 'string' || value.remaining === null)
    && (typeof value.resetAt === 'string' || value.resetAt === null)
    && typeof value.source === 'string'
    && typeof value.unavailable === 'boolean';
}

async function fetchCodexQuota(): Promise<QuotaStatus> {
  const auth = JSON.parse(await readFile(CODEX_AUTH_FILE, 'utf8')) as { tokens?: JsonObject };
  const accessToken = typeof auth.tokens?.access_token === 'string' ? auth.tokens.access_token : null;
  const accountId = typeof auth.tokens?.account_id === 'string' ? auth.tokens.account_id : null;
  if (!accessToken) return unavailableQuota('codex', '~/.codex/auth.json');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop',
  };
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;

  const response = await fetch(CODEX_USAGE_URL, { headers });
  if (!response.ok) {
    throw new Error(`codex usage ${response.status}`);
  }

  const payload = await response.json() as JsonObject;
  const rateLimit = isObject(payload.rate_limit) ? payload.rate_limit : null;
  if (!rateLimit) return unavailableQuota('codex', 'codex-usage-missing-rate-limit');

  const primaryWindow = isObject(rateLimit.primary_window) ? rateLimit.primary_window : null;
  const secondaryWindow = isObject(rateLimit.secondary_window) ? rateLimit.secondary_window : null;
  const window = primaryWindow ?? secondaryWindow;
  if (!window) return unavailableQuota('codex', 'codex-usage-missing-window');

  return {
    provider: 'codex',
    remaining: formatRemaining(window.used_percent),
    resetAt: resolveResetAt(window),
    source: primaryWindow ? 'chatgpt.com/backend-api/wham/usage.primary_window' : 'chatgpt.com/backend-api/wham/usage.secondary_window',
    unavailable: false,
  };
}

async function fetchClaudeQuota(): Promise<QuotaStatus> {
  return unavailableQuota('claude', '~/.claude/stats-cache.json');
}

async function fetchAgyQuota(): Promise<QuotaStatus> {
  return unavailableQuota('agy', 'agy-cli-no-local-quota-source');
}

function unavailableQuota(provider: QuotaProvider, source: string): QuotaStatus {
  return { provider, remaining: null, resetAt: null, source, unavailable: true };
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatRemaining(usedPercent: unknown): string | null {
  const used = toFiniteNumber(usedPercent);
  if (used === null) return null;
  const remaining = Math.max(0, Math.min(100, Math.round((100 - used) * 100) / 100));
  return `${remaining}%`;
}

function resolveResetAt(window: JsonObject): string | null {
  const resetAt = normalizeTimestamp(window.reset_at);
  if (resetAt) return new Date(resetAt).toISOString();
  const resetAfterSeconds = toFiniteNumber(window.reset_after_seconds);
  if (resetAfterSeconds === null) return null;
  return new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
}

function normalizeTimestamp(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric !== null) {
    return Math.abs(numeric) > 100000000000 ? numeric : numeric * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
