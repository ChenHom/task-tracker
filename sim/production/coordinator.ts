// 正式環境 sim 協調器的卡關轉移／Owner 介入狀態機。
//
// 目前範圍刻意窄：只處理「連續多次 member attempt 都沒有可驗證進展時，該不該
// enqueue Owner intervention、該不該轉入 human_blocked」這一件事（計畫任務 5
// 步驟 5）。整合／部署／完成通知／真正的 tick loop 是之後任務（6／7／8）的責任，
// 屆時會繼續擴充這個檔案，這裡不預先蓋範圍。
//
// 純函式、零 I/O：不 import node:sqlite、node:http 或 git.ts。no-progress 計數、
// Owner intervention 門檻與 human_blocked 判斷全部委派給 policy.ts 既有的
// recordMemberAttempt／shouldResumeHumanBlocked——這裡不重寫那套邏輯，只負責把
// agent.ts 的 MemberSessionResult.evidenceChanged 原封不動傳給 policy.ts 的
// recordMemberAttempt（不自己另外從 outcome 重新推導一次），並在真的轉入
// human_blocked 的那一刻，產生一則唯一、可去重的 @user09 留言內容。
import type { DatabaseSync } from 'node:sqlite';
import type { TaskRun } from './types';
import type { Tracer } from '../trace';
import { recordMemberAttempt, shouldResumeHumanBlocked, taskEvidenceFingerprint, type TaskEvidence } from './policy';
import type { MemberSessionResult } from './agent';
import {
  waitForDeployment,
  assertSystemdReadyForDeploy,
  createIntegrationWorktree,
  removeIntegrationWorktree,
  mergeTaskIntoMaster,
  revertMasterMerge,
  type SystemdReadback,
  type GetSystemdReadback,
  type CheckHealth,
  type DeployWaitBaseline,
} from './git';
import {
  listUnbatchedCompletions,
  assignBatch,
  listPendingBatchIds,
  getCompletionsByBatch,
  recordBatchAttempt,
} from './state';

export interface HumanBlockedNotice {
  /**
   * action_log 的去重 key：同一次卡關轉移永遠得到同一把 key（純函式於
   * taskId + noProgressCount），重複呼叫（例如 driver 重跑同一個 tick、或
   * action_log 因為並發被重送）必須撞到相同 key 而不是造出第二則留言。
   */
  actionKey: string;
  content: string;
}

export interface MemberAttemptTransition {
  run: TaskRun;
  /** 這次呼叫是否剛好讓 ownerIntervened 從 false 變成 true——該去 enqueue 一次 Owner intervention。 */
  ownerInterventionRequested: boolean;
  /** 非 null 代表這次呼叫剛好讓 phase 轉成 human_blocked——內容即唯一、去重用的 @user09 留言。 */
  humanBlockedNotice: HumanBlockedNotice | null;
}

export const HUMAN_BLOCKED_ACTION_KIND = 'human_blocked_notice';

/** human_blocked 通知的 action key：taskId + noProgressCount，同一次卡關轉移永遠得到同一把 key。 */
export function humanBlockedActionKey(taskId: string, noProgressCount: number): string {
  return `${HUMAN_BLOCKED_ACTION_KIND}:${taskId}:${noProgressCount}`;
}

function buildHumanBlockedNotice(run: TaskRun, session: MemberSessionResult): HumanBlockedNotice {
  const blockerText = session.output.blocker ?? '（member session 未回報明確 blocker）';
  const actionKey = humanBlockedActionKey(run.taskId, run.noProgressCount);
  const content =
    `@user09 這個 task 已卡關，需要人工介入。\n` +
    `連續 ${run.noProgressCount} 次 member attempt 都沒有可驗證的進展（已含一次 Owner 介入後的最後嘗試）。\n` +
    `最近一次回報的 blocker：${blockerText}\n` +
    `task status／assignee 保持不變；在你留言或出現尚未記錄的人工 task 變更之前，不會再排入任何 AI action。\n` +
    `action_key: ${actionKey}`;
  return { actionKey, content };
}

