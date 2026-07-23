// 正式環境 sim 協調器的 Owner／Member session 執行層。
//
// 這裡「session」指的是：正式環境會是一次真正呼叫 AI coding agent 的呼叫，但在這個
// subsystem 目前的階段（以及這個檔案的測試），永遠是呼叫端注入的假 runner
// （plain async function，回傳 canned data）。這個檔案的職責不是「怎麼呼叫 AI」，
// 而是「呼叫完之後，怎麼獨立驗證副作用是否真的發生」。
//
// 核心原則（整個計畫要修的反模式）：process exit code 與 runner 自稱的
// summary／blocker／changedPaths，只供診斷，絕不當作「這次 session 有沒有進展」的
// 證據。真正的證據一律來自：
//   - git.ts 對 worktree 的即時檢查（collectTaskChanges／validateTaskChanges／
//     commitTaskChanges）——commit 是否真的落地、有沒有跳出宣告的 file scope；
//   - 呼叫端注入的 verification command 執行器——宣告的每個指令是否真的 PASS；
//   - 呼叫端注入的 driver 動作（confirmReviewTransition／createSummaryComment）——
//     Doing -> Review 是否真的被 driver 讀回、摘要留言是否真的建立。
//
// agent.ts 只回答「這一次 session 有沒有做出進展」；跨多次 attempt 的 no-progress
// 計數／Owner 介入／human_blocked 轉移是 coordinator.ts 的責任（見該檔），這裡不重複、
// 也不 import 任何 SQLite／HTTP 模組。
import type { ActionOutcome } from './types';
import type { TaskStatus } from './policy';
import { collectTaskChanges, validateTaskChanges, commitTaskChanges, isAllowedVerificationCommand } from './git';

// ---------------------------------------------------------------------------
// 步驟 3：結構化 session output（計畫給定的形狀，逐字照抄，不得偏離）。
// ---------------------------------------------------------------------------

export interface MemberSessionOutput {
  summary: string;
  changedPaths: string[];
  verificationCommands: string[];
  blocker: string | null;
}

export interface OwnerDecision {
  action: 'classify' | 'dispatch' | 'intervene' | 'accept' | 'reject' | 'conclude-discussion';
  rationale: string;
  evidenceCommentIds: string[];
  classification?: 'bug' | 'maintenance' | 'approved' | 'new-feature';
  outcome?: 'implement' | 'no_implementation' | 'no_consensus';
}

// ---------------------------------------------------------------------------
// Member session
// ---------------------------------------------------------------------------

/**
 * 提供給 member runner 的唯讀 context。正式環境下，這就是準備餵給實際 AI coding
 * agent 的 prompt 材料；刻意只包含一個 taskId、其 acceptance criteria、相關留言、
 * 已宣告的 file scope（allowedPrefixes）、verification command allowlist，以及這個
 * task 專屬的 worktree 路徑——沒有任何欄位可以引用或切換到別的 task。
 */
export interface MemberSessionRunnerContext {
  taskId: string;
  acceptanceCriteria: string;
  comments: string[];
  allowedPrefixes: string[];
  verificationCommandAllowlist: readonly string[];
  worktreePath: string;
}

export interface MemberSessionRunnerResult {
  exitCode: number;
  output: MemberSessionOutput;
}

/** 正式環境會是真正呼叫 AI coding agent 的實作；這裡永遠是呼叫端（測試）注入的假函式。 */
export type MemberSessionRunner = (context: MemberSessionRunnerContext) => Promise<MemberSessionRunnerResult>;

/** 執行單一 verification command 的注入器。要不要真的 spawn child process 由呼叫端決定。 */
export type VerificationCommandRunner = (
  command: string,
  worktreePath: string,
) => Promise<{ exitCode: number; output: string }>;

/**
 * Member session 結束後，driver（未來真正呼叫 API 的那一層；這裡永遠是呼叫端注入的假
 * 實作）必須完成的兩個必要副作用。回傳 null 代表「driver 沒有成功完成／根本沒有嘗試」，
 * 一律視為該項證據缺席，不得樂觀假設成功。
 */
export interface MemberSessionDriverActions {
  /** 嘗試把 task 從 Doing patch 成 Review，並讀回目前真正的看板 status。 */
  confirmReviewTransition: () => Promise<TaskStatus | null>;
  /** 建立摘要留言，回傳實際建立的 commentId。 */
  createSummaryComment: (summary: string) => Promise<{ commentId: string } | null>;
}

export interface MemberSessionEvidence {
  commitSha: string | null;
  commitChangedPaths: string[];
  verificationPassed: boolean;
  verificationRanCommands: string[];
  reviewTransitionConfirmed: boolean;
  reviewStatus: TaskStatus | null;
  summaryCommentId: string | null;
  /** 這次回報的 blocker 是否與上一次 attempt 完全相同（同一句話不算新證據）。 */
  blockerRepeated: boolean;
  /**
   * 非 null 代表這次 session 的自稱輸出本身就不可信（例如宣告了不在 allowlist 上的
   * verification command，或宣稱／實際的變更跳出宣告的 file scope），整次 session
   * 直接判定 retryable_failure，不進入任何後續證據檢查。
   */
  rejectedReason: string | null;
}

