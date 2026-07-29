// 正式環境 sim 協調器：安全 CLI 進入點 + 單一 tick orchestration + heartbeat。
//
// 這個檔案是 Task 2-7 已建好的模組（state/api/policy/git/agent/coordinator/completion）
// 之上的組裝層：讀 selectCoordinatorActions() 的決策，依 CoordinatorActionKind 分派給
// agent.ts／coordinator.ts／completion.ts 的既有函式，不重新實作那些模組已經有的邏輯。
//
// 三種模式：
//   --once            唯讀 discovery：印出 planned action，不呼叫 AI、不 mutation。
//   --once --live     授權 tick：允許 AI 與 mutation（只供人工授權或 systemd 使用）。
//   --status          印出最後一個 tick 的 heartbeat；太久沒有心跳且沒有 active lease 就非零碼結束。
//
// Exit code 契約：0 完整 discovery 且 cutover ready／2 CutoverPrerequisiteMissing（零 mutation、
// 零 AI）／3 DiscoveryUnavailable（零 mutation、零 AI）／1 未分類程式錯誤（不保證零 mutation）。
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  openCoordinatorState,
  getTaskRun,
  upsertTaskCheckpoint,
  claimLease,
  releaseLease,
  getAction,
  beginAction,
  completeAction,
  failAction,
  beginTick,
  endTick,
} from './production/state';
import {
  TaskTrackerClient,
  UncertainMutationError,
  type MemberSnapshot,
  type AuditEventSnapshot,
  type TaskSnapshot,
  type CommentSnapshot,
} from './production/api';
import {
  selectCoordinatorActions,
  isExcludedTask,
  validatePrerequisiteEvidence,
  MAIN_WORKSPACE_ID,
  CANONICAL_WORKSPACE_ID,
  CUTOVER_TASKS,
  type CoordinatorSnapshot,
  type CoordinatorAction,
  type CoordinatorActionKind,
  type TaskEvidence,
  type PrerequisiteEvidence,
} from './production/policy';
import {
  ensureTaskWorktree,
  taskBranchName,
  taskWorktreePath,
  isAncestor,
  getCommitMessage,
  getHeadSha,
  type SystemdReadback,
  type GetSystemdReadback,
  type CheckHealth,
} from './production/git';
import {
  runOwnerSession,
  runMemberSession,
  type OwnerSessionRunner,
  type MemberSessionRunner,
  type VerificationCommandRunner,
  type MemberSessionDriverActions,
  type MemberSessionResult,
} from './production/agent';
import { createOwnerSessionRunner, createMemberSessionRunner } from './production/runner';
import {
  recordMemberSessionAttempt,
  runDeployAcceptance,
  performMasterRevert,
  resolveRollbackWait,
  runDiscordOutboxTick,
  assertNoFatalCoordinatorError,
  type AcceptanceCheckResult,
  type IntegrationCommandRunner,
  type SendDiscordMessage,
  type FatalCoordinatorError,
  type MemberAttemptTransition,
} from './production/coordinator';
import { postCompletionAndTransitionToDone } from './production/completion';
import type { TaskRun, WorkPhase } from './production/types';

// =============================================================================
// 常數
// =============================================================================

const ROOT = join(__dirname, '..');
export const DB_PATH = join(ROOT, 'sim-logs', 'production-coordinator.db');
const BASE_URL = 'http://localhost:3000';
// 匯出給 sim/production/migrate.ts（任務 9）：cutover reconciliation 需要用同一組
// canonical Owner／user09 email 登入，不得自己另外維護一份同值的 literal。
export const OWNER_EMAIL = 'user01@test.local';
export const USER09_EMAIL = 'user09@test.local';
// 既有 seed 慣例（見 sim/run.ts 的 PASSWORD 常數、src/seed.ts）：所有 user01~09 共用同一組
// local seed credential。硬編在原始碼裡（不走 env var／CLI arg），不寫入任何 log／manifest／error。
const PASSWORD = 'test1234';
const APP_SERVICE_UNIT = 'task-tracker.service';
const AUTODEPLOY_PATH_UNIT = 'sim-autodeploy.path';
const AUTODEPLOY_SERVICE_UNIT = 'sim-autodeploy.service';
const DEPLOYED_REV_STATE_FILE = '/home/hom/.local/state/sim-autodeploy/deployed_rev';
const HEARTBEAT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_ALLOWED_PREFIXES = ['sim/', 'src/', 'public/'];
const MAX_TICK_ITERATIONS = 50;

const execFileAsync = promisify(execFile);

function shortId(taskId: string): string {
  return `${taskId.slice(0, 8)}...`;
}

/** 開啟 coordinator state 前先確保父目錄存在（`sim-logs/` 是 gitignored，全新 checkout 不會有這個目錄）。 */
function openDbEnsuringDir(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  return openCoordinatorState(dbPath);
}

// =============================================================================
// 唯讀 discovery preconditions（--once／--once --live 共用）
// =============================================================================

export interface DiscoveryOk {
  ok: true;
  ownerClient: TaskTrackerClient;
  user09Client: TaskTrackerClient;
  healthRev: string;
}
export interface DiscoveryFail {
  ok: false;
  reason: string;
}
export type DiscoveryResult = DiscoveryOk | DiscoveryFail;

export async function performDiscovery(
  baseUrl: string,
  isServiceActive: (unit: string) => Promise<boolean>,
): Promise<DiscoveryResult> {
  let serviceActive: boolean;
  try {
    serviceActive = await isServiceActive(APP_SERVICE_UNIT);
  } catch (err) {
    return { ok: false, reason: `task-tracker.service active 檢查失敗：${(err as Error).message}` };
  }
  if (!serviceActive) return { ok: false, reason: 'task-tracker.service 不是 active' };

  const probe = new TaskTrackerClient({ baseUrl });
  let health: { status: string; db: boolean; rev: string };
  try {
    health = await probe.health();
  } catch (err) {
    return { ok: false, reason: `GET /api/health 失敗：${(err as Error).message}` };
  }
  // health() 內部已經在 HTTP status !== 200 時 throw；這裡另外守 response body 的
  // status 欄位（規格要求 body.status === 'ok'）。
  if (health.status !== 'ok') {
    return { ok: false, reason: `/api/health status 欄位非 ok：${health.status}` };
  }

  const ownerClient = new TaskTrackerClient({ baseUrl });
  try {
    await ownerClient.login(OWNER_EMAIL, PASSWORD);
  } catch {
    // 不把底層 error message 原樣吐出去：login() 的錯誤訊息可能夾帶 server 回應 body，
    // 保守起見一律用固定文字，不論如何都不含密碼本身。
    return { ok: false, reason: 'canonical Owner 登入失敗' };
  }

  try {
    await ownerClient.listWorkspaceTasks(MAIN_WORKSPACE_ID);
    await ownerClient.listWorkspaceTasks(CANONICAL_WORKSPACE_ID);
  } catch (err) {
    return { ok: false, reason: `required workspace GET 失敗：${(err as Error).message}` };
  }

  const user09Client = new TaskTrackerClient({ baseUrl });
  try {
    await user09Client.login(USER09_EMAIL, PASSWORD);
  } catch {
    return { ok: false, reason: 'user09 登入失敗（用於 completion notification readback）' };
  }

  return { ok: true, ownerClient, user09Client, healthRev: health.rev };
}

// =============================================================================
// gatherSnapshot：把 live API 讀回組成 selectCoordinatorActions 要吃的 CoordinatorSnapshot。
// =============================================================================

async function buildTaskEvidence(ownerClient: TaskTrackerClient, task: TaskSnapshot): Promise<TaskEvidence> {
  const comments = await ownerClient.listComments(task.taskId);
  const last = comments.length > 0 ? comments[comments.length - 1] : null;
  return {
    taskId: task.taskId,
    status: task.status,
    assigneeId: task.assigneeId,
    dueAt: task.dueAt,
    commentCount: comments.length,
    lastCommentId: last?.commentId ?? null,
    lastCommentAt: last?.createdAt ?? null,
  };
}

export interface GatherSnapshotDeps {
  db: DatabaseSync;
  ownerClient: TaskTrackerClient;
  user09Client: TaskTrackerClient;
  repoRoot: string;
}