/**
 * 把一次 member session 的獨立驗證結果（agent.ts 的 MemberSessionResult）套進
 * policy.ts 既有的 no-progress／Owner intervention／human_blocked 狀態機，並在
 * 剛好轉入 human_blocked 的那一刻，把「目前板面證據」的 fingerprint 寫回 TaskRun、
 * 產生唯一的 @user09 留言內容。
 *
 * 這裡直接消費 `session.evidenceChanged`（不會自己另外從 `session.outcome` 重新
 * 推導一次）——agent.ts 的 MemberSessionResult 已經明文定義 `evidenceChanged` 就是
 * 餵給這裡的權威訊號，兩邊各寫一份等價邏輯只會製造「文件說的資料流」與「程式碼真正
 * 的資料流」不一致的風險：agent.ts 未來若讓 `evidenceChanged` 的判斷比目前的
 * `outcome === 'progressed'` 更細緻，這裡完全不需要跟著改。目前的判斷邏輯（見
 * agent.ts）仍然是：只有跨過完整成功門檻（已驗證 commit + verification PASS +
 * driver 摘要留言 + Doing -> Review readback）才代表這個 task 的板面狀態真的往前
 * 走了；一個「這次 blocker 文字換了、但仍然沒有任何可驗證副作用」的 session 依然是
 * 卡住的，不應該重置 noProgressCount——否則 AI 只要每次講不同的藉口就能無限期避開
 * Owner 介入與 human_blocked 升級，違背這整個 subsystem 要防的「假裝有進展」反模式。
 *
 * `currentEvidence` 代表呼叫端（未來真正呼叫 API 的那一層；這裡永遠是呼叫端自行
 * 組好或測試注入的快照）目前讀到的板面證據（留言／狀態／期限）。只有在這次呼叫
 * 剛好轉入 human_blocked 時才會用到它，寫進 evidenceFingerprint 當作「卡關當下」的
 * 基準，讓之後的 shouldResumeFromHumanBlocked 只在真的出現新證據（新留言、期限
 * 事件，或未記錄的人工 task mutation）時才判定可恢復——不會因為卡關前後板面完全沒變
 * 就立刻誤判「可以恢復」。
 */
export function recordMemberSessionAttempt(
  run: TaskRun,
  session: MemberSessionResult,
  currentEvidence: TaskEvidence,
): MemberAttemptTransition {
  const evidenceChanged = session.evidenceChanged;
  const wasIntervened = run.ownerIntervened;
  const wasBlocked = run.phase === 'human_blocked';

  let updatedRun = recordMemberAttempt(run, evidenceChanged);

  const ownerInterventionRequested = !wasIntervened && updatedRun.ownerIntervened;

  let humanBlockedNotice: HumanBlockedNotice | null = null;
  if (!wasBlocked && updatedRun.phase === 'human_blocked') {
    updatedRun = { ...updatedRun, evidenceFingerprint: taskEvidenceFingerprint(currentEvidence) };
    humanBlockedNotice = buildHumanBlockedNotice(updatedRun, session);
  }

  return { run: updatedRun, ownerInterventionRequested, humanBlockedNotice };
}

/**
 * human_blocked 是否應該恢復——直接委派給 policy.ts 既有的比對邏輯，這裡不重寫
 * 任何 fingerprint 比對規則。存在的理由只是把「coordinator 該問 policy.ts 什麼問題」
 * 講清楚、可以獨立於 recordMemberSessionAttempt 被呼叫與測試。
 */
export function shouldResumeFromHumanBlocked(run: TaskRun, currentEvidence: TaskEvidence): boolean {
  return shouldResumeHumanBlocked(run, currentEvidence);
}

