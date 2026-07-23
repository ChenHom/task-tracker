// 正式環境 sim 協調器的純 scheduling policy。
//
// 這個檔案只能是 pure functions over plain data：CoordinatorSnapshot 進、
// CoordinatorAction[] 出。**不得** import node:http、node:sqlite 或任何 I/O module。
// node:crypto 是唯一例外——taskEvidenceFingerprint 只用它做同步、確定性的 hashing，
// 不牽涉任何檔案／網路 I/O。
import { createHash } from 'node:crypto';
import type { TaskRun, WorkPhase } from './types';

// ---------------------------------------------------------------------------
// 固定 workspace allowlist：正式環境只服務這兩個 workspace。
// ---------------------------------------------------------------------------
export const MAIN_WORKSPACE_ID = '11a82028-fc50-466a-a723-e002032cd9a6';
export const CANONICAL_WORKSPACE_ID = 'd9da9945-ce5f-400f-806e-1d75e95e313a';
export const ALLOWED_WORKSPACE_IDS: readonly string[] = [MAIN_WORKSPACE_ID, CANONICAL_WORKSPACE_ID];

// ---------------------------------------------------------------------------
// CUTOVER_TASKS：權威完整版本由任務 9 的 sim/production/migrate.ts 定義。
// 這裡只先放 policy.ts 需要的子集，值必須與該權威版本 byte-for-byte 相同
// （這些是真實、永久的看板 task ID，不是測試用假資料）。
// ---------------------------------------------------------------------------
export const CUTOVER_TASKS = {
  mainDiscussion: '10e65231-a4b2-4bdb-aab4-9f3c5fb0e916',
  mainPolicy: '27ec8d7e-8605-468c-9f2c-13a80bef2a5a',
  legacyCanonicalDiscussion: '8be538bc-ffc6-4122-9757-026a54ba813f',
  activeReview: {
    taskId: '938aa035-5f96-4908-b28b-876fa4735061',
    assigneeEmail: 'user06@test.local',
    classification: 'bug',
  },
  queuedReview: {
    taskId: '6384b6f4-f92f-45a2-a5e1-133f04f76372',
    assigneeEmail: null,
    afterTaskId: '938aa035-5f96-4908-b28b-876fa4735061',
  },
  completedPrerequisite: {
    taskId: '00123ef0-81cb-410e-aed1-d6d1fb925ed6',
    implementedByPlanTask: 1,
    implementerEmail: 'user03@test.local',
    taskBranch: 'sim/task/00123ef0-81cb-410e-aed1-d6d1fb925ed6',
    requiredStatus: 'Done',
  },
  deferredAssignment: {
    taskId: '027c0052-46d5-4da7-90fa-dd8efb2219fc',
    assigneeEmail: 'user05@test.local',
    classification: 'approved',
    afterTaskId: '938aa035-5f96-4908-b28b-876fa4735061',
  },
} as const;

// 雙重規則排除用的 canonical title（ID 為主、title 為輔的 defense-in-depth）。
export const MAIN_POLICY_TITLE = '[規則] 主工作區協作與交接';
export const LEGACY_CANONICAL_DISCUSSION_TITLE = '[討論] 方向與下一步';

// ---------------------------------------------------------------------------
// 共用型別
// ---------------------------------------------------------------------------
export type TaskStatus = 'Todo' | 'Doing' | 'Review' | 'Done' | 'Archived';

/** api.ts 讀回並整形後的看板 task（camelCase，供 policy 消費）。 */
export interface TaskSnapshot {
  taskId: string;
  workspaceId: string;
  title: string;
  status: TaskStatus;
  assigneeId: string | null;
  dueAt: string | null;
  updatedAt: string | null;
  version: number;
}

export interface CommentSnapshot {
  commentId: string;
  taskId: string;
  userId: string;
  content: string;
  createdAt: string;
}

export interface NotificationSnapshot {
  notificationId: string;
  recipientId: string;
  sourceTaskId: string;
  sourceCommentId: string;
  snippet: string;
  createdAt: string;
  readAt: string | null;
}

/**
 * 單一 task 的「可執行變化」證據：用來算 evidenceFingerprint，判斷從上次 checkpoint
 * 到現在，這個 task 是否發生任何值得重新評估的變化（留言、指派、期限、狀態）。
 */