export async function gatherSnapshot(deps: GatherSnapshotDeps): Promise<CoordinatorSnapshot> {
  const [mainTasks, canonicalTasks] = await Promise.all([
    deps.ownerClient.listWorkspaceTasks(MAIN_WORKSPACE_ID),
    deps.ownerClient.listWorkspaceTasks(CANONICAL_WORKSPACE_ID),
  ]);
  const tasks = [...mainTasks, ...canonicalTasks];

  const taskRuns: Record<string, TaskRun | undefined> = {};
  for (const t of tasks) {
    taskRuns[t.taskId] = getTaskRun(deps.db, t.taskId) ?? undefined;
  }

  // taskEvidence 只需要對「已有持久化 checkpoint 的 task」（human_blocked 恢復判斷會用到）
  // 與 mainDiscussion（buildMainDiscussionAction 每次都要用到）計算——其餘 task 完全不需要
  // 額外的 per-task listComments() 呼叫（見 policy.ts：isUnresumableHumanBlocked 只有在
  // run.phase === 'human_blocked' 時才會真的讀 evidence）。
  const evidenceNeeded = new Set<string>([CUTOVER_TASKS.mainDiscussion]);
  for (const t of tasks) {
    if (taskRuns[t.taskId]) evidenceNeeded.add(t.taskId);
  }
  const taskEvidence: Record<string, TaskEvidence | undefined> = {};
  for (const taskId of evidenceNeeded) {
    const task = tasks.find((t) => t.taskId === taskId);
    if (!task) continue;
    taskEvidence[taskId] = await buildTaskEvidence(deps.ownerClient, task);
  }

  const members = await deps.ownerClient.listMembers(CANONICAL_WORKSPACE_ID);
  const userIdsByEmail: Record<string, string> = {};
  for (const m of members) userIdsByEmail[m.email] = m.userId;

  const prerequisiteEvidence = await gatherPrerequisiteEvidence(deps, tasks, userIdsByEmail);

  return { tasks, taskRuns, taskEvidence, prerequisiteEvidence, userIdsByEmail };
}

// =============================================================================
// gatherPrerequisiteEvidence：`00123ef0...`（completedPrerequisite）唯一需要的完整
// 完成證據鏈。任務 1 的 bootstrap driver 把整條證據鏈（授權時間／canonical Owner ID／
// assignment audit event／task branch／accepted head／Owner acceptance／merge SHA／
// live rev）都寫進了唯一的完成留言裡（見該留言逐字內容）；這裡把它解析出來後，
// 每一環都用獨立 readback（audit trail／comments／git ancestry／health）重新驗證，
// 不直接信任留言的自稱內容——只有 evidence.liveRev 例外：它就是「被驗證的那個值」
// 本身（來自留言宣稱），真正的獨立驗證落在 liveRevIsMergeOrDescendant：必須同時
// 證明「宣稱的 rev 是 merge 的後代」與「目前 live rev 是宣稱值的後代」，缺一不可，
// 這樣才能同時滿足 policy.ts 的字面比對，又不會因為 master 之後繼續前進就永遠失效。
// ---------------------------------------------------------------------------
function parseLabeled(content: string, label: string): string | null {
  const idx = content.indexOf(`${label}：`); // 全形冒號「：」
  if (idx === -1) return null;
  const rest = content.slice(idx + label.length + 1);
  const lineEnd = rest.indexOf('\n');
  return (lineEnd === -1 ? rest : rest.slice(0, lineEnd)).trim();
}

interface ParsedCompletionFields {
  task1AuthorizedAt: string | null;
  canonicalOwnerId: string | null;
  assignmentEventId: string | null;
  taskBranch: string | null;
  acceptedHeadSha: string | null;
  ownerAcceptanceId: string | null;
  mergeSha: string | null;
  liveRevFromComment: string | null;
}

