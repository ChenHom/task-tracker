// 正式環境 sim 協調器的 cutover reconciliation（任務 9）。
//
// 這個檔案負責協調五筆既有卡關 task（見 CUTOVER_TASKS）從舊 sweep 遺留下來的狀態，
// 轉換成 production coordinator 可以安全接手的固定 disposition，且全程不重用任何
// 舊 `sim/user02`～`sim/user06` branch、commit 或 dirty diff。三種模式：
//
//   （預設）唯讀 manifest：只 read back 證據鏈，寫入 sim-logs/cutover-<ts>/manifest.json，
//            不呼叫任何 task／Git／AI mutation adapter。
//   --preflight --live --expect-generation <n>：唯讀，重新計算 fingerprint，只有
//            generation 與全部證據仍相符才 exit 0；不呼叫任何 mutation adapter。
//   --apply --live --expect-generation <n>：唯一會真正 mutate 的模式。
//
// 全程零 AI：mainDiscussion 的機械式結案沿用既有的到期 window／Owner conclusion／
// handoff，不建立新的 Owner AI action；其餘四個 task 的 reconciliation 全部是固定
// 順序的單欄位 PATCH／留言／branch 建立，沒有任何程式路徑會呼叫 Owner／member AI
// runner——這個模組的所有函式簽名裡根本沒有 AI runner 參數，「AI 呼叫數為零」是
// 結構性保證，不是靠執行期檢查湊出來的。
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { CUTOVER_TASKS, MAIN_POLICY_TITLE, LEGACY_CANONICAL_DISCUSSION_TITLE } from './cutoverTasks';
import {
  isExcludedTask,
  validatePrerequisiteEvidence,
  prerequisiteEvidenceFingerprint,
  MAIN_WORKSPACE_ID,
  CANONICAL_WORKSPACE_ID,
  type TaskSnapshot,
  type TaskStatus,
  type CommentSnapshot,
  type NotificationSnapshot,
  type PrerequisiteEvidence,
} from './policy';
import {
  ensureTaskWorktree,
  taskBranchName,
  taskWorktreePath,
  branchExists,
  isAncestor,
  getHeadSha,
  countCommitsAhead,
  collectTaskChanges,
} from './git';
import {
  openCoordinatorState,
  getTaskRun,
  upsertTaskCheckpoint,
  getAction,
  beginAction,
  completeAction,
  failAction,
  getCoordinatorMeta,
  recordCutoverGeneration,
} from './state';
import type { TaskRun } from './types';
import { UncertainMutationError, type AuditEventSnapshot, type MemberSnapshot } from './api';
import { gatherPrerequisiteEvidence, performDiscovery, OWNER_EMAIL, USER09_EMAIL, type PrerequisiteEvidenceDeps } from '../production';

const execFileAsync = promisify(execFile);

// 供任何想直接從 migrate.ts import 這組 migration set 的呼叫端使用；權威定義在
// ./cutoverTasks（見該檔頭註解），這裡只 re-export，不另外維護一份。
export { CUTOVER_TASKS };

// =============================================================================
// 任務特定驗收條件（純文字，供 manifest 稽核；不是任何自動化程式碼——這個
// subsystem 沒有瀏覽器自動化能力，這裡只是把「人工／未來 E2E 驗收要涵蓋什麼」
// 這件事寫成 manifest 看得到的固定清單，供操作者比對）。
// =============================================================================
export const ACTIVE_REVIEW_ACCEPTANCE_CRITERIA: readonly string[] = [
  '冷啟動／重新整理 task URL',
  '目前選到其他 workspace 時仍切到正確 workspace',
  'task modal 與 comment anchor',
  '403／404',
  '既有 #/tasks 回歸',
  '正式瀏覽器 smoke',
];

export const QUEUED_REVIEW_ACCEPTANCE_CRITERIA: readonly string[] = [
  'branch base 已包含 938aa035... merge',
  '手機 menu toggle 後 badge 節點仍存在',
  'hidden tab 不執行 60 秒 polling',
  '來源 task／comment 真正開啟成功後才標已讀',
  '涵蓋 0／1／多筆',
  '403／404',
  '手動已讀',
  '桌機／手機 smoke',
];

// =============================================================================
// 注入介面：task mutation adapter／Git adapter／舊 timer readback。
//
// CutoverBoardClient／CutoverNotificationClient 刻意是介面（不是 api.ts 的
// TaskTrackerClient 具體 class）：正式環境會傳入真正的 TaskTrackerClient 實例
// （結構上自然滿足這裡的介面），測試則可以直接餵一個手寫的 plain object spy
// （呼應 completion.ts 既有的 CompletionOwnerClient／CompletionNotifierClient
// 慣例），不需要架一個真的 HTTP server。
// =============================================================================

export interface CutoverBoardClient {
  getTask(taskId: string): Promise<TaskSnapshot>;
  listComments(taskId: string): Promise<CommentSnapshot[]>;
  postCommentOnce(taskId: string, content: string, actionKey: string): Promise<string>;
  patchTaskField(taskId: string, field: 'status' | 'assignee', value: unknown): Promise<TaskSnapshot>;
  listMembers(workspaceId: string): Promise<MemberSnapshot[]>;
  getAuditTrail(aggregateId: string): Promise<AuditEventSnapshot[]>;
  whoAmI(): Promise<{ id: string; email: string; name: string }>;
  health(): Promise<{ status: string; db: boolean; rev: string }>;
}

export interface CutoverNotificationClient {
  listNotifications(): Promise<NotificationSnapshot[]>;
}

export interface LegacyTimerState {
  ownerTimerActive: boolean;
  teamTimerActive: boolean;
}

export type GetLegacyTimerState = () => Promise<LegacyTimerState>;

async function realIsUnitActive(unit: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', unit]);
    return stdout.trim() === 'active';
  } catch {
    return false; // unit 可能根本沒安裝——保守回報 inactive，這只是稽核用的描述欄位。
  }
}

async function realGetLegacyTimerState(): Promise<LegacyTimerState> {
  const [ownerTimerActive, teamTimerActive] = await Promise.all([
    realIsUnitActive('sim-sweep-owner.timer'),
    realIsUnitActive('sim-sweep-team.timer'),
  ]);
  return { ownerTimerActive, teamTimerActive };
}

// =============================================================================
// 唯讀 manifest 型別。
// =============================================================================

export interface CutoverBranchDescriptor {
  name: string;
  exists: boolean;
  headSha: string | null;
  dirty: boolean;
  aheadOfMaster: number | null;
}

export interface CutoverManifestTaskEntry {
  taskId: string;
  version: number;
  status: TaskStatus;
  assigneeId: string | null;
  fixedAssigneeEmail: string | null;
  releaseDependency: string | null;
  coordinatorPhase: string | null;
  plannedDisposition: string;
  branch: CutoverBranchDescriptor;
  /** 只有 activeReview／queuedReview 非空——這個 task 的固定驗收清單，見檔頭常數。 */
  acceptanceCriteria: readonly string[];
}

