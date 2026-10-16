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
  /** Goal Task 開工前，把 repo 主工作樹的檔案複製進 worktree（`to` 必須是 gitignored 路徑，目標已存在就不覆蓋）。 */
  seedFiles?: SeedFile[];
  /** 成員工作時可執行的建置／測試／研究指令；claude 成員的 Bash 白名單會加上這些，codex 只在 prompt 列出。 */
  workCommands?: string[];
  /**
   * false = 該 repo 的 codex 成員 workspace-write 不開網路（預設 true，維持現況）。
   * codex 的 sandbox 可讀整台機器，網路一開就能把讀到的憑證外流；claude confined 本來就擋網路，不受影響。
   */
  network?: boolean;
  /**
   * 相對於 repo 主工作樹、claude confined session 額外拒讀的具體路徑（`.env` 永遠會擋，不必列）。
   * 不接受萬用字元。codex 無法逐檔拒讀，這個欄位對它沒有作用——codex 要靠 network=false 防外流。
   */
  denyRead?: string[];
  /**
   * true = 含憑證的 repo 只允許 claude confined 路線（預設 false，維持現況）。codex 的 sandbox 可讀整台機器、
   * 無法逐檔拒讀，agy（--mode accept-edits）也不吃 denyRead／network；network=false 還擋不住它們把憑證寫進
   * 回報留言或會被 commit 的檔案，所以 codex、agy 一律不派。
   */
  claudeOnly?: boolean;
}

export interface SeedFile {
  from: string;
  to: string;
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
  seedFiles?: unknown;
  workCommands?: unknown;
  network?: unknown;
  denyRead?: unknown;
  claudeOnly?: unknown;
}

/** 非空字串陣列；每項必須是相對路徑（不以 `/` 開頭、不含 `..` 段）。 */
function isValidPrefixList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((prefix) =>
    typeof prefix === 'string' && prefix.length > 0 && !prefix.startsWith('/') && !prefix.split('/').includes('..'));
}

function isRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.split('/').includes('..');
}

function isValidSeedFiles(value: unknown): value is SeedFile[] {
  return Array.isArray(value) && value.length > 0 && value.every((seed) =>
    Boolean(seed) && typeof seed === 'object' && !Array.isArray(seed)
    && isRelativePath((seed as SeedFile).from) && isRelativePath((seed as SeedFile).to));
}

/** 非空字串陣列；指令會被拼進 claude 的 `Bash(cmd)` 規則，所以不得含 shell 控制字元或換行。 */
function isValidWorkCommands(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((command) =>
    typeof command === 'string' && command.trim().length > 0 && !/[;|&$`<>\r\n]/u.test(command));
}

/** denyRead 同樣是相對路徑，且只收具體路徑：sandbox denyRead 是否支援萬用字元未查證，寧可拒絕也不要靜默失效。 */
function isValidDenyReadList(value: unknown): value is string[] {
  return isValidPrefixList(value) && value.every((path) => !/[*?[\]]/u.test(path));
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
    const { checks, deployment, allowedPrefixes, seedFiles, workCommands, network, denyRead, claudeOnly } = rawConfig as RawRepoConfig;
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
    if (seedFiles !== undefined && !isValidSeedFiles(seedFiles)) {
      throw new CommandError(`repo seedFiles 不合法：${rawPath}`);
    }
    if (workCommands !== undefined && !isValidWorkCommands(workCommands)) {
      throw new CommandError(`repo workCommands 不合法：${rawPath}`);
    }
    if (network !== undefined && typeof network !== 'boolean') {
      throw new CommandError(`repo network 不合法：${rawPath}`);
    }
    if (denyRead !== undefined && !isValidDenyReadList(denyRead)) {
      throw new CommandError(`repo denyRead 不合法：${rawPath}`);
    }
    if (claudeOnly !== undefined && typeof claudeOnly !== 'boolean') {
      throw new CommandError(`repo claudeOnly 不合法：${rawPath}`);
    }
    registry.set(targetRepo, {
      targetRepo, checks: [...checks], deployment,
      ...(allowedPrefixes ? { allowedPrefixes: [...allowedPrefixes] } : {}),
      ...(seedFiles ? { seedFiles: seedFiles.map(({ from, to }) => ({ from, to })) } : {}),
      ...(workCommands ? { workCommands: [...workCommands] } : {}),
      ...(network !== undefined ? { network } : {}),
      ...(denyRead ? { denyRead: [...denyRead] } : {}),
      ...(claudeOnly !== undefined ? { claudeOnly } : {}),
    });
  }
  return registry;
}