// =============================================================================
// 任務 6：整合、部署 readback 與自動 revert。
//
// 這裡實作計畫步驟 3（固定 acceptance sequence）與步驟 4（失敗復原／revert／fatal
// 升級）的「協調」部分——真正的 git merge／revert／worktree 操作，以及唯一的
// systemd readback 等待／逾時決議函式（waitForDeployment），都定義在 git.ts；這裡
// 只負責照著固定順序呼叫它們，並把 CI 步驟、systemd readback、health check 這三種
// 「正式環境會是真正呼叫」但這個 subsystem 目前永遠是注入假函式的動作串起來。
//
// 部署 revision 通過 readback 前，這裡的函式完全不 import、也不呼叫任何
// TaskTrackerClient／看板 API——這個邊界不是靠檢查達成的，而是靠「這個檔案的簽名
// 裡根本沒有能做那件事的參數」達成的（呼應 agent.ts 的 OwnerSession 唯讀契約）。
// =============================================================================

/** 任一 acceptance／task-specific／live 驗收步驟的注入結果：pass/fail + 人類可讀細節。 */
export interface AcceptanceCheckResult {
  passed: boolean;
  detail: string;
}

/** 正式環境會是真正跑檢查的實作；這裡永遠是呼叫端（測試）注入的假函式。 */
export type AcceptanceCheck = () => Promise<AcceptanceCheckResult>;

/** 在暫時 integration worktree 裡執行單一指令（npm test／npm run build／git diff --check）的注入器。 */
export type IntegrationCommandRunner = (
  command: string,
  worktreePath: string,
) => Promise<{ exitCode: number; output: string }>;

/** 固定順序：對應計畫步驟 3 的 `npm test -> npm run build -> git diff --check`。 */
const INTEGRATION_COMMANDS: readonly string[] = ['npm test', 'npm run build', 'git diff --check'];

/**
 * Coordinator 記錄在案的致命錯誤：只有 rollback invocation 明確失敗，或
 * DeploymentIndeterminate 連續兩個 tick 仍未收斂時才會產生（見
 * resolveRollbackWait）。一旦存在，`assertNoFatalCoordinatorError` 必須讓後續所有
 * AI／mutation action 一律拒絕，直到人工清除。這裡不持久化它（state.ts 不在本任務的
 * 檔案清單內）——由呼叫端負責保存並在下一次呼叫任何 mutation 前重新餵回來。
 */
export interface FatalCoordinatorError {
  taskId: string;
  sha: string;
  reason: string;
}

/** 任何後續 AI／mutation action 的呼叫端，都必須在動手前先呼叫這個 guard。 */
export function assertNoFatalCoordinatorError(fatal: FatalCoordinatorError | null): void {
  if (fatal) {
    throw new Error(
      `coordinator fatal error 已經記錄在案（task ${fatal.taskId}, sha ${fatal.sha}）：${fatal.reason}——` +
        `在人工清除這個錯誤之前，拒絕執行任何後續 AI／mutation action`,
    );
  }
}

export interface RunDeployAcceptanceInput {
  taskId: string;
  repoRoot: string;
  taskBranch: string;
  /** 非 null 代表這個 task 已經有記錄在案的 fatal error——整個函式立刻拒絕、不執行任何步驟。 */
  existingFatalError: FatalCoordinatorError | null;
  runBranchCi: AcceptanceCheck;
  runIntegrationCommand: IntegrationCommandRunner;
  runTaskSpecificAcceptance: AcceptanceCheck;
  getSystemdReadback: GetSystemdReadback;
  checkHealth: CheckHealth;
  runTaskLiveAcceptance: AcceptanceCheck;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * 選填：只有 production.ts 這一個正式呼叫端會傳，測試不傳。ci.checked 的成功案例
   * 從回傳值看不出來（DeployAcceptanceResult 只回報第一個失敗），所以必須掛在這裡面。
   */
  trace?: Tracer;
}

export type DeployAcceptanceResult =
  | { kind: 'fatal_blocked'; fatal: FatalCoordinatorError }
  | { kind: 'branch_ci_failed'; detail: string }
  | { kind: 'integration_conflict'; detail: string }
  | { kind: 'integration_command_failed'; command: string; detail: string }
  | { kind: 'task_specific_acceptance_failed'; detail: string }
  | { kind: 'deploy_precondition_failed'; detail: string }
  | { kind: 'deployed'; mergeSha: string; deployObservedOutOfBand: boolean }
  | { kind: 'deploy_indeterminate'; targetSha: string; detail: string }
  | { kind: 'deploy_failed_post_merge'; mergeSha: string; reason: string };

