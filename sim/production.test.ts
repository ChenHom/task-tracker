import assert from 'node:assert';
import { mkdtempSync, existsSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  LEASE_TTL_MS,
  openCoordinatorState,
  getTaskRun,
  upsertTaskCheckpoint,
  claimLease,
  releaseLease,
  getAction,
  beginAction,
  completeAction,
  failAction,
  storeCiRun,
  lookupCiRun,
  getCompletion,
  enqueueCompletion,
  recordCompletionAttempt,
  beginTick,
  endTick,
  getTick,
} from './production/state';
import type { TaskRun, ActionOutcome } from './production/types';
import { TaskTrackerClient, UncertainMutationError } from './production/api';
import {
  MAIN_WORKSPACE_ID,
  CANONICAL_WORKSPACE_ID,
  CUTOVER_TASKS,
  MAIN_POLICY_TITLE,
  LEGACY_CANONICAL_DISCUSSION_TITLE,
  isExcludedTask,
  validatePrerequisiteEvidence,
  validateOwnerClassification,
  taskEvidenceFingerprint,
  selectCoordinatorActions,
  recordMemberAttempt,
  shouldResumeHumanBlocked,
  type TaskSnapshot,
  type TaskStatus,
  type TaskEvidence,
  type CoordinatorSnapshot,
  type PrerequisiteEvidence,
  type OwnerClassification,
  type WorkClass,
} from './production/policy';
import {
  taskBranchName,
  taskWorktreePath,
  ensureTaskWorktree,
  collectTaskChanges,
  validateTaskChanges,
  commitTaskChanges,
  ciCacheKey,
  isAllowedVerificationCommand,
  ALLOWED_VERIFICATION_COMMANDS,
  DEPLOY_WAIT_TIMEOUT_MS,
  waitForDeployment,
  assertSystemdReadyForDeploy,
  createIntegrationWorktree,
  removeIntegrationWorktree,
  mergeTaskIntoMaster,
  revertMasterMerge,
  type ChangedPath,
  type SystemdReadback,
  type GetSystemdReadback,
  type HealthCheckResult,
  type CheckHealth,
  type DeployWaitBaseline,
} from './production/git';
import {
  runMemberSession,
  runOwnerSession,
  type MemberSessionOutput,
  type MemberSessionResult,
  type MemberSessionRunner,
  type MemberSessionDriverActions,
  type OwnerDecision,
  type OwnerSessionRunner,
} from './production/agent';
import {
  recordMemberSessionAttempt,
  shouldResumeFromHumanBlocked,
  humanBlockedActionKey,
  runDeployAcceptance,
  performMasterRevert,
  resolveRollbackWait,
  assertNoFatalCoordinatorError,
  deploymentRollbackActionKey,
  type AcceptanceCheckResult,
  type AcceptanceCheck,
  type IntegrationCommandRunner,
  type FatalCoordinatorError,
} from './production/coordinator';

// ---------------------------------------------------------------------------
// LEASE_TTL_MS 必須嚴格大於 DEPLOY_WAIT_TIMEOUT_MS
// ---------------------------------------------------------------------------
// DEPLOY_WAIT_TIMEOUT_MS 的權威定義現在就在 sim/production/git.ts（任務 6）；
// 這裡直接 import 那個真正的常數做比較，不再自己維護一份同值的 local literal——
// 兩者只可能有一份會漂移，而 import 保證漂移不可能發生。
assert.strictEqual(DEPLOY_WAIT_TIMEOUT_MS, 35 * 60 * 1000, 'DEPLOY_WAIT_TIMEOUT_MS 必須固定為 35 分鐘');
assert.strictEqual(LEASE_TTL_MS, 45 * 60 * 1000, 'LEASE_TTL_MS 必須固定為 45 分鐘');
assert.ok(
  LEASE_TTL_MS > DEPLOY_WAIT_TIMEOUT_MS,
  'LEASE_TTL_MS 必須嚴格大於 DEPLOY_WAIT_TIMEOUT_MS，否則等待部署的 tick 可能讓 lease 先過期',
);

// ---------------------------------------------------------------------------
// task lease：只能被 claim 一次；過期後可重新 claim
// （不需要驗證 reopen persistence，用 :memory: 即可）
// ---------------------------------------------------------------------------
{
  const db = openCoordinatorState(':memory:');
  const t0 = new Date('2026-07-22T00:00:00.000Z');

  upsertTaskCheckpoint(
    db,
    {
      taskId: 'task-lease',
      workspaceId: 'ws-1',
      phase: 'assigned',
      evidenceFingerprint: 'fp-0',
    },
    t0,
  );

  const claimed = claimLease(db, { taskId: 'task-lease', workerId: 'worker-a', now: t0, leaseMs: 1000 });
  assert.ok(claimed, '第一次 claim 應成功');
  assert.strictEqual(claimed!.workerId, 'worker-a');
  assert.strictEqual(claimed!.leaseUntil, new Date(t0.getTime() + 1000).toISOString());

  // 未過期前，任何 worker（含原 worker）再 claim 都必須失敗——只能被 claim 一次。
  const reclaimSameWorker = claimLease(db, {
    taskId: 'task-lease',
    workerId: 'worker-a',
    now: new Date(t0.getTime() + 500),
    leaseMs: 1000,
  });
  assert.strictEqual(reclaimSameWorker, null, '未過期的 lease 不可被再次 claim（即使同一 worker）');
  const reclaimOtherWorker = claimLease(db, {
    taskId: 'task-lease',
    workerId: 'worker-b',
    now: new Date(t0.getTime() + 500),
    leaseMs: 1000,
  });
  assert.strictEqual(reclaimOtherWorker, null, '未過期的 lease 不可被其他 worker 搶走');

  // 過期後可被重新 claim（換一個 worker）。
  const afterExpiry = new Date(t0.getTime() + 1001);
  const reclaimed = claimLease(db, { taskId: 'task-lease', workerId: 'worker-c', now: afterExpiry, leaseMs: 1000 });
  assert.ok(reclaimed, '過期 lease 必須可重新 claim');
  assert.strictEqual(reclaimed!.workerId, 'worker-c');

  // 釋放 lease 之後，其他 worker 立刻可以 claim，即使尚未到期。
  releaseLease(db, 'task-lease', 'worker-c', afterExpiry);
  const afterRelease = getTaskRun(db, 'task-lease');
  assert.strictEqual(afterRelease!.leaseUntil, null, 'release 之後 leaseUntil 應清空');
  const claimAfterRelease = claimLease(db, {
    taskId: 'task-lease',
    workerId: 'worker-d',
    now: afterExpiry,
    leaseMs: 1000,
  });
  assert.ok(claimAfterRelease, 'release 之後應可立即被其他 worker claim');

  // release 若不是目前持有者，必須拒絕。
  assert.throws(() => releaseLease(db, 'task-lease', 'worker-not-holder', afterExpiry), /not held by/);

  // claim 是單一 atomic UPDATE，不是 check-then-act：直接用原始 SQL 模擬「另一個 process
  // 恰好在這一刻已經寫下未過期 lease」，證明 claimLease 的 WHERE guard 會擋下這次 claim，
  // 且失敗的 claim 完全不動任何欄位（不會覆寫並發寫入者的 worker_id/lease_until）。
  db.prepare('UPDATE task_runs SET worker_id = ?, lease_until = ? WHERE task_id = ?').run(
    'concurrent-worker',
    new Date(afterExpiry.getTime() + 10000).toISOString(),
    'task-lease',
  );
  const racedClaim = claimLease(db, {
    taskId: 'task-lease',
    workerId: 'worker-e',
    now: afterExpiry,
    leaseMs: 1000,
  });
  assert.strictEqual(racedClaim, null, 'atomic UPDATE 的 WHERE guard 必須擋下未過期 lease 的 claim');
  const afterRacedClaim = getTaskRun(db, 'task-lease');
  assert.strictEqual(
    afterRacedClaim!.workerId,
    'concurrent-worker',
    '失敗的 claim 不得覆寫並發寫入者已持有的 worker_id',
  );
  assert.strictEqual(
    afterRacedClaim!.leaseUntil,
    new Date(afterExpiry.getTime() + 10000).toISOString(),
    '失敗的 claim 不得覆寫並發寫入者已持有的 lease_until',
  );

  db.close();
}

// ---------------------------------------------------------------------------
// action_log：重複 action key 必須被拒絕（:memory:，不需要 reopen）
// ---------------------------------------------------------------------------
{
  const db = openCoordinatorState(':memory:');
  const t0 = new Date('2026-07-22T00:00:00.000Z');

  upsertTaskCheckpoint(
    db,
    { taskId: 'task-action', workspaceId: 'ws-1', phase: 'doing', evidenceFingerprint: 'fp-0' },
    t0,
  );

  beginAction(db, { actionKey: 'patch-status:task-action:v3', taskId: 'task-action', kind: 'patch_status' }, t0);
  assert.throws(
    () => beginAction(db, { actionKey: 'patch-status:task-action:v3', taskId: 'task-action', kind: 'patch_status' }, t0),
    /UNIQUE/,
    '重複 action key 必須被拒絕',
  );

  const completed = completeAction(db, 'patch-status:task-action:v3', JSON.stringify({ status: 'Review' }), t0);
  assert.strictEqual(completed.status, 'completed');
  assert.strictEqual(completed.resultJson, JSON.stringify({ status: 'Review' }));

  // 針對不存在的 action_key 收尾必須拋錯，而不是靜默成功。
  assert.throws(() => completeAction(db, 'no-such-key', null, t0), /unknown action_key/);

  beginAction(db, { actionKey: 'patch-status:task-action:v4', taskId: 'task-action', kind: 'patch_status' }, t0);
  const failed = failAction(db, 'patch-status:task-action:v4', 'socket hang up', t0);
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.error, 'socket hang up');
  assert.throws(() => failAction(db, 'no-such-key', 'boom', t0), /unknown action_key/);

  db.close();
}

// 以下幾組測試需要驗證「重新開啟 DB 後資料仍在」，因此改用真實暫存檔而非 :memory:
// （:memory: 一旦 close 就不可能重開後還讀得到資料）。
const dir = mkdtempSync(join(tmpdir(), 'sim-production-state-'));

// ---------------------------------------------------------------------------
// checkpoint 必須在重新開啟資料庫後仍存在
// ---------------------------------------------------------------------------
{
  const dbPath = join(dir, 'checkpoint.db');
  const t0 = new Date('2026-07-22T00:00:00.000Z');

  const db = openCoordinatorState(dbPath);
  upsertTaskCheckpoint(
    db,
    {
      taskId: 'task-checkpoint',
      workspaceId: 'ws-1',
      phase: 'review',
      workerId: 'worker-a',
      branch: 'sim/task/task-checkpoint',
      baseSha: 'base123',
      headSha: 'head456',
      evidenceFingerprint: 'fp-1',
      noProgressCount: 1,
      ownerIntervened: true,
      leaseUntil: new Date(t0.getTime() + 60000).toISOString(),
    },
    t0,
  );
  db.close();

  const reopened = openCoordinatorState(dbPath);
  const row = getTaskRun(reopened, 'task-checkpoint');
  assert.deepStrictEqual(row, {
    taskId: 'task-checkpoint',
    workspaceId: 'ws-1',
    phase: 'review',
    workerId: 'worker-a',
    branch: 'sim/task/task-checkpoint',
    baseSha: 'base123',
    headSha: 'head456',
    evidenceFingerprint: 'fp-1',
    noProgressCount: 1,
    ownerIntervened: true,
    leaseUntil: new Date(t0.getTime() + 60000).toISOString(),
    updatedAt: t0.toISOString(),
  });
  reopened.close();
}

// ---------------------------------------------------------------------------
// ci_runs：以 base_sha + head_sha + commands_hash 為 key（:memory:，不需要 reopen）
// ---------------------------------------------------------------------------
{
  const db = openCoordinatorState(':memory:');
  const t0 = new Date('2026-07-22T00:00:00.000Z');

  const hash = (commands: string[]) => createHash('sha256').update(commands.join('|')).digest('hex');
  const commandsA = hash(['npx tsc --noEmit', 'npx tsx sim/production.test.ts']);
  const commandsB = hash(['npm test']);

  assert.strictEqual(lookupCiRun(db, 'base1', 'head1', commandsA), null, '尚未 store 前應查無結果');

  storeCiRun(db, { baseSha: 'base1', headSha: 'head1', commandsHash: commandsA, output: 'PASS' }, t0);
  const hit = lookupCiRun(db, 'base1', 'head1', commandsA);
  assert.ok(hit, '相同 base/head/commandsHash 必須命中 cache');
  assert.strictEqual(hit!.output, 'PASS');

  // 任一維度不同都必須是不同的 cache key。
  assert.strictEqual(lookupCiRun(db, 'base1', 'head1', commandsB), null, '不同 commandsHash 不得命中');
  assert.strictEqual(lookupCiRun(db, 'base1', 'head2', commandsA), null, '不同 headSha 不得命中');
  assert.strictEqual(lookupCiRun(db, 'base2', 'head1', commandsA), null, '不同 baseSha 不得命中');

  db.close();
}

// ---------------------------------------------------------------------------
// completion attempt 最多三次（:memory:，不需要 reopen）
// ---------------------------------------------------------------------------
{
  const db = openCoordinatorState(':memory:');
  const t0 = new Date('2026-07-22T00:00:00.000Z');

  const completionId = 'task-completion:head789';
  enqueueCompletion(db, { completionId, taskId: 'task-completion', batchId: 'batch-1' }, t0);
  // 重複 enqueue 必須是冪等的，不重置 attempt_count。
  enqueueCompletion(db, { completionId, taskId: 'task-completion', batchId: 'batch-1' }, t0);
  assert.strictEqual(getCompletion(db, completionId)!.attemptCount, 0);

  const attempt1 = recordCompletionAttempt(db, completionId, 'failed', t0);
  assert.strictEqual(attempt1.attemptCount, 1);
  assert.strictEqual(attempt1.status, 'pending');

  const attempt2 = recordCompletionAttempt(db, completionId, 'failed', t0);
  assert.strictEqual(attempt2.attemptCount, 2);
  assert.strictEqual(attempt2.status, 'pending');

  const attempt3 = recordCompletionAttempt(db, completionId, 'failed', t0);
  assert.strictEqual(attempt3.attemptCount, 3);
  assert.strictEqual(attempt3.status, 'notify_failed', '第三次仍失敗必須轉為 notify_failed');

  // 已解決（notify_failed）之後，不得再有第四次嘗試。
  assert.throws(
    () => recordCompletionAttempt(db, completionId, 'failed', t0),
    /already resolved/,
    'completion attempt 上限為 3 次，之後必須拒絕',
  );

  // 另一筆 completion 若第一次就送達成功，狀態直接是 sent，不佔用 attempt 上限邏輯。
  const okCompletionId = 'task-completion-2:headabc';
  enqueueCompletion(db, { completionId: okCompletionId, taskId: 'task-completion-2' }, t0);
  const sent = recordCompletionAttempt(db, okCompletionId, 'sent', t0);
  assert.strictEqual(sent.attemptCount, 1);
  assert.strictEqual(sent.status, 'sent');
  assert.throws(() => recordCompletionAttempt(db, okCompletionId, 'sent', t0), /already resolved/);

  db.close();
}

// ---------------------------------------------------------------------------
// queued task：workerId=null、branch=null 可持久化；reopen 後仍不得取得 lease 或建立 action
// ---------------------------------------------------------------------------
{
  const dbPath = join(dir, 'queued.db');
  const t0 = new Date('2026-07-22T00:00:00.000Z');

  const db = openCoordinatorState(dbPath);
  upsertTaskCheckpoint(
    db,
    {
      taskId: 'task-queued',
      workspaceId: 'ws-1',
      phase: 'queued',
      workerId: null,
      branch: null,
      evidenceFingerprint: 'fp-queued',
    },
    t0,
  );
  db.close();

  const reopened = openCoordinatorState(dbPath);
  const row = getTaskRun(reopened, 'task-queued');
  assert.ok(row, 'queued task 的 checkpoint 必須存在');
  assert.strictEqual(row!.phase, 'queued');
  assert.strictEqual(row!.workerId, null, 'queued task 必須持久化 workerId=null');
  assert.strictEqual(row!.branch, null, 'queued task 必須持久化 branch=null');

  assert.throws(
    () => claimLease(reopened, { taskId: 'task-queued', workerId: 'worker-x', now: t0 }),
    /is queued and cannot be leased/,
    'reopen 後 queued task 仍不得取得執行 lease',
  );
  assert.throws(
    () => beginAction(reopened, { actionKey: 'ai:task-queued:1', taskId: 'task-queued', kind: 'member_ai' }, t0),
    /is queued and cannot start an action/,
    'reopen 後 queued task 仍不得建立 AI action',
  );
  assert.strictEqual(getAction(reopened, 'ai:task-queued:1'), null, '被拒絕的 action 不應留下任何紀錄');

  // 只有透過固定 release condition（例如把 checkpoint 的 phase 轉出 queued）才能重新啟用；
  // 這裡示範轉出後 lease／action 便恢復正常，佐證上面兩個拒絕不是永久性 bug。
  upsertTaskCheckpoint(
    reopened,
    {
      taskId: 'task-queued',
      workspaceId: 'ws-1',
      phase: 'assigned',
      workerId: null,
      branch: 'sim/task/task-queued',
      evidenceFingerprint: 'fp-queued-released',
    },
    t0,
  );
  const releasedClaim = claimLease(reopened, { taskId: 'task-queued', workerId: 'worker-x', now: t0 });
  assert.ok(releasedClaim, '轉出 queued 後應可正常取得 lease');

  reopened.close();
}

// ---------------------------------------------------------------------------
// ticks：begin/end heartbeat 也必須可持久化（供 --status 使用）
// ---------------------------------------------------------------------------
{
  const dbPath = join(dir, 'tick.db');
  const t0 = new Date('2026-07-22T00:00:00.000Z');
  const t1 = new Date('2026-07-22T00:05:00.000Z');

  const db = openCoordinatorState(dbPath);
  beginTick(db, 'tick-1', t0);
  endTick(
    db,
    {
      tickId: 'tick-1',
      outcome: 'success',
      discoveredCount: 2,
      processedCount: 2,
      skippedCount: 0,
      errorCount: 0,
    },
    t1,
  );
  assert.throws(() => endTick(db, { tickId: 'no-such-tick', outcome: 'success', discoveredCount: 0, processedCount: 0, skippedCount: 0, errorCount: 0 }, t1), /unknown tick_id/);
  db.close();

  const reopened = openCoordinatorState(dbPath);
  const tick = getTick(reopened, 'tick-1');
  assert.deepStrictEqual(tick, {
    tickId: 'tick-1',
    startedAt: t0.toISOString(),
    endedAt: t1.toISOString(),
    outcome: 'success',
    discoveredCount: 2,
    processedCount: 2,
    skippedCount: 0,
    errorCount: 0,
    error: null,
  });
  reopened.close();
}

// ---------------------------------------------------------------------------
// coordinator_meta：schema 建立時應自動 seed 一列，reopen 後仍存在
// ---------------------------------------------------------------------------
{
  const dbPath = join(dir, 'meta.db');
  const db = openCoordinatorState(dbPath);
  const seeded = db.prepare('SELECT schema_version, cutover_generation FROM coordinator_meta WHERE id = 1').get() as
    | { schema_version: number; cutover_generation: number }
    | undefined;
  assert.ok(seeded, 'openCoordinatorState 必須 seed coordinator_meta 單列');
  assert.strictEqual(seeded!.schema_version, 1);
  assert.strictEqual(seeded!.cutover_generation, 0);
  db.close();

  const reopened = openCoordinatorState(dbPath);
  const stillThere = reopened
    .prepare('SELECT schema_version, cutover_generation FROM coordinator_meta WHERE id = 1')
    .get() as { schema_version: number; cutover_generation: number } | undefined;
  assert.ok(stillThere, 'reopen 不得重置 coordinator_meta');
  assert.strictEqual(stillThere!.cutover_generation, 0);
  reopened.close();
}

// =============================================================================
// policy.ts：純 scheduling policy 測試（零 I/O，全部同步）
// =============================================================================

const NOW = new Date('2026-07-23T00:00:00.000Z');

const USER_IDS: Record<string, string> = {
  'user01@test.local': 'user-owner-01',
  'user03@test.local': 'user-03',
  'user05@test.local': 'user-05',
  'user06@test.local': 'user-06',
  'user09@test.local': 'user-09',
};

function makeTaskRun(overrides: Partial<TaskRun> & { taskId: string; workspaceId: string }): TaskRun {
  return {
    taskId: overrides.taskId,
    workspaceId: overrides.workspaceId,
    phase: overrides.phase ?? 'doing',
    workerId: overrides.workerId ?? null,
    branch: overrides.branch ?? null,
    baseSha: overrides.baseSha ?? null,
    headSha: overrides.headSha ?? null,
    evidenceFingerprint: overrides.evidenceFingerprint ?? '',
    noProgressCount: overrides.noProgressCount ?? 0,
    ownerIntervened: overrides.ownerIntervened ?? false,
    leaseUntil: overrides.leaseUntil ?? null,
    updatedAt: overrides.updatedAt ?? '2026-07-22T00:00:00.000Z',
  };
}

function makeTask(
  overrides: Partial<TaskSnapshot> & { taskId: string; workspaceId: string; status: TaskStatus },
): TaskSnapshot {
  return {
    taskId: overrides.taskId,
    workspaceId: overrides.workspaceId,
    title: overrides.title ?? 'untitled',
    status: overrides.status,
    assigneeId: overrides.assigneeId ?? null,
    dueAt: overrides.dueAt ?? null,
    updatedAt: overrides.updatedAt ?? '2026-07-22T00:00:00.000Z',
    version: overrides.version ?? 1,
  };
}

