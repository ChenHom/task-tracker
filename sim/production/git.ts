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
import { existsSync, lstatSync, rmSync } from 'node:fs';
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

// =============================================================================
// 任務 6：部署 readback（唯一允許的 systemd 互動：讀取狀態，永遠不 start／stop 任何
// unit）。這裡只定義可注入的介面與純粹依賴注入的等待／逾時決議邏輯——真正呼叫
// `systemctl show` 的實作、真正的 `/api/health` HTTP 呼叫，都是呼叫端（未來任務 8 的
// CLI）的責任，這個檔案本身不 import node:http、不 shell out 呼叫 systemctl。
// =============================================================================

/**
 * 等待部署 readback 逾時固定 35 分鐘：必須嚴格大於 sim-autodeploy.sh 最長 30 分鐘的
 * `pgrep sim/run.ts` 等待，否則一次正常、只是恰好撞上 sweep in-flight 的部署會被誤判
 * 逾時。這個大小關係由 sim/production/state.ts 的 LEASE_TTL_MS 與
 * production.test.ts 共同斷言（LEASE_TTL_MS 必須嚴格大於這個值）。
 */
export const DEPLOY_WAIT_TIMEOUT_MS = 35 * 60 * 1000;

/**
 * `systemctl show sim-autodeploy.path` / `systemctl show sim-autodeploy.service` 讀回的
 * 精簡快照。真正的實作（未來任務 8）會 shell out 呼叫 `systemctl --user show`
 * 並解析對應欄位；這裡的呼叫端一律注入假函式，回傳測試想模擬的任何組合。
 */
export interface SystemdReadback {
  /** `sim-autodeploy.path` 目前是否為 active（沒有它，merge／revert 完全不會被觸發）。 */
  pathActive: boolean;
  /** `sim-autodeploy.service` 目前的 ActiveState，正常情況只會是 'active' 或 'inactive'。 */
  serviceActiveState: string;
  /** 這次（或上一次）invocation 的 systemd InvocationID。 */
  invocationId: string;
  /** 這次（或上一次）invocation 的 ExecMainStartTimestampMonotonic（單調遞增）。 */
  execMainStartTimestampMonotonic: number;
  /** systemd 回報的 Result（例如 'success'、'exit-code'……）。 */
  result: string;
  /** ExecMainStatus：service 的 main process exit code。 */
  execMainStatus: number;
  /** `sim-autodeploy.sh` 寫入的 `deployed_rev` 狀態檔內容。 */
  deployedRev: string;
}

/** 可注入的 systemd readback 讀取器：一律唯讀，永遠不會、也不應該去 start／stop 任何 unit。 */
export type GetSystemdReadback = () => Promise<SystemdReadback>;

/** `/api/health` 的精簡形狀（呼應 api.ts 的 TaskTrackerClient.health()，但這裡永遠是注入的假函式）。 */
export interface HealthCheckResult {
  status: string;
  db: boolean;
  rev: string;
}

export type CheckHealth = () => Promise<HealthCheckResult>;

/** merge／revert 前擷取的 baseline：判斷「有沒有出現新一輪 invocation」唯一的比對基準。 */
export interface DeployWaitBaseline {
  invocationId: string;
  execMainStartTimestampMonotonic: number;
}

export type DeployWaitResult =
  | {
      outcome: 'success';
      targetSha: string;
      invocationId: string;
      deployedRev: string;
      healthRev: string;
      /**
       * true 代表這次成功是逾時後改以 deployed_rev／health rev 比對決議出來的
       * （這一輪 invocation 可能是遺漏觸發後的人工 start，或單純 readback 延遲），
       * 不是我們親眼觀察到「新 invocation 結束」而確認的。
       */
      deployObservedOutOfBand: boolean;
    }
  | { outcome: 'deployment_failure'; targetSha: string; reason: string }
  | { outcome: 'deployment_indeterminate'; targetSha: string; reason: string };