/**
 * 計畫步驟 3 的固定 acceptance sequence：
 *
 *   task branch CI -> temporary integration worktree -> npm test -> npm run build
 *   -> git diff --check -> task-specific acceptance
 *   -> require path active／service inactive -> snapshot baseline -> merge --no-ff
 *   -> waitForDeployment -> task live acceptance
 *
 * 任何一步失敗立刻回傳對應的失敗 kind，不繼續往下走。merge 之後才會遇到的失敗
 * （deploy_indeterminate／deploy_failed_post_merge）由呼叫端決定下一步：
 * indeterminate 就什麼都不做、等下一個 tick 用同一個 mergeSha 重新呼叫
 * waitForDeployment（不必重新跑這整個 sequence）；failed_post_merge 則呼叫
 * `performMasterRevert` 進入步驟 4 的復原流程。
 */
export async function runDeployAcceptance(input: RunDeployAcceptanceInput): Promise<DeployAcceptanceResult> {
  if (input.existingFatalError) {
    return { kind: 'fatal_blocked', fatal: input.existingFatalError };
  }

  const branchCi = await input.runBranchCi();
  input.trace?.('ci.checked', {
    outcome: branchCi.passed ? 'ok' : 'fail',
    reason: 'branch_ci',
    evidence: { kind: 'test', ref: input.taskBranch },
    detail: branchCi.detail,
  });
  if (!branchCi.passed) {
    return { kind: 'branch_ci_failed', detail: branchCi.detail };
  }

  const integration = await createIntegrationWorktree(input.repoRoot, input.taskId, input.taskBranch);
  if (integration.conflict) {
    await removeIntegrationWorktree(input.repoRoot, integration);
    return { kind: 'integration_conflict', detail: integration.conflictDetail ?? 'merge conflict' };
  }

  try {
    for (const command of INTEGRATION_COMMANDS) {
      const result = await input.runIntegrationCommand(command, integration.path);
      input.trace?.('ci.checked', {
        outcome: result.exitCode === 0 ? 'ok' : 'fail',
        reason: 'integration',
        evidence: { kind: 'test', ref: `${command}@${integration.path}` },
        detail: result.output,
      });
      if (result.exitCode !== 0) {
        return { kind: 'integration_command_failed', command, detail: result.output };
      }
    }

    const taskSpecific = await input.runTaskSpecificAcceptance();
    input.trace?.('ci.checked', {
      outcome: taskSpecific.passed ? 'ok' : 'fail',
      reason: 'task_specific',
      evidence: { kind: 'test', ref: `task:${input.taskId}` },
      detail: taskSpecific.detail,
    });
    if (!taskSpecific.passed) {
      return { kind: 'task_specific_acceptance_failed', detail: taskSpecific.detail };
    }
  } finally {
    await removeIntegrationWorktree(input.repoRoot, integration);
  }

  const preMergeReadback = await input.getSystemdReadback();
  try {
    assertSystemdReadyForDeploy(preMergeReadback, `task ${input.taskId} pre-merge`);
  } catch (err) {
    return { kind: 'deploy_precondition_failed', detail: (err as Error).message };
  }

  const baseline: DeployWaitBaseline = {
    invocationId: preMergeReadback.invocationId,
    execMainStartTimestampMonotonic: preMergeReadback.execMainStartTimestampMonotonic,
  };

  const mergeSha = await mergeTaskIntoMaster(input.repoRoot, input.taskBranch, input.taskId);
  input.trace?.('merge.integrated', {
    evidence: { kind: 'git', ref: mergeSha },
    detail: `${input.taskBranch} --no-ff→ master`,
  });

  const waitResult = await waitForDeployment({
    targetSha: mergeSha,
    baseline,
    getReadback: input.getSystemdReadback,
    checkHealth: input.checkHealth,
    now: input.now,
    sleep: input.sleep,
  });

  if (waitResult.outcome === 'deployment_indeterminate') {
    return { kind: 'deploy_indeterminate', targetSha: mergeSha, detail: waitResult.reason };
  }
  if (waitResult.outcome === 'deployment_failure') {
    return { kind: 'deploy_failed_post_merge', mergeSha, reason: waitResult.reason };
  }

  const liveAcceptance = await input.runTaskLiveAcceptance();
  if (!liveAcceptance.passed) {
    return {
      kind: 'deploy_failed_post_merge',
      mergeSha,
      reason: `task live acceptance failed after deploy: ${liveAcceptance.detail}`,
    };
  }

  return { kind: 'deployed', mergeSha, deployObservedOutOfBand: waitResult.deployObservedOutOfBand };
}