function makeEvidence(overrides: Partial<TaskEvidence> & { taskId: string; status: TaskStatus }): TaskEvidence {
  return {
    taskId: overrides.taskId,
    status: overrides.status,
    assigneeId: overrides.assigneeId ?? null,
    dueAt: overrides.dueAt ?? null,
    commentCount: overrides.commentCount ?? 0,
    lastCommentId: overrides.lastCommentId ?? null,
    lastCommentAt: overrides.lastCommentAt ?? null,
  };
}

function baseSnapshot(overrides: Partial<CoordinatorSnapshot> = {}): CoordinatorSnapshot {
  return {
    tasks: overrides.tasks ?? [],
    taskRuns: overrides.taskRuns ?? {},
    taskEvidence: overrides.taskEvidence ?? {},
    prerequisiteEvidence: overrides.prerequisiteEvidence ?? null,
    userIdsByEmail: overrides.userIdsByEmail ?? USER_IDS,
  };
}

function validPrerequisiteEvidence(): PrerequisiteEvidence {
  return {
    status: 'Done',
    task1AuthorizedAt: '2026-07-20T00:00:00.000Z',
    canonicalOwnerId: USER_IDS['user01@test.local'],
    user03CanonicalId: USER_IDS['user03@test.local'],
    user09CanonicalId: USER_IDS['user09@test.local'],
    assignmentEvent: {
      eventId: 'event-assign-1',
      actorId: USER_IDS['user01@test.local'],
      payloadAssigneeId: USER_IDS['user03@test.local'],
      createdAt: '2026-07-20T01:00:00.000Z',
    },
    acceptedHead: {
      sha: 'headsha123',
      branch: CUTOVER_TASKS.completedPrerequisite.taskBranch,
      hasTaskIdTrailer: true,
    },
    ownerAcceptance: {
      acceptanceId: 'acceptance-1',
      referencedHeadSha: 'headsha123',
    },
    acceptedMerge: {
      sha: 'mergesha456',
      headIsAncestor: true,
    },
    liveRev: 'mergesha456',
    liveRevIsMergeOrDescendant: true,
    completionComment: {
      commentId: 'comment-complete-1',
      referencesTask1AuthorizedAt: true,
      referencesAssignmentEventId: 'event-assign-1',
      referencesAcceptanceId: 'acceptance-1',
      referencesHeadSha: 'headsha123',
      referencesMergeSha: 'mergesha456',
      referencesLiveRev: 'mergesha456',
    },
    notification: {
      notificationId: 'notif-1',
      recipientId: USER_IDS['user09@test.local'],
      sourceCommentId: 'comment-complete-1',
    },
  };
}

// ---------------------------------------------------------------------------
// CUTOVER_TASKS 常數必須與計畫給定的值 byte-for-byte 相同（Task 9 的
// migrate.ts 會假設同一組真實 ID）。
// ---------------------------------------------------------------------------
{
  assert.strictEqual(MAIN_WORKSPACE_ID, '11a82028-fc50-466a-a723-e002032cd9a6');
  assert.strictEqual(CANONICAL_WORKSPACE_ID, 'd9da9945-ce5f-400f-806e-1d75e95e313a');
  assert.strictEqual(CUTOVER_TASKS.mainDiscussion, '10e65231-a4b2-4bdb-aab4-9f3c5fb0e916');
  assert.strictEqual(CUTOVER_TASKS.mainPolicy, '27ec8d7e-8605-468c-9f2c-13a80bef2a5a');
  assert.strictEqual(CUTOVER_TASKS.legacyCanonicalDiscussion, '8be538bc-ffc6-4122-9757-026a54ba813f');
  assert.deepStrictEqual(CUTOVER_TASKS.activeReview, {
    taskId: '938aa035-5f96-4908-b28b-876fa4735061',
    assigneeEmail: 'user06@test.local',
    classification: 'bug',
  });
  assert.deepStrictEqual(CUTOVER_TASKS.queuedReview, {
    taskId: '6384b6f4-f92f-45a2-a5e1-133f04f76372',
    assigneeEmail: null,
    afterTaskId: '938aa035-5f96-4908-b28b-876fa4735061',
  });
  assert.deepStrictEqual(CUTOVER_TASKS.completedPrerequisite, {
    taskId: '00123ef0-81cb-410e-aed1-d6d1fb925ed6',
    implementedByPlanTask: 1,
    implementerEmail: 'user03@test.local',
    taskBranch: 'sim/task/00123ef0-81cb-410e-aed1-d6d1fb925ed6',
    requiredStatus: 'Done',
  });
  assert.deepStrictEqual(CUTOVER_TASKS.deferredAssignment, {
    taskId: '027c0052-46d5-4da7-90fa-dd8efb2219fc',
    assigneeEmail: 'user05@test.local',
    classification: 'approved',
    afterTaskId: '938aa035-5f96-4908-b28b-876fa4735061',
  });
  assert.strictEqual(MAIN_POLICY_TITLE, '[規則] 主工作區協作與交接');
  assert.strictEqual(LEGACY_CANONICAL_DISCUSSION_TITLE, '[討論] 方向與下一步');
}

// ---------------------------------------------------------------------------
// 完整 cutover 場景：只發現兩個 workspace、雙重規則排除、fixed disposition
// 優先於一般排序（且不受 updated_at 影響）、queued 保持零 action、主討論
// 未到期未變更保持零 action。
// ---------------------------------------------------------------------------
{
  const THIRD_WORKSPACE_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'; // 不在允許清單內

  const activeReviewTask = makeTask({
    taskId: CUTOVER_TASKS.activeReview.taskId,
    workspaceId: CANONICAL_WORKSPACE_ID,
    title: '既有卡關 task（activeReview）',
    status: 'Doing',
    assigneeId: USER_IDS['user06@test.local'],
    updatedAt: '2026-01-01T00:00:00.000Z', // 刻意很舊
  });

  // Decoy：同一個 assignee(user06) 的另一筆 Doing，updated_at 明顯比 activeReview 新。
  // 如果 fixed disposition 沒有優先於一般排序，一般 tie-break（依 updated_at）會誤選這筆。
  const decoyDoingSameAssignee = makeTask({
    taskId: 'decoy-doing-user06',
    workspaceId: CANONICAL_WORKSPACE_ID,
    title: '同一 assignee 的 decoy Doing task',
    status: 'Doing',
    assigneeId: USER_IDS['user06@test.local'],
    updatedAt: '2026-07-20T00:00:00.000Z',
  });

  const queuedReviewTask = makeTask({
    taskId: CUTOVER_TASKS.queuedReview.taskId,
    workspaceId: CANONICAL_WORKSPACE_ID,
    title: 'queued review task',
    status: 'Todo', // cutover 後固定是 Todo／unassigned
    assigneeId: null,
  });

  const mainPolicyTask = makeTask({
    taskId: CUTOVER_TASKS.mainPolicy,
    workspaceId: MAIN_WORKSPACE_ID,
    title: MAIN_POLICY_TITLE,
    status: 'Todo',
  });

  const legacyDiscussionTask = makeTask({
    taskId: CUTOVER_TASKS.legacyCanonicalDiscussion,
    workspaceId: MAIN_WORKSPACE_ID,
    title: LEGACY_CANONICAL_DISCUSSION_TITLE,
    status: 'Todo',
  });

  // 雙重規則防禦性 fixture：同樣的 canonical title，但 ID／workspace 不同的「假」task，
  // 不應被誤排除——只有 ID 相符才算 canonical task。
  const decoySameTitleDifferentId = makeTask({
    taskId: 'decoy-same-title-different-id',
    workspaceId: CANONICAL_WORKSPACE_ID,
    title: LEGACY_CANONICAL_DISCUSSION_TITLE,
    status: 'Todo',
  });

  const thirdWorkspaceTask = makeTask({
    taskId: 'task-in-disallowed-workspace',
    workspaceId: THIRD_WORKSPACE_ID,
    title: '不該被發現',
    status: 'Todo',
  });

  const deferredAssignmentTaskNotYet = makeTask({
    taskId: CUTOVER_TASKS.deferredAssignment.taskId,
    workspaceId: CANONICAL_WORKSPACE_ID,
    title: 'deferred assignment task',
    status: 'Todo',
    assigneeId: null,
  });

  const mainDiscussionEvidenceBase = makeEvidence({
    taskId: CUTOVER_TASKS.mainDiscussion,
    status: 'Todo',
    commentCount: 3,
    lastCommentId: 'comment-x',
    lastCommentAt: '2026-07-10T00:00:00.000Z',
  });
  const mainDiscussionFingerprint = taskEvidenceFingerprint(mainDiscussionEvidenceBase);

  const mainDiscussionTaskNotDue = makeTask({
    taskId: CUTOVER_TASKS.mainDiscussion,
    workspaceId: MAIN_WORKSPACE_ID,
    title: '目前主討論窗口',
    status: 'Todo',
    dueAt: '2099-01-01T00:00:00.000Z', // 尚未到期
  });

  const snapshot = baseSnapshot({
    tasks: [
      activeReviewTask,
      decoyDoingSameAssignee,
      queuedReviewTask,
      mainPolicyTask,
      legacyDiscussionTask,
      decoySameTitleDifferentId,
      thirdWorkspaceTask,
      deferredAssignmentTaskNotYet,
      mainDiscussionTaskNotDue,
    ],
    taskRuns: {
      [queuedReviewTask.taskId]: makeTaskRun({
        taskId: queuedReviewTask.taskId,
        workspaceId: CANONICAL_WORKSPACE_ID,
        phase: 'queued',
      }),
      [deferredAssignmentTaskNotYet.taskId]: makeTaskRun({
        taskId: deferredAssignmentTaskNotYet.taskId,
        workspaceId: CANONICAL_WORKSPACE_ID,
        phase: 'queued',
      }),
      [mainDiscussionTaskNotDue.taskId]: makeTaskRun({
        taskId: mainDiscussionTaskNotDue.taskId,
        workspaceId: MAIN_WORKSPACE_ID,
        phase: 'assigned',
        evidenceFingerprint: mainDiscussionFingerprint,
      }),
    },
    taskEvidence: {
      [mainDiscussionTaskNotDue.taskId]: mainDiscussionEvidenceBase,
    },
  });

  const actions = selectCoordinatorActions(snapshot, NOW);
  const taskIdsInActions = new Set(actions.map((a) => a.taskId));

  // 只會發現兩個已鎖定的 workspace UUID：第三個 workspace 的 task 必須完全不出現。
  assert.strictEqual(taskIdsInActions.has(thirdWorkspaceTask.taskId), false, '不在允許清單內的 workspace 必須被忽略');

  // 排除 mainPolicy 與 legacyCanonicalDiscussion：兩者永遠不產生任何 action。
  assert.strictEqual(taskIdsInActions.has(mainPolicyTask.taskId), false, 'mainPolicy 必須永遠被排除');
  assert.strictEqual(taskIdsInActions.has(legacyDiscussionTask.taskId), false, 'legacyCanonicalDiscussion 必須永遠被排除');

  // 雙重規則：同 title 但不同 ID 的 decoy 不應被誤排除，必須正常產生 action。
  assert.strictEqual(
    actions.find((a) => a.taskId === decoySameTitleDifferentId.taskId)?.kind,
    'owner_dispatch',
    '排除規則以 ID 為主、title 為輔——同 title 不同 ID 的 task 不得被誤排除',
  );

  // activeReview 是 user06 唯一可執行 action。
  const activeReviewActions = actions.filter((a) => a.taskId === activeReviewTask.taskId);
  assert.strictEqual(activeReviewActions.length, 1);
  assert.strictEqual(activeReviewActions[0].kind, 'member_work');
  assert.strictEqual(activeReviewActions[0].assigneeId, USER_IDS['user06@test.local']);

  // 每位 member 只取得一個非 blocked WIP task；fixed disposition 優先於一般排序，
  // 且不受同狀態 task 的 updated_at 影響——decoy 比 activeReview 新，仍然被排除。
  assert.strictEqual(
    taskIdsInActions.has(decoyDoingSameAssignee.taskId),
    false,
    '同一 assignee 的第二筆 Doing 不得再取得 action（WIP1 + fixed disposition 優先）',
  );

  // queuedReview：cutover 後為 Todo／unassigned，checkpoint 是 queued，零 action——
  // 即使排程看到它是 Todo，也不得因「未指派可執行 Todo」而觸發 Owner 派工。
  assert.strictEqual(taskIdsInActions.has(queuedReviewTask.taskId), false, 'queued checkpoint 的 task 必須零 action');

  // deferredAssignment：938aa035 尚未 Done，必須保持零 action。
  assert.strictEqual(
    taskIdsInActions.has(deferredAssignmentTaskNotYet.taskId),
    false,
    'gate task 尚未 Done 時，deferredAssignment 必須保持零 action',
  );

  // 尚未到期且沒有變更的主討論，不會建立 Owner action。
  assert.strictEqual(
    taskIdsInActions.has(mainDiscussionTaskNotDue.taskId),
    false,
    '尚未到期且證據未變化的主討論不得建立 Owner action',
  );

  // 總數：只有 activeReview（固定 disposition）與 decoySameTitleDifferentId（generic owner_dispatch）。
  assert.strictEqual(actions.length, 2, '這個 snapshot 裡只應該有這兩筆 action');
}

// ---------------------------------------------------------------------------
// 主討論：到期，或證據 fingerprint 變化，才建立 Owner action。
// ---------------------------------------------------------------------------
{
  const evidence = makeEvidence({
    taskId: CUTOVER_TASKS.mainDiscussion,
    status: 'Todo',
    commentCount: 1,
    lastCommentId: 'c1',
    lastCommentAt: '2026-07-01T00:00:00.000Z',
  });
  const fingerprint = taskEvidenceFingerprint(evidence);

  // Scenario 1：已過期。
  const pastDueTask = makeTask({
    taskId: CUTOVER_TASKS.mainDiscussion,
    workspaceId: MAIN_WORKSPACE_ID,
    status: 'Todo',
    dueAt: '2026-07-22T00:00:00.000Z', // 早於 NOW
  });
  const pastDueSnapshot = baseSnapshot({
    tasks: [pastDueTask],
    taskRuns: {
      [pastDueTask.taskId]: makeTaskRun({
        taskId: pastDueTask.taskId,
        workspaceId: MAIN_WORKSPACE_ID,
        evidenceFingerprint: fingerprint,
      }),
    },
    taskEvidence: { [pastDueTask.taskId]: evidence },
  });
  const pastDueActions = selectCoordinatorActions(pastDueSnapshot, NOW);
  assert.strictEqual(pastDueActions.length, 1, '已過期的主討論必須建立 Owner action');
  assert.strictEqual(pastDueActions[0].kind, 'main_discussion_owner');

  // Scenario 2：未過期，但證據已變化（新留言）。
  const notDueTask = makeTask({
    taskId: CUTOVER_TASKS.mainDiscussion,
    workspaceId: MAIN_WORKSPACE_ID,
    status: 'Todo',
    dueAt: '2099-01-01T00:00:00.000Z',
  });
  const changedEvidence = makeEvidence({ ...evidence, commentCount: 2, lastCommentId: 'c2' });
  const changedSnapshot = baseSnapshot({
    tasks: [notDueTask],
    taskRuns: {
      [notDueTask.taskId]: makeTaskRun({
        taskId: notDueTask.taskId,
        workspaceId: MAIN_WORKSPACE_ID,
        evidenceFingerprint: fingerprint, // 舊 fingerprint
      }),
    },
    taskEvidence: { [notDueTask.taskId]: changedEvidence }, // 目前證據已經不同
  });
  const changedActions = selectCoordinatorActions(changedSnapshot, NOW);
  assert.strictEqual(changedActions.length, 1, '證據變化必須建立 Owner action，即使尚未到期');
  assert.strictEqual(changedActions[0].kind, 'main_discussion_owner');

  // Scenario 3：未過期且證據未變化 —— 零 action。
  const unchangedSnapshot = baseSnapshot({
    tasks: [notDueTask],
    taskRuns: {
      [notDueTask.taskId]: makeTaskRun({
        taskId: notDueTask.taskId,
        workspaceId: MAIN_WORKSPACE_ID,
        evidenceFingerprint: fingerprint,
      }),
    },
    taskEvidence: { [notDueTask.taskId]: evidence },
  });
  assert.deepStrictEqual(selectCoordinatorActions(unchangedSnapshot, NOW), [], '未到期且未變更必須是零 action');
}

// ---------------------------------------------------------------------------
// completedPrerequisite（00123ef0）：完整證據鏈全部符合時零 action。
// ---------------------------------------------------------------------------
{
  const task = makeTask({
    taskId: CUTOVER_TASKS.completedPrerequisite.taskId,
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Done',
    assigneeId: USER_IDS['user03@test.local'],
  });
  const evidence = validPrerequisiteEvidence();
  assert.strictEqual(validatePrerequisiteEvidence(evidence), true);

  const snapshot = baseSnapshot({ tasks: [task], prerequisiteEvidence: evidence });
  const result = selectCoordinatorActions(snapshot, NOW);
  assert.deepStrictEqual(result, [], '完整證據鏈全部符合時，00123ef0 不得產生任何 action');
}

// ---------------------------------------------------------------------------
// completedPrerequisite：任一環節缺漏或不相符 -> CutoverPrerequisiteMissing，
// 且整批 task／Git／AI cutover mutation 必須為零（只有這一個診斷 action）。
// ---------------------------------------------------------------------------
{
  const task = makeTask({
    taskId: CUTOVER_TASKS.completedPrerequisite.taskId,
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Done',
  });

  type Breaker = (e: PrerequisiteEvidence) => PrerequisiteEvidence;
  const brokenVariants: Array<[string, Breaker]> = [
    ['status 不是 Done', (e) => ({ ...e, status: 'Review' })],
    ['assignment event 早於 task1AuthorizedAt', (e) => ({
      ...e,
      assignmentEvent: { ...e.assignmentEvent!, createdAt: '2026-07-19T00:00:00.000Z' },
    })],
    ['assignment actor 不是 canonical Owner', (e) => ({
      ...e,
      assignmentEvent: { ...e.assignmentEvent!, actorId: 'someone-else' },
    })],
    ['assignment payload 不是 user03', (e) => ({
      ...e,
      assignmentEvent: { ...e.assignmentEvent!, payloadAssigneeId: 'someone-else' },
    })],
    ['accepted head 不在固定 task branch', (e) => ({
      ...e,
      acceptedHead: { ...e.acceptedHead!, branch: 'wrong-branch' },
    })],
    ['accepted head 缺少 Task-Id trailer', (e) => ({
      ...e,
      acceptedHead: { ...e.acceptedHead!, hasTaskIdTrailer: false },
    })],
    ['owner acceptance 引用錯誤的 head', (e) => ({
      ...e,
      ownerAcceptance: { ...e.ownerAcceptance!, referencedHeadSha: 'other-sha' },
    })],
    ['accepted merge 沒有把 head 保留為 ancestor', (e) => ({
      ...e,
      acceptedMerge: { ...e.acceptedMerge!, headIsAncestor: false },
    })],
    ['live rev 不等於 merge 或其後代', (e) => ({ ...e, liveRevIsMergeOrDescendant: false })],
    ['live rev 缺席', (e) => ({ ...e, liveRev: null })],
    ['完成留言引用錯誤的 assignment event', (e) => ({
      ...e,
      completionComment: { ...e.completionComment!, referencesAssignmentEventId: 'other-event' },
    })],
    ['完成留言引用錯誤的 acceptance', (e) => ({
      ...e,
      completionComment: { ...e.completionComment!, referencesAcceptanceId: 'other-acceptance' },
    })],
    ['完成留言引用錯誤的 head', (e) => ({
      ...e,
      completionComment: { ...e.completionComment!, referencesHeadSha: 'other-sha' },
    })],
    ['完成留言引用錯誤的 merge', (e) => ({
      ...e,
      completionComment: { ...e.completionComment!, referencesMergeSha: 'other-sha' },
    })],
    ['完成留言引用錯誤的 live rev', (e) => ({
      ...e,
      completionComment: { ...e.completionComment!, referencesLiveRev: 'other-rev' },
    })],
    ['完成留言沒有引用 task1AuthorizedAt', (e) => ({
      ...e,
      completionComment: { ...e.completionComment!, referencesTask1AuthorizedAt: false },
    })],
    ['notification 沒有指向完成留言', (e) => ({
      ...e,
      notification: { ...e.notification!, sourceCommentId: 'other-comment' },
    })],
    ['notification recipient 不是 user09', (e) => ({
      ...e,
      notification: { ...e.notification!, recipientId: 'not-user09' },
    })],
    ['assignment event 整個缺席', (e) => ({ ...e, assignmentEvent: null })],
    ['owner acceptance 整個缺席', (e) => ({ ...e, ownerAcceptance: null })],
    ['completion comment 整個缺席', (e) => ({ ...e, completionComment: null })],
    ['notification 整個缺席', (e) => ({ ...e, notification: null })],
  ];

  for (const [label, breakIt] of brokenVariants) {
    const evidence = breakIt(validPrerequisiteEvidence());
    assert.strictEqual(validatePrerequisiteEvidence(evidence), false, `validatePrerequisiteEvidence 必須拒絕：${label}`);

    const snapshot = baseSnapshot({ tasks: [task], prerequisiteEvidence: evidence });
    const result = selectCoordinatorActions(snapshot, NOW);
    assert.strictEqual(result.length, 1, `${label}：必須恰好只有一個 cutover_prerequisite_missing 標記`);
    assert.strictEqual(result[0].kind, 'cutover_prerequisite_missing');
    assert.strictEqual(result[0].errorCode, 'CutoverPrerequisiteMissing');
    assert.strictEqual(result[0].taskId, task.taskId);
  }

  // 證據整個缺席（null）也必須被拒絕。
  const snapshotNoEvidence = baseSnapshot({ tasks: [task], prerequisiteEvidence: null });
  const resultNoEvidence = selectCoordinatorActions(snapshotNoEvidence, NOW);
  assert.strictEqual(resultNoEvidence.length, 1);
  assert.strictEqual(resultNoEvidence[0].errorCode, 'CutoverPrerequisiteMissing');
}

