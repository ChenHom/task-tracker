// 正式環境 sim 協調器的 Git 隔離層：每個 task 在自己的 branch + worktree 裡工作。
//
// 這是這個 subsystem 目前唯一允許使用 node:child_process 的檔案——所有其他模組
// 若需要操作 git，必須透過這裡匯出的函式，不得自己再 shell out。
//
// 安全準則：一律用 execFile（陣列參數傳入 git 子指令），絕不用 exec(shell string)，
// 避免 task id／檔案路徑內含 shell metacharacters 時被當成 shell 指令解讀
// （command injection）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);

/** 執行一個 git 子指令並回傳 trim 過的 stdout；非 0 exit code 會直接 throw。 */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

/**
 * 檢查 `baseSha` 是否真的是 `headSha` 的祖先（或就是同一個 commit）。用在
 * ensureTaskWorktree 的冪等重用路徑：確保回傳的 `baseSha` 不是對呼叫端輸入的
 * 盲目回音，而是跟這個 branch 目前真正的歷史一致。非 0 exit code（不是祖先，
 * 或根本不是合法 object）一律視為不一致。
 */
async function assertBaseIsAncestor(cwd: string, taskId: string, baseSha: string, headSha: string): Promise<void> {
  if (baseSha === headSha) return;
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', baseSha, headSha], { cwd });
  } catch (err) {
    throw new Error(
      `ensureTaskWorktree: task ${taskId} 已經有 branch／worktree，但目前的 head (${headSha}) 並不是傳入的 ` +
        `baseSha (${baseSha}) 的後代。重用既有 worktree 卻回報一個跟真實歷史不符的 baseSha 等於悄悄說謊——` +
        `拒絕重用；呼叫端必須自行決定如何在新 base 上重建這個 task 的 worktree。`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Task branch／worktree 命名
// ---------------------------------------------------------------------------

// taskId 一律來自看板 API 回應（外部輸入），在抵達這裡之前完全不保證是 UUID 形狀。
// 這個檔案是這個 subsystem 唯一的 git shell-out 信任邊界，所以字元白名單檢查放這裡：
// 只允許英數字、底線、連字號——沒有 `/`、沒有 `.`，天生排除任何 `../` path traversal，
// 不可能把 repo root 或共用父目錄悄悄冒充成「隔離」worktree。
const SAFE_TASK_ID_RE = /^[A-Za-z0-9_-]+$/;

function assertSafeTaskId(taskId: string): void {
  if (!SAFE_TASK_ID_RE.test(taskId)) {
    throw new Error(
      `unsafe taskId (must match ${SAFE_TASK_ID_RE.source}, no "/" or "."): ${JSON.stringify(taskId)}`,
    );
  }
}

/** 單一 task 專用的 branch 名稱：固定 `sim/task/<taskId>` 格式。 */
export function taskBranchName(taskId: string): string {
  assertSafeTaskId(taskId);
  return `sim/task/${taskId}`;
}

/** 單一 task 專用的 worktree 路徑：固定 `<repoRoot>/sim-work/tasks/<taskId>`。 */
export function taskWorktreePath(repoRoot: string, taskId: string): string {
  assertSafeTaskId(taskId);
  return join(repoRoot, 'sim-work', 'tasks', taskId);
}

export interface TaskWorktree {
  taskId: string;
  branch: string;
  path: string;
  baseSha: string;
  headSha: string;
}

/**
 * 確保 task 有自己專屬的 branch + linked worktree，從 `baseSha` 分支出去。
 * 冪等：worktree 目錄若已存在就直接回報現況，不重新建立。
 *
 * 呼叫端（coordinator）負責決定「現在是不是輪到這個 task」──queued task
 * 在解除依賴前，呼叫端根本不會呼叫這個函式；這裡本身不做任何排程判斷。
 */
export async function ensureTaskWorktree(repoRoot: string, taskId: string, baseSha: string): Promise<TaskWorktree> {
  const branch = taskBranchName(taskId);
  const worktreePath = taskWorktreePath(repoRoot, taskId);

  if (existsSync(worktreePath)) {
    const headSha = await git(['rev-parse', 'HEAD'], worktreePath);
    // 冪等重用：不能對呼叫端傳入的 baseSha 照單全收再原樣回報——必須先確認它真的
    // 是這個既有 branch 目前歷史的祖先，否則等於用假資料冒充「這個 worktree 的真實 base」。
    await assertBaseIsAncestor(worktreePath, taskId, baseSha, headSha);
    return { taskId, branch, path: worktreePath, baseSha, headSha };
  }

  if (await branchExists(repoRoot, branch)) {
    // branch 已存在（例如先前的 worktree 目錄被清掉但 branch 還在）：checkout 既有 branch，
    // 不是重新以 baseSha 建一個新 branch。
    await git(['worktree', 'add', worktreePath, branch], repoRoot);
    const headSha = await git(['rev-parse', 'HEAD'], worktreePath);
    await assertBaseIsAncestor(worktreePath, taskId, baseSha, headSha);
    return { taskId, branch, path: worktreePath, baseSha, headSha };
  }

  await git(['worktree', 'add', '-b', branch, worktreePath, baseSha], repoRoot);
  const headSha = await git(['rev-parse', 'HEAD'], worktreePath);
  return { taskId, branch, path: worktreePath, baseSha, headSha };
}

// ---------------------------------------------------------------------------
// 安全變更收集／驗證
// ---------------------------------------------------------------------------

export type ChangedPathStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unknown';

export interface ChangedPath {
  /** 相對於 worktree 根目錄的路徑（永遠用 `/` 分隔）。 */
  path: string;
  status: ChangedPathStatus;
  /** 目前是否為 symlink（deleted 的路徑一律回報 false，因為已經沒有檔案可以 lstat）。 */
  isSymlink: boolean;
}

/** 讀取 worktree 目前所有未 commit 的變更（含 untracked），供 validateTaskChanges 檢查。 */
export async function collectTaskChanges(worktree: string): Promise<ChangedPath[]> {
  const stdout = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree);
  const entries = stdout.split('\0').filter((entry) => entry.length > 0);
  const changes: ChangedPath[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    i++;

    let status: ChangedPathStatus;
    if (xy === '??') status = 'untracked';
    else if (xy.includes('R')) status = 'renamed';
    else if (xy.includes('C')) status = 'copied';
    else if (xy.includes('D')) status = 'deleted';
    else if (xy.includes('A')) status = 'added';
    else if (xy.includes('M')) status = 'modified';
    else status = 'unknown';

    if (status === 'renamed' || status === 'copied') {
      // porcelain -z 的 rename/copy 條目後面會多帶一個「原始路徑」條目；
      // 這裡不需要它，直接跳過，避免它被誤判成獨立的一筆變更。
      i++;
    }

    let isSymlink = false;
    if (status !== 'deleted') {
      try {
        isSymlink = lstatSync(join(worktree, path)).isSymbolicLink();
      } catch {
        isSymlink = false;
      }
    }

    changes.push({ path, status, isSymlink });
  }
  return changes;
}

const FORBIDDEN_PATH_SEGMENTS = new Set(['data', 'node_modules']);

/** 回傳拒絕理由（人類可讀），或 null 代表沒有命中任何固定禁止規則。 */
function forbiddenReason(path: string): string | null {
  const segments = path.split('/');
  const basename = segments[segments.length - 1];
  if (basename.startsWith('.jar-')) return '.jar-* 是保留的暫存檔案命名，不得被 commit';
  if (basename.startsWith('.tmp-')) return '.tmp-* 是保留的暫存檔案命名，不得被 commit';
  for (const segment of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) return `路徑包含禁止的目錄／檔名 "${segment}"`;
  }
  return null;
}