// ---------------------------------------------------------------------------
// 步驟 4：失敗復原（revert）。
// ---------------------------------------------------------------------------

/** 去重用的 deployment-rollback 留言。 */
export interface DeploymentRollbackNotice {
  actionKey: string;
  content: string;
}

/** 去重 key：同一個 mergeSha 的 rollback 永遠得到同一把 key，重跑不會造出第二則留言。 */
export function deploymentRollbackActionKey(taskId: string, mergeSha: string): string {
  return `deployment_rollback_notice:${taskId}:${mergeSha}`;
}

function buildDeploymentRollbackNotice(
  taskId: string,
  mergeSha: string,
  revertSha: string,
  reason: string,
): DeploymentRollbackNotice {
  const actionKey = deploymentRollbackActionKey(taskId, mergeSha);
  const content =
    `@user09 這個 task 合併後的部署失敗，已自動 revert。\n` +
    `merge commit: ${mergeSha}\n` +
    `revert commit: ${revertSha}\n` +
    `失敗原因：${reason}\n` +
    `task status 維持 Review，需要人工檢視後決定下一步。\n` +
    `action_key: ${actionKey}`;
  return { actionKey, content };
}

export type PerformMasterRevertResult =
  | { kind: 'reverted'; revertSha: string; baseline: DeployWaitBaseline }
  | { kind: 'fatal'; fatal: FatalCoordinatorError };

/**
 * 步驟 4 的一次性動作：確認 master HEAD === mergeSha、確認 systemd 前置條件（path
 * active／service inactive），才真的執行 `git revert -m 1 --no-edit`，並擷取新的
 * invocation baseline。這個函式只應該對同一個 mergeSha 呼叫一次——重試收斂交給
 * `resolveRollbackWait`（用同一個 revertSha／baseline 重新 readback，不會、也不需要
 * 再 revert 第二次）。
 *
 * 任何一個前置條件不成立都直接回傳 fatal：這是失敗復原的最後一道防線，如果連它都
 * 無法安全進行，代表現況已經超出這個 subsystem 能自動處理的範圍，必須交給人工。
 */
export async function performMasterRevert(
  taskId: string,
  repoRoot: string,
  mergeSha: string,
  getSystemdReadback: GetSystemdReadback,
): Promise<PerformMasterRevertResult> {
  const readback: SystemdReadback = await getSystemdReadback();
  try {
    assertSystemdReadyForDeploy(readback, `task ${taskId} pre-revert`);
  } catch (err) {
    return {
      kind: 'fatal',
      fatal: { taskId, sha: mergeSha, reason: `refusing to revert: ${(err as Error).message}` },
    };
  }

  const revertResult = await revertMasterMerge(repoRoot, mergeSha);
  if (!revertResult.ok) {
    return { kind: 'fatal', fatal: { taskId, sha: mergeSha, reason: revertResult.reason } };
  }

  return {
    kind: 'reverted',
    revertSha: revertResult.revertSha,
    baseline: {
      invocationId: readback.invocationId,
      execMainStartTimestampMonotonic: readback.execMainStartTimestampMonotonic,
    },
  };
}