// ---------------------------------------------------------------------------
// deferredAssignment（027c0052）：938aa035 尚未 Done 時保持 queued／unassigned；
// Done readback 後只產生指派 user05 的 action。
// ---------------------------------------------------------------------------
{
  const deferredTask = makeTask({
    taskId: CUTOVER_TASKS.deferredAssignment.taskId,
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Todo',
    assigneeId: null,
  });
  const deferredCheckpoint = {
    [deferredTask.taskId]: makeTaskRun({
      taskId: deferredTask.taskId,
      workspaceId: CANONICAL_WORKSPACE_ID,
      phase: 'queued',
    }),
  };

  const activeReviewNotDone = makeTask({
    taskId: CUTOVER_TASKS.activeReview.taskId,
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Doing',
    assigneeId: USER_IDS['user06@test.local'],
  });
  const snapshotNotYet = baseSnapshot({
    tasks: [activeReviewNotDone, deferredTask],
    taskRuns: deferredCheckpoint,
  });
  const resultNotYet = selectCoordinatorActions(snapshotNotYet, NOW);
  assert.strictEqual(
    resultNotYet.some((a) => a.taskId === deferredTask.taskId),
    false,
    '938aa035 尚未 Done 時，027c0052 必須保持零 action',
  );

  const activeReviewDone = makeTask({
    taskId: CUTOVER_TASKS.activeReview.taskId,
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Done',
    assigneeId: USER_IDS['user06@test.local'],
  });
  const snapshotDone = baseSnapshot({
    tasks: [activeReviewDone, deferredTask],
    taskRuns: deferredCheckpoint, // checkpoint 仍然是舊的 queued——policy 必須自己判斷已解鎖
  });
  const resultDone = selectCoordinatorActions(snapshotDone, NOW);
  const deferredActions = resultDone.filter((a) => a.taskId === deferredTask.taskId);
  assert.strictEqual(deferredActions.length, 1, '938aa035 Done readback 後，027c0052 只產生一個 action');
  assert.strictEqual(deferredActions[0].kind, 'assign_member');
  assert.strictEqual(deferredActions[0].assigneeId, USER_IDS['user05@test.local']);
}

// ---------------------------------------------------------------------------
// Generic（非固定 cutover disposition）排序：Review 驗收優先於新派工；
// 已指派 Doing 優先於 Todo；每位 member 只取得一個非 blocked WIP task。
// ---------------------------------------------------------------------------
{
  const memberA = 'member-a';
  const memberB = 'member-b';
  const reviewTask = makeTask({
    taskId: 'generic-review',
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Review',
    assigneeId: memberA,
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
  const doingTaskSameMember = makeTask({
    taskId: 'generic-doing-same-member',
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Doing',
    assigneeId: memberA,
    updatedAt: '2026-07-02T00:00:00.000Z',
  });
  const doingOlder = makeTask({
    taskId: 'generic-doing-older',
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Doing',
    assigneeId: memberB,
    updatedAt: '2026-06-01T00:00:00.000Z',
  });
  const doingNewerSameMember = makeTask({
    taskId: 'generic-doing-newer',
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Doing',
    assigneeId: memberB,
    updatedAt: '2026-07-05T00:00:00.000Z',
  });
  const unassignedTodo = makeTask({
    taskId: 'generic-todo-unassigned',
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Todo',
    assigneeId: null,
    updatedAt: '2026-05-01T00:00:00.000Z',
  });

  const snapshot = baseSnapshot({
    tasks: [unassignedTodo, doingNewerSameMember, doingOlder, doingTaskSameMember, reviewTask],
  });
  const result = selectCoordinatorActions(snapshot, NOW);
  const kindByTaskId = new Map(result.map((a) => [a.taskId, a.kind]));

  assert.strictEqual(kindByTaskId.get(reviewTask.taskId), 'owner_review');
  assert.strictEqual(kindByTaskId.get(unassignedTodo.taskId), 'owner_dispatch');
  assert.strictEqual(
    kindByTaskId.has(doingTaskSameMember.taskId),
    false,
    'memberA 已經有 Review 佔用 WIP，不該再取得另一筆 Doing 的 action',
  );
  assert.strictEqual(kindByTaskId.get(doingOlder.taskId), 'member_work');
  assert.strictEqual(
    kindByTaskId.has(doingNewerSameMember.taskId),
    false,
    '同一 member 的第二筆 Doing 不得同時取得 action（WIP1）',
  );

  const indexOf = (id: string) => result.findIndex((a) => a.taskId === id);
  assert.ok(indexOf(reviewTask.taskId) < indexOf(unassignedTodo.taskId), 'Review 驗收必須優先於新派工');
  assert.ok(indexOf(doingOlder.taskId) < indexOf(unassignedTodo.taskId), '已指派 Doing 必須優先於 Todo');
}

// ---------------------------------------------------------------------------
// recordMemberAttempt：連續兩次無進展 -> Owner 介入；介入後再一次無進展 ->
// human_blocked；provider／network failure（evidenceChanged: true）永遠不增加
// noProgressCount。
// ---------------------------------------------------------------------------
{
  let run = makeTaskRun({ taskId: 'member-attempt-task', workspaceId: CANONICAL_WORKSPACE_ID, phase: 'doing' });

  run = recordMemberAttempt(run, false);
  assert.strictEqual(run.noProgressCount, 1);
  assert.strictEqual(run.ownerIntervened, false);
  assert.strictEqual(run.phase, 'doing');

  run = recordMemberAttempt(run, false);
  assert.strictEqual(run.noProgressCount, 2);
  assert.strictEqual(run.ownerIntervened, true, '連續兩次無進展必須觸發 Owner 介入');
  assert.strictEqual(run.phase, 'doing', '介入本身不改變 phase');

  run = recordMemberAttempt(run, false);
  assert.strictEqual(run.noProgressCount, 3);
  assert.strictEqual(run.phase, 'human_blocked', '介入後再一次無進展必須轉為 human_blocked');

  // Provider／network failure 永遠不增加 noProgressCount：呼叫端必須以
  // evidenceChanged: true 呼叫（視為不計分的一次），不論之前的狀態如何。
  let blockedRun = makeTaskRun({
    taskId: 'member-attempt-task-2',
    workspaceId: CANONICAL_WORKSPACE_ID,
    phase: 'doing',
    noProgressCount: 1,
    ownerIntervened: true,
  });
  const afterNetworkFailure = recordMemberAttempt(blockedRun, true);
  assert.strictEqual(afterNetworkFailure.noProgressCount, 0, 'network failure 不得增加 noProgressCount');
  assert.strictEqual(afterNetworkFailure.ownerIntervened, false, '真正的進展必須清除舊的介入旗標');

  // 真正有進展：noProgressCount 重置。
  const progressed = recordMemberAttempt(makeTaskRun({ taskId: 't', workspaceId: CANONICAL_WORKSPACE_ID, noProgressCount: 1 }), true);
  assert.strictEqual(progressed.noProgressCount, 0);
}

// ---------------------------------------------------------------------------
// shouldResumeHumanBlocked：只有證據 fingerprint 變化才恢復。
// ---------------------------------------------------------------------------
{
  const evidence = makeEvidence({ taskId: 'blocked-task', status: 'Doing', commentCount: 1 });
  const fingerprint = taskEvidenceFingerprint(evidence);
  const blockedRun = makeTaskRun({
    taskId: 'blocked-task',
    workspaceId: CANONICAL_WORKSPACE_ID,
    phase: 'human_blocked',
    evidenceFingerprint: fingerprint,
  });

  assert.strictEqual(shouldResumeHumanBlocked(blockedRun, evidence), false, '證據未變化不得恢復');
  const changedEvidence = makeEvidence({ ...evidence, commentCount: 2 });
  assert.strictEqual(shouldResumeHumanBlocked(blockedRun, changedEvidence), true, '證據變化必須恢復');

  const notBlockedRun = makeTaskRun({
    taskId: 'blocked-task',
    workspaceId: CANONICAL_WORKSPACE_ID,
    phase: 'doing',
    evidenceFingerprint: fingerprint,
  });
  assert.strictEqual(shouldResumeHumanBlocked(notBlockedRun, changedEvidence), false, '非 human_blocked 的 run 不適用');
}

// ---------------------------------------------------------------------------
// validateOwnerClassification：預設 new-feature，不信任 Owner 自稱的 claim。
// ---------------------------------------------------------------------------
{
  const cases: Array<[OwnerClassification, WorkClass]> = [
    [
      {
        claim: 'bug',
        restoresDocumentedBehavior: true,
        isUserInvisibleMaintenance: false,
        approvedDiscussionId: null,
        approvedByUser09: false,
      },
      'bug',
    ],
    [
      {
        claim: 'maintenance',
        restoresDocumentedBehavior: false,
        isUserInvisibleMaintenance: true,
        approvedDiscussionId: null,
        approvedByUser09: false,
      },
      'maintenance',
    ],
    [
      {
        claim: 'new-feature',
        restoresDocumentedBehavior: false,
        isUserInvisibleMaintenance: false,
        approvedDiscussionId: 'discussion-1',
        approvedByUser09: false,
      },
      'approved',
    ],
    [
      {
        claim: 'new-feature',
        restoresDocumentedBehavior: false,
        isUserInvisibleMaintenance: false,
        approvedDiscussionId: null,
        approvedByUser09: true,
      },
      'approved',
    ],
    [
      // Owner 自稱 bug，但沒有任何佐證旗標——必須預設 new-feature，不能只信 claim。
      {
        claim: 'bug',
        restoresDocumentedBehavior: false,
        isUserInvisibleMaintenance: false,
        approvedDiscussionId: null,
        approvedByUser09: false,
      },
      'new-feature',
    ],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(validateOwnerClassification(input), expected, `claim=${input.claim} 應解析為 ${expected}`);
  }
}

// ---------------------------------------------------------------------------
// taskEvidenceFingerprint：同輸入同結果；不同輸入不同結果。
// ---------------------------------------------------------------------------
{
  const evidenceA = makeEvidence({ taskId: 't', status: 'Doing', commentCount: 1, lastCommentId: 'c1' });
  const evidenceA2 = makeEvidence({ taskId: 't', status: 'Doing', commentCount: 1, lastCommentId: 'c1' });
  const evidenceB = makeEvidence({ taskId: 't', status: 'Doing', commentCount: 2, lastCommentId: 'c2' });

  assert.strictEqual(taskEvidenceFingerprint(evidenceA), taskEvidenceFingerprint(evidenceA2), '相同輸入必須得到相同 fingerprint');
  assert.notStrictEqual(taskEvidenceFingerprint(evidenceA), taskEvidenceFingerprint(evidenceB), '不同輸入必須得到不同 fingerprint');
}

// ---------------------------------------------------------------------------
// isExcludedTask：單元測試（ID 相符但 title 不符 -> 不排除；title 相符但 ID 不符 -> 不排除）。
// ---------------------------------------------------------------------------
{
  assert.strictEqual(
    isExcludedTask(makeTask({ taskId: CUTOVER_TASKS.mainPolicy, workspaceId: MAIN_WORKSPACE_ID, title: MAIN_POLICY_TITLE, status: 'Todo' })),
    true,
  );
  assert.strictEqual(
    isExcludedTask(makeTask({ taskId: CUTOVER_TASKS.mainPolicy, workspaceId: MAIN_WORKSPACE_ID, title: '改過的標題', status: 'Todo' })),
    false,
    'ID 符合但 title 不符——defense-in-depth 拒絕誤判為 canonical task',
  );
  assert.strictEqual(
    isExcludedTask(makeTask({ taskId: 'some-other-id', workspaceId: MAIN_WORKSPACE_ID, title: MAIN_POLICY_TITLE, status: 'Todo' })),
    false,
    'title 符合但 ID 不符——不得誤排除',
  );
}

// ---------------------------------------------------------------------------
// Coordinator restart：以 state.ts 真正持久化 TaskRun，close + reopen 資料庫後
// 重建 snapshot，selectCoordinatorActions 的結果必須完全相同，且任何 member
// 都不超過 WIP1。
// ---------------------------------------------------------------------------
{
  const restartDir = mkdtempSync(join(tmpdir(), 'sim-production-policy-restart-'));
  const dbPath = join(restartDir, 'restart.db');

  const memberX = 'member-x';
  const doingTask = makeTask({
    taskId: 'restart-doing',
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Doing',
    assigneeId: memberX,
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
  const blockedTask = makeTask({
    taskId: 'restart-blocked',
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Doing',
    assigneeId: 'member-y',
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
  const todoTask = makeTask({
    taskId: 'restart-todo',
    workspaceId: CANONICAL_WORKSPACE_ID,
    status: 'Todo',
    assigneeId: null,
  });

  const buildSnapshotFromDb = (db: ReturnType<typeof openCoordinatorState>): CoordinatorSnapshot => {
    const tasks = [doingTask, blockedTask, todoTask];
    const taskRuns: Record<string, TaskRun | undefined> = {};
    const taskEvidence: Record<string, TaskEvidence | undefined> = {};
    for (const t of tasks) {
      taskRuns[t.taskId] = getTaskRun(db, t.taskId) ?? undefined;
      taskEvidence[t.taskId] = makeEvidence({ taskId: t.taskId, status: t.status, assigneeId: t.assigneeId });
    }
    return baseSnapshot({ tasks, taskRuns, taskEvidence });
  };

  {
    const db = openCoordinatorState(dbPath);
    upsertTaskCheckpoint(
      db,
      { taskId: doingTask.taskId, workspaceId: CANONICAL_WORKSPACE_ID, phase: 'doing', evidenceFingerprint: 'fp-doing' },
      new Date('2026-07-01T00:00:00.000Z'),
    );
    upsertTaskCheckpoint(
      db,
      {
        taskId: blockedTask.taskId,
        workspaceId: CANONICAL_WORKSPACE_ID,
        phase: 'human_blocked',
        evidenceFingerprint: taskEvidenceFingerprint(
          makeEvidence({ taskId: blockedTask.taskId, status: blockedTask.status, assigneeId: blockedTask.assigneeId }),
        ),
      },
      new Date('2026-07-01T00:00:00.000Z'),
    );
    db.close();
  }

  const dbTick1 = openCoordinatorState(dbPath);
  const snapshotTick1 = buildSnapshotFromDb(dbTick1);
  const actionsTick1 = selectCoordinatorActions(snapshotTick1, NOW);
  dbTick1.close();

  // 模擬 coordinator 重啟：重新開檔、重建 snapshot、再跑一次。
  const dbTick2 = openCoordinatorState(dbPath);
  const snapshotTick2 = buildSnapshotFromDb(dbTick2);
  const actionsTick2 = selectCoordinatorActions(snapshotTick2, NOW);
  dbTick2.close();

  assert.deepStrictEqual(actionsTick1, actionsTick2, 'restart 前後、相同 snapshot 必須得到完全相同的 actions');

  // blockedTask 仍是 human_blocked 且證據未變化 -> 不應該出現在 actions 裡。
  assert.strictEqual(actionsTick1.some((a) => a.taskId === blockedTask.taskId), false, 'human_blocked 且證據未變化必須保持零 action');

  // WIP1：所有出現在 actions 裡、帶 assigneeId 的 action，同一個 assigneeId 只能出現一次。
  const assigneeCounts = new Map<string, number>();
  for (const action of actionsTick1) {
    if (!action.assigneeId) continue;
    assigneeCounts.set(action.assigneeId, (assigneeCounts.get(action.assigneeId) ?? 0) + 1);
  }
  for (const [assigneeId, count] of assigneeCounts) {
    assert.strictEqual(count, 1, `member ${assigneeId} 在同一次 tick 不得超過 WIP1`);
  }
}

// =============================================================================
// api.ts：具復原能力的 HTTP client 測試（需要暫存 node:http server，全部非同步）
// =============================================================================

function startFakeServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('startFakeServer: failed to bind'));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function runApiTests(): Promise<void> {
  // -------------------------------------------------------------------------
  // login：第一次主動中斷 socket，第二次才成功；安全 request 必須自動重試。
  // -------------------------------------------------------------------------
  {
    let loginAttempts = 0;
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === '/api/auth/login' && req.method === 'POST') {
        loginAttempts += 1;
        if (loginAttempts === 1) {
          req.socket.destroy(); // 主動中斷 socket，模擬暫時性失敗
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'tt_session=abc123; HttpOnly; Path=/' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 2, retryDelayMs: 5 });
      await client.login('user01@test.local', 'whatever');
      assert.strictEqual(loginAttempts, 2, '第一次 login 中斷 socket 後，安全 request 必須自動重試才成功');
    } finally {
      await close();
    }
  }

  // -------------------------------------------------------------------------
  // GET（getTask）遇到暫時性 socket 中斷：可重試。
  // -------------------------------------------------------------------------
  {
    let getAttempts = 0;
    const taskId = 'task-retry-get';
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === `/api/tasks/${taskId}` && req.method === 'GET') {
        getAttempts += 1;
        if (getAttempts === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            task_id: taskId,
            workspace_id: MAIN_WORKSPACE_ID,
            title: 'GET retry fixture',
            status: 'Todo',
            assignee_id: null,
            due_at: null,
            version: 1,
            updated_at: '2026-07-22T00:00:00.000Z',
          }),
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 2, retryDelayMs: 5 });
      const task = await client.getTask(taskId);
      assert.strictEqual(getAttempts, 2, '安全 GET 遇到第一次 socket 中斷後必須自動重試');
      assert.strictEqual(task.taskId, taskId);
      assert.strictEqual(task.status, 'Todo');
    } finally {
      await close();
    }
  }

  // -------------------------------------------------------------------------
  // health：暫時性 5xx 之後才成功——安全 request 對 5xx 也會重試。
  // -------------------------------------------------------------------------
  {
    let healthAttempts = 0;
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === '/api/health') {
        healthAttempts += 1;
        if (healthAttempts === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'db warming up' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', db: true, rev: 'abc123' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 2, retryDelayMs: 5 });
      const health = await client.health();
      assert.strictEqual(healthAttempts, 2, '安全 GET 遇到暫時性 5xx 必須自動重試');
      assert.deepStrictEqual(health, { status: 'ok', db: true, rev: 'abc123' });
    } finally {
      await close();
    }
  }

  // -------------------------------------------------------------------------
  // error.cause 會保留：重試預算耗盡後拋出的 Error 必須帶著底層網路錯誤。
  // -------------------------------------------------------------------------
  {
    const { port, close } = await startFakeServer((req) => {
      req.socket.destroy(); // 永遠中斷，逼安全 request 用完重試預算
    });
    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 1, retryDelayMs: 5 });
      await assert.rejects(
        () => client.health(),
        (err: unknown) => {
          assert.ok(err instanceof Error, '重試耗盡後必須拋出 Error');
          assert.ok(err.cause, 'error.cause 必須保留底層網路錯誤');
          return true;
        },
      );
    } finally {
      await close();
    }
  }

  // -------------------------------------------------------------------------
  // error.cause 會保留：重試預算耗盡後、仍是持續性 5xx 的那個路徑，同樣必須
  // 拋出帶 cause 的 Error，而不是把失敗的 raw response 當成功 return 回去
  // （這條路徑先前會悄悄把 error.cause 弄丟）。
  // -------------------------------------------------------------------------
  {
    let attempts = 0;
    const { port, close } = await startFakeServer((req, res) => {
      attempts += 1;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'db always warming up' }));
    });
    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 2, retryDelayMs: 5 });
      await assert.rejects(
        () => client.health(),
        (err: unknown) => {
          assert.ok(err instanceof Error, '5xx 重試耗盡後必須拋出 Error');
          assert.ok(err.cause, '5xx 重試耗盡後 error.cause 必須保留（不得悄悄消失）');
          assert.strictEqual((err.cause as { status: number }).status, 503, 'cause 必須帶著造成失敗的 HTTP 狀態碼');
          return true;
        },
      );
      assert.strictEqual(attempts, 3, '重試預算 retries=2 代表最多嘗試 3 次（1 次原始 + 2 次重試）');
    } finally {
      await close();
    }
  }

  // -------------------------------------------------------------------------
  // postCommentOnce：結果不確定時，先 readback 而非盲目重送。
  // 伺服器端其實已經把留言寫進去了，只是在送出 response 之前中斷 socket——
  // 模擬「mutation 可能已成功，但呼叫端從未收到確認」。api.ts 必須拋出
  // UncertainMutationError，且絕不自動重送同一個 POST；呼叫端之後自行 readback，
  // 會發現這個 actionKey 語意的留言其實已經送達，因此不需要（也不應該）再送一次。
  // -------------------------------------------------------------------------
  {
    let postAttempts = 0;
    const taskId = 'task-uncertain-comment';
    const comments: Array<{ comment_id: string; task_id: string; user_id: string; content: string; created_at: string }> = [];
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'POST') {
        postAttempts += 1;
        readJsonBody(req)
          .then((body) => {
            comments.push({
              comment_id: `comment-${postAttempts}`,
              task_id: taskId,
              user_id: 'user01',
              content: body.content,
              created_at: '2026-07-22T00:00:00.000Z',
            });
            req.socket.destroy(); // 寫入完成，但在回應送出前中斷——結果對 caller 而言不確定
          })
          .catch(() => req.socket.destroy());
        return;
      }
      if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(comments));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 2, retryDelayMs: 5 });
      await assert.rejects(
        () => client.postCommentOnce(taskId, '【SYSTEM完成】 @user09 ...', 'complete:task-uncertain-comment:v1'),
        (err: unknown) => {
          assert.ok(err instanceof UncertainMutationError, '結果不確定時必須拋出 UncertainMutationError，而不是靜默重試');
          assert.ok((err as Error).cause, 'UncertainMutationError 必須保留 cause');
          return true;
        },
      );
      assert.strictEqual(postAttempts, 1, 'api.ts 不得在結果不確定時自動重送同一個 POST');

      const landed = await client.listComments(taskId);
      assert.strictEqual(landed.length, 1, 'readback 必須看到伺服器其實已經處理過的那次留言');
      assert.strictEqual(landed[0].content, '【SYSTEM完成】 @user09 ...');
    } finally {
      await close();
    }
  }

  // -------------------------------------------------------------------------
  // postCommentOnce：不確定結果的另一條路徑——收到明確的 5xx response（不是連線層
  // 失敗）。cause 的結構必須跟 safeRequest 的 5xx-exhaustion path 一致：
  // { status, body }，而不是把 body 包成一個丟失狀態碼的 Error。
  // -------------------------------------------------------------------------
  {
    const taskId = 'task-uncertain-comment-5xx';
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'POST') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end('db unavailable');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 2, retryDelayMs: 5 });
      await assert.rejects(
        () => client.postCommentOnce(taskId, 'content', 'action-key-5xx'),
        (err: unknown) => {
          assert.ok(err instanceof UncertainMutationError, '5xx 也必須是 UncertainMutationError，不是盲目重送');
          const cause = (err as Error).cause as { status: number; body: string };
          assert.strictEqual(cause.status, 503, 'cause 必須帶結構化的 status，而不是包進 Error message 裡');
          assert.strictEqual(cause.body, 'db unavailable');
          return true;
        },
      );
    } finally {
      await close();
    }
  }

  // -------------------------------------------------------------------------
  // patchTaskField：結果不確定時，同樣先 readback 而非盲目重送 PATCH。
  // -------------------------------------------------------------------------
  {
    let patchAttempts = 0;
    const taskId = 'task-uncertain-patch';
    let boardStatus: TaskStatus = 'Todo';
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === `/api/tasks/${taskId}` && req.method === 'PATCH') {
        patchAttempts += 1;
        readJsonBody(req)
          .then((body) => {
            boardStatus = body.status; // 伺服器端其實已經套用了這次 mutation
            req.socket.destroy(); // 送出 response 前中斷，模擬結果不確定
          })
          .catch(() => req.socket.destroy());
        return;
      }
      if (req.url === `/api/tasks/${taskId}` && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            task_id: taskId,
            workspace_id: MAIN_WORKSPACE_ID,
            title: 'PATCH uncertain fixture',
            status: boardStatus,
            assignee_id: null,
            due_at: null,
            version: 2,
            updated_at: '2026-07-22T00:00:00.000Z',
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 2, retryDelayMs: 5 });
      await assert.rejects(
        () => client.patchTaskField(taskId, 'status', 'Doing'),
        (err: unknown) => {
          assert.ok(err instanceof UncertainMutationError, 'PATCH 結果不確定時必須拋出 UncertainMutationError');
          return true;
        },
      );
      assert.strictEqual(patchAttempts, 1, 'api.ts 不得在結果不確定時自動重送同一個 PATCH');

      const readback = await client.getTask(taskId);
      assert.strictEqual(readback.status, 'Doing', 'readback 必須看到伺服器其實已經套用過的那次 mutation');
    } finally {
      await close();
    }
  }

  // -------------------------------------------------------------------------
  // patchTaskField：不確定結果的另一條路徑——收到明確的 5xx response。cause 的
  // 結構必須跟 safeRequest 的 5xx-exhaustion path 一致：{ status, body }。
  // -------------------------------------------------------------------------
  {
    const taskId = 'task-uncertain-patch-5xx';
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === `/api/tasks/${taskId}` && req.method === 'PATCH') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('internal error');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 2, retryDelayMs: 5 });
      await assert.rejects(
        () => client.patchTaskField(taskId, 'status', 'Doing'),
        (err: unknown) => {
          assert.ok(err instanceof UncertainMutationError, '5xx 也必須是 UncertainMutationError，不是盲目重送');
          const cause = (err as Error).cause as { status: number; body: string };
          assert.strictEqual(cause.status, 500, 'cause 必須帶結構化的 status，而不是包進 Error message 裡');
          assert.strictEqual(cause.body, 'internal error');
          return true;
        },
      );
    } finally {
      await close();
    }
  }

  // -------------------------------------------------------------------------
  // 單一 workspace 失敗不會阻擋另一個 workspace 的 action：兩個獨立呼叫互不影響。
  // -------------------------------------------------------------------------
  {
    const okWorkspace = CANONICAL_WORKSPACE_ID;
    const brokenWorkspace = MAIN_WORKSPACE_ID;
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === `/api/workspaces/${brokenWorkspace}/tasks`) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      if (req.url === `/api/workspaces/${okWorkspace}/tasks`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              task_id: 't1',
              workspace_id: okWorkspace,
              title: 'ok task',
              status: 'Todo',
              assignee_id: null,
              due_at: null,
              version: 1,
              updated_at: null,
            },
          ]),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 0, retryDelayMs: 5 });
      // 5xx 重試耗盡現在直接從 safeRequest 內部拋出（帶 cause），listWorkspaceTasks
      // 自己的 status 檢查已經來不及執行——訊息格式因此變成 safeRequest 那種通用格式。
      await assert.rejects(
        () => client.listWorkspaceTasks(brokenWorkspace),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /HTTP 500/);
          assert.ok(err.cause, '5xx 重試耗盡的 error 必須保留 cause');
          return true;
        },
      );
      // 壞掉的 workspace 呼叫失敗，不影響對另一個 workspace 的獨立呼叫。
      const okTasks = await client.listWorkspaceTasks(okWorkspace);
      assert.strictEqual(okTasks.length, 1);
      assert.strictEqual(okTasks[0].taskId, 't1');
    } finally {
      await close();
    }
  }

  // -------------------------------------------------------------------------
  // cookie jar：login 後的 Set-Cookie 必須被帶到後續請求；沒有 cookie 就 401。
  // -------------------------------------------------------------------------
  {
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === '/api/auth/login' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'tt_session=xyz789; HttpOnly; Path=/' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/api/notifications' && req.method === 'GET') {
        const cookie = req.headers.cookie ?? '';
        if (!cookie.includes('tt_session=xyz789')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthenticated' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 0, retryDelayMs: 5 });
      await client.login('user01@test.local', 'whatever');
      const notifications = await client.listNotifications();
      assert.deepStrictEqual(notifications, [], 'login 後的 cookie 必須被帶到後續請求，否則會 401');
    } finally {
      await close();
    }
  }
}