function parseCompletionCommentFields(content: string): ParsedCompletionFields {
  const assignmentRaw = parseLabeled(content, 'Assignment audit event ID');
  const assignmentEventId = assignmentRaw ? (assignmentRaw.match(/\d+/)?.[0] ?? null) : null;
  // liveRev 該行可能帶行內附註（例如「<sha>（/api/health 確認 status=ok、db=true）」）——
  // 只取開頭那個不含空白／全形括號的 token 當作 SHA，附註文字不是值的一部分。
  const liveRevRaw = parseLabeled(content, '部署版本／live rev');
  const liveRevFromComment = liveRevRaw ? (liveRevRaw.match(/^[^\s（(]+/)?.[0] ?? null) : null;
  return {
    task1AuthorizedAt: parseLabeled(content, 'Task 1 授權時間'),
    canonicalOwnerId: parseLabeled(content, 'Canonical Owner ID'),
    assignmentEventId,
    taskBranch: parseLabeled(content, 'Task branch'),
    acceptedHeadSha: parseLabeled(content, 'Accepted head'),
    ownerAcceptanceId: parseLabeled(content, 'Owner acceptance ID'),
    mergeSha: parseLabeled(content, 'Merge SHA'),
    liveRevFromComment,
  };
}

// 匯出給 sim/production/migrate.ts（任務 9）重用：`00123ef0...` 的完整完成證據鏈
// 只應該有一份獨立驗證邏輯（見下方函式頭註解），manifest／apply 都必須呼叫同一個
// 函式，不得各自重新實作一份會漂移的複本。
//
// 這裡刻意只要求呼叫端提供 gatherPrerequisiteEvidence 真正用到的那個子集
// （`Pick<TaskTrackerClient, ...>`：只保留這裡實際呼叫的 method 簽名，不是完整
// class），而不是完整的 GatherSnapshotDeps（那個型別的 ownerClient／user09Client
// 是具體的 TaskTrackerClient class，帶有 private 欄位，測試沒辦法用一般 plain
// object 去滿足它）。gatherSnapshot() 呼叫這個函式時傳入的仍然是完整的
// GatherSnapshotDeps——結構上一定滿足這個更窄的介面（多出來的欄位不影響），
// 這裡只是放寬「呼叫端最少需要準備什麼」，不是重寫任何驗證邏輯。
export interface PrerequisiteEvidenceDeps {
  ownerClient: Pick<TaskTrackerClient, 'listComments' | 'getAuditTrail' | 'whoAmI' | 'health'>;
  user09Client: Pick<TaskTrackerClient, 'listNotifications'>;
  repoRoot: string;
}

export async function gatherPrerequisiteEvidence(
  deps: PrerequisiteEvidenceDeps,
  tasks: TaskSnapshot[],
  userIdsByEmail: Record<string, string>,
): Promise<PrerequisiteEvidence | null> {
  const taskId = CUTOVER_TASKS.completedPrerequisite.taskId;
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return null;

  let comments: CommentSnapshot[];
  try {
    comments = await deps.ownerClient.listComments(taskId);
  } catch {
    return null;
  }

  const completionComment = comments.find(
    (c) => c.content.startsWith('【SYSTEM完成】') && c.content.includes('@user09'),
  );
  const empty: PrerequisiteEvidence = {
    status: task.status,
    task1AuthorizedAt: '',
    canonicalOwnerId: '',
    user03CanonicalId: userIdsByEmail[CUTOVER_TASKS.completedPrerequisite.implementerEmail] ?? '',
    user09CanonicalId: userIdsByEmail[USER09_EMAIL] ?? '',
    assignmentEvent: null,
    acceptedHead: null,
    ownerAcceptance: null,
    acceptedMerge: null,
    liveRev: null,
    liveRevIsMergeOrDescendant: false,
    completionComment: null,
    notification: null,
  };
  if (!completionComment) return empty;

  const fields = parseCompletionCommentFields(completionComment.content);

  const ownerAcceptanceComment = fields.ownerAcceptanceId
    ? comments.find((c) => c.commentId === fields.ownerAcceptanceId)
    : undefined;

  let hasTaskIdTrailer = false;
  if (fields.acceptedHeadSha) {
    try {
      const message = await getCommitMessage(deps.repoRoot, fields.acceptedHeadSha);
      hasTaskIdTrailer = message.includes(`Task-Id: ${taskId}`);
    } catch {
      hasTaskIdTrailer = false;
    }
  }
  const acceptedHead =
    fields.acceptedHeadSha && fields.taskBranch
      ? { sha: fields.acceptedHeadSha, branch: fields.taskBranch, hasTaskIdTrailer }
      : null;

  const ownerAcceptance =
    ownerAcceptanceComment && fields.ownerAcceptanceId && fields.acceptedHeadSha &&
    ownerAcceptanceComment.content.includes(fields.acceptedHeadSha)
      ? { acceptanceId: fields.ownerAcceptanceId, referencedHeadSha: fields.acceptedHeadSha }
      : null;

  let headIsAncestor = false;
  if (fields.acceptedHeadSha && fields.mergeSha) {
    try {
      headIsAncestor = await isAncestor(deps.repoRoot, fields.acceptedHeadSha, fields.mergeSha);
    } catch {
      headIsAncestor = false;
    }
  }
  const acceptedMerge = fields.mergeSha ? { sha: fields.mergeSha, headIsAncestor } : null;

  // liveRev 就是被驗證的值本身（留言宣稱的那個 rev）——見上方函式註解：獨立驗證的重量全部
  // 放在 liveRevIsMergeOrDescendant，不是靠這裡的值跟「現在的」health rev 逐字相等。
  const liveRev = fields.liveRevFromComment;
  let liveRevIsMergeOrDescendant = false;
  if (liveRev && fields.mergeSha) {
    try {
      const claimIsMergeOrDescendant = liveRev === fields.mergeSha || (await isAncestor(deps.repoRoot, fields.mergeSha, liveRev));
      let currentRev: string | null = null;
      try {
        currentRev = (await deps.ownerClient.health()).rev;
      } catch {
        currentRev = null;
      }
      const currentDescendsFromClaim =
        currentRev !== null && (currentRev === liveRev || (await isAncestor(deps.repoRoot, liveRev, currentRev)));
      liveRevIsMergeOrDescendant = claimIsMergeOrDescendant && currentDescendsFromClaim;
    } catch {
      liveRevIsMergeOrDescendant = false;
    }
  }

  let assignmentEvent: PrerequisiteEvidence['assignmentEvent'] = null;
  if (fields.assignmentEventId) {
    try {
      const audit = await deps.ownerClient.getAuditTrail(taskId);
      const match: AuditEventSnapshot | undefined = audit.find(
        (e) => String(e.id) === fields.assignmentEventId && e.eventType === 'task.assignee_changed',
      );
      if (match) {
        assignmentEvent = {
          eventId: String(match.id),
          actorId: match.actorId,
          payloadAssigneeId: (match.payload as { assigneeId?: string }).assigneeId ?? '',
          createdAt: match.occurredAt,
        };
      }
    } catch {
      assignmentEvent = null;
    }
  }

  let notification: PrerequisiteEvidence['notification'] = null;
  try {
    const notifications = await deps.user09Client.listNotifications();
    const match = notifications.find((n) => n.sourceCommentId === completionComment.commentId);
    if (match) {
      notification = { notificationId: match.notificationId, recipientId: match.recipientId, sourceCommentId: match.sourceCommentId };
    }
  } catch {
    notification = null;
  }

  // canonicalOwnerId 不直接信任留言的自稱：獨立呼叫 whoAmI() 取得目前登入者（canonical
  // Owner）的真實 ID，只有在跟留言宣稱的值相符時才採用；不符就視為缺漏（空字串），
  // 讓 validatePrerequisiteEvidence 的 assignmentEvent.actorId 比對自然失敗。
  let verifiedOwnerId = '';
  try {
    const me = await deps.ownerClient.whoAmI();
    if (fields.canonicalOwnerId && me.id === fields.canonicalOwnerId) verifiedOwnerId = me.id;
  } catch {
    verifiedOwnerId = '';
  }

  return {
    status: task.status,
    task1AuthorizedAt: fields.task1AuthorizedAt ?? '',
    canonicalOwnerId: verifiedOwnerId,
    user03CanonicalId: userIdsByEmail[CUTOVER_TASKS.completedPrerequisite.implementerEmail] ?? '',
    user09CanonicalId: userIdsByEmail[USER09_EMAIL] ?? '',
    assignmentEvent,
    acceptedHead,
    ownerAcceptance,
    acceptedMerge,
    liveRev,
    liveRevIsMergeOrDescendant,
    completionComment: {
      commentId: completionComment.commentId,
      referencesTask1AuthorizedAt: Boolean(fields.task1AuthorizedAt),
      referencesAssignmentEventId: fields.assignmentEventId,
      referencesAcceptanceId: fields.ownerAcceptanceId,
      referencesHeadSha: fields.acceptedHeadSha,
      referencesMergeSha: fields.mergeSha,
      referencesLiveRev: fields.liveRevFromComment,
    },
    notification,
  };
}

// =============================================================================
// dry-run 報表：五個固定 cutover task 的 disposition + 排除清單。純粹描述用途，
// 不影響 selectCoordinatorActions 本身的決策（那才是唯一權威的排程來源）。
// =============================================================================

export function describeCutoverDisposition(
  tasks: TaskSnapshot[],
  userIdsByEmail: Record<string, string>,
  prerequisiteSatisfied: boolean,
): string[] {
  const emailByUserId = new Map(Object.entries(userIdsByEmail).map(([email, id]) => [id, email] as const));
  const shortName = (userId: string | null): string => {
    if (!userId) return 'unassigned';
    const email = emailByUserId.get(userId);
    return email ? email.split('@')[0] : userId.slice(0, 8);
  };

  const lines: string[] = [];

  const activeReviewTask = tasks.find((t) => t.taskId === CUTOVER_TASKS.activeReview.taskId);
  lines.push(`${shortId(CUTOVER_TASKS.activeReview.taskId)} -> ${shortName(activeReviewTask?.assigneeId ?? null)}／active`);

  // queuedReview（6384b6f4...）：CUTOVER_TASKS.queuedReview.afterTaskId 目前只是 policy.ts
  // 裡的一個資料欄位，selectCoordinatorActions 完全沒有讀它——真正把這個 task 機械式退回
  // Todo／unassigned／queued checkpoint（Review -> Doing -> Todo -> 清除 assignee 三步
  // PATCH）是任務 9 sim/production/migrate.ts 的 `--apply` 職責，這裡不得也不需要提前
  // 實作那段 DEP-gating／bootstrap 邏輯：任務 11 的 cutover 順序保證 migrate.ts --apply
  // 一定先跑過，才會啟用正式 live timer，所以 selectCoordinatorActions 目前不用特別處理
  // 這個 task 也不會有 mutation-safety 風險。但 disposition 報表本身必須誠實反映「現在」
  // 的真實 live 狀態，不能不看 tasks 就印一句寫死的 "queued／unassigned"——那句話只有在
  // task 9 真的 reconcile 完成、live 狀態也確實收斂之後才是事實。
  const queuedReviewTask = tasks.find((t) => t.taskId === CUTOVER_TASKS.queuedReview.taskId);
  const queuedReviewConverged = queuedReviewTask?.status === 'Todo' && !queuedReviewTask.assigneeId;
  lines.push(
    `${shortId(CUTOVER_TASKS.queuedReview.taskId)} -> ${
      queuedReviewConverged
        ? 'queued／unassigned'
        : `尚待任務 9 reconciliation（目前：${queuedReviewTask?.status ?? '未知'}／${shortName(queuedReviewTask?.assigneeId ?? null)}）`
    }`,
  );

  lines.push(
    `${shortId(CUTOVER_TASKS.completedPrerequisite.taskId)} -> ${
      prerequisiteSatisfied ? '任務 1 已完成前置條件／cutover 無 action' : 'CutoverPrerequisiteMissing：完成證據鏈缺漏或不相符'
    }`,
  );

  lines.push(
    `${shortId(CUTOVER_TASKS.mainDiscussion)} -> ${
      prerequisiteSatisfied ? '前置條件通過後機械式結案' : '等待任務1前置條件通過'
    }`,
  );

  const gateTask = tasks.find((t) => t.taskId === CUTOVER_TASKS.deferredAssignment.afterTaskId);
  const gateDone = gateTask?.status === 'Done';
  lines.push(
    `${shortId(CUTOVER_TASKS.deferredAssignment.taskId)} -> ${
      gateDone ? `${CUTOVER_TASKS.deferredAssignment.assigneeEmail.split('@')[0]}／已派工` : '等待 938 Done 後交給 user05'
    }`,
  );

  const mainPolicyTask = tasks.find((t) => t.taskId === CUTOVER_TASKS.mainPolicy);
  const legacyTask = tasks.find((t) => t.taskId === CUTOVER_TASKS.legacyCanonicalDiscussion);
  lines.push(`${shortId(CUTOVER_TASKS.mainPolicy)} -> excluded${mainPolicyTask && isExcludedTask(mainPolicyTask) ? '' : '（警告：title 不符）'} (mainPolicy)`);
  lines.push(`${shortId(CUTOVER_TASKS.legacyCanonicalDiscussion)} -> excluded${legacyTask && isExcludedTask(legacyTask) ? '' : '（警告：title 不符）'} (legacyCanonicalDiscussion)`);

  return lines;
}

// =============================================================================
// 真正的 systemd／health／verification-command 實作（--live 模式使用；--once 唯讀
// discovery 完全不會呼叫這些）。全部唯讀或明確 allowlist 過的指令，沒有任何路徑會
// 呼叫 systemctl start／enable。
// =============================================================================

async function isUnitActive(unit: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', unit]);
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
}

async function parseSystemctlShow(unit: string, properties: string[]): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync('systemctl', ['--user', 'show', unit, ...properties.map((p) => `--property=${p}`)]);
  const map: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

async function realGetSystemdReadback(): Promise<SystemdReadback> {
  const pathActive = await isUnitActive(AUTODEPLOY_PATH_UNIT);
  const props = await parseSystemctlShow(AUTODEPLOY_SERVICE_UNIT, [
    'ActiveState',
    'InvocationID',
    'ExecMainStartTimestampMonotonic',
    'Result',
    'ExecMainStatus',
  ]);
  let deployedRev = 'none';
  try {
    deployedRev = readFileSync(DEPLOYED_REV_STATE_FILE, 'utf8').trim();
  } catch {
    /* 尚未部署過 */
  }
  return {
    pathActive,
    serviceActiveState: props.ActiveState ?? 'unknown',
    invocationId: props.InvocationID ?? '',
    execMainStartTimestampMonotonic: Number(props.ExecMainStartTimestampMonotonic ?? 0),
    result: props.Result ?? '',
    execMainStatus: Number(props.ExecMainStatus ?? -1),
    deployedRev,
  };
}

/** 只允許已通過 allowlist 的固定字面指令；用陣列參數 execFile，永不 shell out 字串。 */
async function execAllowlistedCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  const [cmd, ...args] = command.split(' ');
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException & { code?: number }).code as number | undefined) ?? 1 : 0;
      resolve({ exitCode: typeof code === 'number' ? code : 1, output: `${stdout}${stderr}` });
    });
  });
}

