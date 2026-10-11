import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CommandError } from './eventStore';

export type DeploymentPolicy = 'task-tracker' | 'not_required';

export interface RegisteredRepo {
  targetRepo: string;
  checks: string[];
  deployment: DeploymentPolicy;
}

export type RepoRegistry = ReadonlyMap<string, RegisteredRepo>;

const ALLOWED_CHECKS = new Set([
  'npm test',
  'npm run build',
  'npm run typecheck',
  'npx tsc --noEmit',
  'git diff --check',
]);

interface RawRepoConfig {
  checks?: unknown;
  deployment?: unknown;
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
    const { checks, deployment } = rawConfig as RawRepoConfig;
    if (!Array.isArray(checks) || checks.length === 0 || checks.some((check) => typeof check !== 'string')) {
      throw new CommandError(`repo checks 不合法：${rawPath}`);
    }
    if (checks.some((check) => !ALLOWED_CHECKS.has(check))) {
      throw new CommandError(`repo check 不允許：${rawPath}`);
    }
    if (deployment !== 'task-tracker' && deployment !== 'not_required') {
      throw new CommandError(`repo deployment 不合法：${rawPath}`);
    }
    registry.set(targetRepo, { targetRepo, checks: [...checks], deployment });
  }
  return registry;
}