// =============================================================================
// git.ts：task 隔離用的 Git worktree／branch helper（真實 git 操作，全部在
// os.tmpdir() 底下的假 repo 進行——絕不能碰到本專案自己的 repo／worktree）。
// =============================================================================

async function runGitTests(): Promise<void> {
  const ACTIVE_TASK_ID = CUTOVER_TASKS.activeReview.taskId; // 938aa035-5f96-4908-b28b-876fa4735061
  const QUEUED_TASK_ID = CUTOVER_TASKS.queuedReview.taskId; // 6384b6f4-f92f-45a2-a5e1-133f04f76372

  const repoRoot = mkdtempSync(join(tmpdir(), 'sim-production-git-'));
  const g = (args: string[], cwd: string = repoRoot): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  try {
    // -------------------------------------------------------------------------
    // 假 repo 初始化：一個真實的 initial commit 當 base SHA。
    // -------------------------------------------------------------------------
    g(['init', '-q', '-b', 'master']);
    g(['config', 'user.email', 'sim-git-test@example.com']);
    g(['config', 'user.name', 'Sim Git Test']);
    writeFileSync(join(repoRoot, 'README.md'), 'root\n');
    g(['add', 'README.md']);
    g(['commit', '-q', '-m', 'init']);
    const baseSha0 = g(['rev-parse', 'HEAD']);

    // -------------------------------------------------------------------------
    // taskId 必須先過安全字元檢查：不能靠 `/` 或 `..` 逃逸出 sim-work/tasks/ 底下，
    // 例如把 repo root 本身或共用父目錄悄悄冒充成「隔離」worktree。
    // 這裡刻意放在任何合法 worktree 建立「之前」，才能證明拒絕時真的零副作用
    // （沒有留下任何 sim-work 目錄）。
    // -------------------------------------------------------------------------
    assert.strictEqual(existsSync(join(repoRoot, 'sim-work')), false, '測試一開始不應該有任何 sim-work 目錄');
    for (const unsafeTaskId of ['../..', '..', 'foo/bar', '/etc/passwd', '']) {
      assert.throws(
        () => taskBranchName(unsafeTaskId),
        /unsafe taskId/i,
        `taskBranchName 必須拒絕不安全的 taskId: ${JSON.stringify(unsafeTaskId)}`,
      );
      assert.throws(
        () => taskWorktreePath(repoRoot, unsafeTaskId),
        /unsafe taskId/i,
        `taskWorktreePath 必須拒絕不安全的 taskId: ${JSON.stringify(unsafeTaskId)}`,
      );
    }
    // 逐字重現 reviewer 回報的兩個具體案例：`../..` 會讓 sim-work/tasks/../.. 抵銷成
    // repoRoot 本身；`..` 會抵銷成共用的 sim-work 父目錄。兩者都必須被 ensureTaskWorktree
    // 明確拒絕，絕不能把它們當成合法的「隔離」worktree 回傳（例如悄悄回報 repo root
    // 自己的 HEAD 當作這個 task 的 headSha）。
    await assert.rejects(
      () => ensureTaskWorktree(repoRoot, '../..', baseSha0),
      /unsafe taskId/i,
      'ensureTaskWorktree(taskId="../..") 絕不能把 repo root 本身悄悄當成隔離 worktree 回傳',
    );
    await assert.rejects(
      () => ensureTaskWorktree(repoRoot, '..', baseSha0),
      /unsafe taskId/i,
      'ensureTaskWorktree(taskId="..") 絕不能把共用父目錄悄悄當成隔離 worktree 回傳',
    );
    assert.strictEqual(
      existsSync(join(repoRoot, 'sim-work')),
      false,
      '不安全的 taskId 全部被拒絕後，不得留下任何 sim-work 相關目錄或副作用',
    );

    // -------------------------------------------------------------------------
    // taskBranchName / taskWorktreePath：合法 taskId 的純字串 helper。
    // -------------------------------------------------------------------------
    assert.strictEqual(taskBranchName(ACTIVE_TASK_ID), `sim/task/${ACTIVE_TASK_ID}`);
    assert.strictEqual(taskWorktreePath(repoRoot, ACTIVE_TASK_ID), join(repoRoot, 'sim-work', 'tasks', ACTIVE_TASK_ID));

    // -------------------------------------------------------------------------
    // ensureTaskWorktree(activeReview, baseSha0)：真實 worktree + branch，
    // 且對 baseSha0 的初始 diff 必須為空。
    // -------------------------------------------------------------------------
    const wtA = await ensureTaskWorktree(repoRoot, ACTIVE_TASK_ID, baseSha0);
    assert.strictEqual(wtA.taskId, ACTIVE_TASK_ID);
    assert.strictEqual(wtA.branch, `sim/task/${ACTIVE_TASK_ID}`);
    assert.strictEqual(wtA.path, taskWorktreePath(repoRoot, ACTIVE_TASK_ID));
    assert.ok(existsSync(wtA.path), 'worktree 目錄必須真的被建立');
    assert.ok(existsSync(join(wtA.path, '.git')), '必須是真正的 linked worktree（有 .git 檔案）');
    assert.strictEqual(g(['rev-parse', '--abbrev-ref', 'HEAD'], wtA.path), wtA.branch, '必須 checkout 到 task branch 上');
    assert.strictEqual(wtA.headSha, baseSha0, '剛建立的 worktree HEAD 必須等於 baseSha');
    assert.strictEqual(g(['diff', baseSha0, 'HEAD'], wtA.path), '', '新 worktree 對 baseSha 的初始 diff 必須為空');

    // -------------------------------------------------------------------------
    // 解除依賴前：queued task（6384b6f4）必須完全沒有 branch／worktree。
    // -------------------------------------------------------------------------
    const queuedBranch = taskBranchName(QUEUED_TASK_ID);
    const queuedPath = taskWorktreePath(repoRoot, QUEUED_TASK_ID);
    assert.strictEqual(existsSync(queuedPath), false, 'queued task 解除依賴前不得有 worktree 目錄');
    assert.strictEqual(g(['branch', '--list', queuedBranch]), '', 'queued task 解除依賴前不得有 branch');
    const worktreeListBefore = g(['worktree', 'list', '--porcelain']);
    assert.ok(!worktreeListBefore.includes(queuedPath), 'queued task 解除依賴前不得出現在 worktree 清單裡');

    // -------------------------------------------------------------------------
    // collectTaskChanges / validateTaskChanges：對每一種被拒絕的情境做獨立、
    // 真實的驗證（每次只放一個受測路徑，驗證完立刻清掉，避免互相汙染）。
    // -------------------------------------------------------------------------
    const allowedPrefixes = ['feature/'];

    const onlyChangeNamed = (changes: ChangedPath[], path: string): ChangedPath => {
      const found = changes.find((c) => c.path === path);
      assert.ok(found, `collectTaskChanges 必須回報 ${path}`);
      return found!;
    };

    // .jar-* 暫存檔必須被拒絕。
    {
      writeFileSync(join(wtA.path, '.jar-staging'), 'x');
      const changes = await collectTaskChanges(wtA.path);
      const change = onlyChangeNamed(changes, '.jar-staging');
      assert.throws(() => validateTaskChanges([change], allowedPrefixes), /\.jar-/, '.jar-* 暫存檔必須被拒絕');
      rmSync(join(wtA.path, '.jar-staging'));
    }

    // .tmp-* 暫存檔必須被拒絕。
    {
      writeFileSync(join(wtA.path, '.tmp-staging'), 'x');
      const changes = await collectTaskChanges(wtA.path);
      const change = onlyChangeNamed(changes, '.tmp-staging');
      assert.throws(() => validateTaskChanges([change], allowedPrefixes), /\.tmp-/, '.tmp-* 暫存檔必須被拒絕');
      rmSync(join(wtA.path, '.tmp-staging'));
    }

    // data/ 目錄必須被拒絕。
    {
      execFileSync('mkdir', ['-p', join(wtA.path, 'data')]);
      writeFileSync(join(wtA.path, 'data', 'seed.json'), '{}');
      const changes = await collectTaskChanges(wtA.path);
      const change = onlyChangeNamed(changes, 'data/seed.json');
      assert.throws(() => validateTaskChanges([change], allowedPrefixes), /data/, 'data/ 底下的檔案必須被拒絕');
      rmSync(join(wtA.path, 'data'), { recursive: true });
    }

    // node_modules 必須被拒絕。
    {
      execFileSync('mkdir', ['-p', join(wtA.path, 'node_modules', 'left-pad')]);
      writeFileSync(join(wtA.path, 'node_modules', 'left-pad', 'index.js'), '');
      const changes = await collectTaskChanges(wtA.path);
      const change = onlyChangeNamed(changes, 'node_modules/left-pad/index.js');
      assert.throws(() => validateTaskChanges([change], allowedPrefixes), /node_modules/, 'node_modules 必須被拒絕');
      rmSync(join(wtA.path, 'node_modules'), { recursive: true });
    }

    // 宣告 scope 以外的路徑必須被拒絕。
    {
      writeFileSync(join(wtA.path, 'out-of-scope.txt'), 'x');
      const changes = await collectTaskChanges(wtA.path);
      const change = onlyChangeNamed(changes, 'out-of-scope.txt');
      assert.throws(
        () => validateTaskChanges([change], allowedPrefixes),
        /allowedPrefixes|scope/,
        '不在 allowedPrefixes 內的路徑必須被拒絕',
      );
      rmSync(join(wtA.path, 'out-of-scope.txt'));
    }

    // 未被明確允許的新 symlink 必須被拒絕（即使 target 在 allowedPrefixes 底下）。
    {
      execFileSync('mkdir', ['-p', join(wtA.path, 'feature')]);
      writeFileSync(join(wtA.path, 'feature', 'real-file.txt'), 'x');
      symlinkSync('real-file.txt', join(wtA.path, 'feature', 'sneaky-link'));
      const changes = await collectTaskChanges(wtA.path);
      const linkChange = onlyChangeNamed(changes, 'feature/sneaky-link');
      assert.strictEqual(linkChange.isSymlink, true, 'collectTaskChanges 必須正確偵測 symlink');
      assert.throws(() => validateTaskChanges([linkChange], allowedPrefixes), /symlink/, '新 symlink 必須被拒絕');
      rmSync(join(wtA.path, 'feature', 'sneaky-link'));
      rmSync(join(wtA.path, 'feature', 'real-file.txt'));
    }

    // 正面案例：在 allowedPrefixes 底下的一般新檔案必須通過驗證，不拋錯。
    {
      execFileSync('mkdir', ['-p', join(wtA.path, 'feature')]);
      writeFileSync(join(wtA.path, 'feature', 'foo.txt'), 'hello\n');
      const changes = await collectTaskChanges(wtA.path);
      const change = onlyChangeNamed(changes, 'feature/foo.txt');
      assert.strictEqual(change.status, 'untracked');
      assert.strictEqual(change.isSymlink, false);
      assert.doesNotThrow(() => validateTaskChanges([change], allowedPrefixes), '合法範圍內的新檔案不應被拒絕');
    }

    // -------------------------------------------------------------------------
    // commitTaskChanges：只 add 已驗證路徑（絕不 git add -A），且會跑
    // `git diff --cached --check`。
    // -------------------------------------------------------------------------

    // 先證明「不在驗證清單內的 untracked 檔案」不會被 commitTaskChanges 掃進去。
    writeFileSync(join(wtA.path, 'unrelated-untracked.txt'), 'should stay untracked\n');

    const headShaAfterCommit = await commitTaskChanges(wtA.path, ACTIVE_TASK_ID, 'feat(sim): add foo', ['feature/foo.txt']);
    assert.notStrictEqual(headShaAfterCommit, baseSha0, 'commitTaskChanges 必須產生一個新 commit');
    assert.strictEqual(g(['rev-parse', 'HEAD'], wtA.path), headShaAfterCommit);

    const commitMessage = g(['log', '-1', '--format=%B'], wtA.path);
    assert.ok(commitMessage.includes(`Task-Id: ${ACTIVE_TASK_ID}`), 'commit message 必須帶 Task-Id trailer');
    assert.ok(commitMessage.startsWith('feat(sim): add foo'), 'commit message 必須以傳入的 title 開頭');

    const statusAfterCommit = g(['status', '--porcelain'], wtA.path);
    assert.ok(
      statusAfterCommit.includes('unrelated-untracked.txt'),
      'commitTaskChanges 絕不能呼叫 git add -A：未被驗證的 untracked 檔案必須仍然是 untracked',
    );
    rmSync(join(wtA.path, 'unrelated-untracked.txt'));

    // git diff --cached --check：故意製造 trailing whitespace，證明真的有跑這個檢查、
    // 而且檢查失敗時不得建立 commit。
    {
      const headBeforeBadCommit = g(['rev-parse', 'HEAD'], wtA.path);
      writeFileSync(join(wtA.path, 'feature', 'whitespace.txt'), 'hello   \n');
      await assert.rejects(
        () => commitTaskChanges(wtA.path, ACTIVE_TASK_ID, 'feat(sim): trailing whitespace', ['feature/whitespace.txt']),
        /whitespace|check/i,
        'git diff --cached --check 抓到 trailing whitespace 時必須拒絕 commit',
      );
      assert.strictEqual(g(['rev-parse', 'HEAD'], wtA.path), headBeforeBadCommit, '檢查失敗不得留下新 commit');
      // 清掉這次失敗嘗試留下的 staged/untracked 檔案，避免汙染後續斷言。
      g(['reset', '--hard', headBeforeBadCommit], wtA.path);
      rmSync(join(wtA.path, 'feature', 'whitespace.txt'), { force: true });
    }

    // commitTaskChanges 也必須拒絕新 symlink，即使呼叫端沒有先跑 validateTaskChanges
    // （defense-in-depth：直接對 worktree 上的真實檔案重新做一次 symlink 檢查）。
    {
      const headBeforeSymlinkAttempt = g(['rev-parse', 'HEAD'], wtA.path);
      symlinkSync('foo.txt', join(wtA.path, 'feature', 'sneaky-commit-link'));
      await assert.rejects(
        () => commitTaskChanges(wtA.path, ACTIVE_TASK_ID, 'feat(sim): sneaky symlink', ['feature/sneaky-commit-link']),
        /symlink/i,
        'commitTaskChanges 必須拒絕 commit 新 symlink，即使呼叫端沒先驗證過',
      );
      assert.strictEqual(g(['rev-parse', 'HEAD'], wtA.path), headBeforeSymlinkAttempt, '拒絕的 symlink 不得留下新 commit');
      rmSync(join(wtA.path, 'feature', 'sneaky-commit-link'));
    }

    // -------------------------------------------------------------------------
    // ensureTaskWorktree 冪等重用（同一 taskId 再次呼叫）：
    // 1) 傳入「真的是既有 branch 祖先」的 baseSha 必須成功，且 headSha 反映目前真正的
    //    HEAD（不是舊快照），baseSha 如實回報。
    // 2) 傳入「跟既有 branch 不相容」的新 baseSha（不是它的祖先——例如 master 之後
    //    獨立前進出來的另一個 commit）必須被明確拒絕，絕不能悄悄回傳這個錯誤的
    //    baseSha 冒充成真相（這正是 reviewer 回報的「base-reuse 說謊」問題）。
    // -------------------------------------------------------------------------
    {
      const wtAAgain = await ensureTaskWorktree(repoRoot, ACTIVE_TASK_ID, baseSha0);
      assert.strictEqual(wtAAgain.path, wtA.path, '冪等重用必須回傳同一個 worktree 路徑');
      assert.strictEqual(
        wtAAgain.headSha,
        headShaAfterCommit,
        '重用既有 worktree 時，headSha 必須反映目前真正的 HEAD（commitTaskChanges 之後的那個 commit），不是舊快照',
      );
      assert.strictEqual(wtAAgain.baseSha, baseSha0, '傳入的 baseSha 若真的是既有 branch 的祖先，可以如實回報');

      // 讓 master 獨立前進一個跟 activeReview branch 完全無關的 commit，模擬「這個
      // baseSha 對這個既有 branch 而言不相容」的情境（它不是這個 branch 目前 HEAD 的祖先）。
      writeFileSync(join(repoRoot, 'unrelated-master-advance.txt'), 'x');
      g(['add', 'unrelated-master-advance.txt']);
      g(['commit', '-q', '-m', 'advance master independently of task branch']);
      const unrelatedLaterSha = g(['rev-parse', 'HEAD']);

      await assert.rejects(
        () => ensureTaskWorktree(repoRoot, ACTIVE_TASK_ID, unrelatedLaterSha),
        /base/i,
        '同一 taskId 若傳入與既有 branch 不相容的新 baseSha，ensureTaskWorktree 必須明確拒絕，不能悄悄回傳錯誤的 baseSha',
      );
    }

    // -------------------------------------------------------------------------
    // 模擬「938aa035 的 accepted merge 落地到 master」：把 task branch 合回 master，
    // 產生一個新的 master SHA。
    // -------------------------------------------------------------------------
    g(['merge', '--no-ff', wtA.branch, '-m', `merge ${ACTIVE_TASK_ID}`]);
    const newMasterSha = g(['rev-parse', 'HEAD']);
    assert.notStrictEqual(newMasterSha, baseSha0, '合併後 master 必須前進');
    // `git merge-base --is-ancestor` 用 exit code 表達結果：非 0 會讓 execFileSync 直接
    // throw，所以能無異常執行到下一行，就代表 headShaAfterCommit 確實是新 master 的 ancestor。
    g(['merge-base', '--is-ancestor', headShaAfterCommit, 'HEAD']);

    // -------------------------------------------------------------------------
    // 解除依賴後：queued task 必須以新 master 為 base，且不能共用 938aa035 的 branch。
    // -------------------------------------------------------------------------
    const wtB = await ensureTaskWorktree(repoRoot, QUEUED_TASK_ID, newMasterSha);
    assert.strictEqual(wtB.branch, queuedBranch);
    assert.notStrictEqual(wtB.branch, wtA.branch, 'queued task 不能共用 activeReview 的 branch');
    assert.ok(existsSync(wtB.path));
    assert.strictEqual(wtB.headSha, newMasterSha, '新 worktree 的 HEAD 必須等於新 master SHA');
    assert.strictEqual(g(['diff', newMasterSha, 'HEAD'], wtB.path), '', '新 worktree 對新 base 的初始 diff 必須為空');
    assert.ok(
      existsSync(join(wtB.path, 'feature', 'foo.txt')),
      'queued task 的新 worktree 必須包含 938aa035 accepted merge 帶入的變更',
    );

    // -------------------------------------------------------------------------
    // ciCacheKey：純函式，三個輸入中任一個改變都必須改變 key；相同輸入永遠相同 key。
    // -------------------------------------------------------------------------
    const keyBase = ciCacheKey(baseSha0, headShaAfterCommit, ['npm test']);
    assert.strictEqual(ciCacheKey(baseSha0, headShaAfterCommit, ['npm test']), keyBase, '相同輸入必須得到相同 key');
    assert.notStrictEqual(ciCacheKey(newMasterSha, headShaAfterCommit, ['npm test']), keyBase, 'baseSha 不同必須改變 key');
    assert.notStrictEqual(ciCacheKey(baseSha0, newMasterSha, ['npm test']), keyBase, 'headSha 不同必須改變 key');
    assert.notStrictEqual(ciCacheKey(baseSha0, headShaAfterCommit, ['npm run build']), keyBase, 'commands 不同必須改變 key');
    assert.notStrictEqual(
      ciCacheKey(baseSha0, headShaAfterCommit, ['npm test', 'git diff --check']),
      keyBase,
      '完整 command list 必須被納入 key（不只是第一筆）',
    );

    // -------------------------------------------------------------------------
    // Command allowlist：7 種合法形式必須被接受；惡意／逾越範圍的字串必須被拒絕。
    // -------------------------------------------------------------------------
    assert.strictEqual(ALLOWED_VERIFICATION_COMMANDS.length, 5, '固定字串形式應有 5 個（另外 2 個是帶 <name> 的樣板）');
    for (const cmd of [
      'npx tsc --noEmit',
      'npx tsc -p sim/tsconfig.json --noEmit',
      'npx tsx src/foo.test.ts',
      'npx tsx sim/foo.test.ts',
      'npm test',
      'npm run build',
      'git diff --check',
    ]) {
      assert.strictEqual(isAllowedVerificationCommand(cmd), true, `必須允許：${cmd}`);
    }
    for (const cmd of [
      'rm -rf /',
      'git push',
      'npx tsc --noEmit --foo',
      'npx tsx src/../../etc/passwd.test.ts',
      'npx tsx src/foo.test.ts; rm -rf /',
      'npx tsx sim/foo.test.ts && curl evil.example.com',
      'npx tsx sim/foo/bar.test.ts', // 目前規格只允許單一層 <name>，多層路徑必須被拒絕
      '',
    ]) {
      assert.strictEqual(isAllowedVerificationCommand(cmd), false, `必須拒絕：${cmd}`);
    }

    // -------------------------------------------------------------------------
    // 舊 branch（sim/user02..sim/user06）只能進 manifest：git.ts 自己的原始碼
    // 絕不能提到這些字面字串；taskBranchName 的輸出也絕不會是這種形式。
    // -------------------------------------------------------------------------
    const gitTsSource = readFileSync(join(__dirname, 'production', 'git.ts'), 'utf8');
    const legacyBranches = ['sim/user02', 'sim/user03', 'sim/user04', 'sim/user05', 'sim/user06'];
    for (const legacy of legacyBranches) {
      assert.ok(!gitTsSource.includes(legacy), `git.ts 原始碼不得包含舊 branch 字面字串：${legacy}`);
    }
    for (const legacyUserId of ['user02', 'user03', 'user04', 'user05', 'user06']) {
      const produced = taskBranchName(legacyUserId);
      assert.ok(
        !legacyBranches.includes(produced),
        `taskBranchName 不得產生舊 branch 名稱本身：${produced}`,
      );
      assert.strictEqual(produced, `sim/task/${legacyUserId}`, 'taskBranchName 永遠是 sim/task/<taskId> 格式');
    }
  } finally {
    // -------------------------------------------------------------------------
    // 清理：整個假 repo（含所有 linked worktree）都在這個臨時目錄底下，
    // 直接刪除整個目錄即可，不會影響本專案自己的 repo／worktree。
    // -------------------------------------------------------------------------
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// =============================================================================
// agent.ts：Owner／Member session 執行層——只信獨立驗證過的副作用，不信 exit code
// 或 runner 自稱的 summary／blocker（真實 git 操作，全部在 os.tmpdir() 底下的假 repo
// 進行）。
// =============================================================================

async function runAgentTests(): Promise<void> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'sim-production-agent-'));
  const g = (args: string[], cwd: string = repoRoot): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  try {
    g(['init', '-q', '-b', 'master']);
    g(['config', 'user.email', 'sim-agent-test@example.com']);
    g(['config', 'user.name', 'Sim Agent Test']);
    writeFileSync(join(repoRoot, 'README.md'), 'root\n');
    g(['add', 'README.md']);
    g(['commit', '-q', '-m', 'init']);
    const baseSha0 = g(['rev-parse', 'HEAD']);

    const allowedPrefixes = ['feature/'];

    function makeOutput(overrides: Partial<MemberSessionOutput> = {}): MemberSessionOutput {
      return {
        summary: overrides.summary ?? 'did the work',
        changedPaths: overrides.changedPaths ?? [],
        verificationCommands: overrides.verificationCommands ?? [],
        blocker: overrides.blocker ?? null,
      };
    }

    function makeRunner(exitCode: number, output: MemberSessionOutput): MemberSessionRunner {
      return async () => ({ exitCode, output });
    }

    function makeVerify(result: { exitCode: number } = { exitCode: 0 }): {
      run: (command: string, worktreePath: string) => Promise<{ exitCode: number; output: string }>;
      calls: string[];
    } {
      const calls: string[] = [];
      return {
        calls,
        run: async (command: string) => {
          calls.push(command);
          return { exitCode: result.exitCode, output: '' };
        },
      };
    }

    function makeDriverActions(opts: {
      reviewResult?: TaskStatus | null;
      commentResult?: { commentId: string } | null;
    }): { actions: MemberSessionDriverActions; counters: { reviewCalls: number; commentCalls: number } } {
      const counters = { reviewCalls: 0, commentCalls: 0 };
      const actions: MemberSessionDriverActions = {
        confirmReviewTransition: async () => {
          counters.reviewCalls += 1;
          return opts.reviewResult ?? null;
        },
        createSummaryComment: async () => {
          counters.commentCalls += 1;
          return opts.commentResult ?? null;
        },
      };
      return { actions, counters };
    }

    // -------------------------------------------------------------------------
    // 宣告的 verification command 不在 allowlist 上：整批拒絕，不執行任何 command，
    // 也不呼叫 driver 的任何副作用。
    // -------------------------------------------------------------------------
    {
      const taskId = 'agent-fixture-disallowed-cmd';
      const wt = await ensureTaskWorktree(repoRoot, taskId, baseSha0);
      const verify = makeVerify();
      const driver = makeDriverActions({});
      const result = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: null,
        runner: makeRunner(0, makeOutput({ verificationCommands: ['rm -rf /'] })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });
      assert.strictEqual(result.outcome, 'retryable_failure', '宣告不在 allowlist 上的 verification command 必須整批拒絕');
      assert.match(result.evidence.rejectedReason ?? '', /allowlist/);
      assert.strictEqual(result.evidenceChanged, false);
      assert.strictEqual(verify.calls.length, 0, '被拒絕的 session 不應該執行任何 verification command');
      assert.strictEqual(driver.counters.reviewCalls, 0, '被拒絕的 session 不應該呼叫 driver 的 Review readback');
      assert.strictEqual(driver.counters.commentCalls, 0, '被拒絕的 session 不應該呼叫 driver 建立摘要留言');
    }

    // -------------------------------------------------------------------------
    // verificationCommandAllowlist 是真正的 per-call 執行邊界，不是只餵給 prompt
    // context 的裝飾欄位：宣告的指令即使在 git.ts 的全域 allowlist 上，只要不在這個
    // task 自己宣告的（更窄的）allowlist 裡，一樣要被拒絕。
    // -------------------------------------------------------------------------
    {
      const taskId = 'agent-fixture-declared-allowlist-narrower';
      const wt = await ensureTaskWorktree(repoRoot, taskId, baseSha0);
      const verify = makeVerify();
      const driver = makeDriverActions({});
      const result = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        // 這個 task 宣告只允許 'npm test'——'npx tsc --noEmit' 雖然在全域 allowlist
        // 上，但沒有落在這個 task 自己宣告的清單裡，必須被拒絕。
        verificationCommandAllowlist: ['npm test'],
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: null,
        runner: makeRunner(0, makeOutput({ verificationCommands: ['npx tsc --noEmit'] })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });
      assert.strictEqual(result.outcome, 'retryable_failure', '不在這個 task 自己宣告的 verificationCommandAllowlist 裡的指令必須被拒絕，即使它在全域 allowlist 上');
      assert.match(result.evidence.rejectedReason ?? '', /declared verificationCommandAllowlist/);
      assert.strictEqual(verify.calls.length, 0, '被拒絕的 session 不應該執行任何 verification command');

      // 對照組：宣告的指令同時落在全域 allowlist 與這個 task 自己的宣告清單裡——
      // 正常通過這一關，且真的往下執行到 verification 這一步（需要真實 diff 才會
      // 走到那裡，所以這裡先製造一筆真實變更）。
      execFileSync('mkdir', ['-p', join(wt.path, 'feature')]);
      writeFileSync(join(wt.path, 'feature', 'declared-allowlist-ok.txt'), 'hello\n');
      const okResult = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        verificationCommandAllowlist: ['npm test'],
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: null,
        runner: makeRunner(0, makeOutput({ verificationCommands: ['npm test'] })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });
      assert.strictEqual(okResult.evidence.rejectedReason, null, 'declared verificationCommandAllowlist 邊界不應該誤擋合法指令');
      assert.ok(verify.calls.includes('npm test'), '宣告的指令同時在全域與 per-task allowlist 內時，必須真的被送去執行（沒有在這一關被短路）');
    }

    // -------------------------------------------------------------------------
    // false-success fixture 1：exit 0，但沒有真實 diff／comment／status 變更——
    // 不管 runner 自稱多成功，都必須是 no_change。
    // -------------------------------------------------------------------------
    {
      const taskId = 'agent-fixture-false-success-noop';
      const wt = await ensureTaskWorktree(repoRoot, taskId, baseSha0);
      const verify = makeVerify();
      const driver = makeDriverActions({}); // reviewResult/commentResult 都缺席 -> null
      const result = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: null,
        runner: makeRunner(0, makeOutput({ summary: '（自稱）已完成' })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });
      assert.strictEqual(result.outcome, 'no_change', 'exit 0 但沒有真實 diff／comment／status 變更時，不得回傳 progressed');
      assert.strictEqual(result.evidenceChanged, false);
      assert.strictEqual(result.evidence.commitSha, null);
      assert.strictEqual(result.evidence.reviewTransitionConfirmed, false);
      assert.strictEqual(result.evidence.summaryCommentId, null);
    }

    // -------------------------------------------------------------------------
    // false-success fixture 2：產生有效 diff 後 exit 1。這裡刻意拆成兩個對照組，
    // 把「exit code 只供診斷」的雙向意義都證明到：
    //   (a) 證據齊全（commit+verification PASS+summary comment+Review transition）
    //       時，即使 exitCode=1 仍然是 progressed——exit code 不會讓它變得更糟。
    //   (b) 證據不齊全（缺 Review transition）時，即使有真實 commit，也不是
    //       progressed，但同樣不會因為 exitCode=1 被誤判成比 no_change 更差的
    //       retryable_failure——exit code 也不會讓它變得更好或更壞，一切只看證據。
    // -------------------------------------------------------------------------
    {
      const taskId = 'agent-fixture-exit1-full-evidence';
      const wt = await ensureTaskWorktree(repoRoot, taskId, baseSha0);
      execFileSync('mkdir', ['-p', join(wt.path, 'feature')]);
      writeFileSync(join(wt.path, 'feature', 'exit1-full.txt'), 'hello\n');

      const verify = makeVerify({ exitCode: 0 });
      const driver = makeDriverActions({ reviewResult: 'Review', commentResult: { commentId: 'comment-full-1' } });
      const result = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: null,
        runner: makeRunner(1, makeOutput({ summary: 'implemented X', verificationCommands: ['npm test'] })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(
        result.outcome,
        'progressed',
        'exit code 只供診斷：四項證據齊全時，即使 exitCode=1 仍必須是 progressed',
      );
      assert.strictEqual(result.evidenceChanged, true);
      assert.ok(result.evidence.commitSha, '必須產生真實 commit');
      assert.strictEqual(g(['rev-parse', 'HEAD'], wt.path), result.evidence.commitSha);
      const msg = g(['log', '-1', '--format=%B'], wt.path);
      assert.ok(msg.includes(`Task-Id: ${taskId}`), '真實 commit 必須帶 Task-Id trailer（由 commitTaskChanges 蓋章）');
    }
    {
      const taskId = 'agent-fixture-exit1-partial-evidence';
      const wt = await ensureTaskWorktree(repoRoot, taskId, baseSha0);
      execFileSync('mkdir', ['-p', join(wt.path, 'feature')]);
      writeFileSync(join(wt.path, 'feature', 'exit1-partial.txt'), 'hello\n');

      const verify = makeVerify({ exitCode: 0 });
      // driver 沒有確認 Review transition（reviewResult 缺席 -> null）。
      const driver = makeDriverActions({ commentResult: { commentId: 'comment-partial-1' } });
      const result = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: null,
        runner: makeRunner(1, makeOutput({ summary: 'partially implemented', verificationCommands: ['npm test'] })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });

      assert.strictEqual(
        result.outcome,
        'no_change',
        '有效 diff + exit 1，但缺 Review transition 證據：不得是 progressed，也不因 exit code 被判定成更差的 retryable_failure',
      );
      assert.strictEqual(result.evidenceChanged, false);
      assert.ok(result.evidence.commitSha, '即使不是 progressed，真實 commit 仍然必須被獨立記錄下來');
    }

    // -------------------------------------------------------------------------
    // 真實 commit 落地，但宣告的 verification command 真的執行失敗（非 0 exit）：
    // 這次 session 邏輯上不可能是 progressed，driver 的 Doing -> Review readback／
    // 摘要留言必須完全不被呼叫——不能對已知壞掉的工作仍然觸發真正的 driver 副作用
    // （呼應 realChanges.length === 0 分支同樣的短路原則）。
    // -------------------------------------------------------------------------
    {
      const taskId = 'agent-fixture-verification-fails-skips-driver';
      const wt = await ensureTaskWorktree(repoRoot, taskId, baseSha0);
      execFileSync('mkdir', ['-p', join(wt.path, 'feature')]);
      writeFileSync(join(wt.path, 'feature', 'verification-fails.txt'), 'hello\n');

      const verify = makeVerify({ exitCode: 1 }); // 宣告的 verification command 真的跑，但失敗
      const driver = makeDriverActions({ reviewResult: 'Review', commentResult: { commentId: 'comment-should-not-happen' } });
      const result = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: null,
        runner: makeRunner(0, makeOutput({ summary: 'claims success', verificationCommands: ['npm test'] })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });

      assert.strictEqual(verify.calls.length, 1, 'verification command 必須真的被執行一次');
      assert.strictEqual(result.evidence.verificationPassed, false);
      assert.notStrictEqual(result.outcome, 'progressed', 'verification 已知失敗時絕不能是 progressed');
      assert.strictEqual(
        driver.counters.reviewCalls,
        0,
        'verification 已知失敗時，不得呼叫 driver 的 Doing -> Review readback（即使 driver 假設性地會回報 Review）',
      );
      assert.strictEqual(
        driver.counters.commentCalls,
        0,
        'verification 已知失敗時，不得呼叫 driver 建立摘要留言',
      );
      assert.strictEqual(result.evidence.reviewTransitionConfirmed, false);
      assert.strictEqual(result.evidence.summaryCommentId, null);
    }

    // -------------------------------------------------------------------------
    // false-success fixture 3（最清楚的一組）：member 有真實 commit，卻沒有
    // Doing -> Review 的 driver readback——不得是 progressed。
    // -------------------------------------------------------------------------
    {
      const taskId = 'agent-fixture-commit-no-review-transition';
      const wt = await ensureTaskWorktree(repoRoot, taskId, baseSha0);
      execFileSync('mkdir', ['-p', join(wt.path, 'feature')]);
      writeFileSync(join(wt.path, 'feature', 'commit-no-review.txt'), 'hello\n');

      const verify = makeVerify({ exitCode: 0 });
      const driver = makeDriverActions({ commentResult: { commentId: 'comment-no-review-1' } });
      const result = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: null,
        runner: makeRunner(0, makeOutput({ summary: 'implemented Y', verificationCommands: ['npm test'] })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });

      assert.strictEqual(result.outcome, 'no_change', 'member 有真實 commit，但 driver 沒有讀回 Doing -> Review：不得是 progressed');
      assert.strictEqual(result.evidenceChanged, false);
      assert.ok(result.evidence.commitSha, '真實 commit 必須存在（獨立於 outcome 判斷）');
      assert.strictEqual(result.evidence.reviewTransitionConfirmed, false);
      assert.strictEqual(driver.counters.reviewCalls, 1, '有真實 commit 時，必須真的呼叫 driver 的 Review readback（不是短路跳過）');
    }

    // -------------------------------------------------------------------------
    // false-success fixture 4：重複 blocker 文字不算新證據。
    // -------------------------------------------------------------------------
    {
      const taskId = 'agent-fixture-duplicate-blocker';
      const wt = await ensureTaskWorktree(repoRoot, taskId, baseSha0);
      const blockerText = '卡在缺少測試資料庫連線';
      const verify = makeVerify();
      const driver = makeDriverActions({});

      const result = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: blockerText, // 上一次 attempt 回報的 blocker 跟這次一模一樣
        runner: makeRunner(1, makeOutput({ blocker: blockerText })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });
      assert.strictEqual(result.outcome, 'no_change');
      assert.strictEqual(result.evidence.blockerRepeated, true, '重複的 blocker 文字必須被偵測為「不是新證據」');
      assert.strictEqual(result.evidenceChanged, false, '重複 blocker 不得被當成有進展餵給 recordMemberAttempt');

      // 對照組：blocker 文字不同——blockerRepeated 必須是 false，證明這個欄位真的
      //在比對文字內容，不是恆真或恆假的裝飾欄位；但 outcome／evidenceChanged 依然
      // 一樣（兩者只取決於是否真的有可驗證副作用，不取決於 blocker 文字是否換了）。
      const differentBlockerResult = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: '卡在別的原因',
        runner: makeRunner(1, makeOutput({ blocker: blockerText })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });
      assert.strictEqual(differentBlockerResult.outcome, 'no_change');
      assert.strictEqual(differentBlockerResult.evidence.blockerRepeated, false);
      assert.strictEqual(differentBlockerResult.evidenceChanged, false, 'evidenceChanged 只取決於是否真的 progressed，不取決於 blocker 文字是否換了');
    }

    // -------------------------------------------------------------------------
    // false-success fixture 5：試圖編輯程式的 Owner output 必須被拒絕。Owner 的
    // read-only 契約不是靠信任 runner 自稱，而是獨立檢查 worktree 目前真正的變更。
    // -------------------------------------------------------------------------
    {
      const taskId = 'agent-fixture-owner-edit-code';
      const wt = await ensureTaskWorktree(repoRoot, taskId, baseSha0);
      const reviewedHeadSha = wt.headSha;

      const ownerRunner: OwnerSessionRunner = async (context) => {
        // 模擬一個失控的 Owner-driving AI：明明被告知唯讀，卻直接編輯了 worktree 檔案。
        execFileSync('mkdir', ['-p', join(context.worktreePath, 'feature')]);
        writeFileSync(join(context.worktreePath, 'feature', 'sneaky-owner-edit.txt'), 'should not happen\n');
        return {
          exitCode: 0,
          decision: {
            action: 'accept',
            rationale: `looks good, accepting ${reviewedHeadSha}`,
            evidenceCommentIds: ['c1'],
          },
        };
      };

      const result = await runOwnerSession({
        taskId,
        acceptanceCriteria: 'n/a',
        comments: [],
        reviewedHeadSha,
        worktreePath: wt.path,
        runner: ownerRunner,
      });

      assert.strictEqual(result.valid, false, '試圖編輯程式的 Owner output 必須被拒絕，不能被當成有效決策');
      assert.strictEqual(result.decision, null);
      assert.match(result.rejectedReason ?? '', /read-only|edit/);

      rmSync(join(wt.path, 'feature'), { recursive: true, force: true });
    }

    // -------------------------------------------------------------------------
    // Owner accept 決策必須引用被驗收的 head SHA（OwnerDecision 沒有專屬欄位，
    // 用 rationale 是否提到這個 SHA 當引用證據）；其餘 action（例如 dispatch）
    // 不受此限制。
    // -------------------------------------------------------------------------
    {
      const taskId = 'agent-fixture-owner-accept-sha';
      const wt = await ensureTaskWorktree(repoRoot, taskId, baseSha0);
      const reviewedHeadSha = wt.headSha;

      const resultNoSha = await runOwnerSession({
        taskId,
        acceptanceCriteria: 'n/a',
        comments: [],
        reviewedHeadSha,
        worktreePath: wt.path,
        runner: async () => ({
          exitCode: 0,
          decision: { action: 'accept', rationale: 'looks fine to me', evidenceCommentIds: [] },
        }),
      });
      assert.strictEqual(resultNoSha.valid, false, 'accept 決策沒有引用被驗收的 head SHA 必須被拒絕');
      assert.strictEqual(resultNoSha.decision, null);

      const resultWithSha = await runOwnerSession({
        taskId,
        acceptanceCriteria: 'n/a',
        comments: [],
        reviewedHeadSha,
        worktreePath: wt.path,
        runner: async () => ({
          exitCode: 0,
          decision: { action: 'accept', rationale: `accepting head ${reviewedHeadSha} after review`, evidenceCommentIds: ['c1'] },
        }),
      });
      assert.strictEqual(resultWithSha.valid, true);
      assert.strictEqual(resultWithSha.decision?.action, 'accept');

      const resultDispatch = await runOwnerSession({
        taskId,
        acceptanceCriteria: 'n/a',
        comments: [],
        reviewedHeadSha,
        worktreePath: wt.path,
        runner: async () => ({
          exitCode: 0,
          decision: { action: 'dispatch', rationale: 'assign to member X', evidenceCommentIds: [] },
        }),
      });
      assert.strictEqual(resultDispatch.valid, true, 'dispatch 等非 accept action 不受 head SHA 引用限制');
      assert.strictEqual(resultDispatch.decision?.action, 'dispatch');
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// =============================================================================
// coordinator.ts：卡關轉移／Owner 介入狀態機（純函式，零 I/O）。委派 policy.ts
// 既有的 recordMemberAttempt／shouldResumeHumanBlocked，這裡只驗證 wiring 本身。
// =============================================================================

function makeMemberSessionResult(
  overrides: Partial<MemberSessionResult> & { outcome: ActionOutcome },
): MemberSessionResult {
  return {
    outcome: overrides.outcome,
    exitCode: overrides.exitCode ?? 0,
    output: overrides.output ?? { summary: '', changedPaths: [], verificationCommands: [], blocker: null },
    evidence: overrides.evidence ?? {
      commitSha: null,
      commitChangedPaths: [],
      verificationPassed: false,
      verificationRanCommands: [],
      reviewTransitionConfirmed: false,
      reviewStatus: null,
      summaryCommentId: null,
      blockerRepeated: false,
      rejectedReason: null,
    },
    evidenceChanged: overrides.evidenceChanged ?? overrides.outcome === 'progressed',
  };
}

function runCoordinatorTests(): void {
  // ---------------------------------------------------------------------------
  // 連續兩次無進展 member attempt -> Owner intervention；介入後再一次無進展 ->
  // human_blocked。只有「剛好跨過門檻」的那一次呼叫才回報 true／建立留言。
  // ---------------------------------------------------------------------------
  {
    const taskId = 'coord-stuck-task';
    const run0 = makeTaskRun({ taskId, workspaceId: CANONICAL_WORKSPACE_ID, phase: 'doing' });
    const evidenceSnapshot = makeEvidence({ taskId, status: 'Doing', commentCount: 1 });

    const t1 = recordMemberSessionAttempt(
      run0,
      makeMemberSessionResult({ outcome: 'no_change', output: { summary: '', changedPaths: [], verificationCommands: [], blocker: 'stuck-1' } }),
      evidenceSnapshot,
    );
    assert.strictEqual(t1.run.noProgressCount, 1);
    assert.strictEqual(t1.run.ownerIntervened, false);
    assert.strictEqual(t1.ownerInterventionRequested, false);
    assert.strictEqual(t1.humanBlockedNotice, null);

    const t2 = recordMemberSessionAttempt(
      t1.run,
      makeMemberSessionResult({ outcome: 'no_change', output: { summary: '', changedPaths: [], verificationCommands: [], blocker: 'stuck-2' } }),
      evidenceSnapshot,
    );
    assert.strictEqual(t2.run.noProgressCount, 2);
    assert.strictEqual(t2.run.ownerIntervened, true, '連續兩次無進展必須觸發 Owner 介入');
    assert.strictEqual(t2.ownerInterventionRequested, true, '剛好跨過門檻的這次呼叫必須回報 ownerInterventionRequested');
    assert.strictEqual(t2.humanBlockedNotice, null, '介入本身不等於 human_blocked');

    const noProgress3 = makeMemberSessionResult({ outcome: 'no_change', output: { summary: '', changedPaths: [], verificationCommands: [], blocker: 'still-stuck' } });
    const t3 = recordMemberSessionAttempt(t2.run, noProgress3, evidenceSnapshot);
    assert.strictEqual(t3.run.phase, 'human_blocked', '介入後再一次無進展必須轉為 human_blocked');
    assert.strictEqual(t3.ownerInterventionRequested, false, '已經介入過，不該重複回報 ownerInterventionRequested');
    assert.ok(t3.humanBlockedNotice, '剛好轉入 human_blocked 的這次呼叫必須產生唯一的 @user09 留言');
    assert.ok(t3.humanBlockedNotice!.content.includes('@user09'));
    assert.ok(t3.humanBlockedNotice!.content.includes('still-stuck'));
    assert.strictEqual(t3.humanBlockedNotice!.actionKey, humanBlockedActionKey(taskId, t3.run.noProgressCount));

    // 冪等：完全相同的輸入再呼叫一次，必須得到完全相同、可去重的 action key。
    const t3Again = recordMemberSessionAttempt(t2.run, noProgress3, evidenceSnapshot);
    assert.strictEqual(t3Again.humanBlockedNotice!.actionKey, t3.humanBlockedNotice!.actionKey, '相同輸入必須得到相同、可去重的 action key');

    // human_blocked 之後：證據未變化不得恢復；出現新證據（新留言、期限事件，或
    // 尚未記錄的人工 task mutation）才恢復——直接委派 policy.ts 的比對邏輯。
    assert.strictEqual(shouldResumeFromHumanBlocked(t3.run, evidenceSnapshot), false, '證據未變化時，human_blocked 不得自行恢復');
    const changedEvidence = makeEvidence({ ...evidenceSnapshot, commentCount: evidenceSnapshot.commentCount + 1 });
    assert.strictEqual(shouldResumeFromHumanBlocked(t3.run, changedEvidence), true, '出現新證據後必須可以恢復');
  }

  // ---------------------------------------------------------------------------
  // 真正 progressed 的 session 必須重置 noProgressCount／ownerIntervened，且絕不
  // 產生 human_blocked 留言——委派 policy.ts 的 recordMemberAttempt，不是這裡自己
  // 重寫的邏輯。
  // ---------------------------------------------------------------------------
  {
    const taskId = 'coord-recovering-task';
    const stuckRun = makeTaskRun({
      taskId,
      workspaceId: CANONICAL_WORKSPACE_ID,
      phase: 'doing',
      noProgressCount: 1,
      ownerIntervened: true,
    });
    const progressedSession = makeMemberSessionResult({
      outcome: 'progressed',
      evidence: {
        commitSha: 'abc123',
        commitChangedPaths: ['feature/x.txt'],
        verificationPassed: true,
        verificationRanCommands: ['npm test'],
        reviewTransitionConfirmed: true,
        reviewStatus: 'Review',
        summaryCommentId: 'comment-1',
        blockerRepeated: false,
        rejectedReason: null,
      },
    });
    const evidenceSnapshot = makeEvidence({ taskId, status: 'Review', commentCount: 2 });
    const transition = recordMemberSessionAttempt(stuckRun, progressedSession, evidenceSnapshot);
    assert.strictEqual(transition.run.noProgressCount, 0);
    assert.strictEqual(transition.run.ownerIntervened, false, '真正的進展必須清除舊的 Owner 介入旗標');
    assert.strictEqual(transition.ownerInterventionRequested, false);
    assert.strictEqual(transition.humanBlockedNotice, null);
  }

  // ---------------------------------------------------------------------------
  // recordMemberSessionAttempt 必須直接消費 session.evidenceChanged，不得自己
  // 另外從 session.outcome 重新推導一次。用一個（現實中不會發生，但足以讓兩種
  // wiring 產生不同結果的）分歧值來證明：如果 coordinator.ts 是自己重算
  // `outcome === 'progressed'`，這裡會得到跟斷言相反的結果。
  // ---------------------------------------------------------------------------
  {
    const taskId = 'coord-evidence-changed-is-not-recomputed';

    // outcome 是 'no_change'，但 evidenceChanged 明確設為 true：若 coordinator.ts
    // 忠實消費這個欄位，noProgressCount 必須被重置為 0；若它偷偷從 outcome 重新
    // 推導，noProgressCount 會變成 1。
    const runA = makeTaskRun({ taskId, workspaceId: CANONICAL_WORKSPACE_ID, phase: 'doing', noProgressCount: 1, ownerIntervened: true });
    const sessionClaimsEvidenceChangedDespiteNoChangeOutcome = makeMemberSessionResult({
      outcome: 'no_change',
      evidenceChanged: true,
    });
    const evidenceSnapshot = makeEvidence({ taskId, status: 'Doing', commentCount: 1 });
    const transitionA = recordMemberSessionAttempt(runA, sessionClaimsEvidenceChangedDespiteNoChangeOutcome, evidenceSnapshot);
    assert.strictEqual(
      transitionA.run.noProgressCount,
      0,
      'recordMemberSessionAttempt 必須直接使用 session.evidenceChanged，不能自己從 outcome 重新推導',
    );
    assert.strictEqual(transitionA.run.ownerIntervened, false);

    // 反過來：outcome 是 'progressed'，但 evidenceChanged 明確設為 false——同樣必須
    // 尊重 evidenceChanged，把這次算成一次無進展的 attempt。
    const runB = makeTaskRun({ taskId, workspaceId: CANONICAL_WORKSPACE_ID, phase: 'doing', noProgressCount: 0 });
    const sessionClaimsProgressedButEvidenceUnchanged = makeMemberSessionResult({
      outcome: 'progressed',
      evidenceChanged: false,
    });
    const transitionB = recordMemberSessionAttempt(runB, sessionClaimsProgressedButEvidenceUnchanged, evidenceSnapshot);
    assert.strictEqual(
      transitionB.run.noProgressCount,
      1,
      'recordMemberSessionAttempt 必須直接使用 session.evidenceChanged，即使 outcome 宣稱 progressed',
    );
  }
}

// =============================================================================
// 任務 6：整合、部署 readback 與自動 revert。
//
// 唯一真正執行的是 git 操作本身（temporary integration worktree 的合併衝突偵測、
// 真正的 `merge --no-ff`、真正的 `git revert -m 1 --no-edit`），全部在
// os.tmpdir() 底下的假 repo 進行。systemd readback、health check、CI 步驟的執行
// 全部是注入的假函式——這個 subsystem 不會、也不應該真的呼叫 systemctl 或真的
// 對 3000 port 發 HTTP 請求；34／35 分鐘的等待也全部靠假時鐘 + 假 sleep 模擬，
// 全程不會真的等待任何時間。
// =============================================================================

function makeReadback(overrides: Partial<SystemdReadback> = {}): SystemdReadback {
  return {
    pathActive: true,
    serviceActiveState: 'inactive',
    invocationId: 'invocation-0',
    execMainStartTimestampMonotonic: 1000,
    result: 'success',
    execMainStatus: 0,
    deployedRev: 'unset',
    ...overrides,
  };
}

function makeHealth(overrides: Partial<HealthCheckResult> = {}): HealthCheckResult {
  return { status: 'ok', db: true, rev: 'unset', ...overrides };
}

/** 假時鐘：now() 回傳目前值；advance() 手動推進，模擬「經過了 N 毫秒」而不需要真的等待。 */
function makeFakeClock(startMs = 0): { now: () => number; advance: (deltaMs: number) => void } {
  let ms = startMs;
  return {
    now: () => ms,
    advance: (deltaMs: number) => {
      ms += deltaMs;
    },
  };
}

/** 近乎零延遲的假 sleep：測試絕不真的等待，時間推進全部靠 readback 假時鐘的 side effect。 */
const noSleep = async (_ms: number): Promise<void> => {};

/**
 * 依序消費的假 getSystemdReadback：每次呼叫先把假時鐘依這一步宣告的 `advanceMs`
 * 推進，再回傳這一步的 reading（用 thunk 而不是預先算好的物件，讓呼叫端可以在
 * reading 真正被消費的當下才去讀「目前真實的 master HEAD」之類的動態值）。
 *
 * 呼叫次數超過提供的步驟數就直接 throw——這是「不得在已經觀察到結果之後又補跑
 * 一輪 poll 去掩蓋結果」的具體回歸測試：如果實作在該回傳的時候還多 poll 一次，
 * 測試會立刻爆炸並指出呼叫次數，而不是悄悄吃掉一個不存在的步驟或誤用前一步的值。
 */
function makeReadbackSequence(
  clock: { advance: (deltaMs: number) => void },
  steps: Array<{ advanceMs?: number; reading: () => SystemdReadback }>,
): { fn: GetSystemdReadback; callCount: () => number } {
  let i = 0;
  const fn: GetSystemdReadback = async () => {
    if (i >= steps.length) {
      throw new Error(
        `getSystemdReadback fixture 已耗盡（第 ${i + 1} 次呼叫，但只準備了 ${steps.length} 步）—— ` +
          `代表實作呼叫 getSystemdReadback 的次數超過測試預期，可能是在已經該回傳結果之後又多跑了一輪`,
      );
    }
    const step = steps[i++];
    if (step.advanceMs) clock.advance(step.advanceMs);
    return step.reading();
  };
  return { fn, callCount: () => i };
}

function makeCountingCheck(result: AcceptanceCheckResult): { fn: AcceptanceCheck; state: { calls: number } } {
  const state = { calls: 0 };
  const fn: AcceptanceCheck = async () => {
    state.calls++;
    return result;
  };
  return { fn, state };
}

function makeCountingIntegrationRunner(
  failing: Record<string, { exitCode: number; output: string }> = {},
): { fn: IntegrationCommandRunner; calls: string[] } {
  const calls: string[] = [];
  const fn: IntegrationCommandRunner = async (command) => {
    calls.push(command);
    if (failing[command]) return failing[command];
    return { exitCode: 0, output: '' };
  };
  return { fn, calls };
}

function initDeployTestRepo(): { repoRoot: string; g: (args: string[], cwd?: string) => string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'sim-production-deploy-'));
  const g = (args: string[], cwd: string = repoRoot): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'sim-deploy-test@example.com']);
  g(['config', 'user.name', 'Sim Deploy Test']);
  writeFileSync(join(repoRoot, 'README.md'), 'root\n');
  g(['add', 'README.md']);
  g(['commit', '-q', '-m', 'init']);
  return { repoRoot, g };
}

