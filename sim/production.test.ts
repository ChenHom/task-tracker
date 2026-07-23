import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
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
import type { TaskRun } from './production/types';
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

// ---------------------------------------------------------------------------
// LEASE_TTL_MS 必須嚴格大於 DEPLOY_WAIT_TIMEOUT_MS
// ---------------------------------------------------------------------------
// DEPLOY_WAIT_TIMEOUT_MS 的權威定義在 sim/production/git.ts（任務 6，尚未建立）。
// 這裡先以同值的 local literal 鎖住兩者的大小關係：任何一邊日後單獨調整，
// 這條斷言都會失敗，逼著調整者同時檢視另一邊，避免悄悄做出雙 coordinator 的風險。
const DEPLOY_WAIT_TIMEOUT_MS = 35 * 60 * 1000;
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

runApiTests()
  .then(() => console.log('production.test.ts OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