export interface CutoverExcludedEntry {
  taskId: string;
  title: string | null;
  isExcluded: boolean;
}

export interface CutoverPrerequisiteManifest {
  taskId: string;
  status: TaskStatus | null;
  task1AuthorizedAt: string | null;
  canonicalOwnerId: string | null;
  user03CanonicalId: string | null;
  assignmentEventId: string | null;
  assignmentActorId: string | null;
  assignmentAggregateVersion: number | null;
  assignmentBaselineVersion: number | null;
  taskBranch: string | null;
  acceptedHeadSha: string | null;
  mergeSha: string | null;
  ownerAcceptanceId: string | null;
  liveRev: string | null;
  completionCommentId: string | null;
  notificationId: string | null;
  fingerprint: string;
  satisfied: boolean;
}

export interface CutoverCursor {
  count: number;
  lastId: string | null;
}

export interface CutoverManifest {
  generatedAt: string;
  cutoverGeneration: number;
  manifestFingerprint: string;
  readyForApply: boolean;
  errorCode: 'CutoverPrerequisiteMissing' | null;
  notificationCursor: CutoverCursor;
  outboxCursor: CutoverCursor;
  legacyTimerState: LegacyTimerState;
  prerequisite: CutoverPrerequisiteManifest;
  tasks: CutoverManifestTaskEntry[];
  excluded: CutoverExcludedEntry[];
}

// =============================================================================
// 共用小工具
// =============================================================================

/** PATCH 一個欄位；`UncertainMutationError` 時改用 readback 判斷是否其實已經生效。 */
async function patchFieldWithReadback(
  client: CutoverBoardClient,
  taskId: string,
  field: 'status' | 'assignee',
  value: unknown,
  satisfiedAfter: (t: TaskSnapshot) => boolean,
): Promise<TaskSnapshot> {
  try {
    return await client.patchTaskField(taskId, field, value);
  } catch (err) {
    if (err instanceof UncertainMutationError) {
      const readback = await client.getTask(taskId);
      if (satisfiedAfter(readback)) return readback;
    }
    throw err;
  }
}

/** 留言的 readback-first 去重：marker（action key）已存在於任一留言就不重貼。 */
async function postCommentIfMissing(
  client: CutoverBoardClient,
  taskId: string,
  content: string,
  actionKey: string,
): Promise<string> {
  const existing = await client.listComments(taskId);
  const found = existing.find((c) => c.content.includes(actionKey));
  if (found) return found.commentId;
  try {
    return await client.postCommentOnce(taskId, content, actionKey);
  } catch (err) {
    if (err instanceof UncertainMutationError) {
      const retry = await client.listComments(taskId);
      const retryMatch = retry.find((c) => c.content.includes(actionKey));
      if (retryMatch) return retryMatch.commentId;
    }
    throw err;
  }
}

async function branchDescriptor(repoRoot: string, taskId: string): Promise<CutoverBranchDescriptor> {
  const name = taskBranchName(taskId);
  const exists = await branchExists(repoRoot, name);
  if (!exists) {
    return { name, exists: false, headSha: null, dirty: false, aheadOfMaster: null };
  }
  const headSha = await getHeadSha(repoRoot, name);
  const aheadOfMaster = await countCommitsAhead(repoRoot, 'master', name);
  const worktreePath = taskWorktreePath(repoRoot, taskId);
  let dirty = false;
  try {
    const changes = await collectTaskChanges(worktreePath);
    dirty = changes.length > 0;
  } catch {
    dirty = false; // 沒有 linked worktree 目錄可以檢查——branch 本身仍然可能存在，只是沒有工作目錄。
  }
  return { name, exists: true, headSha, dirty, aheadOfMaster };
}

// =============================================================================
// gatherPrerequisiteEvidence 的 deps 轉接：migrate.ts 用 CutoverBoardClient／
// CutoverNotificationClient（介面），productions.ts 的 gatherPrerequisiteEvidence
// 吃的是結構相容的 Pick<TaskTrackerClient, ...>——兩者天生結構相容，這裡只是把
// migrate.ts 自己的 deps 包成它要的形狀，不重寫任何驗證邏輯。
// =============================================================================

interface PrerequisiteDeps {
  ownerClient: CutoverBoardClient;
  user09Client: CutoverNotificationClient;
  repoRoot: string;
}

async function readPrerequisiteEvidence(deps: PrerequisiteDeps): Promise<PrerequisiteEvidence | null> {
  const taskId = CUTOVER_TASKS.completedPrerequisite.taskId;
  const task = await deps.ownerClient.getTask(taskId);
  const members = await deps.ownerClient.listMembers(CANONICAL_WORKSPACE_ID);
  const userIdsByEmail: Record<string, string> = {};
  for (const m of members) userIdsByEmail[m.email] = m.userId;

  const evidenceDeps: PrerequisiteEvidenceDeps = {
    ownerClient: deps.ownerClient,
    user09Client: deps.user09Client,
    repoRoot: deps.repoRoot,
  };
  return gatherPrerequisiteEvidence(evidenceDeps, [task], userIdsByEmail);
}

/** 額外讀 assignment audit event 的 aggregateVersion／baseline（純稽核欄位，見檔頭）。 */
async function readAssignmentAggregateVersions(
  deps: PrerequisiteDeps,
  evidence: PrerequisiteEvidence | null,
): Promise<{ aggregateVersion: number | null; baselineVersion: number | null }> {
  if (!evidence?.assignmentEvent) return { aggregateVersion: null, baselineVersion: null };
  try {
    const audit = await deps.ownerClient.getAuditTrail(CUTOVER_TASKS.completedPrerequisite.taskId);
    const match = audit.find((e) => String(e.id) === evidence.assignmentEvent!.eventId);
    if (!match) return { aggregateVersion: null, baselineVersion: null };
    return { aggregateVersion: match.aggregateVersion, baselineVersion: match.aggregateVersion - 1 };
  } catch {
    return { aggregateVersion: null, baselineVersion: null };
  }
}

function buildPrerequisiteManifest(
  evidence: PrerequisiteEvidence | null,
  versions: { aggregateVersion: number | null; baselineVersion: number | null },
): CutoverPrerequisiteManifest {
  const fingerprint = prerequisiteEvidenceFingerprint(evidence);
  const satisfied = validatePrerequisiteEvidence(evidence);
  return {
    taskId: CUTOVER_TASKS.completedPrerequisite.taskId,
    status: evidence?.status ?? null,
    task1AuthorizedAt: evidence?.task1AuthorizedAt || null,
    canonicalOwnerId: evidence?.canonicalOwnerId || null,
    user03CanonicalId: evidence?.user03CanonicalId || null,
    assignmentEventId: evidence?.assignmentEvent?.eventId ?? null,
    assignmentActorId: evidence?.assignmentEvent?.actorId ?? null,
    assignmentAggregateVersion: versions.aggregateVersion,
    assignmentBaselineVersion: versions.baselineVersion,
    taskBranch: evidence?.acceptedHead?.branch ?? null,
    acceptedHeadSha: evidence?.acceptedHead?.sha ?? null,
    mergeSha: evidence?.acceptedMerge?.sha ?? null,
    ownerAcceptanceId: evidence?.ownerAcceptance?.acceptanceId ?? null,
    liveRev: evidence?.liveRev ?? null,
    completionCommentId: evidence?.completionComment?.commentId ?? null,
    notificationId: evidence?.notification?.notificationId ?? null,
    fingerprint,
    satisfied,
  };
}