export interface MemberSessionResult {
  outcome: ActionOutcome;
  /** 診斷用途；不參與 outcome 判斷（見檔頭：process exit 只供診斷）。 */
  exitCode: number;
  output: MemberSessionOutput;
  evidence: MemberSessionEvidence;
  /** 餵給 coordinator.ts -> policy.ts 的 recordMemberAttempt(run, evidenceChanged)。 */
  evidenceChanged: boolean;
}

export interface RunMemberSessionInput {
  taskId: string;
  worktreePath: string;
  allowedPrefixes: string[];
  verificationCommandAllowlist?: readonly string[];
  acceptanceCriteria: string;
  comments: string[];
  /** 上一次 attempt 回報的 blocker（沒有上一次就傳 null），用來偵測重複 blocker。 */
  previousBlocker: string | null;
  runner: MemberSessionRunner;
  runVerificationCommand: VerificationCommandRunner;
  driverActions: MemberSessionDriverActions;
  commitTitle?: string;
}

function emptyEvidence(blockerRepeated: boolean, rejectedReason: string | null): MemberSessionEvidence {
  return {
    commitSha: null,
    commitChangedPaths: [],
    verificationPassed: false,
    verificationRanCommands: [],
    reviewTransitionConfirmed: false,
    reviewStatus: null,
    summaryCommentId: null,
    blockerRepeated,
    rejectedReason,
  };
}

/**
 * 執行一次 member session，並獨立驗證副作用，決定 ActionOutcome。
 *
 * 判斷 progressed 的門檻（對應計畫步驟 4）：通過驗證的 task commit + focused
 * verification PASS + driver 建立的摘要留言 + driver 對 Doing -> Review 的 readback，
 * 四項全部具備才算 progressed；process exit code 完全不參與這個判斷——即使
 * exitCode !== 0，只要證據齊全一樣是 progressed，即使 exitCode === 0，只要缺任何
 * 一項證據，一律不是 progressed（"commit 落地但 exit 1" 與 "exit 0 但缺證據" 用同一套
 * evidence-based 邏輯評估，不特別因為 exit code 加分或扣分）。
 */
export async function runMemberSession(input: RunMemberSessionInput): Promise<MemberSessionResult> {
  const context: MemberSessionRunnerContext = {
    taskId: input.taskId,
    acceptanceCriteria: input.acceptanceCriteria,
    comments: input.comments,
    allowedPrefixes: input.allowedPrefixes,
    verificationCommandAllowlist: input.verificationCommandAllowlist ?? [],
    worktreePath: input.worktreePath,
  };

  const { exitCode, output } = await input.runner(context);
  const blockerRepeated = output.blocker !== null && output.blocker === input.previousBlocker;

  // 1) 宣告的 verification command 只要有一個不在 allowlist 上，整次 session 直接
  //    判定不可信——不管 exitCode 或 summary 講得多好聽，都不會進入後續證據檢查。
  const disallowed = output.verificationCommands.find((cmd) => !isAllowedVerificationCommand(cmd));
  if (disallowed) {
    return {
      outcome: 'retryable_failure',
      exitCode,
      output,
      evidence: emptyEvidence(blockerRepeated, `verification command not on allowlist: ${JSON.stringify(disallowed)}`),
      evidenceChanged: false,
    };
  }

  // 2) 獨立檢查 worktree 目前真正的未 commit 變更——絕不信任 output.changedPaths 自稱。
  const realChanges = await collectTaskChanges(input.worktreePath);

  if (realChanges.length === 0) {
    // 沒有任何真實變更：不管 exitCode／summary 怎麼講，都是 no_change。既然連
    // commit 都不存在，後面的 verification／comment／status 檢查邏輯上不可能讓這次
    // 判定成立，因此不需要真的去呼叫 driverActions——但回傳的 evidence 欄位
    // （reviewTransitionConfirmed=false、summaryCommentId=null）如實反映「沒有發生」，
    // 與真的檢查過但發現沒發生，結論一致。
    return {
      outcome: 'no_change',
      exitCode,
      output,
      evidence: emptyEvidence(blockerRepeated, null),
      evidenceChanged: false,
    };
  }

  let commitSha: string;
  const commitChangedPaths = realChanges.map((c) => c.path);
  try {
    validateTaskChanges(realChanges, input.allowedPrefixes);
    const title = input.commitTitle ?? (output.summary.trim() || `member session for ${input.taskId}`);
    commitSha = await commitTaskChanges(input.worktreePath, input.taskId, title, commitChangedPaths);
  } catch (err) {
    return {
      outcome: 'retryable_failure',
      exitCode,
      output,
      evidence: emptyEvidence(blockerRepeated, `real worktree changes failed independent validation: ${(err as Error).message}`),
      evidenceChanged: false,
    };
  }

  // 3) 真的有 commit：獨立執行宣告的 verification commands（此時已知全部在 allowlist 內）。
  let verificationPassed = output.verificationCommands.length > 0;
  for (const cmd of output.verificationCommands) {
    const result = await input.runVerificationCommand(cmd, input.worktreePath);
    if (result.exitCode !== 0) {
      verificationPassed = false;
      break;
    }
  }

  // 4) driver 對 Doing -> Review 的獨立 readback，與摘要留言的建立——都是真正的
  //    副作用，這裡只信呼叫端回傳的結果，不信 output 自稱。
  const reviewStatus = await input.driverActions.confirmReviewTransition();
  const reviewTransitionConfirmed = reviewStatus === 'Review';
  const commentResult = await input.driverActions.createSummaryComment(output.summary);
  const summaryCommentId = commentResult?.commentId ?? null;

  const evidence: MemberSessionEvidence = {
    commitSha,
    commitChangedPaths,
    verificationPassed,
    verificationRanCommands: output.verificationCommands,
    reviewTransitionConfirmed,
    reviewStatus,
    summaryCommentId,
    blockerRepeated,
    rejectedReason: null,
  };

  const progressed = Boolean(commitSha) && verificationPassed && reviewTransitionConfirmed && Boolean(summaryCommentId);

  return {
    outcome: progressed ? 'progressed' : 'no_change',
    exitCode,
    output,
    evidence,
    evidenceChanged: progressed,
  };
}