/** 從目前 master HEAD 分支出一個 task branch，加一個 allowedPrefixes 底下的檔案並 commit，再切回 master。 */
function makeDeployTaskBranch(
  g: (args: string[], cwd?: string) => string,
  repoRoot: string,
  taskId: string,
  fileContent: string,
): string {
  const branch = `sim/task/${taskId}`;
  const baseSha = g(['rev-parse', 'master']);
  g(['checkout', '-q', '-b', branch, baseSha]);
  execFileSync('mkdir', ['-p', join(repoRoot, 'feature')]);
  writeFileSync(join(repoRoot, 'feature', `${taskId}.txt`), fileContent);
  g(['add', `feature/${taskId}.txt`]);
  g(['commit', '-q', '-m', `feat: ${taskId}`]);
  g(['checkout', '-q', 'master']);
  return branch;
}

async function runDeployTests(): Promise<void> {
  // ===========================================================================
  // Part A：waitForDeployment（git.ts）——唯一的部署 readback 等待／逾時決議函式。
  // 純函式邏輯，不需要真實 git repo；用假時鐘＋依序消費的假 readback 精準控制
  // 「第幾次 poll、經過多久」。merge-wait 與 revert-wait 共用這一個函式（下面
  // Part C 的 revert 測試會再次呼叫它，不是另外寫一份）。
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // A1：baseline 本身（先前 invocation）反覆出現，不能被誤判成「新一輪已結束」。
  //     直到真的出現新 invocationId + 更晚的 timestamp，且該輪已結束、success，
  //     才算數；deployObservedOutOfBand 必須是 false（是靠正常 fast path 偵測到的，
  //     不是逾時後才用 deployed_rev／health rev 湊出來的）。
  // ---------------------------------------------------------------------------
  {
    const clock = makeFakeClock(0);
    const baseline: DeployWaitBaseline = { invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000 };
    const seq = makeReadbackSequence(clock, [
      { advanceMs: 5000, reading: () => makeReadback({ invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000, deployedRev: 'old-sha' }) },
      { advanceMs: 5000, reading: () => makeReadback({ invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000, deployedRev: 'old-sha' }) },
      { advanceMs: 5000, reading: () => makeReadback({ invocationId: 'inv-1', execMainStartTimestampMonotonic: 4000, serviceActiveState: 'inactive', deployedRev: 'target-sha' }) },
    ]);
    let healthCalls = 0;
    const checkHealth: CheckHealth = async () => {
      healthCalls++;
      return makeHealth({ rev: 'target-sha' });
    };
    const result = await waitForDeployment({
      targetSha: 'target-sha',
      baseline,
      getReadback: seq.fn,
      checkHealth,
      now: clock.now,
      sleep: noSleep,
    });
    assert.strictEqual(result.outcome, 'success', 'baseline 重複出現多輪後，真正的新 invocation 結束時必須判定成功');
    if (result.outcome === 'success') {
      assert.strictEqual(result.deployObservedOutOfBand, false, '透過正常 poll 偵測到的成功，不是逾時 out-of-band 決議');
    }
    assert.strictEqual(seq.callCount(), 3, '必須剛好呼叫 3 次 getReadback（2 次仍是 baseline + 1 次真正的新 invocation）');
    assert.strictEqual(healthCalls, 1, 'health 只應該在確認新 invocation 成功之後被呼叫一次');
  }

  // ---------------------------------------------------------------------------
  // A2：path-triggered invocation failure（result != success）——不逾時、快速失敗，
  //     且絕不能因為「還是查一下 health」而多打一次 health（invocation 本身已經
  //     失敗，後面的檢查在邏輯上不可能成立，不需要真的呼叫）。
  // ---------------------------------------------------------------------------
  {
    const clock = makeFakeClock(0);
    const baseline: DeployWaitBaseline = { invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000 };
    const seq = makeReadbackSequence(clock, [
      { advanceMs: 3000, reading: () => makeReadback({ invocationId: 'inv-1', execMainStartTimestampMonotonic: 2000, serviceActiveState: 'inactive', result: 'exit-code', execMainStatus: 1, deployedRev: 'old-sha' }) },
    ]);
    let healthCalls = 0;
    const checkHealth: CheckHealth = async () => {
      healthCalls++;
      return makeHealth();
    };
    const result = await waitForDeployment({
      targetSha: 'target-sha',
      baseline,
      getReadback: seq.fn,
      checkHealth,
      now: clock.now,
      sleep: noSleep,
    });
    assert.strictEqual(result.outcome, 'deployment_failure', 'result != success 必須立刻判定 deployment failure');
    assert.strictEqual(healthCalls, 0, 'invocation 本身失敗時絕不能再去呼叫 health check');
    assert.strictEqual(seq.callCount(), 1, '不得補跑第二輪 poll 去掩蓋這次觀察到的失敗');
  }

  // ---------------------------------------------------------------------------
  // A3：health rev mismatch——invocation 與 deployed_rev 都通過，但 /api/health
  //     回報的 rev 不等於 target，整體仍必須判定 deployment failure。
  // ---------------------------------------------------------------------------
  {
    const clock = makeFakeClock(0);
    const baseline: DeployWaitBaseline = { invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000 };
    const seq = makeReadbackSequence(clock, [
      { advanceMs: 3000, reading: () => makeReadback({ invocationId: 'inv-1', execMainStartTimestampMonotonic: 2000, serviceActiveState: 'inactive', result: 'success', execMainStatus: 0, deployedRev: 'target-sha' }) },
    ]);
    const checkHealth: CheckHealth = async () => makeHealth({ rev: 'stale-sha' });
    const result = await waitForDeployment({
      targetSha: 'target-sha',
      baseline,
      getReadback: seq.fn,
      checkHealth,
      now: clock.now,
      sleep: noSleep,
    });
    assert.strictEqual(result.outcome, 'deployment_failure', 'health rev 與 target 不符必須判定 deployment failure');
    if (result.outcome === 'deployment_failure') {
      assert.match(result.reason, /health/i);
    }
  }

  // ---------------------------------------------------------------------------
  // A4：34 分鐘後才成功——因為 pgrep sim/run.ts 等待而晚到，仍在 35 分鐘預算內，
  //     不得逾時；必須走正常成功路徑（deployObservedOutOfBand=false）。
  // ---------------------------------------------------------------------------
  {
    const clock = makeFakeClock(0);
    const baseline: DeployWaitBaseline = { invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000 };
    const THIRTY_FOUR_MIN = 34 * 60 * 1000;
    const seq = makeReadbackSequence(clock, [
      { advanceMs: THIRTY_FOUR_MIN, reading: () => makeReadback({ invocationId: 'inv-1', execMainStartTimestampMonotonic: 999999, serviceActiveState: 'inactive', result: 'success', execMainStatus: 0, deployedRev: 'target-sha' }) },
    ]);
    const checkHealth: CheckHealth = async () => makeHealth({ rev: 'target-sha' });
    const result = await waitForDeployment({
      targetSha: 'target-sha',
      baseline,
      getReadback: seq.fn,
      checkHealth,
      now: clock.now,
      sleep: noSleep,
    });
    assert.strictEqual(result.outcome, 'success', '34 分鐘後才成功仍在 35 分鐘預算內，不得判定逾時');
    if (result.outcome === 'success') {
      assert.strictEqual(result.deployObservedOutOfBand, false, '在預算內透過正常 poll 偵測到的成功不是 out-of-band');
    }
  }

  // ---------------------------------------------------------------------------
  // A5：逾時（>= 35 分鐘）且 deployed_rev／health rev 都已等於 target——視為成功，
  //     並標記 deployObservedOutOfBand=true（可能是遺漏觸發後的人工 start，或單純
  //     readback 延遲）。
  // ---------------------------------------------------------------------------
  {
    const clock = makeFakeClock(0);
    const baseline: DeployWaitBaseline = { invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000 };
    const THIRTY_FIVE_MIN = 35 * 60 * 1000;
    const seq = makeReadbackSequence(clock, [
      // 逾時前反覆是「還沒看到新 invocation」；最後一步把時間推過 35 分鐘門檻。
      { advanceMs: THIRTY_FIVE_MIN, reading: () => makeReadback({ invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000, serviceActiveState: 'active', deployedRev: 'target-sha' }) },
    ]);
    const checkHealth: CheckHealth = async () => makeHealth({ rev: 'target-sha' });
    const result = await waitForDeployment({
      targetSha: 'target-sha',
      baseline,
      getReadback: seq.fn,
      checkHealth,
      now: clock.now,
      sleep: noSleep,
    });
    assert.strictEqual(result.outcome, 'success', '逾時但 deployed_rev／health rev 都等於 target 必須視為成功');
    if (result.outcome === 'success') {
      assert.strictEqual(result.deployObservedOutOfBand, true, '逾時後才決議出的成功必須標記 deployObservedOutOfBand=true');
    }
  }

  // ---------------------------------------------------------------------------
  // A6：逾時且 deployed_rev 不符，但 service 仍 active——回傳 DeploymentIndeterminate，
  //     且下一個 tick 用「同一個 baseline／target SHA」重新呼叫 waitForDeployment
  //     （不重新 merge／revert）就能收斂成功——這就是「下一個 tick 重新 readback」
  //     在這個函式層級的具體樣子。
  // ---------------------------------------------------------------------------
  {
    const clock = makeFakeClock(0);
    const baseline: DeployWaitBaseline = { invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000 };
    const THIRTY_FIVE_MIN = 35 * 60 * 1000;

    const seq1 = makeReadbackSequence(clock, [
      { advanceMs: THIRTY_FIVE_MIN, reading: () => makeReadback({ invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000, serviceActiveState: 'active', deployedRev: 'old-sha' }) },
    ]);
    const checkHealth: CheckHealth = async () => makeHealth({ rev: 'old-sha' });
    const result1 = await waitForDeployment({
      targetSha: 'target-sha',
      baseline,
      getReadback: seq1.fn,
      checkHealth,
      now: clock.now,
      sleep: noSleep,
    });
    assert.strictEqual(result1.outcome, 'deployment_indeterminate', '逾時且 deployed_rev 不符、service 仍 active 必須是 DeploymentIndeterminate');

    // 下一個 tick：同一個 baseline、同一個 target SHA，重新呼叫 waitForDeployment。
    // 這次立刻看到新 invocation 已經結束且成功——必須收斂成功，且不得因為第一次
    // 逾時就對「同一個 target SHA」提前放棄或永久卡死。
    const seq2 = makeReadbackSequence(clock, [
      { advanceMs: 1000, reading: () => makeReadback({ invocationId: 'inv-1', execMainStartTimestampMonotonic: 2000, serviceActiveState: 'inactive', result: 'success', execMainStatus: 0, deployedRev: 'target-sha' }) },
    ]);
    const result2 = await waitForDeployment({
      targetSha: 'target-sha',
      baseline,
      getReadback: seq2.fn,
      checkHealth: async () => makeHealth({ rev: 'target-sha' }),
      now: clock.now,
      sleep: noSleep,
    });
    assert.strictEqual(result2.outcome, 'success', '下一個 tick 以同一 target SHA 重新 readback 後必須能成功收斂');
  }

  // ---------------------------------------------------------------------------
  // A7：逾時且 deployed_rev 不符、service 已 inactive——確認 .path 觸發遺漏，
  //     回傳該 target SHA 的 deployment failure（這正是計畫步驟 1 列的
  //     「merge 後沒有新 invocation」）。
  // ---------------------------------------------------------------------------
  {
    const clock = makeFakeClock(0);
    const baseline: DeployWaitBaseline = { invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000 };
    const THIRTY_FIVE_MIN = 35 * 60 * 1000;
    const seq = makeReadbackSequence(clock, [
      { advanceMs: THIRTY_FIVE_MIN, reading: () => makeReadback({ invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000, serviceActiveState: 'inactive', deployedRev: 'old-sha' }) },
    ]);
    const result = await waitForDeployment({
      targetSha: 'target-sha',
      baseline,
      getReadback: seq.fn,
      checkHealth: async () => makeHealth({ rev: 'old-sha' }),
      now: clock.now,
      sleep: noSleep,
    });
    assert.strictEqual(result.outcome, 'deployment_failure', '逾時且 deployed_rev 不符、service 已 inactive 必須確認 .path 觸發遺漏並判定失敗');
  }

  // ===========================================================================
  // Part B：runDeployAcceptance（coordinator.ts）——固定 acceptance sequence 的
  // orchestration，含真正的 git 合併衝突偵測與真正的 merge --no-ff。
  // ===========================================================================

  const repo = initDeployTestRepo();
  try {
    const { repoRoot, g } = repo;

    // ---------------------------------------------------------------------------
    // B1：branch CI failure——最早的一步就失敗，之後任何步驟（含建立 integration
    //     worktree）都不得被執行；master HEAD 完全不變。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-branch-ci-fail';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'branch ci fail content\n');
      const masterBefore = g(['rev-parse', 'master']);
      const integrationRunner = makeCountingIntegrationRunner();
      const taskSpecific = makeCountingCheck({ passed: true, detail: 'n/a' });
      const liveAcceptance = makeCountingCheck({ passed: true, detail: 'n/a' });
      let readbackCalls = 0;

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch,
        existingFatalError: null,
        runBranchCi: async () => ({ passed: false, detail: 'branch CI failed on task branch' }),
        runIntegrationCommand: integrationRunner.fn,
        runTaskSpecificAcceptance: taskSpecific.fn,
        getSystemdReadback: async () => {
          readbackCalls++;
          return makeReadback();
        },
        checkHealth: async () => makeHealth(),
        runTaskLiveAcceptance: liveAcceptance.fn,
        now: () => 0,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'branch_ci_failed');
      assert.strictEqual(g(['rev-parse', 'master']), masterBefore, 'branch CI failure 之後 master 完全不得前進');
      assert.strictEqual(integrationRunner.calls.length, 0, 'branch CI 失敗後不得執行任何 integration command');
      assert.strictEqual(taskSpecific.state.calls, 0);
      assert.strictEqual(readbackCalls, 0, 'branch CI 失敗後不得讀取 systemd readback');
      assert.strictEqual(liveAcceptance.state.calls, 0);
      assert.strictEqual(existsSync(join(repoRoot, 'sim-work', 'integration', taskId)), false, '不得留下 integration worktree');
    }

    // ---------------------------------------------------------------------------
    // B2：integration conflict——真正的合併衝突偵測（temp worktree 對目前 master
    //     跑 `merge --no-ff --no-commit`），衝突後必須清掉暫時 worktree、master
    //     不變、後續步驟都不執行。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-integration-conflict';
      // 讓 task branch 與 master 各自修改同一個檔案，製造真正的合併衝突。
      const baseSha = g(['rev-parse', 'master']);
      const branch = `sim/task/${taskId}`;
      g(['checkout', '-q', '-b', branch, baseSha]);
      execFileSync('mkdir', ['-p', join(repoRoot, 'feature')]);
      writeFileSync(join(repoRoot, 'feature', 'conflict-target.txt'), 'task version\n');
      g(['add', 'feature/conflict-target.txt']);
      g(['commit', '-q', '-m', 'task change conflict-target']);
      g(['checkout', '-q', 'master']);
      execFileSync('mkdir', ['-p', join(repoRoot, 'feature')]);
      writeFileSync(join(repoRoot, 'feature', 'conflict-target.txt'), 'master version\n');
      g(['add', 'feature/conflict-target.txt']);
      g(['commit', '-q', '-m', 'master change conflict-target']);

      const masterBefore = g(['rev-parse', 'master']);
      const integrationRunner = makeCountingIntegrationRunner();
      let readbackCalls = 0;

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch: branch,
        existingFatalError: null,
        runBranchCi: async () => ({ passed: true, detail: 'ok' }),
        runIntegrationCommand: integrationRunner.fn,
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
        getSystemdReadback: async () => {
          readbackCalls++;
          return makeReadback();
        },
        checkHealth: async () => makeHealth(),
        runTaskLiveAcceptance: async () => ({ passed: true, detail: 'ok' }),
        now: () => 0,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'integration_conflict');
      assert.strictEqual(g(['rev-parse', 'master']), masterBefore, 'integration conflict 之後 master 完全不得前進');
      assert.strictEqual(integrationRunner.calls.length, 0, '衝突偵測到後不得執行任何 integration command');
      assert.strictEqual(readbackCalls, 0, '衝突之後不得讀取 systemd readback');
      assert.strictEqual(existsSync(join(repoRoot, 'sim-work', 'integration', taskId)), false, '衝突之後必須清掉暫時 worktree');
      const worktreeList = g(['worktree', 'list', '--porcelain']);
      assert.ok(!worktreeList.includes(join(repoRoot, 'sim-work', 'integration', taskId)), '衝突之後 git 自己的 worktree 清單裡也不該再看到它');
    }

    // ---------------------------------------------------------------------------
    // B3：full test failure——temp integration worktree 裡的 `npm test` 步驟失敗。
    //     `npm run build`／`git diff --check` 不得被執行；worktree 依然要被清掉。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-full-test-fail';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'full test fail content\n');
      const masterBefore = g(['rev-parse', 'master']);
      const integrationRunner = makeCountingIntegrationRunner({ 'npm test': { exitCode: 1, output: '3 tests failed' } });

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch,
        existingFatalError: null,
        runBranchCi: async () => ({ passed: true, detail: 'ok' }),
        runIntegrationCommand: integrationRunner.fn,
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
        getSystemdReadback: async () => makeReadback(),
        checkHealth: async () => makeHealth(),
        runTaskLiveAcceptance: async () => ({ passed: true, detail: 'ok' }),
        now: () => 0,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'integration_command_failed');
      if (result.kind === 'integration_command_failed') {
        assert.strictEqual(result.command, 'npm test');
      }
      assert.deepStrictEqual(integrationRunner.calls, ['npm test'], 'npm test 失敗後不得再跑 npm run build／git diff --check');
      assert.strictEqual(g(['rev-parse', 'master']), masterBefore, 'full test failure 之後 master 完全不得前進');
      assert.strictEqual(existsSync(join(repoRoot, 'sim-work', 'integration', taskId)), false, '失敗之後仍必須清掉暫時 worktree');
    }

    // ---------------------------------------------------------------------------
    // B4：merge 前 build failure——`npm run build` 失敗；`git diff --check` 不得執行。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-build-fail';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'build fail content\n');
      const masterBefore = g(['rev-parse', 'master']);
      const integrationRunner = makeCountingIntegrationRunner({ 'npm run build': { exitCode: 1, output: 'tsc error' } });

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch,
        existingFatalError: null,
        runBranchCi: async () => ({ passed: true, detail: 'ok' }),
        runIntegrationCommand: integrationRunner.fn,
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
        getSystemdReadback: async () => makeReadback(),
        checkHealth: async () => makeHealth(),
        runTaskLiveAcceptance: async () => ({ passed: true, detail: 'ok' }),
        now: () => 0,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'integration_command_failed');
      if (result.kind === 'integration_command_failed') {
        assert.strictEqual(result.command, 'npm run build');
      }
      assert.deepStrictEqual(integrationRunner.calls, ['npm test', 'npm run build'], 'build 失敗後不得再跑 git diff --check');
      assert.strictEqual(g(['rev-parse', 'master']), masterBefore, 'build failure 之後 master 完全不得前進');
    }

    // ---------------------------------------------------------------------------
    // B5：task-specific acceptance failure（額外覆蓋，不在計畫列的 11 項核心情境
    //     內，但同屬固定 sequence 的一步，補上證明它也會正確短路）。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-task-specific-fail';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'task specific fail content\n');
      const masterBefore = g(['rev-parse', 'master']);
      const integrationRunner = makeCountingIntegrationRunner();
      let readbackCalls = 0;

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch,
        existingFatalError: null,
        runBranchCi: async () => ({ passed: true, detail: 'ok' }),
        runIntegrationCommand: integrationRunner.fn,
        runTaskSpecificAcceptance: async () => ({ passed: false, detail: 'acceptance criteria not met' }),
        getSystemdReadback: async () => {
          readbackCalls++;
          return makeReadback();
        },
        checkHealth: async () => makeHealth(),
        runTaskLiveAcceptance: async () => ({ passed: true, detail: 'ok' }),
        now: () => 0,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'task_specific_acceptance_failed');
      assert.deepStrictEqual(integrationRunner.calls, ['npm test', 'npm run build', 'git diff --check']);
      assert.strictEqual(readbackCalls, 0, 'task-specific acceptance 失敗後不得讀取 systemd readback');
      assert.strictEqual(g(['rev-parse', 'master']), masterBefore);
    }

    // ---------------------------------------------------------------------------
    // B6：sim-autodeploy.path inactive——merge 前置條件檢查失敗；merge 絕不得發生。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-path-inactive';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'path inactive content\n');
      const masterBefore = g(['rev-parse', 'master']);
      const liveAcceptance = makeCountingCheck({ passed: true, detail: 'ok' });

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch,
        existingFatalError: null,
        runBranchCi: async () => ({ passed: true, detail: 'ok' }),
        runIntegrationCommand: makeCountingIntegrationRunner().fn,
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
        getSystemdReadback: async () => makeReadback({ pathActive: false }),
        checkHealth: async () => makeHealth(),
        runTaskLiveAcceptance: liveAcceptance.fn,
        now: () => 0,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'deploy_precondition_failed');
      if (result.kind === 'deploy_precondition_failed') {
        assert.match(result.detail, /path/i);
      }
      assert.strictEqual(g(['rev-parse', 'master']), masterBefore, 'path inactive 時絕不得 merge');
      assert.strictEqual(liveAcceptance.state.calls, 0);
    }

    // ---------------------------------------------------------------------------
    // B7：merge 前 service 尚 active——同樣的前置條件檢查失敗；merge 絕不得發生。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-service-active';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'service active content\n');
      const masterBefore = g(['rev-parse', 'master']);

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch,
        existingFatalError: null,
        runBranchCi: async () => ({ passed: true, detail: 'ok' }),
        runIntegrationCommand: makeCountingIntegrationRunner().fn,
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
        getSystemdReadback: async () => makeReadback({ pathActive: true, serviceActiveState: 'active' }),
        checkHealth: async () => makeHealth(),
        runTaskLiveAcceptance: async () => ({ passed: true, detail: 'ok' }),
        now: () => 0,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'deploy_precondition_failed');
      if (result.kind === 'deploy_precondition_failed') {
        assert.match(result.detail, /service/i);
      }
      assert.strictEqual(g(['rev-parse', 'master']), masterBefore, 'service 仍 active 時絕不得 merge');
    }

    // ---------------------------------------------------------------------------
    // B8：fatal_blocked 短路——已經有記錄在案的 fatal coordinator error 時，
    //     整個函式必須在第一行就拒絕，完全不執行任何步驟（regression guard：
    //     這就是「revert 部署失敗後停止全部後續 live action」的具體證明）。
    // ---------------------------------------------------------------------------
    {
      const fatal: FatalCoordinatorError = { taskId: 'deploy-fatal-blocked', sha: 'deadbeef', reason: '先前記錄的 fatal error（測試用）' };
      const branchCi = makeCountingCheck({ passed: true, detail: 'ok' });
      const integrationRunner = makeCountingIntegrationRunner();
      const taskSpecific = makeCountingCheck({ passed: true, detail: 'ok' });
      const liveAcceptance = makeCountingCheck({ passed: true, detail: 'ok' });
      let readbackCalls = 0;
      let healthCalls = 0;

      const result = await runDeployAcceptance({
        taskId: 'deploy-fatal-blocked',
        repoRoot,
        taskBranch: 'sim/task/never-used',
        existingFatalError: fatal,
        runBranchCi: branchCi.fn,
        runIntegrationCommand: integrationRunner.fn,
        runTaskSpecificAcceptance: taskSpecific.fn,
        getSystemdReadback: async () => {
          readbackCalls++;
          return makeReadback();
        },
        checkHealth: async () => {
          healthCalls++;
          return makeHealth();
        },
        runTaskLiveAcceptance: liveAcceptance.fn,
        now: () => 0,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'fatal_blocked');
      if (result.kind === 'fatal_blocked') {
        assert.strictEqual(result.fatal, fatal);
      }
      assert.strictEqual(branchCi.state.calls, 0, 'fatal 記錄在案時，連 branch CI 都不得執行');
      assert.strictEqual(integrationRunner.calls.length, 0);
      assert.strictEqual(taskSpecific.state.calls, 0);
      assert.strictEqual(readbackCalls, 0);
      assert.strictEqual(healthCalls, 0);
      assert.strictEqual(liveAcceptance.state.calls, 0);
      assert.throws(() => assertNoFatalCoordinatorError(fatal), /fatal/i, 'assertNoFatalCoordinatorError 必須對非 null 的 fatal 拋錯');
      assert.doesNotThrow(() => assertNoFatalCoordinatorError(null), 'assertNoFatalCoordinatorError(null) 不得拋錯');
    }

    // ---------------------------------------------------------------------------
    // B9：完整成功路徑（額外覆蓋，不在核心 11 項情境內，但沒有它就從未驗證過整條
    //     sequence 真的能走到底）——merge 真的落地、waitForDeployment 透過正常
    //     fast path 判定成功、task live acceptance 也通過。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-happy-path';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'happy path content\n');
      const masterBefore = g(['rev-parse', 'master']);
      const clock = makeFakeClock(0);
      const liveAcceptance = makeCountingCheck({ passed: true, detail: 'ok' });

      const seq = makeReadbackSequence(clock, [
        // 第一次呼叫：merge 前置條件檢查 + baseline 擷取。
        { reading: () => makeReadback({ invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000, deployedRev: masterBefore }) },
        // 第二次呼叫（waitForDeployment 的第一輪 poll）：新 invocation 已經結束、成功。
        { advanceMs: 4000, reading: () => makeReadback({ invocationId: 'inv-1', execMainStartTimestampMonotonic: 2000, serviceActiveState: 'inactive', result: 'success', execMainStatus: 0, deployedRev: g(['rev-parse', 'master']) }) },
      ]);

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch,
        existingFatalError: null,
        runBranchCi: async () => ({ passed: true, detail: 'ok' }),
        runIntegrationCommand: makeCountingIntegrationRunner().fn,
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
        getSystemdReadback: seq.fn,
        checkHealth: async () => makeHealth({ rev: g(['rev-parse', 'master']) }),
        runTaskLiveAcceptance: liveAcceptance.fn,
        now: clock.now,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'deployed', `預期成功部署，實際：${JSON.stringify(result)}`);
      if (result.kind === 'deployed') {
        assert.notStrictEqual(result.mergeSha, masterBefore, 'merge 必須真的讓 master 前進');
        assert.strictEqual(result.mergeSha, g(['rev-parse', 'master']), 'runDeployAcceptance 回報的 mergeSha 必須等於 master 目前真正的 HEAD');
        assert.strictEqual(result.deployObservedOutOfBand, false);
      }
      assert.strictEqual(liveAcceptance.state.calls, 1, '成功部署後必須執行一次 task live acceptance');
      assert.strictEqual(existsSync(join(repoRoot, 'sim-work', 'integration', taskId)), false, '成功之後暫時 integration worktree 也必須被清掉');
    }

    // ---------------------------------------------------------------------------
    // B10：merge 後沒有新 invocation（逾時且 service 已 inactive）——透過完整
    //     runDeployAcceptance 走一次，證明 orchestration 層正確把 git.ts 的
    //     deployment_failure 轉成 deploy_failed_post_merge、且 live acceptance
    //     不會被執行。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-no-new-invocation';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'no new invocation content\n');
      const clock = makeFakeClock(0);
      const liveAcceptance = makeCountingCheck({ passed: true, detail: 'ok' });
      const THIRTY_FIVE_MIN = 35 * 60 * 1000;

      const seq = makeReadbackSequence(clock, [
        { reading: () => makeReadback({ invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000, deployedRev: 'stale-sha' }) },
        { advanceMs: THIRTY_FIVE_MIN, reading: () => makeReadback({ invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000, serviceActiveState: 'inactive', deployedRev: 'stale-sha' }) },
      ]);

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch,
        existingFatalError: null,
        runBranchCi: async () => ({ passed: true, detail: 'ok' }),
        runIntegrationCommand: makeCountingIntegrationRunner().fn,
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
        getSystemdReadback: seq.fn,
        checkHealth: async () => makeHealth({ rev: 'stale-sha' }),
        runTaskLiveAcceptance: liveAcceptance.fn,
        now: clock.now,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'deploy_failed_post_merge', `預期 deploy_failed_post_merge，實際：${JSON.stringify(result)}`);
      assert.strictEqual(liveAcceptance.state.calls, 0, '部署失敗時不得執行 task live acceptance');
    }

    // ---------------------------------------------------------------------------
    // B11：merge 後逾時且 service 仍 active——deploy_indeterminate；同一個 tick
    //     裡絕不執行 task live acceptance（零 revert、零 status change、零
    //     completion comment的具體表現：這裡就是「完全不繼續往下走」）。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-indeterminate-merge';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'indeterminate merge content\n');
      const clock = makeFakeClock(0);
      const liveAcceptance = makeCountingCheck({ passed: true, detail: 'ok' });
      const THIRTY_FIVE_MIN = 35 * 60 * 1000;

      const seq = makeReadbackSequence(clock, [
        { reading: () => makeReadback({ invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000, deployedRev: 'stale-sha' }) },
        { advanceMs: THIRTY_FIVE_MIN, reading: () => makeReadback({ invocationId: 'inv-0', execMainStartTimestampMonotonic: 1000, serviceActiveState: 'active', deployedRev: 'stale-sha' }) },
      ]);

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch,
        existingFatalError: null,
        runBranchCi: async () => ({ passed: true, detail: 'ok' }),
        runIntegrationCommand: makeCountingIntegrationRunner().fn,
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
        getSystemdReadback: seq.fn,
        checkHealth: async () => makeHealth({ rev: 'stale-sha' }),
        runTaskLiveAcceptance: liveAcceptance.fn,
        now: clock.now,
        sleep: noSleep,
      });

      assert.strictEqual(result.kind, 'deploy_indeterminate', `預期 deploy_indeterminate，實際：${JSON.stringify(result)}`);
      assert.strictEqual(liveAcceptance.state.calls, 0, 'DeploymentIndeterminate 的這個 tick 絕不得執行 task live acceptance（也就不會有後續的 status／completion comment）');
    }

    // ===========================================================================
    // Part C：performMasterRevert／resolveRollbackWait（coordinator.ts）——步驟 4
    // 的失敗復原：真正的 `git revert -m 1 --no-edit`，readback 等待沿用 Part A
    // 已經測過的同一個 waitForDeployment。
    // ===========================================================================

    // ---------------------------------------------------------------------------
    // C1：成功 revert 並由另一個新 invocation 恢復 health。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-rollback-success';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'rollback success content\n');
      const mergeSha = await mergeTaskIntoMaster(repoRoot, taskBranch, taskId);

      const revertResult = await performMasterRevert(taskId, repoRoot, mergeSha, async () =>
        makeReadback({ pathActive: true, serviceActiveState: 'inactive', invocationId: 'inv-fail', execMainStartTimestampMonotonic: 5000, deployedRev: mergeSha }),
      );
      assert.strictEqual(revertResult.kind, 'reverted', `預期 reverted，實際：${JSON.stringify(revertResult)}`);
      if (revertResult.kind !== 'reverted') throw new Error('unreachable');
      const { revertSha, baseline } = revertResult;
      assert.notStrictEqual(revertSha, mergeSha);
      assert.strictEqual(g(['rev-parse', 'master']), revertSha, 'performMasterRevert 必須真的讓 master 前進到新的 revert commit');

      const clock = makeFakeClock(0);
      const seq = makeReadbackSequence(clock, [
        { advanceMs: 2000, reading: () => makeReadback({ invocationId: 'inv-fail', execMainStartTimestampMonotonic: 5000, serviceActiveState: 'inactive', deployedRev: mergeSha }) },
        { advanceMs: 2000, reading: () => makeReadback({ invocationId: 'inv-rollback', execMainStartTimestampMonotonic: 8000, serviceActiveState: 'inactive', result: 'success', execMainStatus: 0, deployedRev: revertSha }) },
      ]);

      const waitResult = await resolveRollbackWait({
        taskId,
        mergeSha,
        revertSha,
        baseline,
        getSystemdReadback: seq.fn,
        checkHealth: async () => makeHealth({ rev: revertSha }),
        now: clock.now,
        sleep: noSleep,
      });

      assert.strictEqual(waitResult.kind, 'rolled_back', `預期 rolled_back，實際：${JSON.stringify(waitResult)}`);
      if (waitResult.kind === 'rolled_back') {
        assert.strictEqual(waitResult.notice.actionKey, deploymentRollbackActionKey(taskId, mergeSha));
        assert.ok(waitResult.notice.content.includes(mergeSha));
        assert.ok(waitResult.notice.content.includes(revertSha));
        assert.ok(waitResult.notice.content.includes('@user09'));
      }
    }

    // ---------------------------------------------------------------------------
    // C2：rollback invocation 本身明確失敗——立刻升級 fatal，且該 fatal 必須讓
    //     `assertNoFatalCoordinatorError` 拋錯，並讓 runDeployAcceptance 對這個
    //     task 的任何後續呼叫立刻 fatal_blocked（revert 部署失敗後停止全部後續
    //     live action）。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-rollback-fails';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'rollback fails content\n');
      const mergeSha = await mergeTaskIntoMaster(repoRoot, taskBranch, taskId);

      const revertResult = await performMasterRevert(taskId, repoRoot, mergeSha, async () =>
        makeReadback({ pathActive: true, serviceActiveState: 'inactive', invocationId: 'inv-fail-2', execMainStartTimestampMonotonic: 5000, deployedRev: mergeSha }),
      );
      assert.strictEqual(revertResult.kind, 'reverted');
      if (revertResult.kind !== 'reverted') throw new Error('unreachable');
      const { revertSha, baseline } = revertResult;

      const clock = makeFakeClock(0);
      const seq = makeReadbackSequence(clock, [
        { advanceMs: 2000, reading: () => makeReadback({ invocationId: 'inv-rollback-fail', execMainStartTimestampMonotonic: 9000, serviceActiveState: 'inactive', result: 'exit-code', execMainStatus: 1, deployedRev: 'stale-sha' }) },
      ]);

      const waitResult = await resolveRollbackWait({
        taskId,
        mergeSha,
        revertSha,
        baseline,
        getSystemdReadback: seq.fn,
        checkHealth: async () => makeHealth(),
        now: clock.now,
        sleep: noSleep,
      });

      assert.strictEqual(waitResult.kind, 'fatal', `預期 fatal，實際：${JSON.stringify(waitResult)}`);
      if (waitResult.kind !== 'fatal') throw new Error('unreachable');
      assert.throws(() => assertNoFatalCoordinatorError(waitResult.fatal), /fatal/i);

      // 後續任何一次 runDeployAcceptance 呼叫（不論是同一個 task 或任何 task）都必須
      // 立刻被這個 fatal 檔下來，完全不執行任何步驟。
      const branchCi = makeCountingCheck({ passed: true, detail: 'ok' });
      const followUp = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch: 'sim/task/never-used-again',
        existingFatalError: waitResult.fatal,
        runBranchCi: branchCi.fn,
        runIntegrationCommand: makeCountingIntegrationRunner().fn,
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
        getSystemdReadback: async () => makeReadback(),
        checkHealth: async () => makeHealth(),
        runTaskLiveAcceptance: async () => ({ passed: true, detail: 'ok' }),
        now: () => 0,
        sleep: noSleep,
      });
      assert.strictEqual(followUp.kind, 'fatal_blocked');
      assert.strictEqual(branchCi.state.calls, 0, 'fatal 之後，連下一次呼叫的 branch CI 都不得執行——這就是「停止全部後續 live action」');
    }

    // ---------------------------------------------------------------------------
    // C3：rollback DeploymentIndeterminate 連續兩個 tick 仍未收斂——第二次才升級
    //     為 fatal（第一次不能，必須先給機會收斂）。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-rollback-indeterminate-fatal';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'rollback indeterminate fatal content\n');
      const mergeSha = await mergeTaskIntoMaster(repoRoot, taskBranch, taskId);

      const revertResult = await performMasterRevert(taskId, repoRoot, mergeSha, async () =>
        makeReadback({ pathActive: true, serviceActiveState: 'inactive', invocationId: 'inv-fail-3', execMainStartTimestampMonotonic: 5000, deployedRev: mergeSha }),
      );
      assert.strictEqual(revertResult.kind, 'reverted');
      if (revertResult.kind !== 'reverted') throw new Error('unreachable');
      const { revertSha, baseline } = revertResult;
      const THIRTY_FIVE_MIN = 35 * 60 * 1000;

      // 第一個 tick：逾時且 service 仍 active -> rollback_indeterminate（count=1，不是 fatal）。
      const clock1 = makeFakeClock(0);
      const seq1 = makeReadbackSequence(clock1, [
        { advanceMs: THIRTY_FIVE_MIN, reading: () => makeReadback({ invocationId: 'inv-fail-3', execMainStartTimestampMonotonic: 5000, serviceActiveState: 'active', deployedRev: 'stale-sha' }) },
      ]);
      const tick1 = await resolveRollbackWait({
        taskId,
        mergeSha,
        revertSha,
        baseline,
        getSystemdReadback: seq1.fn,
        checkHealth: async () => makeHealth({ rev: 'stale-sha' }),
        now: clock1.now,
        sleep: noSleep,
      });
      assert.strictEqual(tick1.kind, 'rollback_indeterminate', `第一次逾時不得升級為 fatal，實際：${JSON.stringify(tick1)}`);
      if (tick1.kind !== 'rollback_indeterminate') throw new Error('unreachable');
      assert.strictEqual(tick1.rollbackIndeterminateCount, 1);
      // 這一步不得真的再 revert 一次——直接沿用同一個 revertSha／baseline 進第二個 tick 即可證明。
      assert.strictEqual(g(['rev-parse', 'master']), revertSha, '第一次 indeterminate 之後 master 不得再變動（沒有第二次 revert）');

      // 第二個 tick：仍然 indeterminate -> 這次必須升級為 fatal。
      const clock2 = makeFakeClock(0);
      const seq2 = makeReadbackSequence(clock2, [
        { advanceMs: THIRTY_FIVE_MIN, reading: () => makeReadback({ invocationId: 'inv-fail-3', execMainStartTimestampMonotonic: 5000, serviceActiveState: 'active', deployedRev: 'stale-sha' }) },
      ]);
      const tick2 = await resolveRollbackWait({
        taskId,
        mergeSha,
        revertSha,
        baseline,
        getSystemdReadback: seq2.fn,
        checkHealth: async () => makeHealth({ rev: 'stale-sha' }),
        now: clock2.now,
        sleep: noSleep,
        previousRollbackIndeterminateCount: tick1.rollbackIndeterminateCount,
      });
      assert.strictEqual(tick2.kind, 'fatal', `連續兩個 tick 都是 indeterminate 必須升級為 fatal，實際：${JSON.stringify(tick2)}`);
    }

    // ---------------------------------------------------------------------------
    // C4：rollback DeploymentIndeterminate 一次之後，第二個 tick 收斂成功——
    //     不得因為第一次 indeterminate 就提早判死或提早升級 fatal。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-rollback-indeterminate-then-success';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'rollback indeterminate then success content\n');
      const mergeSha = await mergeTaskIntoMaster(repoRoot, taskBranch, taskId);

      const revertResult = await performMasterRevert(taskId, repoRoot, mergeSha, async () =>
        makeReadback({ pathActive: true, serviceActiveState: 'inactive', invocationId: 'inv-fail-4', execMainStartTimestampMonotonic: 5000, deployedRev: mergeSha }),
      );
      assert.strictEqual(revertResult.kind, 'reverted');
      if (revertResult.kind !== 'reverted') throw new Error('unreachable');
      const { revertSha, baseline } = revertResult;
      const THIRTY_FIVE_MIN = 35 * 60 * 1000;

      const clock1 = makeFakeClock(0);
      const seq1 = makeReadbackSequence(clock1, [
        { advanceMs: THIRTY_FIVE_MIN, reading: () => makeReadback({ invocationId: 'inv-fail-4', execMainStartTimestampMonotonic: 5000, serviceActiveState: 'active', deployedRev: 'stale-sha' }) },
      ]);
      const tick1 = await resolveRollbackWait({
        taskId,
        mergeSha,
        revertSha,
        baseline,
        getSystemdReadback: seq1.fn,
        checkHealth: async () => makeHealth({ rev: 'stale-sha' }),
        now: clock1.now,
        sleep: noSleep,
      });
      assert.strictEqual(tick1.kind, 'rollback_indeterminate');
      if (tick1.kind !== 'rollback_indeterminate') throw new Error('unreachable');

      const clock2 = makeFakeClock(0);
      const seq2 = makeReadbackSequence(clock2, [
        { advanceMs: 3000, reading: () => makeReadback({ invocationId: 'inv-rollback-4', execMainStartTimestampMonotonic: 9000, serviceActiveState: 'inactive', result: 'success', execMainStatus: 0, deployedRev: revertSha }) },
      ]);
      const tick2 = await resolveRollbackWait({
        taskId,
        mergeSha,
        revertSha,
        baseline,
        getSystemdReadback: seq2.fn,
        checkHealth: async () => makeHealth({ rev: revertSha }),
        now: clock2.now,
        sleep: noSleep,
        previousRollbackIndeterminateCount: tick1.rollbackIndeterminateCount,
      });
      assert.strictEqual(tick2.kind, 'rolled_back', `第二個 tick 應該成功收斂，實際：${JSON.stringify(tick2)}`);
    }

    // ---------------------------------------------------------------------------
    // C5：master HEAD !== mergeSha——revert 前的 sanity guard。如果在等待部署
    //     readback 期間 master 又被別的東西推進了，performMasterRevert 絕不能盲目
    //     revert 現在的 master HEAD（那可能是完全不相干的 commit）；必須拒絕並
    //     回傳 fatal，交由人工介入。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-master-moved';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'master moved content\n');
      const mergeSha = await mergeTaskIntoMaster(repoRoot, taskBranch, taskId);

      // 模擬「master 在等待期間又被別的東西推進」：直接在 repoRoot 上再加一個
      // 與這次 revert 完全不相干的 commit。
      writeFileSync(join(repoRoot, 'unrelated-advance.txt'), 'x\n');
      g(['add', 'unrelated-advance.txt']);
      g(['commit', '-q', '-m', 'unrelated advance while waiting for readback']);
      const masterAfterUnrelatedAdvance = g(['rev-parse', 'master']);
      assert.notStrictEqual(masterAfterUnrelatedAdvance, mergeSha);

      const revertResult = await performMasterRevert(taskId, repoRoot, mergeSha, async () =>
        makeReadback({ pathActive: true, serviceActiveState: 'inactive', deployedRev: mergeSha }),
      );

      assert.strictEqual(revertResult.kind, 'fatal', 'master HEAD !== mergeSha 時絕不能盲目 revert，必須拒絕並回報 fatal');
      assert.strictEqual(g(['rev-parse', 'master']), masterAfterUnrelatedAdvance, '拒絕 revert 之後 master 不得再被這次呼叫改動');
      if (revertResult.kind === 'fatal') {
        assert.strictEqual(revertResult.fatal.sha, mergeSha);
        assert.match(revertResult.fatal.reason, /master HEAD|mergeSha/i);
      }
    }

    // ---------------------------------------------------------------------------
    // C6：revert 前置條件失敗（service 仍 active）——同樣拒絕、回傳 fatal，
    //     不嘗試 revert。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-revert-precondition-fail';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'revert precondition fail content\n');
      const mergeSha = await mergeTaskIntoMaster(repoRoot, taskBranch, taskId);
      const masterBefore = g(['rev-parse', 'master']);

      const revertResult = await performMasterRevert(taskId, repoRoot, mergeSha, async () =>
        makeReadback({ pathActive: true, serviceActiveState: 'active', deployedRev: mergeSha }),
      );

      assert.strictEqual(revertResult.kind, 'fatal');
      assert.strictEqual(g(['rev-parse', 'master']), masterBefore, 'service 仍 active 時不得執行 revert');
    }
  } finally {
    rmSync(repo.repoRoot, { recursive: true, force: true });
  }

  // ===========================================================================
  // Part D：regression guard——coordinator 絕不呼叫 `systemctl start
  // sim-autodeploy.service`（事實上這個 subsystem 沒有任何路徑會呼叫真正的
  // systemctl：readback 永遠透過注入的 getSystemdReadback／checkHealth 函式取得，
  // 兩者的型別簽章本身就沒有參數可以表達「start」這個動作）。這裡用原始碼靜態
  // 掃描把這件事變成一條會失敗的回歸測試，而不只是「程式碼裡沒有這行」的論證。
  // ===========================================================================
  {
    const gitTsSource = readFileSync(join(__dirname, 'production', 'git.ts'), 'utf8');
    const coordinatorTsSource = readFileSync(join(__dirname, 'production', 'coordinator.ts'), 'utf8');

    // coordinator.ts 完全不得 import node:child_process——它只透過注入的函式跟
    // systemd／HTTP 互動，結構上就不可能自己 shell out 呼叫任何東西（更不用說
    // systemctl start）。
    assert.ok(
      !coordinatorTsSource.includes('child_process'),
      'coordinator.ts 不得 import node:child_process：它必須只透過注入的 getSystemdReadback／checkHealth 跟外界互動',
    );

    // git.ts 是這個 subsystem 唯一允許 shell out 的檔案，但每一次呼叫
    // execFile／execFileAsync，實際執行的程式都必須是 'git'——逐一掃描原始碼裡
    // 每一次呼叫，而不是只檢查「沒有出現 systemctl 這個字」（註解裡本來就會提到
    // systemctl 這個字，用來解釋 readback adapter 對應的真實語意；重點是「程式碼
    // 真正會執行的程式只有 git」）。
    const execFileCallRe = /execFileAsync\(\s*'([^']+)'|(?<!Async)execFile\(\s*'([^']+)'/g;
    let match: RegExpExecArray | null;
    let execFileCallCount = 0;
    while ((match = execFileCallRe.exec(gitTsSource)) !== null) {
      execFileCallCount++;
      const program = match[1] ?? match[2];
      assert.strictEqual(
        program,
        'git',
        `git.ts 每一次 execFile／execFileAsync 呼叫的程式都必須是 'git'，但發現呼叫了 '${program}'（這正是「絕不呼叫 systemctl」這條規則的具體檢查）`,
      );
    }
    assert.ok(
      execFileCallCount >= 5,
      `sanity check：這個掃描本身至少要找到幾次 execFile 呼叫才有意義（實際找到 ${execFileCallCount} 次）——` +
        `數字太低代表 regex 本身可能壞了，沒有真的在檢查任何東西`,
    );
  }
}

async function main(): Promise<void> {
  await runApiTests();
  await runGitTests();
  await runAgentTests();
  runCoordinatorTests();
  await runDeployTests();
}

main()
  .then(() => console.log('production.test.ts OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