export interface WaitForDeploymentInput {
  targetSha: string;
  baseline: DeployWaitBaseline;
  getReadback: GetSystemdReadback;
  checkHealth: CheckHealth;
  /** 目前時間來源（毫秒）。真正實作可以是 `() => Date.now()`；測試一律注入假時鐘。 */
  now: () => number;
  /** 每輪 poll 之間的延遲注入點；測試一律注入近乎零延遲的假函式，不真的 sleep。 */
  sleep?: (ms: number) => Promise<void>;
  /** 真正實作的 poll 間隔；純測試邏輯不關心這個值（sleep 已經被注入成近乎零延遲）。 */
  pollIntervalMs?: number;
}

function isNewFinishedInvocation(reading: SystemdReadback, baseline: DeployWaitBaseline): boolean {
  // 兩個訊號都必須同時成立才算「真的出現新一輪 invocation」：只看 timestamp 遞增，
  // 萬一注入的假資料打錯只改了一個欄位，也不會被誤判成新的一輪；只看 invocationId
  // 不同，也無法排除時鐘倒退之類的異常快照。只要有一個訊號還沒動，就保守地當作
  // 「還是先前那一輪」繼續等，寧可多等一輪、逾時後仍有三路決議兜底，也不要在訊號
  // 互相矛盾時貿然判定「新一輪已經結束」——這正是「不能把先前 invocation 或第二次
  // 重試誤認為目前 generation 的成功」這條要求的核心。
  const invocationChanged = reading.invocationId !== baseline.invocationId;
  const timestampAdvanced = reading.execMainStartTimestampMonotonic > baseline.execMainStartTimestampMonotonic;
  if (!invocationChanged || !timestampAdvanced) return false;
  return reading.serviceActiveState !== 'active';
}

/** 一輪新 invocation 真的結束了：檢查它自己的 Result／ExecMainStatus，再核對 deployed_rev 與 health rev。 */
async function resolveFinishedInvocation(
  reading: SystemdReadback,
  targetSha: string,
  checkHealth: CheckHealth,
): Promise<DeployWaitResult> {
  if (reading.result !== 'success' || reading.execMainStatus !== 0) {
    return {
      outcome: 'deployment_failure',
      targetSha,
      reason:
        `path-triggered invocation ${reading.invocationId} 結束但 result=${JSON.stringify(reading.result)}` +
        ` execMainStatus=${reading.execMainStatus}（非 success/0）`,
    };
  }
  if (reading.deployedRev !== targetSha) {
    return {
      outcome: 'deployment_failure',
      targetSha,
      reason: `invocation ${reading.invocationId} 回報 success，但 deployed_rev=${reading.deployedRev} 不等於 target ${targetSha}`,
    };
  }
  const health = await checkHealth();
  if (health.status !== 'ok' || health.db !== true || health.rev !== targetSha) {
    return {
      outcome: 'deployment_failure',
      targetSha,
      reason:
        `invocation 與 deployed_rev 都通過，但 /api/health 不符：status=${health.status} db=${health.db} ` +
        `rev=${health.rev}（要求 status=ok, db=true, rev=${targetSha}）`,
    };
  }
  return {
    outcome: 'success',
    targetSha,
    invocationId: reading.invocationId,
    deployedRev: reading.deployedRev,
    healthRev: health.rev,
    deployObservedOutOfBand: false,
  };
}

/**
 * 逾時後的三路決議（步驟 5）：不得直接判定 deployment failure，必須先看
 * deployed_rev／health rev 是否已經悄悄收斂，再看 service 是否仍 active。
 */