export interface TaskEvidence {
  taskId: string;
  status: TaskStatus;
  assigneeId: string | null;
  dueAt: string | null;
  commentCount: number;
  lastCommentId: string | null;
  lastCommentAt: string | null;
}

export type WorkClass = 'bug' | 'maintenance' | 'approved' | 'new-feature';

/**
 * Owner 對一筆 task 的分類主張與可佐證的證據旗標。validateOwnerClassification
 * 只信證據旗標，不信 `claim` 本身——避免 Owner 隨口宣稱 bug／maintenance 就繞過
 * 新功能必須走 24 小時主討論的政策。
 */
export interface OwnerClassification {
  claim: WorkClass;
  restoresDocumentedBehavior: boolean;
  isUserInvisibleMaintenance: boolean;
  approvedDiscussionId: string | null;
  approvedByUser09: boolean;
}

/**
 * `00123ef0...`（completedPrerequisite）專用的完成證據鏈。每個欄位對應任務 1
 * 留下的其中一環；任一環缺漏或不相符，cutover 都必須整批拒絕（見
 * validatePrerequisiteEvidence）。Git ancestry／live rev 比對本身需要 I/O，
 * 由呼叫端（未來的 git.ts／migrate.ts）算好布林值再交給這裡消費，policy.ts
 * 本身不做任何 ancestry 查詢。
 */
export interface PrerequisiteEvidence {
  status: TaskStatus;
  task1AuthorizedAt: string;
  canonicalOwnerId: string;
  user03CanonicalId: string;
  /** user09 的 canonical user ID：完成通知的 recipient 必須恰好是這個人，不是任意使用者。 */
  user09CanonicalId: string;
  assignmentEvent: {
    eventId: string;
    actorId: string;
    payloadAssigneeId: string;
    createdAt: string;
  } | null;
  acceptedHead: {
    sha: string;
    branch: string;
    hasTaskIdTrailer: boolean;
  } | null;
  ownerAcceptance: {
    acceptanceId: string;
    referencedHeadSha: string;
  } | null;
  acceptedMerge: {
    sha: string;
    headIsAncestor: boolean;
  } | null;
  liveRev: string | null;
  liveRevIsMergeOrDescendant: boolean;
  completionComment: {
    commentId: string;
    referencesTask1AuthorizedAt: boolean;
    referencesAssignmentEventId: string | null;
    referencesAcceptanceId: string | null;
    referencesHeadSha: string | null;
    referencesMergeSha: string | null;
    referencesLiveRev: string | null;
  } | null;
  notification: {
    notificationId: string;
    recipientId: string;
    sourceCommentId: string;
  } | null;
}

/** 協調器單次 tick 決策要吃的完整輸入快照——全部是 plain data，沒有任何 I/O handle。 */
export interface CoordinatorSnapshot {
  tasks: TaskSnapshot[];
  taskRuns: Record<string, TaskRun | undefined>;
  taskEvidence: Record<string, TaskEvidence | undefined>;
  prerequisiteEvidence: PrerequisiteEvidence | null;
  /** email -> canonical user ID，由呼叫端（有 I/O 能力那層）先解析好。 */
  userIdsByEmail: Record<string, string>;
}

export type CoordinatorActionKind =
  | 'owner_review'
  | 'owner_dispatch'
  | 'member_work'
  | 'assign_member'
  | 'main_discussion_owner'
  | 'cutover_prerequisite_missing';

export interface CoordinatorAction {
  kind: CoordinatorActionKind;
  taskId: string;
  workspaceId: string;
  reason: string;
  assigneeId?: string | null;
  errorCode?: 'CutoverPrerequisiteMissing';
}

// ---------------------------------------------------------------------------
// 排除規則：ID + canonical title 雙重規則
// ---------------------------------------------------------------------------

/**
 * 排除 `CUTOVER_TASKS.mainPolicy` 與 `CUTOVER_TASKS.legacyCanonicalDiscussion`。
 * 以 ID 為主要判斷依據，title 只是 defense-in-depth 的第二道檢查：其他 workspace
 * 剛好也叫「[討論] 方向與下一步」的 task 不會被誤排除（ID 不符就不算）。
 */