// =============================================================================
// 唯讀 manifest 建構（預設 invocation；--preflight --live 也會呼叫這裡重新計算
// facts／fingerprint，但絕不寫檔、絕不呼叫任何 mutation adapter）。
// =============================================================================

export interface BuildManifestInput {
  db: DatabaseSync;
  ownerClient: CutoverBoardClient;
  user09Client: CutoverNotificationClient;
  repoRoot: string;
  getLegacyTimerState?: GetLegacyTimerState;
  now?: () => Date;
}

function coordinatorPhaseFor(db: DatabaseSync, taskId: string): string | null {
  return getTaskRun(db, taskId)?.phase ?? null;
}

export async function buildManifest(input: BuildManifestInput): Promise<CutoverManifest> {
  const now = (input.now ?? (() => new Date()))();
  const getLegacyTimerState = input.getLegacyTimerState ?? realGetLegacyTimerState;
  const deps: PrerequisiteDeps = { ownerClient: input.ownerClient, user09Client: input.user09Client, repoRoot: input.repoRoot };

  const [mainDiscussionTask, activeReviewTask, queuedReviewTask, prerequisiteTask, deferredTask, mainPolicyTask, legacyTask] =
    await Promise.all([
      input.ownerClient.getTask(CUTOVER_TASKS.mainDiscussion),
      input.ownerClient.getTask(CUTOVER_TASKS.activeReview.taskId),
      input.ownerClient.getTask(CUTOVER_TASKS.queuedReview.taskId),
      input.ownerClient.getTask(CUTOVER_TASKS.completedPrerequisite.taskId),
      input.ownerClient.getTask(CUTOVER_TASKS.deferredAssignment.taskId),
      input.ownerClient.getTask(CUTOVER_TASKS.mainPolicy),
      input.ownerClient.getTask(CUTOVER_TASKS.legacyCanonicalDiscussion),
    ]);

  const evidence = await readPrerequisiteEvidence(deps);
  const versions = await readAssignmentAggregateVersions(deps, evidence);
  const prerequisite = buildPrerequisiteManifest(evidence, versions);

  const activeReviewGateOpen = await isActiveReviewGateOpen(input.db, input.repoRoot, activeReviewTask);

  const tasks: CutoverManifestTaskEntry[] = [
    {
      taskId: mainDiscussionTask.taskId,
      version: mainDiscussionTask.version,
      status: mainDiscussionTask.status,
      assigneeId: mainDiscussionTask.assigneeId,
      fixedAssigneeEmail: null,
      releaseDependency: null,
      coordinatorPhase: coordinatorPhaseFor(input.db, mainDiscussionTask.taskId),
      plannedDisposition: prerequisite.satisfied
        ? mainDiscussionTask.status === 'Done'
          ? '已機械式結案（Done），重跑不再重複結案'
          : '前置條件通過，apply 會以既有到期 window／Owner conclusion／handoff 機械式結案一次'
        : '等待 00123ef0 前置條件通過',
      branch: { name: '(no task branch)', exists: false, headSha: null, dirty: false, aheadOfMaster: null },
      acceptanceCriteria: [],
    },
    {
      taskId: activeReviewTask.taskId,
      version: activeReviewTask.version,
      status: activeReviewTask.status,
      assigneeId: activeReviewTask.assigneeId,
      fixedAssigneeEmail: CUTOVER_TASKS.activeReview.assigneeEmail,
      releaseDependency: null,
      coordinatorPhase: coordinatorPhaseFor(input.db, activeReviewTask.taskId),
      plannedDisposition: prerequisite.satisfied
        ? '恢復／保留 user06 assignee，PATCH Review -> Doing，從當時 master 建立乾淨 branch'
        : '等待 00123ef0 前置條件通過',
      branch: await branchDescriptor(input.repoRoot, activeReviewTask.taskId),
      acceptanceCriteria: ACTIVE_REVIEW_ACCEPTANCE_CRITERIA,
    },
    {
      taskId: queuedReviewTask.taskId,
      version: queuedReviewTask.version,
      status: queuedReviewTask.status,
      assigneeId: queuedReviewTask.assigneeId,
      fixedAssigneeEmail: CUTOVER_TASKS.queuedReview.assigneeEmail,
      releaseDependency: CUTOVER_TASKS.queuedReview.afterTaskId,
      coordinatorPhase: coordinatorPhaseFor(input.db, queuedReviewTask.taskId),
      plannedDisposition: !prerequisite.satisfied
        ? '等待 00123ef0 前置條件通過'
        : activeReviewGateOpen
          ? '938aa035 已 Done 且 master 已包含其 accepted merge：指派 user06、PATCH Todo -> Doing、建立新 branch'
          : '三步 PATCH 退回 Review -> Doing -> Todo -> 清除 assignee，checkpoint=queued，等待 938aa035 Done',
      branch: await branchDescriptor(input.repoRoot, queuedReviewTask.taskId),
      acceptanceCriteria: QUEUED_REVIEW_ACCEPTANCE_CRITERIA,
    },
    {
      taskId: prerequisiteTask.taskId,
      version: prerequisiteTask.version,
      status: prerequisiteTask.status,
      assigneeId: prerequisiteTask.assigneeId,
      fixedAssigneeEmail: CUTOVER_TASKS.completedPrerequisite.implementerEmail,
      releaseDependency: null,
      coordinatorPhase: coordinatorPhaseFor(input.db, prerequisiteTask.taskId),
      plannedDisposition: prerequisite.satisfied
        ? '任務 1 已完成前置條件／cutover 無 action'
        : 'CutoverPrerequisiteMissing：完成證據鏈缺漏或不相符',
      branch: { name: CUTOVER_TASKS.completedPrerequisite.taskBranch, exists: true, headSha: prerequisite.acceptedHeadSha, dirty: false, aheadOfMaster: null },
      acceptanceCriteria: [],
    },
    {
      taskId: deferredTask.taskId,
      version: deferredTask.version,
      status: deferredTask.status,
      assigneeId: deferredTask.assigneeId,
      fixedAssigneeEmail: CUTOVER_TASKS.deferredAssignment.assigneeEmail,
      releaseDependency: CUTOVER_TASKS.deferredAssignment.afterTaskId,
      coordinatorPhase: coordinatorPhaseFor(input.db, deferredTask.taskId),
      plannedDisposition: !prerequisite.satisfied
        ? '等待 00123ef0 前置條件通過'
        : activeReviewGateOpen
          ? '938aa035 已 Done 且 master 已包含其 accepted merge：指派 user05、PATCH Todo -> Doing、建立新 branch'
          : '維持 Todo／unassigned／queued，等待 938aa035 Done',
      branch: await branchDescriptor(input.repoRoot, deferredTask.taskId),
      acceptanceCriteria: [],
    },
  ];

  const excluded: CutoverExcludedEntry[] = [
    { taskId: mainPolicyTask.taskId, title: mainPolicyTask.title, isExcluded: isExcludedTask(mainPolicyTask) },
    { taskId: legacyTask.taskId, title: legacyTask.title, isExcluded: isExcludedTask(legacyTask) },
  ];

  const notifications = await input.user09Client.listNotifications();
  const notificationCursor: CutoverCursor = {
    count: notifications.length,
    lastId: notifications.length > 0 ? notifications[notifications.length - 1].notificationId : null,
  };
  const outboxCursor = readOutboxCursor(input.db);
  const legacyTimerState = await getLegacyTimerState();

  const facts = buildDriftFacts(tasks, prerequisite, notificationCursor, evidence?.liveRev ?? null);
  const manifestFingerprint = driftFactsFingerprint(facts);

  const meta = getCoordinatorMeta(input.db);
  const stored = readManifestSnapshot(input.db);
  // 只有 fingerprint 真的變化時才前進 generation；重跑一個完全沒變化的 manifest
  // 不應該讓 operator 手上的 --expect-generation 悄悄失效。
  const cutoverGeneration =
    stored && stored.fingerprint === manifestFingerprint ? meta.cutoverGeneration : meta.cutoverGeneration + 1;
  recordCutoverGeneration(input.db, cutoverGeneration, now);
  writeManifestSnapshot(input.db, cutoverGeneration, manifestFingerprint, facts, now);

  return {
    generatedAt: now.toISOString(),
    cutoverGeneration,
    manifestFingerprint,
    readyForApply: prerequisite.satisfied,
    errorCode: prerequisite.satisfied ? null : 'CutoverPrerequisiteMissing',
    notificationCursor,
    outboxCursor,
    legacyTimerState,
    prerequisite,
    tasks,
    excluded,
  };
}