async function resolveDeployWaitTimeout(
  reading: SystemdReadback,
  targetSha: string,
  checkHealth: CheckHealth,
): Promise<DeployWaitResult> {
  if (reading.deployedRev === targetSha) {
    const health = await checkHealth();
    if (health.rev === targetSha) {
      return {
        outcome: 'success',
        targetSha,
        invocationId: reading.invocationId,
        deployedRev: reading.deployedRev,
        healthRev: health.rev,
        deployObservedOutOfBand: true,
      };
    }
  }
  if (reading.serviceActiveState === 'active') {
    return {
      outcome: 'deployment_indeterminate',
      targetSha,
      reason:
        `等待 ${DEPLOY_WAIT_TIMEOUT_MS}ms 後逾時：deployed_rev=${reading.deployedRev}（要求 ${targetSha}），` +
        `但 sim-autodeploy.service 仍是 active——決議延後到下一個 tick 以同一 target SHA 重新 readback`,
    };
  }
  return {
    outcome: 'deployment_failure',
    targetSha,
    reason:
      `等待 ${DEPLOY_WAIT_TIMEOUT_MS}ms 後逾時：deployed_rev=${reading.deployedRev}（要求 ${targetSha}），` +
      `且 sim-autodeploy.service 已 inactive——確認 .path 觸發遺漏`,
  };
}

/**
 * 唯一的部署 readback 等待／逾時決議函式：merge-wait 與 revert-wait 都呼叫這一個
 * 函式，不得各自維護一份等價邏輯。
 *
 * 每一輪呼叫 `getReadback()`：
 * - 若讀到「相對 baseline 是新一輪、且已經跑完」的 invocation，立刻依那一輪自己的
 *   Result／ExecMainStatus／deployed_rev／health rev 決議（成功或失敗），絕不再多跑
 *   一輪去掩蓋這次觀察到的結果。
 * - 否則檢查是否已經超過 DEPLOY_WAIT_TIMEOUT_MS；若尚未超過就 sleep 一輪再繼續 poll；
 *   若已超過，改用最後一次 reading 做三路逾時決議（見 resolveDeployWaitTimeout）。
 *
 * `now` 與 `sleep` 都是注入點：測試餵入近乎零延遲的假 sleep，並用假時鐘（例如每次
 * `getReadback` 呼叫時順手把假時鐘往前推）模擬「34 分鐘後成功」「35 分鐘後逾時」等
 * 邊界情境，全程不需要真的等待任何時間。
 */
export async function waitForDeployment(input: WaitForDeploymentInput): Promise<DeployWaitResult> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = input.pollIntervalMs ?? 5000;
  const waitStartedAt = input.now();

  for (;;) {
    const reading = await input.getReadback();

    if (isNewFinishedInvocation(reading, input.baseline)) {
      return resolveFinishedInvocation(reading, input.targetSha, input.checkHealth);
    }

    const elapsed = input.now() - waitStartedAt;
    if (elapsed >= DEPLOY_WAIT_TIMEOUT_MS) {
      return resolveDeployWaitTimeout(reading, input.targetSha, input.checkHealth);
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * merge／revert 前的必要前置條件：`.path` 必須 active（沒有它就沒有任何觸發器在監看
 * ref 變化），`.service` 必須不是 active（代表沒有前一輪 invocation 可能還在跑）。
 * 不符合就直接 throw，呼叫端必須在丟出這個之後完全不做任何 mutation（不 merge、
 * 不 revert）。這裡永遠不會、也不允許把「不符合」偷偷改成呼叫 `systemctl start`
 * 去讓它符合——這個檔案沒有任何路徑會建構 systemctl 的 start 指令。
 */
export function assertSystemdReadyForDeploy(readback: SystemdReadback, label: string): void {
  if (!readback.pathActive) {
    throw new Error(`${label}: sim-autodeploy.path 不是 active——沒有可觸發部署的機制，拒絕繼續`);
  }
  if (readback.serviceActiveState === 'active') {
    throw new Error(`${label}: sim-autodeploy.service 仍是 active——可能還有前一輪 invocation 在跑，拒絕繼續`);
  }
}

// =============================================================================
// 任務 6：整合／合併／回退——真正的 git 操作（這個檔案是唯一允許 shell out 的地方）。
// =============================================================================

/** `sim-work/integration/<taskId>` 底下、用完即丟的暫時 worktree，只用來偵測合併衝突。 */
export interface IntegrationWorktree {
  path: string;
  conflict: boolean;
  conflictDetail: string | null;
}

function integrationWorktreePath(repoRoot: string, taskId: string): string {
  assertSafeTaskId(taskId);
  return join(repoRoot, 'sim-work', 'integration', taskId);
}

/** `worktreePath` 目前是否已經被 `repoRoot` 註冊成一個 linked worktree（不論目錄本身還在不在）。 */
async function isPathRegisteredAsWorktree(repoRoot: string, worktreePath: string): Promise<boolean> {
  const list = await git(['worktree', 'list', '--porcelain'], repoRoot);
  return list.split('\n').some((line) => line === `worktree ${worktreePath}`);
}

/**
 * 強制清掉 `repoRoot` 底下、路徑為 `worktreePath` 的 linked worktree——不論它現在是
 * 正常註冊狀態、卡在合併衝突處理到一半，還是目錄已經被手動刪掉但 git 的
 * `.git/worktrees/…` metadata 還留著。`createIntegrationWorktree` 用它防禦性地清掉
 * 上一次可能殘留的暫時 worktree；`removeIntegrationWorktree` 用它做正常收尾清理——
 * 兩邊共用同一份邏輯，不重寫兩次。
 */
async function forceRemoveWorktreeAt(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
  } catch {
    // worktree 可能因為合併衝突處理、或上一次呼叫被中斷（OOM／host reboot／
    // SIGKILL）而留在奇怪狀態：用 rmSync 兜底清掉目錄本身，再讓 git 自己的
    // metadata（.git/worktrees/…）跟上真正的檔案系統狀態。
    rmSync(worktreePath, { recursive: true, force: true });
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot });
    } catch {
      // ignore：prune 失敗不影響正確性，只是留下不會再被使用的 metadata。
    }
  }
}