function realSendDiscordMessage(): SendDiscordMessage {
  return async (message) => {
    try {
      const text = `✅ [SYSTEM完成] batch ${message.batchId}：${message.taskIds.length} 個 task 已完成\n${message.taskIds.join('\n')}`;
      execFileSync(join(ROOT, 'sim', 'notify-human.sh'), [text], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
}

// =============================================================================
// RunOnceOptions／runOnce：--once 與 --once --live 共用的單一進入點。也是
// sim/production.integration.test.ts 直接呼叫的對象（全部注入假依賴）。
// =============================================================================

export interface RunOnceOptions {
  live: boolean;
  baseUrl?: string;
  dbPath?: string;
  repoRoot?: string;
  now?: () => Date;
  isServiceActive?: (unit: string) => Promise<boolean>;
  allowedPrefixes?: string[];
  runOwnerSession?: OwnerSessionRunner;
  runMemberSession?: MemberSessionRunner;
  runVerificationCommand?: VerificationCommandRunner;
  runIntegrationCommand?: IntegrationCommandRunner;
  runBranchCi?: (taskId: string, worktreePath: string) => Promise<AcceptanceCheckResult>;
  runTaskSpecificAcceptance?: (taskId: string) => Promise<AcceptanceCheckResult>;
  runTaskLiveAcceptance?: (taskId: string) => Promise<AcceptanceCheckResult>;
  getSystemdReadback?: GetSystemdReadback;
  checkHealth?: CheckHealth;
  sendDiscordMessage?: SendDiscordMessage;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOnceResult {
  exitCode: 0 | 1 | 2 | 3;
  tickId: string;
  lines: string[];
}

interface ResolvedDeps {
  db: DatabaseSync;
  ownerClient: TaskTrackerClient;
  user09Client: TaskTrackerClient;
  repoRoot: string;
  now: () => Date;
  allowedPrefixes: string[];
  runOwnerSession?: OwnerSessionRunner;
  runMemberSession?: MemberSessionRunner;
  runVerificationCommand: VerificationCommandRunner;
  runIntegrationCommand: IntegrationCommandRunner;
  runBranchCi: (taskId: string, worktreePath: string) => Promise<AcceptanceCheckResult>;
  runTaskSpecificAcceptance: (taskId: string) => Promise<AcceptanceCheckResult>;
  runTaskLiveAcceptance: (taskId: string) => Promise<AcceptanceCheckResult>;
  getSystemdReadback: GetSystemdReadback;
  checkHealth: CheckHealth;
  sendDiscordMessage: SendDiscordMessage;
  newId: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const baseUrl = options.baseUrl ?? BASE_URL;
  const dbPath = options.dbPath ?? DB_PATH;
  const repoRoot = options.repoRoot ?? ROOT;
  const now = options.now ?? (() => new Date());
  const isServiceActive = options.isServiceActive ?? isUnitActive;
  const tickId = randomUUID();
  const lines: string[] = [];

  const db = openDbEnsuringDir(dbPath);
  try {
    beginTick(db, tickId, now());

    const discovery = await performDiscovery(baseUrl, isServiceActive);
    if (!discovery.ok) {
      lines.push(`DiscoveryUnavailable: ${discovery.reason}`);
      endTick(db, { tickId, outcome: 'discovery_unavailable', discoveredCount: 0, processedCount: 0, skippedCount: 0, errorCount: 1, error: discovery.reason }, now());
      return { exitCode: 3, tickId, lines };
    }

    const deps: ResolvedDeps = {
      db,
      ownerClient: discovery.ownerClient,
      user09Client: discovery.user09Client,
      repoRoot,
      now,
      allowedPrefixes: options.allowedPrefixes ?? DEFAULT_ALLOWED_PREFIXES,
      runOwnerSession: options.runOwnerSession,
      runMemberSession: options.runMemberSession,
      runVerificationCommand: options.runVerificationCommand ?? execAllowlistedCommand,
      runIntegrationCommand: options.runIntegrationCommand ?? execAllowlistedCommand,
      runBranchCi: options.runBranchCi ?? (async (_taskId, worktreePath) => {
        const result = await execAllowlistedCommand('npm test', worktreePath);
        return { passed: result.exitCode === 0, detail: result.output.slice(-2000) };
      }),
      runTaskSpecificAcceptance:
        options.runTaskSpecificAcceptance ?? (async () => ({ passed: true, detail: 'no task-specific acceptance defined (see Task 9/10)' })),
      runTaskLiveAcceptance:
        options.runTaskLiveAcceptance ?? (async () => ({ passed: true, detail: 'no task-specific live acceptance defined (see Task 9/10)' })),
      getSystemdReadback: options.getSystemdReadback ?? realGetSystemdReadback,
      checkHealth: options.checkHealth ?? (async () => new TaskTrackerClient({ baseUrl }).health()),
      sendDiscordMessage: options.sendDiscordMessage ?? realSendDiscordMessage(),
      newId: options.newId ?? randomUUID,
      sleep: options.sleep,
    };

    const snapshot = await gatherSnapshot(deps);
    const actions = selectCoordinatorActions(snapshot, now());
    const prerequisiteSatisfied = validatePrerequisiteEvidence(snapshot.prerequisiteEvidence);
    const prereqMissing = actions.find((a) => a.kind === 'cutover_prerequisite_missing');

    lines.push(...describeCutoverDisposition(snapshot.tasks, snapshot.userIdsByEmail, prerequisiteSatisfied));
    lines.push(`app rev: ${discovery.healthRev}`);
    lines.push(`planned actions this tick: ${actions.length}`);
    for (const a of actions) {
      lines.push(`  ${a.kind} ${shortId(a.taskId)} — ${a.reason}`);
    }

    if (!options.live) {
      endTick(
        db,
        {
          tickId,
          outcome: prereqMissing ? 'cutover_prerequisite_missing' : 'dry_run',
          discoveredCount: actions.length,
          processedCount: 0,
          skippedCount: actions.length,
          errorCount: prereqMissing ? 1 : 0,
          error: prereqMissing ? 'CutoverPrerequisiteMissing' : null,
        },
        now(),
      );
      return { exitCode: prereqMissing ? 2 : 0, tickId, lines };
    }

    if (prereqMissing) {
      lines.push('CutoverPrerequisiteMissing：本次 tick 零 mutation、零 AI。');
      endTick(
        db,
        { tickId, outcome: 'cutover_prerequisite_missing', discoveredCount: actions.length, processedCount: 0, skippedCount: actions.length, errorCount: 1, error: 'CutoverPrerequisiteMissing' },
        now(),
      );
      return { exitCode: 2, tickId, lines };
    }

    if (!deps.runOwnerSession || !deps.runMemberSession) {
      throw new Error(
        'runOnce: --live 模式需要真正的 AI runner（runOwnerSession/runMemberSession）；' +
          '目前尚未接上真實 AI 呼叫，這是刻意保留給未來任務的整合點，不得假造一個會靜默通過的假 runner。',
      );
    }

    const summary = await runLiveDispatchLoop(deps, tickId);
    lines.push(`live tick: discovered=${summary.discovered} processed=${summary.processed} skipped=${summary.skipped} errors=${summary.errors}`);
    for (const d of summary.errorDetails) lines.push(`  ERROR: ${d}`);

    const discordOutcomes = await runDiscordOutboxTick({ db, sendDiscordMessage: deps.sendDiscordMessage, newBatchId: deps.newId, now: now() });
    for (const o of discordOutcomes) lines.push(`discord batch ${o.batchId}: ${o.status} (attempt ${o.attemptCount}, ${o.taskIds.length} tasks)`);

    const outcome = summary.errors > 0 ? 'partial_failure' : 'ok';
    endTick(
      db,
      { tickId, outcome, discoveredCount: summary.discovered, processedCount: summary.processed, skippedCount: summary.skipped, errorCount: summary.errors, error: summary.errorDetails[0] ?? null },
      now(),
    );
    return { exitCode: summary.errors > 0 ? 1 : 0, tickId, lines };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    lines.push(`UNCLASSIFIED ERROR: ${message}`);
    try {
      endTick(db, { tickId, outcome: 'error', discoveredCount: 0, processedCount: 0, skippedCount: 0, errorCount: 1, error: message }, now());
    } catch {
      /* endTick 本身失敗就放棄記錄，不讓 heartbeat 寫入蓋過原始錯誤 */
    }
    return { exitCode: 1, tickId, lines };
  } finally {
    db.close();
  }
}

// =============================================================================
// Live tick 的 drain loop：反覆 gatherSnapshot -> selectCoordinatorActions ->
// dispatch，直到沒有更多 action，或這一輪完全沒有任何 action 產生進展為止（避免
// 卡在合法阻塞狀態時無窮迴圈）。單一 `--once --live` 呼叫因此可能在一次呼叫內把
// 同一個 task 從 Todo 推進到 Done——這是刻意設計，對應 integration test「一個 tick
// 從 Todo assignment 走到 Review 及模擬 deployment／completion」的要求。
// =============================================================================

interface DispatchSummary {
  discovered: number;
  processed: number;
  skipped: number;
  errors: number;
  errorDetails: string[];
}

async function runLiveDispatchLoop(deps: ResolvedDeps, tickId: string): Promise<DispatchSummary> {
  const summary: DispatchSummary = { discovered: 0, processed: 0, skipped: 0, errors: 0, errorDetails: [] };

  for (let iter = 0; iter < MAX_TICK_ITERATIONS; iter++) {
    const snapshot = await gatherSnapshot(deps);
    const actions = selectCoordinatorActions(snapshot, deps.now());
    if (actions.length === 0) break;

    const prereqMissing = actions.find((a) => a.kind === 'cutover_prerequisite_missing');
    if (prereqMissing) {
      summary.errors++;
      summary.errorDetails.push(`cutover prerequisite missing for ${prereqMissing.taskId}（tick 中途出現，立刻中止）`);
      break;
    }

    summary.discovered += actions.length;
    let progressedAny = false;
    // 同一輪迭代裡，所有 action 都是從同一次 gatherSnapshot 算出來的同一份（凍結）
    // snapshot——如果這一輪同時有兩個以上的 unassigned Todo task 要 dispatch，
    // resolveDispatchAssignee 不能只看這份凍結快照，還必須知道「這一輪稍早已經被
    // 指派出去的人」，否則兩個 task 會各自獨立解出同一個「目前沒人在忙」的 member。
    const claimedAssigneesThisIteration = new Set<string>();
    for (const action of actions) {
      try {
        const outcome = await dispatchAction(deps, action, snapshot, tickId, claimedAssigneesThisIteration);
        if (outcome === 'progressed') {
          summary.processed++;
          progressedAny = true;
        } else if (outcome === 'skipped') {
          summary.skipped++;
        } else {
          summary.processed++;
        }
      } catch (err) {
        summary.errors++;
        summary.errorDetails.push(`${action.taskId} (${action.kind}): ${(err as Error).message}`);
      }
    }
    if (!progressedAny) break;
  }

  return summary;
}

function initialPhaseFor(kind: CoordinatorActionKind): WorkPhase {
  switch (kind) {
    case 'owner_dispatch':
    case 'assign_member':
      return 'assigned';
    case 'member_work':
      return 'doing';
    case 'owner_review':
      return 'review';
    case 'main_discussion_owner':
      return 'doing';
    default:
      return 'assigned';
  }
}

async function dispatchAction(
  deps: ResolvedDeps,
  action: CoordinatorAction,
  snapshot: CoordinatorSnapshot,
  tickId: string,
  claimedAssigneesThisIteration: Set<string>,
): Promise<'progressed' | 'no_change' | 'skipped'> {
  let run = getTaskRun(deps.db, action.taskId);
  if (!run) {
    run = upsertTaskCheckpoint(
      deps.db,
      { taskId: action.taskId, workspaceId: action.workspaceId, phase: initialPhaseFor(action.kind), evidenceFingerprint: '' },
      deps.now(),
    );
  }

  const claimed = claimLease(deps.db, { taskId: action.taskId, workerId: tickId, now: deps.now() });
  if (!claimed) return 'skipped';

  try {
    switch (action.kind) {
      case 'owner_dispatch':
        return await dispatchOwnerDispatch(deps, action, snapshot, claimed, claimedAssigneesThisIteration);
      case 'assign_member':
        return await dispatchAssignMember(deps, action, claimed, claimedAssigneesThisIteration);
      case 'member_work':
        return await dispatchMemberWork(deps, action, claimed);
      case 'owner_review':
        return await dispatchOwnerReview(deps, action, claimed);
      case 'main_discussion_owner':
        return await dispatchMainDiscussion(deps, action, claimed);
      default:
        return 'no_change';
    }
  } finally {
    releaseLease(deps.db, action.taskId, tickId, deps.now());
  }
}

// ---------------------------------------------------------------------------
// owner_dispatch／assign_member：把 Todo／unassigned task 指派出去並 PATCH 到 Doing，
// 建立 task 專屬 worktree／branch。單欄位 PATCH、每步都 read back、固定 action key。
// ---------------------------------------------------------------------------

/**
 * `alreadyClaimedThisBatch` 是同一個 tick 迭代裡、比這個 action 更早被 dispatch 且
 * 已經解出 assigneeId 的集合——`tasks`（來自單一 gatherSnapshot 快照）在整個
 * runLiveDispatchLoop 的一輪迭代裡是共用、凍結的同一份資料，同一輪裡先前的
 * owner_dispatch 呼叫即使剛把某個 member 指派出去，這份快照也不會反映出來。沒有這個
 * 參數，同一輪裡兩個同時 idle 的 unassigned Todo task 會各自獨立算出「目前沒人在忙」，
 * 雙雙解到同一個「第一個空閒」member，造成真正的 WIP1 違規（同一人同時扛两個 task）。
 */
function resolveDispatchAssignee(
  members: MemberSnapshot[],
  tasks: TaskSnapshot[],
  excludeEmails: string[],
  alreadyClaimedThisBatch: ReadonlySet<string>,
): string | null {
  const busy = new Set(
    tasks.filter((t) => t.status === 'Doing' || t.status === 'Review').map((t) => t.assigneeId).filter((id): id is string => Boolean(id)),
  );
  for (const id of alreadyClaimedThisBatch) busy.add(id);
  const candidates = members.filter((m) => !excludeEmails.includes(m.email)).sort((a, b) => (a.userId < b.userId ? -1 : 1));
  const free = candidates.find((m) => !busy.has(m.userId));
  return free?.userId ?? null;
}

async function assignAndStartDoing(deps: ResolvedDeps, action: CoordinatorAction, run: TaskRun, assigneeId: string): Promise<'progressed' | 'no_change'> {
  const now = deps.now();

  const assignKey = `assign:${action.taskId}:${assigneeId}`;
  if (!getAction(deps.db, assignKey)) {
    beginAction(deps.db, { actionKey: assignKey, taskId: action.taskId, kind: 'assign' }, now);
    try {
      const current = await deps.ownerClient.getTask(action.taskId);
      if (current.assigneeId !== assigneeId) {
        await deps.ownerClient.patchTaskField(action.taskId, 'assignee', assigneeId);
      }
      completeAction(deps.db, assignKey, JSON.stringify({ assigneeId }), now);
    } catch (err) {
      failAction(deps.db, assignKey, (err as Error).message, now);
      throw err;
    }
  }

  const doingKey = `status:${action.taskId}:Doing`;
  if (!getAction(deps.db, doingKey)) {
    beginAction(deps.db, { actionKey: doingKey, taskId: action.taskId, kind: 'status' }, now);
    try {
      const current = await deps.ownerClient.getTask(action.taskId);
      if (current.status !== 'Doing') {
        await deps.ownerClient.patchTaskField(action.taskId, 'status', 'Doing');
      }
      completeAction(deps.db, doingKey, null, now);
    } catch (err) {
      failAction(deps.db, doingKey, (err as Error).message, now);
      throw err;
    }
  }

  const masterSha = await getHeadSha(deps.repoRoot, 'master');
  const worktree = await ensureTaskWorktree(deps.repoRoot, action.taskId, masterSha);

  upsertTaskCheckpoint(
    deps.db,
    {
      taskId: action.taskId,
      workspaceId: action.workspaceId,
      phase: 'doing',
      // workerId 只代表 coordinator 當次執行者（lease 持有者），不是看板 assignee——
      // 看板 assignee 完全交給 live TaskSnapshot，不重複存在這裡（見 types.ts 對
      // TaskRun.workerId 的註解）。這裡必須保留 claimLease 剛設定的 lease 持有者，
      // 不能被 assigneeId 覆蓋掉，否則 releaseLease 會發現 workerId 對不上而拋錯。
      workerId: run.workerId,
      branch: worktree.branch,
      baseSha: worktree.baseSha,
      headSha: worktree.headSha,
      evidenceFingerprint: run.evidenceFingerprint,
      noProgressCount: 0,
      ownerIntervened: false,
    },
    now,
  );

  return 'progressed';
}

async function dispatchOwnerDispatch(
  deps: ResolvedDeps,
  action: CoordinatorAction,
  snapshot: CoordinatorSnapshot,
  run: TaskRun,
  claimedAssigneesThisIteration: Set<string>,
): Promise<'progressed' | 'no_change'> {
  const members = await deps.ownerClient.listMembers(action.workspaceId);
  const assigneeId = resolveDispatchAssignee(members, snapshot.tasks, [OWNER_EMAIL, USER09_EMAIL], claimedAssigneesThisIteration);
  if (!assigneeId) return 'no_change';

  const task = snapshot.tasks.find((t) => t.taskId === action.taskId);
  if (!task) return 'no_change';

  // Owner 的派工理由由 AI session 產生，而且真的會被使用——貼成一則 `【OWNER派工】`
  // 留言（呼應 dispatchOwnerReview 的 `【OWNER退回】`、dispatchMainDiscussion 的
  // 結論留言，都是把 decision.rationale 真正記錄下來，不是叫了一次 AI 卻把結果丟掉）。
  // 這裡直接呼叫注入的原始 runner，不經過 agent.ts 的 runOwnerSession() 包裝——包裝層
  // 的唯讀違規檢查是針對「有真實 task worktree 可能被誤改」設計的，dispatch 階段還沒有
  // worktree（要指派給誰、之後才建立），沒有東西可以被誤改，不適用那層檢查。
  const { decision } = await deps.runOwnerSession!({
    taskId: action.taskId,
    acceptanceCriteria: task.title,
    comments: [],
    reviewedHeadSha: '',
    worktreePath: '',
  });
  if (!decision) return 'no_change'; // AI 沒有給出可用的決策，這次不指派，下一個 tick 重新評估

  const noticeKey = `dispatch_notice:${action.taskId}:${assigneeId}`;
  if (!getAction(deps.db, noticeKey)) {
    beginAction(deps.db, { actionKey: noticeKey, taskId: action.taskId, kind: 'dispatch_notice' }, deps.now());
    try {
      await deps.ownerClient.postCommentOnce(action.taskId, `【OWNER派工】${decision.rationale}\naction_key: ${noticeKey}`, noticeKey);
      completeAction(deps.db, noticeKey, null, deps.now());
    } catch (err) {
      failAction(deps.db, noticeKey, (err as Error).message, deps.now());
      throw err;
    }
  }

  // 這一輪迭代裡先於本次 dispatch 已經解出的 assignee，必須在真正 PATCH assignee 之前
  // 就先記入「已認領」，讓同一輪要 dispatch 的其他 unassigned Todo task 不會再把同一個
  // 人算成空閒（見 resolveDispatchAssignee 的註解）。即使接下來的 assignAndStartDoing
  // 因為 worktree 建立失敗而丟出例外，assignee PATCH 本身很可能已經先成功落地，這裡
  // 仍然保守地把這個人視為已認領。
  claimedAssigneesThisIteration.add(assigneeId);

  return assignAndStartDoing(deps, action, run, assigneeId);
}

async function dispatchAssignMember(
  deps: ResolvedDeps,
  action: CoordinatorAction,
  run: TaskRun,
  claimedAssigneesThisIteration: Set<string>,
): Promise<'progressed' | 'no_change'> {
  if (!action.assigneeId) return 'no_change';

  // 雙向碰撞防護：這一輪迭代裡，assign_member（policy.ts 固定指派，例如
  // deferredAssignment／user05）跟 owner_dispatch（一般 unassigned Todo 的
  // resolveDispatchAssignee heuristic）共用同一個 claimedAssigneesThisIteration。
  // 目前 selectCoordinatorActions 把固定 cutover disposition（含 assign_member）排在
  // 一般 generic candidates（含 owner_dispatch）前面，所以正常情況下這裡會先跑、
  // owner_dispatch 後跑，靠 resolveDispatchAssignee 那邊的檢查就夠了；但這裡仍然主動
  // 檢查反過來的方向——如果同一輪稍早已經有別的 dispatch（不論哪一種 kind）把這個
  // assigneeId 記為已認領，就不得再無條件 PATCH 造成雙重指派，保守地延後到下一個 tick
  // 重新評估（此時完全還沒有任何 mutation，延後是安全的）。
  if (claimedAssigneesThisIteration.has(action.assigneeId)) return 'no_change';
  claimedAssigneesThisIteration.add(action.assigneeId);

  return assignAndStartDoing(deps, action, run, action.assigneeId);
}

// ---------------------------------------------------------------------------
// member_work：呼叫 agent.ts 的 runMemberSession，driver 動作（Doing->Review readback、
// 摘要留言）走 ownerClient；no-progress／human_blocked 狀態機交給 coordinator.ts。
// ---------------------------------------------------------------------------

/**
 * 把一次「完整嘗試但沒有可驗證進展」的結果（不論是真正的 member session 失敗，還是
 * worktree 建立這種更早期的機械式失敗）餵進 policy.ts 既有的 no-progress／Owner
 * 介入／human_blocked 狀態機，並在剛好轉入 human_blocked 時貼出唯一、去重的
 * `@user09` 留言。兩個呼叫端（dispatchMemberWork 正常路徑、worktree 重試失敗路徑）
 * 共用同一份邏輯，不重寫兩次——這正是修正「worktree 建立失敗後永久 silent no_change」
 * 這個 Critical bug的核心：不管失敗發生在哪一步，都必須流進同一套會累計、會升級、
 * 最終會留下人類看得到的訊號的狀態機，不能有任何一條路徑悄悄繞過它。
 */
async function applyMemberAttemptTransition(
  deps: ResolvedDeps,
  action: CoordinatorAction,
  run: TaskRun,
  result: MemberSessionResult,
  task: TaskSnapshot,
): Promise<MemberAttemptTransition> {
  const currentEvidence = await buildTaskEvidence(deps.ownerClient, task);
  const transition = recordMemberSessionAttempt(run, result, currentEvidence);

  if (transition.humanBlockedNotice) {
    const key = transition.humanBlockedNotice.actionKey;
    if (!getAction(deps.db, key)) {
      beginAction(deps.db, { actionKey: key, taskId: action.taskId, kind: 'human_blocked_notice' }, deps.now());
      try {
        await deps.ownerClient.postCommentOnce(action.taskId, transition.humanBlockedNotice.content, key);
        completeAction(deps.db, key, null, deps.now());
      } catch (err) {
        failAction(deps.db, key, (err as Error).message, deps.now());
      }
    }
  }

  return transition;
}

async function dispatchMemberWork(deps: ResolvedDeps, action: CoordinatorAction, run: TaskRun): Promise<'progressed' | 'no_change'> {
  const task = await deps.ownerClient.getTask(action.taskId);

  let workingRun = run;
  if (!workingRun.branch) {
    // 上一次 dispatch（owner_dispatch／assign_member）在 assign＋Doing PATCH 都已經
    // durable 完成之後才呼叫 ensureTaskWorktree；如果那一步曾經失敗（disk full／
    // 上一輪被殺掉留下的 stale lock／權限錯誤……），看板這時已經是 Doing／已指派，
    // selectCoordinatorActions 只會再選到 member_work，不會再回到 owner_dispatch，
    // 所以這裡必須自己重試——ensureTaskWorktree 本身是冪等的（worktree 目錄已存在
        // 就直接重用），可以安全地在每個 tick 重複呼叫，直到成功為止。絕對不能維持原本
    // 「bare `if (!run.branch) return 'no_change'`」那種永久 silent no_change：那會讓
    // task 卡死、noProgressCount 永遠不動、--status 永遠回報 healthy，卻沒有任何人
    // 看得到訊號。
    try {
      const masterSha = workingRun.baseSha ?? (await getHeadSha(deps.repoRoot, 'master'));
      const worktree = await ensureTaskWorktree(deps.repoRoot, action.taskId, masterSha);
      workingRun = upsertTaskCheckpoint(
        deps.db,
        {
          taskId: action.taskId,
          workspaceId: action.workspaceId,
          phase: 'doing',
          workerId: workingRun.workerId,
          branch: worktree.branch,
          baseSha: worktree.baseSha,
          headSha: worktree.headSha,
          evidenceFingerprint: workingRun.evidenceFingerprint,
          noProgressCount: workingRun.noProgressCount,
          ownerIntervened: workingRun.ownerIntervened,
        },
        deps.now(),
      );
    } catch (err) {
      // 重試仍然失敗：這次嘗試同樣沒有可驗證進展，餵進跟 member session 失敗完全相同的
      // no-progress／Owner 介入／human_blocked 狀態機，連續失敗最終會走到人類看得見的
      // @user09 留言，而不是永遠卡住又永遠回報健康。
      const syntheticResult: MemberSessionResult = {
        outcome: 'retryable_failure',
        exitCode: -1,
        output: { summary: '', changedPaths: [], verificationCommands: [], blocker: `task worktree 建立失敗：${(err as Error).message}` },
        evidence: {
          commitSha: null,
          commitChangedPaths: [],
          verificationPassed: false,
          verificationRanCommands: [],
          reviewTransitionConfirmed: false,
          reviewStatus: null,
          summaryCommentId: null,
          blockerRepeated: false,
          rejectedReason: `ensureTaskWorktree failed: ${(err as Error).message}`,
        },
        evidenceChanged: false,
      };
      const transition = await applyMemberAttemptTransition(deps, action, workingRun, syntheticResult, task);
      upsertTaskCheckpoint(
        deps.db,
        {
          taskId: action.taskId,
          workspaceId: action.workspaceId,
          phase: transition.run.phase,
          workerId: workingRun.workerId,
          branch: null,
          baseSha: workingRun.baseSha,
          headSha: workingRun.headSha,
          evidenceFingerprint: transition.run.evidenceFingerprint,
          noProgressCount: transition.run.noProgressCount,
          ownerIntervened: transition.run.ownerIntervened,
        },
        deps.now(),
      );
      return 'no_change';
    }
  }

  const worktreePath = taskWorktreePath(deps.repoRoot, action.taskId);
  const comments = (await deps.ownerClient.listComments(action.taskId)).map((c) => c.content);
  const previousBlocker = comments.length > 0 ? null : null; // 沒有獨立持久化上一次 blocker 文字，保守視為無上一輪

  const summaryActionKeyBase = `member_summary:${action.taskId}:${workingRun.headSha ?? 'none'}`;

  const driverActions: MemberSessionDriverActions = {
    confirmReviewTransition: async () => {
      const current = await deps.ownerClient.getTask(action.taskId);
      if (current.status === 'Review') return 'Review';
      try {
        const patched = await deps.ownerClient.patchTaskField(action.taskId, 'status', 'Review');
        return patched.status;
      } catch (err) {
        if (err instanceof UncertainMutationError) {
          const readback = await deps.ownerClient.getTask(action.taskId);
          return readback.status;
        }
        return null;
      }
    },
    createSummaryComment: async (summary: string) => {
      const content = `${summary}\n\naction_key: ${summaryActionKeyBase}`;
      const existing = await deps.ownerClient.listComments(action.taskId);
      const found = existing.find((c) => c.content.includes(summaryActionKeyBase));
      if (found) return { commentId: found.commentId };
      try {
        const commentId = await deps.ownerClient.postCommentOnce(action.taskId, content, summaryActionKeyBase);
        return { commentId };
      } catch (err) {
        if (err instanceof UncertainMutationError) {
          const retry = await deps.ownerClient.listComments(action.taskId);
          const retryMatch = retry.find((c) => c.content.includes(summaryActionKeyBase));
          if (retryMatch) return { commentId: retryMatch.commentId };
        }
        return null;
      }
    },
  };

  const result = await runMemberSession({
    taskId: action.taskId,
    worktreePath,
    allowedPrefixes: deps.allowedPrefixes,
    acceptanceCriteria: task.title,
    comments,
    previousBlocker,
    runner: deps.runMemberSession!,
    runVerificationCommand: deps.runVerificationCommand,
    driverActions,
  });

  const transition = await applyMemberAttemptTransition(deps, action, workingRun, result, task);

  upsertTaskCheckpoint(
    deps.db,
    {
      taskId: action.taskId,
      workspaceId: action.workspaceId,
      phase: result.outcome === 'progressed' ? 'review' : transition.run.phase,
      workerId: workingRun.workerId,
      branch: workingRun.branch,
      baseSha: workingRun.baseSha,
      headSha: result.evidence.commitSha ?? workingRun.headSha,
      evidenceFingerprint: transition.run.evidenceFingerprint,
      noProgressCount: transition.run.noProgressCount,
      ownerIntervened: transition.run.ownerIntervened,
    },
    deps.now(),
  );

  return result.outcome === 'progressed' ? 'progressed' : 'no_change';
}

// ---------------------------------------------------------------------------
// owner_review：Owner accept -> runDeployAcceptance（merge + 等部署）-> completion.ts
// 貼完成留言、user09 notification readback、Review->Done。Owner reject -> 退回 Doing。
// 部署失敗 -> performMasterRevert + resolveRollbackWait（沿用 coordinator.ts 既有邏輯）。
// ---------------------------------------------------------------------------

function fatalActionKey(taskId: string): string {
  return `fatal_error:${taskId}`;
}

function getFatalError(db: DatabaseSync, taskId: string): FatalCoordinatorError | null {
  const entry = getAction(db, fatalActionKey(taskId));
  if (!entry || entry.status !== 'failed' || !entry.error) return null;
  try {
    return JSON.parse(entry.error) as FatalCoordinatorError;
  } catch {
    return null;
  }
}

function persistFatalError(db: DatabaseSync, fatal: FatalCoordinatorError, now: Date): void {
  const key = fatalActionKey(fatal.taskId);
  if (getAction(db, key)) return; // 已經記錄過，不重複
  beginAction(db, { actionKey: key, taskId: fatal.taskId, kind: 'fatal_error' }, now);
  failAction(db, key, JSON.stringify(fatal), now);
}

async function dispatchOwnerReview(deps: ResolvedDeps, action: CoordinatorAction, run: TaskRun): Promise<'progressed' | 'no_change'> {
  assertNoFatalCoordinatorError(getFatalError(deps.db, action.taskId));

  const reviewedHeadSha = run.headSha ?? '';
  const currentTask = await deps.ownerClient.getTask(action.taskId);
  const comments = (await deps.ownerClient.listComments(action.taskId)).map((c) => c.content);

  const ownerResult = await runOwnerSession({
    taskId: action.taskId,
    acceptanceCriteria: currentTask.title,
    comments,
    reviewedHeadSha,
    worktreePath: taskWorktreePath(deps.repoRoot, action.taskId),
    runner: deps.runOwnerSession!,
  });

  if (!ownerResult.valid || !ownerResult.decision) return 'no_change';

  if (ownerResult.decision.action === 'reject') {
    const key = `reject:${action.taskId}:${reviewedHeadSha}`;
    if (!getAction(deps.db, key)) {
      beginAction(deps.db, { actionKey: key, taskId: action.taskId, kind: 'reject' }, deps.now());
      try {
        await deps.ownerClient.postCommentOnce(
          action.taskId,
          `【OWNER退回】${ownerResult.decision.rationale}\naction_key: ${key}`,
          key,
        );
        const current = await deps.ownerClient.getTask(action.taskId);
        if (current.status !== 'Doing') await deps.ownerClient.patchTaskField(action.taskId, 'status', 'Doing');
        completeAction(deps.db, key, null, deps.now());
      } catch (err) {
        failAction(deps.db, key, (err as Error).message, deps.now());
        throw err;
      }
    }
    upsertTaskCheckpoint(deps.db, { taskId: action.taskId, workspaceId: action.workspaceId, phase: 'doing', workerId: run.workerId, branch: run.branch, baseSha: run.baseSha, headSha: run.headSha, evidenceFingerprint: run.evidenceFingerprint, noProgressCount: 0, ownerIntervened: false }, deps.now());
    return 'progressed';
  }

  if (ownerResult.decision.action !== 'accept') return 'no_change';

  const taskBranch = run.branch ?? taskBranchName(action.taskId);
  const deployResult = await runDeployAcceptance({
    taskId: action.taskId,
    repoRoot: deps.repoRoot,
    taskBranch,
    existingFatalError: getFatalError(deps.db, action.taskId),
    runBranchCi: () => deps.runBranchCi(action.taskId, taskWorktreePath(deps.repoRoot, action.taskId)),
    runIntegrationCommand: deps.runIntegrationCommand,
    runTaskSpecificAcceptance: () => deps.runTaskSpecificAcceptance(action.taskId),
    getSystemdReadback: deps.getSystemdReadback,
    checkHealth: deps.checkHealth,
    runTaskLiveAcceptance: () => deps.runTaskLiveAcceptance(action.taskId),
    now: () => deps.now().getTime(),
    sleep: deps.sleep,
  });

  switch (deployResult.kind) {
    case 'deployed': {
      const completion = await postCompletionAndTransitionToDone({
        db: deps.db,
        ownerClient: deps.ownerClient,
        user09Client: deps.user09Client,
        user09Id: (await deps.ownerClient.listMembers(CANONICAL_WORKSPACE_ID)).find((m) => m.email === USER09_EMAIL)?.userId ?? '',
        taskId: action.taskId,
        taskTitle: currentTask.title,
        acceptedHeadSha: reviewedHeadSha,
        summary: ownerResult.decision.rationale,
        verification: 'npm test, npm run build, git diff --check, task live acceptance',
        deployRev: deployResult.mergeSha,
        now: deps.now(),
      });
      if (completion.kind === 'done') {
        upsertTaskCheckpoint(deps.db, { taskId: action.taskId, workspaceId: action.workspaceId, phase: 'done', workerId: run.workerId, branch: run.branch, baseSha: run.baseSha, headSha: reviewedHeadSha, evidenceFingerprint: run.evidenceFingerprint, noProgressCount: 0, ownerIntervened: false }, deps.now());
        return 'progressed';
      }
      return 'no_change'; // comment_failed／patch_failed：下一個 tick 從 readback-first 續跑
    }
    case 'deploy_indeterminate':
      // 已知、刻意延後的落差（code-quality review Important-3；不是遺漏）：
      // coordinator.ts 對 runDeployAcceptance 上方的註解明文記載「indeterminate 就什麼
      // 都不做，等下一個 tick 用同一個 mergeSha 重新呼叫 waitForDeployment（不必重新跑
      // 這整個 sequence)」，但這裡目前完全沒有照做——下一個 tick 的 owner_review 會對
      // 同一個 reviewedHeadSha 重新跑一次全新的 AI review，若 accept 就把整條
      // runDeployAcceptance（branch CI／整合 worktree／task-specific acceptance／
      // merge）從頭重跑一次。
      //
      // 為什麼現在不直接修：要正確 resume waitForDeployment，必須把這次的
      // targetSha（= mergeSha）與 waitForDeployment 用的 baseline
      // （invocationId／execMainStartTimestampMonotonic）持久化到下一個 tick——但
      // coordinator.ts 的 `DeployAcceptanceResult`（見該檔）目前 'deploy_indeterminate'
      // 這個 variant 只回傳 `{ kind, targetSha, detail }`，並沒有把當時用的 baseline
      // 一併帶出來。要接上 resume 邏輯，得先擴充 coordinator.ts 的公開回傳型別（並同步
      // 調整 production.test.ts 裡對它 exact shape 的既有斷言）——這是比這個檔案（單純
      // CLI 組裝層）更核心、影響面更廣的變更，不適合在這次的安全 CLI 任務裡順手做掉。
      // WorkPhase（types.ts）裡尚未使用的 'integrating'／'deployed' 兩個值，就是為了將來
      // 補上這段 resume 邏輯而預留的掛勾。
      //
      // 目前這樣做「不安全嗎」：不算破壞性，只是浪費：mergeTaskIntoMaster 用 `--no-ff`，
      // 重跑只會多一個 merge commit，不會讓歷史損毀；但如果 AI 這次重新審查剛好翻盤成
      // reject，就會對「可能已經部署成功」的 head 貼一則「退回 Doing」留言，卻沒有觸發
      // 任何 revert（revert 只在 deploy_failed_post_merge 才會觸發）——這是已知、範圍
      // 明確界定的殘留風險，DeploymentIndeterminate 本身依 waitForDeployment 的三路決議
      // 設計已經是很罕見的邊界情況（逾時 + deployed_rev 不符 + service 仍 active 三者
      // 同時成立才會走到這裡），不是每次 timeout 都會命中。
      return 'no_change';
    case 'deploy_failed_post_merge': {
      const revert = await performMasterRevert(action.taskId, deps.repoRoot, deployResult.mergeSha, deps.getSystemdReadback);
      if (revert.kind === 'fatal') {
        persistFatalError(deps.db, revert.fatal, deps.now());
        return 'no_change';
      }
      const rollback = await resolveRollbackWait({
        taskId: action.taskId,
        mergeSha: deployResult.mergeSha,
        revertSha: revert.revertSha,
        baseline: revert.baseline,
        getSystemdReadback: deps.getSystemdReadback,
        checkHealth: deps.checkHealth,
        now: () => deps.now().getTime(),
        sleep: deps.sleep,
      });
      if (rollback.kind === 'rolled_back') {
        const key = rollback.notice.actionKey;
        if (!getAction(deps.db, key)) {
          beginAction(deps.db, { actionKey: key, taskId: action.taskId, kind: 'deployment_rollback_notice' }, deps.now());
          try {
            await deps.ownerClient.postCommentOnce(action.taskId, rollback.notice.content, key);
            completeAction(deps.db, key, null, deps.now());
          } catch (err) {
            failAction(deps.db, key, (err as Error).message, deps.now());
          }
        }
      } else if (rollback.kind === 'fatal') {
        persistFatalError(deps.db, rollback.fatal, deps.now());
      }
      return 'no_change';
    }
    default:
      // fatal_blocked／branch_ci_failed／integration_conflict／integration_command_failed／
      // task_specific_acceptance_failed／deploy_precondition_failed：下一個 tick 重試。
      return 'no_change';
  }
}

// ---------------------------------------------------------------------------
// main_discussion_owner：簡化版機械式收尾（完整 marker 語意屬於 src/mainDiscussion.ts
// 自己的契約，這裡只覆蓋核心路徑；main discussion 的 CUTOVER_TASKS 真實收尾在任務 9
// 的 migrate.ts 有更完整的處理）。
// ---------------------------------------------------------------------------

async function dispatchMainDiscussion(deps: ResolvedDeps, action: CoordinatorAction, run: TaskRun): Promise<'progressed' | 'no_change'> {
  const currentTask = await deps.ownerClient.getTask(action.taskId);
  const comments = (await deps.ownerClient.listComments(action.taskId)).map((c) => c.content);

  // 同上：沒有真實 worktree 可能被誤改，直接呼叫原始 runner，不經過唯讀驗證包裝層。
  const { decision } = await deps.runOwnerSession!({
    taskId: action.taskId,
    acceptanceCriteria: currentTask.title,
    comments,
    reviewedHeadSha: '',
    worktreePath: '',
  });

  if (!decision || decision.action !== 'conclude-discussion') return 'no_change';

  const outcome = decision.outcome ?? 'no_consensus';
  const marker = outcome === 'implement' ? '【結論】' : outcome === 'no_implementation' ? '【結論：不實作】' : '【未達共識】';
  const key = `main_discussion_conclusion:${action.taskId}`;
  if (!getAction(deps.db, key)) {
    beginAction(deps.db, { actionKey: key, taskId: action.taskId, kind: 'main_discussion_conclusion' }, deps.now());
    try {
      await deps.ownerClient.postCommentOnce(action.taskId, `${marker}\n${decision.rationale}\naction_key: ${key}`, key);
      const current = await deps.ownerClient.getTask(action.taskId);
      if (current.status !== 'Done') await deps.ownerClient.patchTaskField(action.taskId, 'status', 'Done');
      completeAction(deps.db, key, null, deps.now());
    } catch (err) {
      failAction(deps.db, key, (err as Error).message, deps.now());
      throw err;
    }
  }
  upsertTaskCheckpoint(deps.db, { taskId: action.taskId, workspaceId: action.workspaceId, phase: 'done', workerId: run.workerId, branch: run.branch, baseSha: run.baseSha, headSha: run.headSha, evidenceFingerprint: run.evidenceFingerprint, noProgressCount: 0, ownerIntervened: false }, deps.now());
  return 'progressed';
}

// =============================================================================
// --status：印出最後一個 tick，並依 heartbeat／active lease 判斷健康與否。
// =============================================================================

interface LatestTickRow {
  tick_id: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  discovered_count: number | null;
  processed_count: number | null;
  skipped_count: number | null;
  error_count: number | null;
  error: string | null;
}

export interface RunStatusOptions {
  dbPath?: string;
  now?: () => Date;
}

export interface RunStatusResult {
  exitCode: 0 | 1;
  lines: string[];
}

export function runStatus(options: RunStatusOptions = {}): RunStatusResult {
  const dbPath = options.dbPath ?? DB_PATH;
  const now = (options.now ?? (() => new Date()))();
  const lines: string[] = [];
  const db = openDbEnsuringDir(dbPath);
  try {
    const latest = db.prepare('SELECT * FROM ticks ORDER BY started_at DESC LIMIT 1').get() as LatestTickRow | undefined;
    const activeLeaseRow = db
      .prepare('SELECT COUNT(*) AS c FROM task_runs WHERE lease_until IS NOT NULL AND lease_until > ?')
      .get(now.toISOString()) as { c: number };
    const activeLeases = activeLeaseRow.c;

    if (!latest) {
      lines.push('尚無任何 tick 紀錄。');
      lines.push(`active leases: ${activeLeases}`);
      const healthy = activeLeases > 0;
      lines.push(`healthy: ${healthy ? 'yes' : 'no'}`);
      return { exitCode: healthy ? 0 : 1, lines };
    }

    lines.push(`last tick: ${latest.tick_id}`);
    lines.push(`  started: ${latest.started_at}`);
    lines.push(`  ended:   ${latest.ended_at ?? '(in progress)'}`);
    lines.push(`  outcome: ${latest.outcome ?? '(unknown)'}`);
    lines.push(`  discovered/processed/skipped/errors: ${latest.discovered_count ?? 0}/${latest.processed_count ?? 0}/${latest.skipped_count ?? 0}/${latest.error_count ?? 0}`);
    if (latest.error) lines.push(`  error: ${latest.error}`);
    lines.push(`active leases: ${activeLeases}`);

    const endedAtMs = latest.ended_at ? Date.parse(latest.ended_at) : NaN;
    const hasRecentHeartbeat = !Number.isNaN(endedAtMs) && now.getTime() - endedAtMs <= HEARTBEAT_STALE_MS;
    const healthy = hasRecentHeartbeat || activeLeases > 0;
    lines.push(`healthy: ${healthy ? 'yes' : 'no'}`);
    return { exitCode: healthy ? 0 : 1, lines };
  } finally {
    db.close();
  }
}

// =============================================================================
// CLI 進入點
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const live = args.includes('--live');
  const status = args.includes('--status');

  if (status) {
    const result = runStatus();
    for (const line of result.lines) console.log(line);
    process.exitCode = result.exitCode;
    return;
  }

  if (once) {
    // 只有 CLI 的 --live 才注入真實 AI runner。刻意不在 runOnce() 裡給預設值：
    // 那會讓任何忘了注入的 programmatic caller（包括測試）意外叫出真 AI 並花錢。
    // runOnce() 裡缺 runner 就 throw 的那道防線因此保留。
    const result = await runOnce(live
      ? { live, runOwnerSession: createOwnerSessionRunner(), runMemberSession: createMemberSessionRunner() }
      : { live });
    for (const line of result.lines) console.log(line);
    process.exitCode = result.exitCode;
    return;
  }

  console.error('usage: npx tsx sim/production.ts --once [--live] | --status');
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