/** `prefix` 可以是目錄前綴（建議以 `/` 結尾）或單一精確檔案路徑。 */
function matchesAllowedPrefix(path: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * 驗證一批變更是否全部落在允許範圍內。任何一筆不符合就立刻 throw（fail-fast），
 * 不會回傳「哪些通過、哪些沒通過」的部分結果——呼叫端要嘛全部合法才能繼續，
 * 要嘛整批拒絕。
 *
 * 拒絕規則：
 * - `.jar-*` / `.tmp-*` 暫存檔案命名。
 * - 路徑含 `data/` 或 `node_modules` 目錄／檔名區段。
 * - 不落在任何一個 `allowedPrefixes` 底下的路徑（宣告 scope 以外）。
 * - 任何新增的 symlink——目前完全沒有「明確允許某個精確路徑的新 symlink」的機制，
 *   所以一律拒絕（最安全的預設值：不存在就不會被濫用）。
 */
export function validateTaskChanges(changes: ChangedPath[], allowedPrefixes: string[]): void {
  for (const change of changes) {
    const reason = forbiddenReason(change.path);
    if (reason) {
      throw new Error(`validateTaskChanges: rejected "${change.path}" (${reason})`);
    }
    if (change.isSymlink) {
      throw new Error(
        `validateTaskChanges: rejected "${change.path}" (new symlink is never permitted for any exact path)`,
      );
    }
    const inScope = allowedPrefixes.some((prefix) => matchesAllowedPrefix(change.path, prefix));
    if (!inScope) {
      throw new Error(`validateTaskChanges: rejected "${change.path}" (outside declared allowedPrefixes scope)`);
    }
  }
}

// ---------------------------------------------------------------------------
// 提交已驗證的變更
// ---------------------------------------------------------------------------

/**
 * 把已經通過 validateTaskChanges 的路徑 commit 進 task 自己的 worktree。
 *
 * - 只 `git add -- <paths>`（明確列出的精確路徑），永遠不呼叫 `git add -A`——
 *   任何呼叫端沒有明確驗證、明確列出的檔案，即使是 untracked，也不會被掃進這次 commit。
 * - `git add` 之後一定跑 `git diff --cached --check`；有 whitespace 錯誤就直接
 *   throw、不建立 commit。
 * - commit message 帶 `Task-Id: <taskId>` trailer，供未來驗收鏈（policy.ts 的
 *   `acceptedHead.hasTaskIdTrailer`）比對。
 *
 * 回傳新建立的 commit SHA。
 */
export async function commitTaskChanges(
  worktree: string,
  taskId: string,
  title: string,
  paths: string[],
): Promise<string> {
  if (paths.length === 0) {
    throw new Error('commitTaskChanges: paths must not be empty');
  }

  // Defense-in-depth：即使呼叫端忘記先跑 validateTaskChanges，這裡仍拒絕明顯違規的路徑
  // （沒有 allowedPrefixes 可比對，所以不重做 scope 檢查，但固定禁止規則與 symlink
  // 檢查都直接對 worktree 上的真實檔案重新做一次，不依賴呼叫端有沒有先驗證過）。
  for (const path of paths) {
    const reason = forbiddenReason(path);
    if (reason) {
      throw new Error(`commitTaskChanges: refusing to stage "${path}" (${reason})`);
    }
    let isSymlink = false;
    try {
      isSymlink = lstatSync(join(worktree, path)).isSymbolicLink();
    } catch {
      isSymlink = false; // 檔案已經不存在（例如刪除的路徑）：沒有東西可以是 symlink
    }
    if (isSymlink) {
      throw new Error(`commitTaskChanges: refusing to stage "${path}" (new symlink is never permitted)`);
    }
  }

  await execFileAsync('git', ['add', '--', ...paths], { cwd: worktree });

  try {
    await execFileAsync('git', ['diff', '--cached', '--check'], { cwd: worktree });
  } catch (err) {
    throw new Error(
      `commitTaskChanges: "git diff --cached --check" failed for task ${taskId} (whitespace error in staged changes)`,
      { cause: err },
    );
  }

  const message = `${title}\n\nTask-Id: ${taskId}`;
  await execFileAsync('git', ['commit', '-m', message], { cwd: worktree });

  return git(['rev-parse', 'HEAD'], worktree);
}

// ---------------------------------------------------------------------------
// CI cache key
// ---------------------------------------------------------------------------

/**
 * 純函式：由 baseSha、headSha 與完整 verification command list 算出一個
 * 確定性 cache key。三者中任一改變，key 就必須改變；相同輸入永遠得到相同 key。
 */
export function ciCacheKey(baseSha: string, headSha: string, commands: string[]): string {
  return createHash('sha256').update(JSON.stringify([baseSha, headSha, commands])).digest('hex');
}

// ---------------------------------------------------------------------------
// Member verification command allowlist
// ---------------------------------------------------------------------------

/** 固定字面字串形式的合法 verification command（不含帶 `<name>` 樣板的兩種）。 */
export const ALLOWED_VERIFICATION_COMMANDS: readonly string[] = [
  'npx tsc --noEmit',
  'npx tsc -p sim/tsconfig.json --noEmit',
  'npm test',
  'npm run build',
  'git diff --check',
];

// `<name>` 只允許單一層、不含路徑分隔符與 `.` 的安全識別字——天生就排除
// path traversal（`..`）與多層路徑（`sim/foo/bar.test.ts`）。
const TEST_COMMAND_RE = /^npx tsx (?:src|sim)\/[A-Za-z0-9_][A-Za-z0-9_-]*\.test\.ts$/;

/**
 * 判斷一個 member verification command 是否落在固定 allowlist 內。只允許
 * 步驟 4 列出的 7 種形式（其中 2 種帶 `<name>` 樣板）；其餘一律拒絕，包含任何
 * 多帶的 flag、shell 分隔符（`;`、`&&`）或路徑跳脫（`..`）。
 */
export function isAllowedVerificationCommand(command: string): boolean {
  if (ALLOWED_VERIFICATION_COMMANDS.includes(command)) return true;
  return TEST_COMMAND_RE.test(command);
}