/**
 * 在一個獨立、用完即丟的臨時 worktree（從目前 master HEAD detach 出來）裡，嘗試把
 * taskBranch `merge --no-ff --no-commit` 進去，純粹用來偵測合併衝突
 * （"integration conflict" fixture）——完全不影響 repoRoot 真正的 master branch，
 * 也不會在這個暫時 worktree 留下任何 commit。呼叫端必須在使用完畢後（不論衝突與否）
 * 呼叫 removeIntegrationWorktree 清掉它。
 *
 * 這個 worktree 永遠是用完即丟、detached 的：每次呼叫都應該從乾淨狀態開始，沒有
 * 「重用既有內容」的語意（不像 ensureTaskWorktree 那樣要保留跨呼叫、已 commit 的
 * task 工作）。如果 coordinator process 在上一次呼叫、清理跑到之前就被中斷
 * （OOM、host reboot、systemctl stop、SIGKILL），這個路徑底下可能會殘留一個舊的
 * 暫時 worktree——若不先清掉，`git worktree add` 會直接對著已存在的路徑／已註冊的
 * worktree 拋出未結構化的 error，讓這個 task 的部署路徑永久卡死到需要人工手動
 * `git worktree remove --force` 才能恢復。因此每次呼叫都先防禦性偵測並清掉任何
 * 殘留，再從乾淨狀態重新建立。
 */
export async function createIntegrationWorktree(
  repoRoot: string,
  taskId: string,
  taskBranch: string,
): Promise<IntegrationWorktree> {
  const masterSha = await git(['rev-parse', 'master'], repoRoot);
  const worktreePath = integrationWorktreePath(repoRoot, taskId);

  if (existsSync(worktreePath) || (await isPathRegisteredAsWorktree(repoRoot, worktreePath))) {
    await forceRemoveWorktreeAt(repoRoot, worktreePath);
  }

  await git(['worktree', 'add', '--detach', worktreePath, masterSha], repoRoot);
  try {
    await git(['merge', '--no-ff', '--no-commit', taskBranch], worktreePath);
  } catch (err) {
    try {
      await execFileAsync('git', ['merge', '--abort'], { cwd: worktreePath });
    } catch {
      // best-effort：即使 abort 也失敗，removeIntegrationWorktree 仍會強制清掉整個目錄。
    }
    return { path: worktreePath, conflict: true, conflictDetail: (err as Error).message };
  }
  return { path: worktreePath, conflict: false, conflictDetail: null };
}