export interface ResolveRollbackWaitInput {
  taskId: string;
  mergeSha: string;
  revertSha: string;
  baseline: DeployWaitBaseline;
  getSystemdReadback: GetSystemdReadback;
  checkHealth: CheckHealth;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 前一個 tick（若有）遺留的連續 DeploymentIndeterminate 計數；第一次呼叫省略即為 0。 */
  previousRollbackIndeterminateCount?: number;
}

export type ResolveRollbackWaitResult =
  | { kind: 'rolled_back'; mergeSha: string; revertSha: string; notice: DeploymentRollbackNotice }
  | {
      kind: 'rollback_indeterminate';
      mergeSha: string;
      revertSha: string;
      rollbackIndeterminateCount: number;
      detail: string;
    }
  | { kind: 'fatal'; fatal: FatalCoordinatorError };

/**
 * 等待 revert 觸發的下一個且唯一的新 invocation（與 merge-wait 共用同一個
 * `waitForDeployment`），並套用步驟 4 的 rollback 專屬決議：
 *
 * - 成功：deployed_rev／health rev 都等於 revertSha -> `rolled_back`，附上去重的
 *   deployment-rollback 留言（task 維持 Review，由呼叫端決定要不要真的張貼）。
 * - DeploymentIndeterminate：不升級為 fatal（除非這已經是連續第二次）——呼叫端把
 *   `rollbackIndeterminateCount` 原封不動存起來，下一個 tick 用同一個
 *   revertSha／baseline 再呼叫一次這個函式（不重新 revert）。
 * - 明確失敗，或連續兩次 tick 都是 Indeterminate：`fatal`——呼叫端必須把這個
 *   FatalCoordinatorError 存起來，之後每次執行 AI／mutation action 前都用
 *   `assertNoFatalCoordinatorError` 檔下來。
 */
export async function resolveRollbackWait(input: ResolveRollbackWaitInput): Promise<ResolveRollbackWaitResult> {
  const previousCount = input.previousRollbackIndeterminateCount ?? 0;

  const waitResult = await waitForDeployment({
    targetSha: input.revertSha,
    baseline: input.baseline,
    getReadback: input.getSystemdReadback,
    checkHealth: input.checkHealth,
    now: input.now,
    sleep: input.sleep,
  });

  if (waitResult.outcome === 'success') {
    const reason = waitResult.deployObservedOutOfBand
      ? 'deployment failed post-merge; automatic revert succeeded (readback observed out-of-band)'
      : 'deployment failed post-merge; automatic revert succeeded';
    return {
      kind: 'rolled_back',
      mergeSha: input.mergeSha,
      revertSha: input.revertSha,
      notice: buildDeploymentRollbackNotice(input.taskId, input.mergeSha, input.revertSha, reason),
    };
  }

  if (waitResult.outcome === 'deployment_indeterminate') {
    const nextCount = previousCount + 1;
    if (nextCount >= 2) {
      return {
        kind: 'fatal',
        fatal: {
          taskId: input.taskId,
          sha: input.revertSha,
          reason: `rollback readback 連續 ${nextCount} 個 tick 都是 DeploymentIndeterminate：${waitResult.reason}`,
        },
      };
    }
    return {
      kind: 'rollback_indeterminate',
      mergeSha: input.mergeSha,
      revertSha: input.revertSha,
      rollbackIndeterminateCount: nextCount,
      detail: waitResult.reason,
    };
  }

  // deployment_failure：rollback invocation 本身明確失敗——立刻升級 fatal，
  // 不得再補跑第二輪去掩蓋這個結果。
  return {
    kind: 'fatal',
    fatal: { taskId: input.taskId, sha: input.revertSha, reason: `rollback deployment failed: ${waitResult.reason}` },
  };
}