export function isExcludedTask(task: TaskSnapshot): boolean {
  if (task.taskId === CUTOVER_TASKS.mainPolicy && task.title === MAIN_POLICY_TITLE) return true;
  if (task.taskId === CUTOVER_TASKS.legacyCanonicalDiscussion && task.title === LEGACY_CANONICAL_DISCUSSION_TITLE) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// validateOwnerClassification
// ---------------------------------------------------------------------------

/**
 * 重新推導 task 的 WorkClass，不信任 Owner 自稱的 `claim`。若無法明確證明
 * 是在恢復既有文件行為、進行不影響使用者的維護，或引用已核准 discussion／
 * user09 決策，一律預設 `new-feature`（必須走 24 小時主討論）。
 */
export function validateOwnerClassification(input: OwnerClassification): WorkClass {
  if (input.restoresDocumentedBehavior) return 'bug';
  if (input.isUserInvisibleMaintenance) return 'maintenance';
  if (input.approvedDiscussionId || input.approvedByUser09) return 'approved';
  return 'new-feature';
}

// ---------------------------------------------------------------------------
// taskEvidenceFingerprint
// ---------------------------------------------------------------------------

/**
 * 把 TaskEvidence 的欄位以固定順序序列化後 sha256——刻意用陣列（而非物件）序列化，
 * 讓結果與呼叫端建構物件時的 key 插入順序無關，維持跨呼叫的確定性。
 */
export function taskEvidenceFingerprint(input: TaskEvidence): string {
  const canonical = JSON.stringify([
    input.taskId,
    input.status,
    input.assigneeId,
    input.dueAt,
    input.commentCount,
    input.lastCommentId,
    input.lastCommentAt,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// recordMemberAttempt / shouldResumeHumanBlocked
// ---------------------------------------------------------------------------

const OWNER_INTERVENTION_THRESHOLD = 2;

/**
 * 依單次嘗試的結果更新 TaskRun 的 noProgressCount／ownerIntervened／phase。
 *
 * 契約（呼叫端必須遵守）：provider／network failure（登入失敗、逾時、連線中斷等
 * 與「這次嘗試有沒有做出可驗證進展」無關的失敗）永遠不算一次無進展嘗試——
 * 呼叫端必須以 `evidenceChanged: true` 呼叫（等同於「這次不計分」），不得傳
 * `false`，否則會誤增 noProgressCount、提早觸發 Owner 介入或 human_blocked。
 *
 * 連續兩次真正「完整嘗試但沒有可驗證進展」會先標記 ownerIntervened；已介入後
 * 再有一次無進展嘗試，直接轉為 human_blocked。
 */
export function recordMemberAttempt(run: TaskRun, evidenceChanged: boolean): TaskRun {
  if (evidenceChanged) {
    return { ...run, noProgressCount: 0, ownerIntervened: false };
  }
  const noProgressCount = run.noProgressCount + 1;
  if (run.ownerIntervened) {
    const phase: WorkPhase = 'human_blocked';
    return { ...run, noProgressCount, phase };
  }
  if (noProgressCount >= OWNER_INTERVENTION_THRESHOLD) {
    return { ...run, noProgressCount, ownerIntervened: true };
  }
  return { ...run, noProgressCount };
}

/**
 * human_blocked 的 task 是否應該恢復嘗試：只有在目前的證據 fingerprint 與
 * 卡關當下記錄的 evidenceFingerprint 不同時（代表期限事件、新留言，或
 * user09／人工決策造成可執行變化）才恢復。
 */
export function shouldResumeHumanBlocked(run: TaskRun, snapshot: TaskEvidence): boolean {
  if (run.phase !== 'human_blocked') return false;
  return taskEvidenceFingerprint(snapshot) !== run.evidenceFingerprint;
}

// ---------------------------------------------------------------------------
// completedPrerequisite 的完成證據鏈驗證
// ---------------------------------------------------------------------------

/**
 * 驗證 `00123ef0...` 的完成證據鏈是否完整、且全部指向同一組授權／assignment
 * event／acceptance／head／merge／live rev。任一環節缺漏或不相符都回傳 false，
 * 呼叫端（selectCoordinatorActions）必須把整批結果視為 `CutoverPrerequisiteMissing`。
 */
export function validatePrerequisiteEvidence(evidence: PrerequisiteEvidence | null): boolean {
  if (!evidence) return false;
  if (evidence.status !== CUTOVER_TASKS.completedPrerequisite.requiredStatus) return false;

  const { assignmentEvent, acceptedHead, ownerAcceptance, acceptedMerge, completionComment, notification } = evidence;
  if (!assignmentEvent || !acceptedHead || !ownerAcceptance || !acceptedMerge || !completionComment || !notification) {
    return false;
  }

  // assignment event 必須在本次 Task 1 授權後由 canonical Owner 產生，payload 是 user03 canonical ID。
  if (!(assignmentEvent.createdAt > evidence.task1AuthorizedAt)) return false;
  if (assignmentEvent.actorId !== evidence.canonicalOwnerId) return false;
  if (assignmentEvent.payloadAssigneeId !== evidence.user03CanonicalId) return false;

  // accepted head 必須在固定 task branch 上且含 Task-Id trailer。
  if (acceptedHead.branch !== CUTOVER_TASKS.completedPrerequisite.taskBranch) return false;
  if (!acceptedHead.hasTaskIdTrailer) return false;

  // Owner acceptance 必須引用該 exact head。
  if (ownerAcceptance.referencedHeadSha !== acceptedHead.sha) return false;

  // accepted merge 必須保留該 head 為 ancestor；live rev 必須等於該 merge 或其後代。
  if (!acceptedMerge.headIsAncestor) return false;
  if (!evidence.liveRev) return false;
  if (!evidence.liveRevIsMergeOrDescendant) return false;

  // 完成留言必須引用同一組授權／assignment event／acceptance／head／merge／live rev。
  if (!completionComment.referencesTask1AuthorizedAt) return false;
  if (completionComment.referencesAssignmentEventId !== assignmentEvent.eventId) return false;
  if (completionComment.referencesAcceptanceId !== ownerAcceptance.acceptanceId) return false;
  if (completionComment.referencesHeadSha !== acceptedHead.sha) return false;
  if (completionComment.referencesMergeSha !== acceptedMerge.sha) return false;
  if (completionComment.referencesLiveRev !== evidence.liveRev) return false;

  // notification 必須指向該留言，且 recipient 必須恰好是 user09（不是任意使用者）。
  if (notification.sourceCommentId !== completionComment.commentId) return false;
  if (notification.recipientId !== evidence.user09CanonicalId) return false;

  return true;
}

// ---------------------------------------------------------------------------
// 主討論（10e65231）：只有 fingerprint 變化或已到期才建立 Owner action
// ---------------------------------------------------------------------------

function buildMainDiscussionAction(
  task: TaskSnapshot,
  snapshot: CoordinatorSnapshot,
  now: Date,
): CoordinatorAction | null {
  if (task.status !== 'Todo') return null; // 非 Todo（已結案／Doing）不是這裡的責任範圍

  const evidence = snapshot.taskEvidence[task.taskId];
  const run = snapshot.taskRuns[task.taskId];
  const previousFingerprint = run?.evidenceFingerprint ?? '';
  const currentFingerprint = evidence ? taskEvidenceFingerprint(evidence) : '';
  const fingerprintChanged = currentFingerprint !== previousFingerprint;
  const isPastDue = Boolean(task.dueAt) && new Date(task.dueAt as string).getTime() <= now.getTime();

  if (!fingerprintChanged && !isPastDue) return null;

  return {
    kind: 'main_discussion_owner',
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    reason: fingerprintChanged
      ? '主討論證據自上次 checkpoint 後已變化（期限事件或新留言）'
      : '主討論已超過固定 24 小時期限',
  };
}

// ---------------------------------------------------------------------------
// Generic（非固定 cutover disposition）task 的排序 tier
// ---------------------------------------------------------------------------
// 0 = Review（驗收優先於新派工）；1 = 已指派 Doing（優先於 Todo）；2 = Todo（新派工）。
function genericTier(task: TaskSnapshot): 0 | 1 | 2 | null {
  if (task.status === 'Review') return 0;
  if (task.status === 'Doing' && task.assigneeId) return 1;
  if (task.status === 'Todo') return 2;
  return null;
}

/** `queued` checkpoint：coordinator metadata 層級的暫停，只在 generic 排程階段生效。 */
function isQueued(taskId: string, snapshot: CoordinatorSnapshot): boolean {
  return snapshot.taskRuns[taskId]?.phase === 'queued';
}

/**
 * 尚未可恢復的 human_blocked。這個檢查也適用於固定 cutover disposition 的
 * 專屬 handler（activeReview／deferredAssignment／主討論）——但 `queued` 不適用：
 * `queued` 描述的是「這個 task 目前還沒輪到」，而固定 disposition handler
 * 本身就是負責判斷「現在是不是輪到了」的邏輯，不能被同一個 flag 反過來擋住。
 */
function isUnresumableHumanBlocked(taskId: string, snapshot: CoordinatorSnapshot): boolean {
  const run = snapshot.taskRuns[taskId];
  if (!run || run.phase !== 'human_blocked') return false;
  const evidence = snapshot.taskEvidence[taskId];
  if (!evidence) return true; // 沒有證據可比對，保守地維持卡關
  return !shouldResumeHumanBlocked(run, evidence);
}

/** Generic 排程階段用的完整封鎖判斷：queued 或尚未可恢復的 human_blocked 都排除。 */
function isBlockedTask(taskId: string, snapshot: CoordinatorSnapshot): boolean {
  return isQueued(taskId, snapshot) || isUnresumableHumanBlocked(taskId, snapshot);
}

// ---------------------------------------------------------------------------
// selectCoordinatorActions
// ---------------------------------------------------------------------------

export function selectCoordinatorActions(snapshot: CoordinatorSnapshot, now: Date): CoordinatorAction[] {
  const tasksById = new Map(snapshot.tasks.map((t) => [t.taskId, t] as const));
  const reservedAssignees = new Set<string>();
  const actions: CoordinatorAction[] = [];

  // 1) Fixed cutover disposition：activeReview（938aa035）是 user06 唯一可執行 action，
  //    優先於一般排序，且不受同狀態 task 的 updated_at 影響。
  const activeReviewTask = tasksById.get(CUTOVER_TASKS.activeReview.taskId);
  if (activeReviewTask && !isExcludedTask(activeReviewTask) && !isUnresumableHumanBlocked(activeReviewTask.taskId, snapshot)) {
    if (activeReviewTask.status === 'Review') {
      const assigneeId = activeReviewTask.assigneeId ?? snapshot.userIdsByEmail[CUTOVER_TASKS.activeReview.assigneeEmail] ?? null;
      actions.push({
        kind: 'owner_review',
        taskId: activeReviewTask.taskId,
        workspaceId: activeReviewTask.workspaceId,
        assigneeId,
        reason: 'fixed cutover disposition：activeReview 等待 Owner 驗收',
      });
      if (assigneeId) reservedAssignees.add(assigneeId);
    } else if (activeReviewTask.status === 'Doing') {
      const assigneeId = activeReviewTask.assigneeId ?? snapshot.userIdsByEmail[CUTOVER_TASKS.activeReview.assigneeEmail] ?? null;
      actions.push({
        kind: 'member_work',
        taskId: activeReviewTask.taskId,
        workspaceId: activeReviewTask.workspaceId,
        assigneeId,
        reason: 'fixed cutover disposition：activeReview 是 user06 唯一授權 WIP',
      });
      if (assigneeId) reservedAssignees.add(assigneeId);
    }
  }

  // 2) completedPrerequisite（00123ef0）：只驗證證據鏈，永遠不產生指派／branch／AI action。
  const prerequisiteTask = tasksById.get(CUTOVER_TASKS.completedPrerequisite.taskId);
  if (prerequisiteTask) {
    const satisfied = validatePrerequisiteEvidence(snapshot.prerequisiteEvidence);
    if (!satisfied) {
      actions.push({
        kind: 'cutover_prerequisite_missing',
        taskId: prerequisiteTask.taskId,
        workspaceId: prerequisiteTask.workspaceId,
        reason: 'completedPrerequisite 完成證據鏈缺漏或不相符',
        errorCode: 'CutoverPrerequisiteMissing',
      });
    }
    // 不論 satisfied 與否，00123ef0 都不落入 generic 排程——cutover 不得再次指派或執行。
  }

  // 3) deferredAssignment（027c0052）：只有在 activeReview 的 readback 狀態是 Done
  //    之後，才產生指派 user05 的 action；在此之前保持 queued／unassigned、零 action。
  const deferredTask = tasksById.get(CUTOVER_TASKS.deferredAssignment.taskId);
  if (deferredTask && !isUnresumableHumanBlocked(deferredTask.taskId, snapshot)) {
    const gateTask = tasksById.get(CUTOVER_TASKS.deferredAssignment.afterTaskId);
    const gateDone = gateTask?.status === 'Done';
    if (gateDone && !deferredTask.assigneeId) {
      const assigneeId = snapshot.userIdsByEmail[CUTOVER_TASKS.deferredAssignment.assigneeEmail] ?? null;
      actions.push({
        kind: 'assign_member',
        taskId: deferredTask.taskId,
        workspaceId: deferredTask.workspaceId,
        assigneeId,
        reason: 'fixed cutover disposition：activeReview 已 Done，deferredAssignment 解除 queued',
      });
      if (assigneeId) reservedAssignees.add(assigneeId);
    }
  }

  // 4) 主討論（10e65231）：mainDiscussionNeedsOwner(status) 不再是 production policy；
  //    只有 fingerprint 變化或已到期才建立 Owner action。
  const mainDiscussionTask = tasksById.get(CUTOVER_TASKS.mainDiscussion);
  if (mainDiscussionTask && !isUnresumableHumanBlocked(mainDiscussionTask.taskId, snapshot)) {
    const action = buildMainDiscussionAction(mainDiscussionTask, snapshot, now);
    if (action) actions.push(action);
  }

  // 5) 其餘所有 in-scope task 走 generic 排序：Review > 已指派 Doing > Todo，
  //    同一 assignee 在本次 tick 只會取得一個非 blocked WIP action（WIP1）。
  const handledIds = new Set<string>([
    CUTOVER_TASKS.activeReview.taskId,
    CUTOVER_TASKS.completedPrerequisite.taskId,
    CUTOVER_TASKS.deferredAssignment.taskId,
    CUTOVER_TASKS.mainDiscussion,
  ]);

  const genericCandidates = snapshot.tasks.filter(
    (task) =>
      ALLOWED_WORKSPACE_IDS.includes(task.workspaceId) &&
      !isExcludedTask(task) &&
      !handledIds.has(task.taskId) &&
      !isBlockedTask(task.taskId, snapshot) &&
      genericTier(task) !== null,
  );

  genericCandidates.sort((a, b) => {
    const tierA = genericTier(a) as number;
    const tierB = genericTier(b) as number;
    if (tierA !== tierB) return tierA - tierB;
    const updatedA = a.updatedAt ?? '';
    const updatedB = b.updatedAt ?? '';
    if (updatedA !== updatedB) return updatedA < updatedB ? -1 : 1;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });

  for (const task of genericCandidates) {
    if (task.assigneeId) {
      if (reservedAssignees.has(task.assigneeId)) continue; // WIP1：這個 member 這次 tick 已經有動作了
      reservedAssignees.add(task.assigneeId);
    }
    const tier = genericTier(task);
    if (tier === 0) {
      actions.push({
        kind: 'owner_review',
        taskId: task.taskId,
        workspaceId: task.workspaceId,
        assigneeId: task.assigneeId,
        reason: 'task 在 Review，等待 Owner 驗收',
      });
    } else if (tier === 1) {
      actions.push({
        kind: 'member_work',
        taskId: task.taskId,
        workspaceId: task.workspaceId,
        assigneeId: task.assigneeId,
        reason: '已指派的 Doing task 繼續 member 工作',
      });
    } else {
      actions.push({
        kind: 'owner_dispatch',
        taskId: task.taskId,
        workspaceId: task.workspaceId,
        assigneeId: task.assigneeId ?? null,
        reason: '未指派的 Todo 等待 Owner 分類與派工',
      });
    }
  }

  return actions;
}