/** 把 manifest 寫入 Git 已忽略的 `sim-logs/cutover-<timestamp>/manifest.json`。回傳實際寫入的路徑。 */
export function writeManifestFile(manifest: CutoverManifest, logsRoot: string): string {
  const stamp = manifest.generatedAt.replace(/[:.]/g, '-');
  const dir = join(logsRoot, `cutover-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

// =============================================================================
// Drift facts：generation-bound preflight 比對用的複合 fingerprint（task
// version／audit cursor／notification cursor／live rev／prerequisite fingerprint）。
// =============================================================================

interface DriftFacts {
  taskVersions: Record<string, number>;
  prerequisiteFingerprint: string;
  notificationCursor: CutoverCursor;
  liveRev: string | null;
}

function buildDriftFacts(
  tasks: CutoverManifestTaskEntry[],
  prerequisite: CutoverPrerequisiteManifest,
  notificationCursor: CutoverCursor,
  liveRev: string | null,
): DriftFacts {
  const taskVersions: Record<string, number> = {};
  for (const t of tasks) taskVersions[t.taskId] = t.version;
  return { taskVersions, prerequisiteFingerprint: prerequisite.fingerprint, notificationCursor, liveRev };
}

function driftFactsFingerprint(facts: DriftFacts): string {
  const canonical = JSON.stringify([
    Object.keys(facts.taskVersions)
      .sort()
      .map((k) => [k, facts.taskVersions[k]]),
    facts.prerequisiteFingerprint,
    facts.notificationCursor.count,
    facts.notificationCursor.lastId,
    facts.liveRev,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

// =============================================================================
// migrate.ts 自己的 sidecar table：只存「目前這個 generation 對應的 drift facts／
// fingerprint」單一列，不新增遷移邏輯（CREATE TABLE IF NOT EXISTS 對全新 table
// 永遠安全）；coordinator_meta.cutover_generation（任務 2 既有欄位）仍是唯一權威
// 的 generation 計數器，這裡只是它的稽核細節快取。
// =============================================================================

function ensureSnapshotTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cutover_manifest_snapshot (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      generation   INTEGER NOT NULL,
      fingerprint  TEXT NOT NULL,
      facts_json   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);
}

function readManifestSnapshot(db: DatabaseSync): { generation: number; fingerprint: string; facts: DriftFacts } | null {
  ensureSnapshotTable(db);
  const row = db.prepare('SELECT generation, fingerprint, facts_json FROM cutover_manifest_snapshot WHERE id = 1').get() as
    | { generation: number; fingerprint: string; facts_json: string }
    | undefined;
  if (!row) return null;
  return { generation: row.generation, fingerprint: row.fingerprint, facts: JSON.parse(row.facts_json) as DriftFacts };
}

function writeManifestSnapshot(db: DatabaseSync, generation: number, fingerprint: string, facts: DriftFacts, now: Date): void {
  ensureSnapshotTable(db);
  db.prepare(`
    INSERT INTO cutover_manifest_snapshot (id, generation, fingerprint, facts_json, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      generation  = excluded.generation,
      fingerprint = excluded.fingerprint,
      facts_json  = excluded.facts_json,
      updated_at  = excluded.updated_at
  `).run(generation, fingerprint, JSON.stringify(facts), now.toISOString());
}

function readOutboxCursor(db: DatabaseSync): CutoverCursor {
  const countRow = db.prepare('SELECT COUNT(*) AS c FROM completion_outbox').get() as { c: number };
  const lastRow = db.prepare('SELECT completion_id FROM completion_outbox ORDER BY created_at DESC, completion_id DESC LIMIT 1').get() as
    | { completion_id: string }
    | undefined;
  return { count: countRow.c, lastId: lastRow?.completion_id ?? null };
}

// =============================================================================
// Generation-bound 唯讀 preflight：`--preflight --live --expect-generation <n>`。
// manifest 與 apply 都必須呼叫「同一個」檢查函式，不得各自維護一份比對邏輯。
// =============================================================================

export interface GenerationCheckInput {
  db: DatabaseSync;
  ownerClient: CutoverBoardClient;
  user09Client: CutoverNotificationClient;
  repoRoot: string;
  expectGeneration: number;
  getLegacyTimerState?: GetLegacyTimerState;
  now?: () => Date;
}

export type GenerationCheckResult = { ok: true; manifest: CutoverManifest } | { ok: false; reason: string; manifest: CutoverManifest };

/**
 * 唯讀：重新跑一次 buildManifest（因此也會重新計算／持久化 generation——見
 * buildManifest 對 fingerprint 未變時保持同一個 generation 的處理），再比對
 * 結果的 generation 與呼叫端期望的 `expectGeneration` 是否相符。這個函式本身
 * 不呼叫任何 task／Git PATCH／mutation，只有 buildManifest 內部的
 * `recordCutoverGeneration`／`writeManifestSnapshot` 兩個小型本地 SQLite 寫入
 * ——那是 migrate.ts 自己的稽核 bookkeeping，不是「唯讀」這個詞在計畫裡真正
 * 要保護的對象（task／Git／AI mutation adapter）。
 */
export async function checkGenerationMatches(input: GenerationCheckInput): Promise<GenerationCheckResult> {
  const manifest = await buildManifest({
    db: input.db,
    ownerClient: input.ownerClient,
    user09Client: input.user09Client,
    repoRoot: input.repoRoot,
    getLegacyTimerState: input.getLegacyTimerState,
    now: input.now,
  });
  if (manifest.cutoverGeneration !== input.expectGeneration) {
    return {
      ok: false,
      reason: `manifest generation 不符：目前重新計算為 ${manifest.cutoverGeneration}，期望 ${input.expectGeneration}`,
      manifest,
    };
  }
  if (!manifest.readyForApply) {
    return { ok: false, reason: 'CutoverPrerequisiteMissing：完成證據鏈缺漏或不相符', manifest };
  }
  return { ok: true, manifest };
}

// =============================================================================
// 938aa035（activeReview）的 gate：queuedReview／deferredAssignment 是否已經可以
// 解除依賴——狀態必須是 Done，且它的 accepted head（來自 coordinator 自己的
// task_runs checkpoint，正常完成流程會把 reviewed head SHA 寫進 headSha）必須是
// 目前 master 的祖先。見檔頭關於為什麼用 task_runs 而不是重新解析完成留言的說明。
// =============================================================================

async function isActiveReviewGateOpen(db: DatabaseSync, repoRoot: string, activeReviewTask: TaskSnapshot): Promise<boolean> {
  if (activeReviewTask.status !== 'Done') return false;
  const run = getTaskRun(db, activeReviewTask.taskId);
  if (!run?.headSha) return false;
  return isAncestor(repoRoot, run.headSha, 'master');
}

// =============================================================================
// --apply --live 的核心 reconciliation（不含 generation 檢查，見下方 runApply）。
// =============================================================================

export interface ApplyCutoverInput {
  db: DatabaseSync;
  ownerClient: CutoverBoardClient;
  user09Client: CutoverNotificationClient;
  repoRoot: string;
  now?: () => Date;
}

export interface ApplyCutoverSummary {
  mainDiscussionClosed: boolean;
  activeReviewBranch: string | null;
  queuedReviewFinalStatus: TaskStatus;
  queuedReviewDispatched: boolean;
  deferredAssignmentDispatched: boolean;
  /** 結構性保證：這個模組沒有任何程式路徑會呼叫 Owner／member AI runner。 */
  aiCalls: 0;
}

export type ApplyCutoverOutcome =
  | { kind: 'prerequisite_missing'; detail: string }
  | { kind: 'applied'; summary: ApplyCutoverSummary };

function mainDiscussionCloseActionKey(): string {
  return `cutover:main_discussion:mechanical_close:${CUTOVER_TASKS.mainDiscussion}`;
}

async function closeMainDiscussionIfDue(db: DatabaseSync, client: CutoverBoardClient, now: Date): Promise<boolean> {
  const taskId = CUTOVER_TASKS.mainDiscussion;
  const key = mainDiscussionCloseActionKey();
  let closedThisCall = false;
  if (!getAction(db, key)) {
    beginAction(db, { actionKey: key, taskId, kind: 'cutover_main_discussion_close' }, now);
    try {
      const current = await client.getTask(taskId);
      if (current.status !== 'Done') {
        await patchFieldWithReadback(client, taskId, 'status', 'Done', (t) => t.status === 'Done');
        closedThisCall = true;
      }
      completeAction(db, key, JSON.stringify({ closedThisCall }), now);
    } catch (err) {
      failAction(db, key, (err as Error).message, now);
      throw err;
    }
  }
  return closedThisCall;
}

function activeReviewAssignKey(taskId: string): string {
  return `cutover:active_review:assign:${taskId}`;
}
function activeReviewNoticeKey(taskId: string): string {
  return `cutover:active_review:reset_notice:${taskId}`;
}
function activeReviewStatusKey(taskId: string): string {
  return `cutover:active_review:status_doing:${taskId}`;
}
function activeReviewBranchKey(taskId: string): string {
  return `cutover:active_review:branch:${taskId}`;
}

function buildActiveReviewResetNotice(taskId: string, actionKey: string): string {
  return (
    `【CUTOVER重啟】這個 task 是既有卡關項目，production coordinator cutover 正在把它重新交回 ` +
    `${CUTOVER_TASKS.activeReview.assigneeEmail}，從 Review 退回 Doing 繼續處理。\n` +
    `分類：${CUTOVER_TASKS.activeReview.classification}\n` +
    `action_key: ${actionKey}`
  );
}

async function reactivateActiveReview(
  db: DatabaseSync,
  client: CutoverBoardClient,
  repoRoot: string,
  now: Date,
): Promise<{ branch: string }> {
  const taskId = CUTOVER_TASKS.activeReview.taskId;

  const members = await client.listMembers(CANONICAL_WORKSPACE_ID);
  const user06Id = members.find((m) => m.email === CUTOVER_TASKS.activeReview.assigneeEmail)?.userId ?? null;

  // (1) 保留或恢復 user06 assignee。
  const assignKey = activeReviewAssignKey(taskId);
  if (!getAction(db, assignKey)) {
    beginAction(db, { actionKey: assignKey, taskId, kind: 'cutover_active_review_assign' }, now);
    try {
      if (user06Id) {
        const current = await client.getTask(taskId);
        if (current.assigneeId !== user06Id) {
          await patchFieldWithReadback(client, taskId, 'assignee', user06Id, (t) => t.assigneeId === user06Id);
        }
      }
      completeAction(db, assignKey, null, now);
    } catch (err) {
      failAction(db, assignKey, (err as Error).message, now);
      throw err;
    }
  }

  // (2) 固定 action key 的 reset 說明留言。
  const noticeKey = activeReviewNoticeKey(taskId);
  if (!getAction(db, noticeKey)) {
    beginAction(db, { actionKey: noticeKey, taskId, kind: 'cutover_active_review_notice' }, now);
    try {
      await postCommentIfMissing(client, taskId, buildActiveReviewResetNotice(taskId, noticeKey), noticeKey);
      completeAction(db, noticeKey, null, now);
    } catch (err) {
      failAction(db, noticeKey, (err as Error).message, now);
      throw err;
    }
  }

  // (3) 單欄位 PATCH：Review -> Doing（只在真的還是 Review 時才 PATCH）。
  const statusKey = activeReviewStatusKey(taskId);
  if (!getAction(db, statusKey)) {
    beginAction(db, { actionKey: statusKey, taskId, kind: 'cutover_active_review_status' }, now);
    try {
      const current = await client.getTask(taskId);
      if (current.status === 'Review') {
        await patchFieldWithReadback(client, taskId, 'status', 'Doing', (t) => t.status === 'Doing');
      }
      completeAction(db, statusKey, null, now);
    } catch (err) {
      failAction(db, statusKey, (err as Error).message, now);
      throw err;
    }
  }

  // (4) checkpoint=doing／noProgressCount=0，並從當時 master 建立乾淨 branch
  //     （ensureTaskWorktree 本身冪等，每次呼叫都安全重用既有 worktree；action key
  //     只是把「這一步發生過」記進稽核紀錄，不是拿來擋住重新驗證的呼叫）。
  const masterSha = await getHeadSha(repoRoot, 'master');
  const worktree = await ensureTaskWorktree(repoRoot, taskId, masterSha);
  const branchKey = activeReviewBranchKey(taskId);
  if (!getAction(db, branchKey)) {
    beginAction(db, { actionKey: branchKey, taskId, kind: 'cutover_active_review_branch' }, now);
    completeAction(db, branchKey, JSON.stringify({ branch: worktree.branch, headSha: worktree.headSha }), now);
  }

  const currentTask = await client.getTask(taskId);
  const existingRun = getTaskRun(db, taskId);
  upsertTaskCheckpoint(
    db,
    {
      taskId,
      workspaceId: currentTask.workspaceId,
      phase: 'doing',
      workerId: existingRun?.workerId ?? null,
      branch: worktree.branch,
      baseSha: worktree.baseSha,
      headSha: worktree.headSha,
      evidenceFingerprint: existingRun?.evidenceFingerprint ?? '',
      noProgressCount: 0,
      ownerIntervened: false,
    },
    now,
  );

  return { branch: worktree.branch };
}

function queuedReviewStepKey(taskId: string, step: 1 | 2 | 3): string {
  return `cutover:queued_review:step${step}:${taskId}`;
}

/**
 * 三次單欄位 PATCH，固定順序：(1) Review -> Doing（此時 assignee 仍是 user06，
 * 滿足 src/task.ts:247 的守衛）→ (2) Doing -> Todo → (3) 清除 assignee。
 *
 * 每一步都用「這一步自己的 action key 是否已存在」擋重複執行，內層再用一次真正的
 * readback 確認目前狀態「剛好是這一步的前置狀態」才 PATCH——這是避免先清 assignee
 * 就永久卡在 Review 的關鍵防呆：如果 step1／step2 因為某種原因還沒真的發生（board
 * 狀態仍是 Review），step3 的內層檢查 `status === 'Todo'` 不成立，就完全不會清除
 * assignee。中斷後重跑：已完成的步驟的 action key 已存在，直接跳過；未完成的步驟
 * 用當下真實 board 狀態決定要不要動作，不會從頭重跑一次已經完成的步驟。
 */
async function releaseQueuedReviewToBaseline(db: DatabaseSync, client: CutoverBoardClient, now: Date): Promise<TaskSnapshot> {
  const taskId = CUTOVER_TASKS.queuedReview.taskId;

  // 已經退回到 baseline（Todo／unassigned）且 checkpoint 已經是 queued：這個函式的
  // 工作早就完成。提前結束，不呼叫任何 beginAction——state.ts 的 beginAction 對
  // phase === 'queued' 的 task 有硬性守衛（queued task 不得建立任何 action，見
  // dispatchToDoingIfNotAlready 的同款註解），這個提前檢查正是避免撞上那個守衛。
  const existingRun = getTaskRun(db, taskId);
  const currentBefore = await client.getTask(taskId);
  if (existingRun?.phase === 'queued' && currentBefore.status === 'Todo' && currentBefore.assigneeId === null) {
    return currentBefore;
  }

  const step1Key = queuedReviewStepKey(taskId, 1);
  if (!getAction(db, step1Key)) {
    beginAction(db, { actionKey: step1Key, taskId, kind: 'cutover_queued_review_step1' }, now);
    try {
      const current = await client.getTask(taskId);
      if (current.status === 'Review') {
        await patchFieldWithReadback(client, taskId, 'status', 'Doing', (t) => t.status === 'Doing');
      }
      completeAction(db, step1Key, null, now);
    } catch (err) {
      failAction(db, step1Key, (err as Error).message, now);
      throw err;
    }
  }

  const step2Key = queuedReviewStepKey(taskId, 2);
  if (!getAction(db, step2Key)) {
    beginAction(db, { actionKey: step2Key, taskId, kind: 'cutover_queued_review_step2' }, now);
    try {
      const current = await client.getTask(taskId);
      if (current.status === 'Doing') {
        await patchFieldWithReadback(client, taskId, 'status', 'Todo', (t) => t.status === 'Todo');
      }
      completeAction(db, step2Key, null, now);
    } catch (err) {
      failAction(db, step2Key, (err as Error).message, now);
      throw err;
    }
  }

  const step3Key = queuedReviewStepKey(taskId, 3);
  if (!getAction(db, step3Key)) {
    beginAction(db, { actionKey: step3Key, taskId, kind: 'cutover_queued_review_step3' }, now);
    try {
      const current = await client.getTask(taskId);
      if (current.status === 'Todo' && current.assigneeId !== null) {
        await patchFieldWithReadback(client, taskId, 'assignee', null, (t) => t.assigneeId === null);
      }
      completeAction(db, step3Key, null, now);
    } catch (err) {
      failAction(db, step3Key, (err as Error).message, now);
      throw err;
    }
  }

  const finalTask = await client.getTask(taskId);
  // 只有「目前真的還在 Todo／unassigned baseline」才把 checkpoint 寫成 queued——這個
  // 函式在 gate 打開之後仍然會被每次 apply 呼叫（見 applyCutoverReconciliation：
  // releaseQueuedReviewToBaseline 永遠先跑，dispatchToDoingIfNotAlready 才視 gate
  // 而定）。若這個 task 已經被 dispatchToDoingIfNotAlready 派工過（status 不再是
  // Todo，或已經有 assignee），這裡絕不能把它的 checkpoint 蓋回 queued，否則會
  // 抹掉派工結果、讓下一次呼叫的 dispatchToDoingIfNotAlready 誤判「還沒派工過」而
  // 重新嘗試（雖然 action key 仍會擋下重複 PATCH，但回傳的 `dispatched` 語意會失真，
  // 且違反「不得取得 lease」這條 queued 專屬保證——task 明明已經不 queued 了）。
  if (finalTask.status === 'Todo' && finalTask.assigneeId === null) {
    const runBeforeFinalCheckpoint = getTaskRun(db, taskId);
    upsertTaskCheckpoint(
      db,
      {
        taskId,
        workspaceId: finalTask.workspaceId,
        phase: 'queued',
        workerId: null,
        branch: null,
        baseSha: null,
        headSha: null,
        evidenceFingerprint: runBeforeFinalCheckpoint?.evidenceFingerprint ?? '',
        noProgressCount: 0,
        ownerIntervened: false,
        leaseUntil: null,
      },
      now,
    );
  }
  return finalTask;
}

/**
 * 依賴解除後（activeReview gate 打開）的一般派工：指派固定 email、單欄位 PATCH
 * Todo -> Doing、從包含 gate task accepted merge 的新版 master 建立乾淨 branch。
 * queuedReview／deferredAssignment 共用同一套邏輯（見檔頭：不透過 production.ts
 * 的 ResolvedDeps 版本，因為那個型別帶了一堆這裡用不到的欄位，這裡改寫一份更貼合
 * migrate.ts 需求的版本，但沿用完全相同的「assign -> PATCH Doing -> branch」順序
 * 與 action-key／readback 慣例）。
 */
async function dispatchToDoingIfNotAlready(
  db: DatabaseSync,
  client: CutoverBoardClient,
  repoRoot: string,
  taskId: string,
  assigneeEmail: string,
  keyPrefix: string,
  now: Date,
): Promise<{ dispatched: boolean; branch: string | null }> {
  const run = getTaskRun(db, taskId);
  if (run && run.phase !== 'queued') {
    // 已經被這個函式（或正常流程）派工過，不重複動作。
    return { dispatched: false, branch: run.branch };
  }

  // state.ts 的 beginAction／claimLease 對 phase === 'queued' 的 task 有硬性守衛
  // （queued task 不得建立任何 action、不得取得 lease）——這正是「queued 不占自動化
  // WIP、不建立 branch／worktree、不取得執行 lease」這條政策的實作依據。依賴解除、
  // 真正要開始派工的這一刻，必須先把 checkpoint 帶出 queued（改成 'assigned'），
  // 才能呼叫下面任何一個 beginAction；這個 upsert 本身冪等（reopen 後重跑，若這個
  // task 已經不是 queued，這裡就不會再被執行——見上面的提前 return）。
  const boardTaskBeforeDispatch = await client.getTask(taskId);
  upsertTaskCheckpoint(
    db,
    {
      taskId,
      workspaceId: boardTaskBeforeDispatch.workspaceId,
      phase: 'assigned',
      workerId: null,
      branch: null,
      baseSha: null,
      headSha: null,
      evidenceFingerprint: run?.evidenceFingerprint ?? '',
      noProgressCount: 0,
      ownerIntervened: false,
      leaseUntil: null,
    },
    now,
  );

  const members = await client.listMembers(CANONICAL_WORKSPACE_ID);
  const assigneeId = members.find((m) => m.email === assigneeEmail)?.userId ?? null;

  const assignKey = `${keyPrefix}:assign:${taskId}`;
  if (!getAction(db, assignKey)) {
    beginAction(db, { actionKey: assignKey, taskId, kind: `${keyPrefix}_assign` }, now);
    try {
      if (assigneeId) {
        const current = await client.getTask(taskId);
        if (current.assigneeId !== assigneeId) {
          await patchFieldWithReadback(client, taskId, 'assignee', assigneeId, (t) => t.assigneeId === assigneeId);
        }
      }
      completeAction(db, assignKey, null, now);
    } catch (err) {
      failAction(db, assignKey, (err as Error).message, now);
      throw err;
    }
  }

  const statusKey = `${keyPrefix}:status_doing:${taskId}`;
  if (!getAction(db, statusKey)) {
    beginAction(db, { actionKey: statusKey, taskId, kind: `${keyPrefix}_status` }, now);
    try {
      const current = await client.getTask(taskId);
      if (current.status === 'Todo') {
        await patchFieldWithReadback(client, taskId, 'status', 'Doing', (t) => t.status === 'Doing');
      }
      completeAction(db, statusKey, null, now);
    } catch (err) {
      failAction(db, statusKey, (err as Error).message, now);
      throw err;
    }
  }

  const masterSha = await getHeadSha(repoRoot, 'master');
  const worktree = await ensureTaskWorktree(repoRoot, taskId, masterSha);
  const branchKey = `${keyPrefix}:branch:${taskId}`;
  if (!getAction(db, branchKey)) {
    beginAction(db, { actionKey: branchKey, taskId, kind: `${keyPrefix}_branch` }, now);
    completeAction(db, branchKey, JSON.stringify({ branch: worktree.branch, headSha: worktree.headSha }), now);
  }

  const currentTask = await client.getTask(taskId);
  upsertTaskCheckpoint(
    db,
    {
      taskId,
      workspaceId: currentTask.workspaceId,
      phase: 'doing',
      workerId: null,
      branch: worktree.branch,
      baseSha: worktree.baseSha,
      headSha: worktree.headSha,
      evidenceFingerprint: '',
      noProgressCount: 0,
      ownerIntervened: false,
    },
    now,
  );

  return { dispatched: true, branch: worktree.branch };
}

/**
 * `--apply --live` 的核心 reconciliation。呼叫端（runApply）必須先驗證 generation／
 * fingerprint 相符才呼叫這裡；這個函式自己只驗證 00123ef0 前置條件（一定要在任何
 * mutation 之前重新 read back），不做 generation 比對。
 */
export async function applyCutoverReconciliation(input: ApplyCutoverInput): Promise<ApplyCutoverOutcome> {
  const now = (input.now ?? (() => new Date()))();
  const deps: PrerequisiteDeps = { ownerClient: input.ownerClient, user09Client: input.user09Client, repoRoot: input.repoRoot };

  // 在任何 task／comment／PATCH／checkpoint／branch／Git／AI mutation 之前，重新
  // read back 00123ef0 的完整證據鏈——這個檢查必須是這個函式做的第一件事。
  const evidence = await readPrerequisiteEvidence(deps);
  if (!validatePrerequisiteEvidence(evidence)) {
    return { kind: 'prerequisite_missing', detail: 'CutoverPrerequisiteMissing：00123ef0 完成證據鏈缺漏或不相符' };
  }

  const mainDiscussionClosed = await closeMainDiscussionIfDue(input.db, input.ownerClient, now);

  // 「再只啟動 938aa035」是一次性動作：只有這個 task 還真的停在 Review（也就是還沒被
  // 這個函式，或後續正常流程）啟動過時才呼叫 reactivateActiveReview。一旦它已經前進
  // （不論是被這裡 PATCH 到 Doing，還是被正常 coordinator 流程帶去 Review -> Done），
  // 這個 task 專屬 branch 的 base 就已經固定在「當時的 master」，之後 master 只會繼續
  // 前進——若每次 apply 都無條件重呼叫 ensureTaskWorktree(repoRoot, taskId,
  // <目前 master>)，會拿一個新的 masterSha 去驗證舊 worktree 的祖先關係，因為
  // worktree 早就分岔（自己往前 commit、又被 merge 進 master）而不再是目前 master 的
  // 祖先，反而錯誤地拋出「base 不是 head 的祖先」。
  const activeReviewBeforeReconcile = await input.ownerClient.getTask(CUTOVER_TASKS.activeReview.taskId);
  let activeReviewBranch: string | null;
  if (activeReviewBeforeReconcile.status === 'Review') {
    const activeReviewOutcome = await reactivateActiveReview(input.db, input.ownerClient, input.repoRoot, now);
    activeReviewBranch = activeReviewOutcome.branch;
  } else {
    activeReviewBranch = getTaskRun(input.db, CUTOVER_TASKS.activeReview.taskId)?.branch ?? null;
  }

  const queuedFinal = await releaseQueuedReviewToBaseline(input.db, input.ownerClient, now);

  const activeReviewTask = await input.ownerClient.getTask(CUTOVER_TASKS.activeReview.taskId);
  const gateOpen = await isActiveReviewGateOpen(input.db, input.repoRoot, activeReviewTask);

  let queuedReviewDispatched = false;
  let deferredAssignmentDispatched = false;
  if (gateOpen) {
    const queuedDispatch = await dispatchToDoingIfNotAlready(
      input.db,
      input.ownerClient,
      input.repoRoot,
      CUTOVER_TASKS.queuedReview.taskId,
      CUTOVER_TASKS.activeReview.assigneeEmail, // queuedReview 解除依賴後固定回到 user06
      'cutover:queued_review:dispatch',
      now,
    );
    queuedReviewDispatched = queuedDispatch.dispatched;

    const deferredDispatch = await dispatchToDoingIfNotAlready(
      input.db,
      input.ownerClient,
      input.repoRoot,
      CUTOVER_TASKS.deferredAssignment.taskId,
      CUTOVER_TASKS.deferredAssignment.assigneeEmail,
      'cutover:deferred_assignment:dispatch',
      now,
    );
    deferredAssignmentDispatched = deferredDispatch.dispatched;
  } else {
    // 明確維持 deferredAssignment 的 queued checkpoint（即使 selectCoordinatorActions
    // 的 dedicated handler 本來就不會在 gate 未開時動它，這裡仍然把 checkpoint 狀態
    // 寫成 queued，讓 manifest／--status 的稽核視圖誠實反映「目前還在等待」）。
    const deferredTask = await input.ownerClient.getTask(CUTOVER_TASKS.deferredAssignment.taskId);
    const existingDeferredRun = getTaskRun(input.db, deferredTask.taskId);
    if (!existingDeferredRun || existingDeferredRun.phase !== 'queued') {
      upsertTaskCheckpoint(
        input.db,
        {
          taskId: deferredTask.taskId,
          workspaceId: deferredTask.workspaceId,
          phase: 'queued',
          workerId: null,
          branch: null,
          baseSha: null,
          headSha: null,
          evidenceFingerprint: existingDeferredRun?.evidenceFingerprint ?? '',
          noProgressCount: 0,
          ownerIntervened: false,
          leaseUntil: null,
        },
        now,
      );
    }
  }

  return {
    kind: 'applied',
    summary: {
      mainDiscussionClosed,
      activeReviewBranch,
      queuedReviewFinalStatus: queuedFinal.status,
      queuedReviewDispatched,
      deferredAssignmentDispatched,
      aiCalls: 0,
    },
  };
}

// =============================================================================
// runApply：`--apply --live --expect-generation <n>` 的完整入口——先驗證
// generation／fingerprint，再委派給 applyCutoverReconciliation。
// =============================================================================

export interface RunApplyInput extends ApplyCutoverInput {
  expectGeneration: number;
  getLegacyTimerState?: GetLegacyTimerState;
}

export type RunApplyResult = { kind: 'generation_mismatch'; reason: string } | ApplyCutoverOutcome;

export async function runApply(input: RunApplyInput): Promise<RunApplyResult> {
  const generationCheck = await checkGenerationMatches({
    db: input.db,
    ownerClient: input.ownerClient,
    user09Client: input.user09Client,
    repoRoot: input.repoRoot,
    expectGeneration: input.expectGeneration,
    getLegacyTimerState: input.getLegacyTimerState,
    now: input.now,
  });
  if (!generationCheck.ok) {
    return { kind: 'generation_mismatch', reason: generationCheck.reason };
  }
  return applyCutoverReconciliation(input);
}

// =============================================================================
// CLI 進入點：預設唯讀 manifest；--preflight --live --expect-generation <n>；
// --apply --live --expect-generation <n>。
// =============================================================================

const ROOT = join(__dirname, '..', '..');
const DB_PATH = join(ROOT, 'sim-logs', 'production-coordinator.db');
const LOGS_ROOT = join(ROOT, 'sim-logs');
const BASE_URL = 'http://localhost:3000';

async function realIsServiceActive(unit: string): Promise<boolean> {
  return realIsUnitActive(unit);
}

function openDbEnsuringDir(dbPath: string): DatabaseSync {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  return openCoordinatorState(dbPath);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const preflight = args.includes('--preflight');
  const apply = args.includes('--apply');
  const generationFlagIndex = args.indexOf('--expect-generation');
  const expectGeneration = generationFlagIndex !== -1 ? Number(args[generationFlagIndex + 1]) : null;

  if ((preflight || apply) && !live) {
    console.error('--preflight／--apply 必須搭配 --live 使用');
    process.exitCode = 1;
    return;
  }
  if ((preflight || apply) && (expectGeneration === null || Number.isNaN(expectGeneration))) {
    console.error('--preflight／--apply 必須搭配 --expect-generation <n> 使用');
    process.exitCode = 1;
    return;
  }

  const db = openDbEnsuringDir(DB_PATH);
  try {
    if (!live) {
      // 唯讀 manifest 模式：連 discovery 前置條件都不檢查 login 以外的 mutation 能力
      // ——這裡仍然需要能登入才能讀 task／comment／notification，但整條路徑不含
      // 任何 mutation 呼叫。
      const discovery = await performDiscovery(BASE_URL, realIsServiceActive);
      if (!discovery.ok) {
        console.error(`DiscoveryUnavailable: ${discovery.reason}`);
        process.exitCode = 3;
        return;
      }
      const manifest = await buildManifest({ db, ownerClient: discovery.ownerClient, user09Client: discovery.user09Client, repoRoot: ROOT });
      const path = writeManifestFile(manifest, LOGS_ROOT);
      console.log(`manifest written: ${path}`);
      console.log(`cutoverGeneration=${manifest.cutoverGeneration} readyForApply=${manifest.readyForApply}`);
      process.exitCode = manifest.readyForApply ? 0 : 2;
      return;
    }

    const discovery = await performDiscovery(BASE_URL, realIsServiceActive);
    if (!discovery.ok) {
      console.error(`DiscoveryUnavailable: ${discovery.reason}`);
      process.exitCode = 3;
      return;
    }

    if (preflight) {
      const result = await checkGenerationMatches({
        db,
        ownerClient: discovery.ownerClient,
        user09Client: discovery.user09Client,
        repoRoot: ROOT,
        expectGeneration: expectGeneration!,
      });
      console.log(result.ok ? 'preflight OK' : `preflight FAILED: ${result.reason}`);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    if (apply) {
      const result = await runApply({
        db,
        ownerClient: discovery.ownerClient,
        user09Client: discovery.user09Client,
        repoRoot: ROOT,
        expectGeneration: expectGeneration!,
      });
      if (result.kind === 'generation_mismatch') {
        console.error(`apply 拒絕：${result.reason}`);
        process.exitCode = 1;
        return;
      }
      if (result.kind === 'prerequisite_missing') {
        console.error(`apply 拒絕：${result.detail}`);
        process.exitCode = 2;
        return;
      }
      console.log(`apply 完成：${JSON.stringify(result.summary)}`);
      process.exitCode = 0;
      return;
    }

    console.error('usage: npx tsx sim/production/migrate.ts [--preflight|--apply --live --expect-generation <n>]');
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