/** 清掉 createIntegrationWorktree 建立的暫時 worktree；不論成功或衝突都必須呼叫。 */
export async function removeIntegrationWorktree(repoRoot: string, worktree: IntegrationWorktree): Promise<void> {
  await forceRemoveWorktreeAt(repoRoot, worktree.path);
}

/**
 * 把 taskBranch 真正合併進 repoRoot 的 master（`--no-ff`，保留可回溯、可 revert 的
 * merge commit）。呼叫前防禦性確認 repoRoot 目前真的 checkout 在 master 上——這個
 * repoRoot 永遠是 sim-autodeploy.path 監看的唯一 master checkout，這裡不重新推導
 * 這個不變量，只是不盲目信任它。回傳新的 master HEAD（mergeSha）。
 */
export async function mergeTaskIntoMaster(repoRoot: string, taskBranch: string, taskId: string): Promise<string> {
  const currentBranch = await git(['symbolic-ref', '--short', 'HEAD'], repoRoot);
  if (currentBranch !== 'master') {
    throw new Error(
      `mergeTaskIntoMaster: repoRoot 目前 checkout 在 "${currentBranch}"，不是 "master"——拒絕合併`,
    );
  }
  await git(['merge', '--no-ff', taskBranch, '-m', `merge ${taskId}`], repoRoot);
  return git(['rev-parse', 'HEAD'], repoRoot);
}

export type RevertMasterMergeResult = { ok: true; revertSha: string } | { ok: false; reason: string };

/**
 * Revert 一個已經合併進 master 的 merge commit（`git revert -m 1 --no-edit`）。
 * 呼叫前先確認 master 目前的 HEAD 真的還是 mergeSha——如果在等待部署 readback 期間
 * master 又被別的東西推進了（不該發生，但不能盲目相信呼叫端的假設），拒絕 revert
 * 並回報原因，交由呼叫端把這個當成需要人工介入的訊號，而不是 revert 一個可能完全
 * 不相干的 commit。
 */
// =============================================================================
// 任務 8：唯讀 ancestry／commit message 查詢（供 production.ts 驗證
// `00123ef0...` 的完成證據鏈——acceptedHead.hasTaskIdTrailer、
// acceptedMerge.headIsAncestor、liveRevIsMergeOrDescendant）。純讀取，
// 不修改任何 ref、不建立 worktree。
// =============================================================================

/** `ancestorSha` 是否真的是 `descendantSha` 的祖先（或就是同一個 commit）。唯讀查詢，不 throw。 */
export async function isAncestor(repoRoot: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
  if (ancestorSha === descendantSha) return true;
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestorSha, descendantSha], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

/** 讀取一個 commit 的完整 commit message（供呼叫端檢查 `Task-Id:` trailer 等）。 */
export async function getCommitMessage(repoRoot: string, sha: string): Promise<string> {
  return git(['log', '-1', '--format=%B', sha], repoRoot);
}

/** 解析任一 ref（預設 `HEAD`）目前指向的 commit SHA。唯讀查詢。 */
export async function getHeadSha(repoRoot: string, ref = 'HEAD'): Promise<string> {
  return git(['rev-parse', ref], repoRoot);
}

export async function revertMasterMerge(repoRoot: string, mergeSha: string): Promise<RevertMasterMergeResult> {
  const currentHead = await git(['rev-parse', 'master'], repoRoot);
  if (currentHead !== mergeSha) {
    return {
      ok: false,
      reason: `master HEAD (${currentHead}) 已經不等於預期的 mergeSha (${mergeSha})——拒絕 revert 可能不相干的 commit`,
    };
  }
  await git(['revert', '-m', '1', '--no-edit', mergeSha], repoRoot);
  const revertSha = await git(['rev-parse', 'HEAD'], repoRoot);
  return { ok: true, revertSha };
}
