import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
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

console.log('production.test.ts OK');
