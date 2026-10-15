import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CommandError } from './eventStore';

export type DeploymentPolicy = 'task-tracker' | 'not_required';

export interface RegisteredRepo {
  targetRepo: string;
  checks: string[];
  deployment: DeploymentPolicy;
  /** member 可修改的相對路徑前綴；未設定時由呼叫端沿用預設（task-tracker 自己的 sim/ src/ public/）。 */
  allowedPrefixes?: string[];
}

export type RepoRegistry = ReadonlyMap<string, RegisteredRepo>;

const ALLOWED_CHECKS = new Set([
  'npm test',
  'npm run build',
  'npm run typecheck',
  'npx tsc --noEmit',
  'git diff --check',
  'python3 -m pytest',
]);

interface RawRepoConfig {
  checks?: unknown;
  deployment?: unknown;
  allowedPrefixes?: unknown;
}

/** 非空字串陣列；每項必須是相對路徑（不以 `/` 開頭、不含 `..` 段）。 */
function isValidPrefixList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((prefix) =>
    typeof prefix === 'string' && prefix.length > 0 && !prefix.startsWith('/') && !prefix.split('/').includes('..'));
}

export function loadRepoRegistry(path = process.env.TASK_TRACKER_REPO_REGISTRY_PATH): RepoRegistry {
  if (!path) return new Map();
  if (!existsSync(path)) throw new CommandError('repo registry 不存在');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CommandError('repo registry 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommandError('repo registry 必須是物件');
  }

  const registry = new Map<string, RegisteredRepo>();
  for (const [rawPath, rawConfig] of Object.entries(parsed)) {
    if (!isAbsolute(rawPath)) throw new CommandError('target repo 必須是絕對路徑');
    if (!existsSync(rawPath)) throw new CommandError(`target repo 不存在：${rawPath}`);
    const targetRepo = realpathSync(rawPath);
    if (registry.has(targetRepo)) throw new CommandError(`target repo 重複登記：${targetRepo}`);
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      throw new CommandError(`repo 設定不合法：${rawPath}`);
    }
    const { checks, deployment, allowedPrefixes } = rawConfig as RawRepoConfig;
    if (!Array.isArray(checks) || checks.length === 0 || checks.some((check) => typeof check !== 'string')) {
      throw new CommandError(`repo checks 不合法：${rawPath}`);
    }
    if (checks.some((check) => !ALLOWED_CHECKS.has(check))) {
      throw new CommandError(`repo check 不允許：${rawPath}`);
    }
    if (deployment !== 'task-tracker' && deployment !== 'not_required') {
      throw new CommandError(`repo deployment 不合法：${rawPath}`);
    }
    if (allowedPrefixes !== undefined && !isValidPrefixList(allowedPrefixes)) {
      throw new CommandError(`repo allowedPrefixes 不合法：${rawPath}`);
    }
    registry.set(targetRepo, {
      targetRepo, checks: [...checks], deployment,
      ...(allowedPrefixes ? { allowedPrefixes: [...allowedPrefixes] } : {}),
    });
  }
  return registry;
}