// ---------------------------------------------------------------------------
// Owner session：read-only——Owner 的決策本身不執行任何 mutation（API／Git merge／
// 部署／留言全部留給 driver）；若偵測到 runner 試圖編輯 worktree 檔案，不論它宣稱
// 什麼，整次 session 判定無效。
// ---------------------------------------------------------------------------

export interface OwnerSessionRunnerContext {
  taskId: string;
  acceptanceCriteria: string;
  comments: string[];
  /** 待驗收的 head SHA；Owner 的 accept 決策必須在 rationale 裡明確引用這個值。 */
  reviewedHeadSha: string;
  /** 唯讀：Owner runner 不應該、也不被允許修改這裡的任何檔案。 */
  worktreePath: string;
}

export interface OwnerSessionRunnerResult {
  exitCode: number;
  decision: OwnerDecision;
}

/** 正式環境會是真正呼叫 AI 的實作；這裡永遠是呼叫端（測試）注入的假函式。 */
export type OwnerSessionRunner = (context: OwnerSessionRunnerContext) => Promise<OwnerSessionRunnerResult>;

export interface RunOwnerSessionInput {
  taskId: string;
  acceptanceCriteria: string;
  comments: string[];
  reviewedHeadSha: string;
  worktreePath: string;
  runner: OwnerSessionRunner;
}

export interface OwnerSessionResult {
  /**
   * false 代表整次 session 被判定無效（例如試圖編輯程式，或 accept 決策沒有引用
   * 被驗收的 head SHA）；此時 decision 必為 null，呼叫端不得執行 decision 裡的任何
   * action——這正是把「process exit／runner 自稱」與「是否可信」分開處理。
   */
  valid: boolean;
  rejectedReason: string | null;
  exitCode: number;
  decision: OwnerDecision | null;
}

export async function runOwnerSession(input: RunOwnerSessionInput): Promise<OwnerSessionResult> {
  const context: OwnerSessionRunnerContext = {
    taskId: input.taskId,
    acceptanceCriteria: input.acceptanceCriteria,
    comments: input.comments,
    reviewedHeadSha: input.reviewedHeadSha,
    worktreePath: input.worktreePath,
  };

  const { exitCode, decision } = await input.runner(context);

  // Owner 的 prompt 契約是唯讀——把 API mutation、Git merge、部署與留言全部留給
  // driver。這裡不信任 runner「說」自己沒動檔案，而是獨立檢查 worktree 目前真正的
  // 未 commit 變更：只要有任何一筆，就代表這個 Owner-driving 的 AI process 違反了
  // 唯讀契約，整次 session 判定無效，decision 一律不被信任、不得執行。
  const changes = await collectTaskChanges(input.worktreePath);
  if (changes.length > 0) {
    return {
      valid: false,
      rejectedReason: `owner session violated read-only contract by editing: ${changes.map((c) => c.path).join(', ')}`,
      exitCode,
      decision: null,
    };
  }

  // Owner acceptance 必須是「引用已審查 head SHA 的結構化決策」；OwnerDecision 沒有
  // 專屬的 sha 欄位，因此以 rationale 是否明確提到這個 head SHA 作為引用證據。
  if (decision.action === 'accept' && !decision.rationale.includes(input.reviewedHeadSha)) {
    return {
      valid: false,
      rejectedReason: 'accept decision must cite the reviewed head SHA in its rationale',
      exitCode,
      decision: null,
    };
  }

  return { valid: true, rejectedReason: null, exitCode, decision };
}