// =============================================================================
// 任務 7 步驟 4：完成通知的 Discord outbox——tick 級 batch／重試。
//
// completion.ts 只處理「一個 task 的完成」；這裡處理「這次 tick 有哪些 task 剛
// 完成，該怎麼合併成一則 Discord 訊息、失敗了要不要重試」。兩者刻意分開：
// completion.ts 對 Discord 的存在一無所知，這裡也完全不碰留言／notification／
// task 狀態——Discord 傳送成敗永遠只是通知管道的事，不是任何 task 是否 Done 的
// 判準（那件事早在 completion.ts 裡就已經透過 readback 確認過了）。
// =============================================================================

/** 一次 Discord 彙整訊息：一個 batch、一組 taskId，不是每個 task 各送一則。 */
export interface DiscordBatchMessage {
  batchId: string;
  taskIds: string[];
}

/** 正式環境會是真正呼叫 Discord webhook 的實作；這裡永遠是呼叫端（測試）注入的假函式。回傳 true 代表送出成功。 */
export type SendDiscordMessage = (message: DiscordBatchMessage) => Promise<boolean>;

export interface RunDiscordOutboxTickInput {
  db: DatabaseSync;
  sendDiscordMessage: SendDiscordMessage;
  /** 產生新 batch 的 id；只有在這次 tick 真的存在尚未 batch 的 completion 時才會被呼叫。 */
  newBatchId: () => string;
  now?: Date;
}

export interface DiscordBatchOutcome {
  batchId: string;
  taskIds: string[];
  /** 沿用 state.ts CompletionStatus：'pending' 代表這次嘗試失敗但還沒到第 3 次，下次 tick 會再試。 */
  status: 'pending' | 'sent' | 'notify_failed';
  attemptCount: number;
}

/**
 * 每個 coordinator tick 都應該呼叫一次：
 *
 *   1) 把「自上次呼叫以來所有已經 Done 確認、但還沒被 batch 過」的 completion
 *      （`listUnbatchedCompletions`）合併成單一新 batch_id——這正是「同一個 tick
 *      的所有新 completion 形成單一 batch」；batch 一旦形成就是封閉集合，下一批
 *      新完成的 task 只會形成下一個新 batch，不會被塞進這個已存在的 batch。
 *   2) 對「目前所有仍是 pending 的 batch」（剛形成的新 batch，加上先前 tick 失敗、
 *      還在重試窗口內的舊 batch）各嘗試一次 Discord 傳送——每個 batch 只送一則
 *      彙整訊息。
 *   3) 每個 batch 最多嘗試 3 次（沿用 state.ts 既有的 `recordCompletionAttempt` /
 *      `MAX_COMPLETION_ATTEMPTS`，不重寫一份）；第 3 次仍失敗後這個 batch 轉為
 *      `notify_failed`，下一次呼叫 `listPendingBatchIds` 就不會再看到它——不會再
 *      自動重試、不會重貼 system comment、不會重跑 deploy，也不會改動任何 task
 *      的 Done 狀態（那些 task 早就在 completion.ts 裡各自 Done 過了）。
 */
export async function runDiscordOutboxTick(input: RunDiscordOutboxTickInput): Promise<DiscordBatchOutcome[]> {
  const now = input.now ?? new Date();

  const unbatched = listUnbatchedCompletions(input.db);
  if (unbatched.length > 0) {
    const batchId = input.newBatchId();
    assignBatch(
      input.db,
      unbatched.map((c) => c.completionId),
      batchId,
      now,
    );
  }

  const outcomes: DiscordBatchOutcome[] = [];
  for (const batchId of listPendingBatchIds(input.db)) {
    const rows = getCompletionsByBatch(input.db, batchId);
    const taskIds = rows.map((row) => row.taskId);

    let sent: boolean;
    try {
      sent = await input.sendDiscordMessage({ batchId, taskIds });
    } catch {
      sent = false; // 傳送函式本身拋出例外，一律當作這次嘗試失敗，不讓它逃出這個迴圈。
    }

    const updated = recordBatchAttempt(input.db, batchId, sent ? 'sent' : 'failed', now);
    outcomes.push({ batchId, taskIds, status: updated[0].status, attemptCount: updated[0].attemptCount });
  }

  return outcomes;
}
