import assert from 'node:assert';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const productionEvidenceSource = [
  join(__dirname, 'production.ts'),
  join(__dirname, 'production', 'deliveryEvidence.ts'),
].map((path) => readFileSync(path, 'utf8')).join('\n');
for (const kind of ['task.execution_started', 'commit.recorded', 'task.blocked', 'ci.checked', 'merge.integrated']) {
  assert.match(productionEvidenceSource, new RegExp(`kind: '${kind.replace('.', '\\.')}'`), `production 必須回送 ${kind}`);
}
assert.match(productionEvidenceSource, /'deployment\.verified'/, 'production 必須回送 deployment.verified');
assert.match(productionEvidenceSource, /failed: \$\{deployResult\.detail\}/, 'CI 失敗也必須寫 ci.checked 失敗結果');
assert.match(productionEvidenceSource, /trackGoalRunAttempt\(/, 'production Goal Task 必須寫入 goal_runs');
assert.match(productionEvidenceSource, /tracked\('primary'/, 'production 必須記錄 primary Run');
assert.match(productionEvidenceSource, /tracked\('fallback'/, 'production fallback 必須另記一筆 Run');
assert.match(productionEvidenceSource, /executeWithSingleFallback\(/, 'production 實作必須使用共用 adapter fallback 契約');
assert.match(productionEvidenceSource, /classifyAdapterResult\(/, 'production 實作必須使用共用 adapter result 分類');
assert.doesNotMatch(productionEvidenceSource, /throw new Error\(`Goal Task \$\{task\.taskId\} 的 Project repo 未登記`\)/, '未登記 repo 不得讓整個 tick 失敗');
assert.match(productionEvidenceSource, /repoUnavailable = true/, '未登記 repo 必須只標記該 Goal Task 略過');
assert.match(productionEvidenceSource, /setGoalWorktreeDirty\([^,]+,[^,]+, true\)/, 'member session 前必須標記 Goal worktree dirty');
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
  markCompletionDone,
  listUnbatchedCompletions,
  assignBatch,
  getCompletionsByBatch,
  listPendingBatchIds,
  recordBatchAttempt,
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
  type CommentSnapshot,
  type NotificationSnapshot,
} from './production/policy';
import {
  taskBranchName,
  taskWorktreePath,
  ensureTaskWorktree,
  seedWorktreeFiles,
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
  isAncestor,
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
  runDiscordOutboxTick,
  type AcceptanceCheckResult,
  type AcceptanceCheck,
  type IntegrationCommandRunner,
  type FatalCoordinatorError,
  type DiscordBatchMessage,
} from './production/coordinator';
import {
  buildCompletionComment,
  completionId,
  completionActionKey,
  postCompletionAndTransitionToDone,
  type CompletionOwnerClient,
  type CompletionNotifierClient,
} from './production/completion';
import {
  CUTOVER_TASKS as MIGRATE_CUTOVER_TASKS,
  ACTIVE_REVIEW_ACCEPTANCE_CRITERIA,
  QUEUED_REVIEW_ACCEPTANCE_CRITERIA,
  buildManifest,
  writeManifestFile,
  checkGenerationMatches,
  applyCutoverReconciliation,
  runApply,
  type CutoverBoardClient,
  type CutoverNotificationClient,
  type CutoverManifest,
} from './production/migrate';
import type { MemberSnapshot, AuditEventSnapshot } from './production/api';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/schema';
import { enqueueHeartbeat, finishRun, markRunRunning, prepareRun, type FinishRunInput, type PrepareRunInput } from '../src/goalRun';
import { trackGoalRunAttempt } from './goalUsage';
import { applyMemberAttemptTransition, assignAndStartDoing, dispatchOwnerReview, sendBackIntegrationConflict, coordinatorChildEnvironment, depsForTask, execAllowlistedCommand, goalRunTriggerRef, productionMemberAdapter, resolveGoalRoutes, withAction } from './production';

assert.deepStrictEqual(coordinatorChildEnvironment({ PATH: '/bin', TASK_TRACKER_COORDINATOR_TOKEN: 'secret' }), { PATH: '/bin' });

// registry 的 network / denyRead 只在 Goal task 帶到 actionDeps；其餘 task 與未設定時維持全域 deps
{
  const globalDeps = { repoRoot: '/global', allowedPrefixes: ['sim/'] } as unknown as Parameters<typeof depsForTask>[0];
  const goalTask = { taskId: 't', goalId: 'g', targetRepo: '/ext/repo', allowedPrefixes: ['src/'], sandboxNetwork: false, denyRead: ['Sinopac.pfx'] } as unknown as TaskSnapshot;
  const scoped = depsForTask(globalDeps, goalTask);
  assert.strictEqual(scoped.repoRoot, '/ext/repo');
  assert.deepStrictEqual(scoped.allowedPrefixes, ['src/']);
  assert.strictEqual(scoped.sandboxNetwork, false);
  assert.deepStrictEqual(scoped.denyRead, ['Sinopac.pfx']);
  const unset = depsForTask(globalDeps, { taskId: 't', goalId: 'g', targetRepo: '/ext/repo' } as unknown as TaskSnapshot);
  assert.strictEqual(unset.sandboxNetwork, undefined, 'registry 沒設定就不帶，runner 走預設');
  assert.strictEqual(unset.denyRead, undefined);
  assert.strictEqual(depsForTask(globalDeps, { taskId: 't', sandboxNetwork: false, denyRead: ['x'] } as unknown as TaskSnapshot), globalDeps, '非 Goal task 完全不動 deps');
  assert.strictEqual(depsForTask(globalDeps, undefined), globalDeps);
}

// registry claudeOnly=true：primary 不是 claude（codex、agy）就標 denied（不換模型）；fallback 不是 claude 一律丟掉；其餘（含未設定）行為不變
{
  const route = (primaryAdapter: 'claude' | 'codex' | 'agy', fallbackAdapter: 'claude' | 'codex' | 'agy' | null) => ({
    agentId: 'a', role: 'member', status: 'active', primaryAdapter, primaryModel: 'm1', effort: null,
    fallbackAdapter, fallbackModel: fallbackAdapter ? 'm2' : null,
  }) as Parameters<typeof resolveGoalRoutes>[0];
  const codexPrimary = resolveGoalRoutes(route('codex', null), true);
  assert.strictEqual(codexPrimary.primaryDenied, true, 'claudeOnly=true 時 codex primary 必須被拒');
  assert.deepStrictEqual(codexPrimary.primaryRoute, { runner: 'codex', model: 'm1' });
  assert.strictEqual(resolveGoalRoutes(route('agy', null), true).primaryDenied, true, 'claudeOnly=true 時 agy primary 必須被拒');
  assert.strictEqual(resolveGoalRoutes(route('claude', null), true).primaryDenied, false, 'claude primary 照常');
  assert.deepStrictEqual(resolveGoalRoutes(route('claude', 'codex'), true).fallbackRoute, null, 'claudeOnly=true 時 codex fallback 一律不用');
  assert.deepStrictEqual(resolveGoalRoutes(route('claude', 'agy'), true).fallbackRoute, null, 'claudeOnly=true 時 agy fallback 一律不用');
  assert.deepStrictEqual(resolveGoalRoutes(route('claude', 'claude'), true).fallbackRoute, { runner: 'claude', model: 'm2' }, 'claude fallback 保留');
  for (const claudeOnly of [undefined, false]) {
    assert.strictEqual(resolveGoalRoutes(route('codex', 'codex'), claudeOnly).primaryDenied, false, `claudeOnly=${claudeOnly} 時行為不變`);
    assert.strictEqual(resolveGoalRoutes(route('agy', 'agy'), claudeOnly).primaryDenied, false, `claudeOnly=${claudeOnly} 時 agy 行為不變`);
    assert.deepStrictEqual(resolveGoalRoutes(route('claude', 'codex'), claudeOnly).fallbackRoute, { runner: 'codex', model: 'm2' });
  }
  const globalDeps = { repoRoot: '/global', allowedPrefixes: ['sim/'] } as unknown as Parameters<typeof depsForTask>[0];
  const goalTask = { taskId: 't', goalId: 'g', targetRepo: '/ext/repo', claudeOnly: true } as unknown as TaskSnapshot;
  assert.strictEqual(depsForTask(globalDeps, goalTask).claudeOnly, true, 'registry claudeOnly 必須帶進 Goal task deps');
  assert.strictEqual(depsForTask(globalDeps, { ...goalTask, claudeOnly: undefined } as unknown as TaskSnapshot).claudeOnly, undefined);
  assert.strictEqual(depsForTask(globalDeps, { taskId: 't', claudeOnly: true } as unknown as TaskSnapshot), globalDeps, '非 Goal task 完全不動 deps');
}

async function runG1Tests(): Promise<void> {
  const db = openCoordinatorState(':memory:');
  const now = new Date('2026-10-14T00:00:00.000Z');
  const actionKey = 'preserve-pending-action';
  beginAction(db, { actionKey, taskId: 'task-pending-action', kind: 'test' }, now);
  const before = getAction(db, actionKey);
  let called = false;
  const deps = { db, now: () => new Date('2026-10-14T00:01:00.000Z'), tracer: () => () => undefined } as never;

  await withAction(deps, actionKey, 'test', 'task-pending-action', async () => {
    called = true;
    return 'must not run';
  });

  assert.strictEqual(called, false, 'status=pending 的 action 不得重新執行');
  assert.deepStrictEqual(getAction(db, actionKey), before, 'status=pending 的 action_log 必須維持不變');
  db.close();
}

async function runF5Tests(): Promise<void> {
  {
    const db = openCoordinatorState(':memory:');
    const now = new Date('2026-10-14T00:00:00.000Z');
    let calls = 0;
    const deps = { db, now: () => now, tracer: () => () => undefined } as never;

    await assert.rejects(
      withAction(deps, 'retry-failed-action', 'test', 'task-retry-action', async () => {
        calls++;
        throw new Error('first attempt failed');
      }),
      /first attempt failed/,
    );
    assert.strictEqual(getAction(db, 'retry-failed-action')?.status, 'failed');

    await withAction(deps, 'retry-failed-action', 'test', 'task-retry-action', async () => {
      calls++;
      return 'retried';
    });
    assert.strictEqual(calls, 2, 'status=failed 的 action 必須重新執行');
    assert.strictEqual(getAction(db, 'retry-failed-action')?.status, 'completed');
    db.close();
  }

  {
    const { repoRoot, g } = migrateTestRepo();
    const db = openCoordinatorState(':memory:');
    const taskId = 'f5-existing-worktree';
    const workspaceId = 'ws-f5';
    const assigneeId = 'user-f5';
    const now = new Date('2026-10-14T00:00:00.000Z');
    try {
      const baseSha = g(['rev-parse', 'master']);
      const originalWorktree = await ensureTaskWorktree(repoRoot, taskId, baseSha);
      writeFileSync(join(repoRoot, 'master-moved.txt'), 'new master commit\n');
      g(['add', 'master-moved.txt']);
      g(['commit', '-q', '-m', 'advance master']);
      assert.notStrictEqual(g(['rev-parse', 'master']), baseSha, 'fixture 必須讓 master 往前移');

      const run = upsertTaskCheckpoint(db, { taskId, workspaceId, phase: 'assigned', baseSha, evidenceFingerprint: '' }, now);
      const task = makeTask({ taskId, workspaceId, title: 'F5 base reuse', status: 'Doing', assigneeId });
      const ownerClient = {
        getTask: async () => task,
        patchTaskField: async () => task,
      };
      const deps = {
        db,
        ownerClient,
        repoRoot,
        now: () => now,
        tracer: () => () => undefined,
      } as never;

      await assignAndStartDoing(deps, { taskId, workspaceId } as never, run, assigneeId);
      const updated = getTaskRun(db, taskId)!;
      assert.strictEqual(updated.baseSha, baseSha, '既有 worktree 必須沿用 run.baseSha，不可改用已前進的 master');
      assert.strictEqual(taskWorktreePath(repoRoot, taskId), originalWorktree.path, '必須重用同一個 task worktree');
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }
}

async function runCoordinatorEnvironmentTest(): Promise<void> {
  const priorCoordinatorToken = process.env.TASK_TRACKER_COORDINATOR_TOKEN;
  process.env.TASK_TRACKER_COORDINATOR_TOKEN = 'must-not-reach-child';
  const childEnvironment = await execAllowlistedCommand('/usr/bin/env', tmpdir());
  assert.strictEqual(childEnvironment.exitCode, 0);
  assert.doesNotMatch(childEnvironment.output, /TASK_TRACKER_COORDINATOR_TOKEN/, 'repo command 不可繼承 coordinator credential');
  if (priorCoordinatorToken === undefined) delete process.env.TASK_TRACKER_COORDINATOR_TOKEN;
  else process.env.TASK_TRACKER_COORDINATOR_TOKEN = priorCoordinatorToken;
}

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
// completion_outbox 的 Discord batch 輔助函式（任務 7 新增）：
// listUnbatchedCompletions／assignBatch／getCompletionsByBatch／
// listPendingBatchIds／recordBatchAttempt。
// ---------------------------------------------------------------------------
{
  const db = openCoordinatorState(':memory:');
  const t0 = new Date('2026-07-23T03:00:00.000Z');

  enqueueCompletion(db, { completionId: 'c1', taskId: 'task-1' }, t0);
  enqueueCompletion(db, { completionId: 'c2', taskId: 'task-2' }, t0);
  assert.deepStrictEqual(
    listUnbatchedCompletions(db),
    [],
    '尚未 doneConfirmed 的 completion 不算 unbatched，不會被誤排進 Discord batch',
  );

  markCompletionDone(db, 'c1', t0);
  const unbatched = listUnbatchedCompletions(db);
  assert.strictEqual(unbatched.length, 1);
  assert.strictEqual(unbatched[0].completionId, 'c1');

  assert.throws(() => assignBatch(db, [], 'batch-x', t0), /non-empty/);
  assert.throws(() => assignBatch(db, ['unknown-id'], 'batch-x', t0), /not found/);

  assignBatch(db, ['c1'], 'batch-x', t0);
  assert.throws(
    () => assignBatch(db, ['c1'], 'batch-y', t0),
    /already belongs to a batch/,
    '已經有 batch_id 的 completion 不得被重新分配到另一個 batch',
  );

  assert.deepStrictEqual(listUnbatchedCompletions(db), [], 'c1 已經 batch 過，不應該再出現在 unbatched 清單');
  assert.deepStrictEqual(listPendingBatchIds(db), ['batch-x']);
  assert.strictEqual(getCompletionsByBatch(db, 'batch-x').length, 1);

  const afterAttempt = recordBatchAttempt(db, 'batch-x', 'failed', t0);
  assert.strictEqual(afterAttempt[0].attemptCount, 1);
  assert.strictEqual(afterAttempt[0].status, 'pending');
  assert.deepStrictEqual(listPendingBatchIds(db), ['batch-x']);

  assert.throws(() => recordBatchAttempt(db, 'no-such-batch', 'failed', t0), /no completion_outbox rows/);

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
    goalId: overrides.goalId ?? null,
    goalStatus: overrides.goalStatus ?? null,
    projectId: overrides.projectId ?? null,
    targetRepo: overrides.targetRepo ?? null,
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
    agentIds: overrides.agentIds ?? Object.entries(USER_IDS).filter(([email]) => email !== 'user09@test.local').map(([, id]) => id),
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

  const goalQueued = makeTask({ taskId: 'goal-queued', workspaceId: CANONICAL_WORKSPACE_ID, status: 'Todo', goalId: 'g1', goalStatus: 'Discussing' });
  const goalExecuting = makeTask({ taskId: 'goal-executing', workspaceId: CANONICAL_WORKSPACE_ID, status: 'Todo', goalId: 'g2', goalStatus: 'Executing' });
  const externalGoal = makeTask({ taskId: 'goal-external', workspaceId: 'third-workspace', status: 'Todo', goalId: 'g3', goalStatus: 'Executing', targetRepo: '/registered/repo' });
  const assignedGoal = makeTask({ taskId: 'goal-assigned', workspaceId: 'third-workspace', status: 'Todo', goalId: 'g4', goalStatus: 'Executing', targetRepo: '/registered/repo', assigneeId: USER_IDS['user03@test.local'] });
  const humanGoal = makeTask({ taskId: 'goal-human', workspaceId: 'third-workspace', status: 'Doing', goalId: 'g5', goalStatus: 'Executing', targetRepo: '/registered/repo', assigneeId: USER_IDS['user09@test.local'] });
  assert.strictEqual(selectCoordinatorActions(baseSnapshot({ tasks: [goalQueued] }), NOW).length, 0, '非 Executing Goal 的 Task 必須跳過');
  assert.strictEqual(selectCoordinatorActions(baseSnapshot({ tasks: [goalExecuting] }), NOW)[0]?.taskId, 'goal-executing');
  assert.strictEqual(selectCoordinatorActions(baseSnapshot({ tasks: [externalGoal] }), NOW)[0]?.taskId, 'goal-external', '已登記 repo 的 Goal Task 不受舊 workspace allowlist 限制');
  assert.strictEqual(selectCoordinatorActions(baseSnapshot({ tasks: [assignedGoal] }), NOW)[0]?.kind, 'assign_member', '已指派 Goal Task 必須保留 Owner 指派，不走 owner_dispatch');
  assert.strictEqual(selectCoordinatorActions(baseSnapshot({ tasks: [humanGoal] }), NOW).length, 0, '指派給人類的 Goal Task 不得進 member_work');

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
  const pastDueEvidence = { ...evidence, dueAt: pastDueTask.dueAt };
  const pastDueSnapshot = baseSnapshot({
    tasks: [pastDueTask],
    taskRuns: {
      [pastDueTask.taskId]: makeTaskRun({
        taskId: pastDueTask.taskId,
        workspaceId: MAIN_WORKSPACE_ID,
        evidenceFingerprint: taskEvidenceFingerprint(pastDueEvidence),
      }),
    },
    taskEvidence: { [pastDueTask.taskId]: pastDueEvidence },
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
    taskRuns: {
      [reviewTask.taskId]: makeTaskRun({
        taskId: reviewTask.taskId,
        workspaceId: reviewTask.workspaceId,
        phase: 'review',
        branch: `task/${reviewTask.taskId}`,
      }),
    },
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

    // 修改既有 tracked 檔：porcelain 第一筆是 ` M path`（開頭空白），不能被 trim 吃掉而把路徑切成 `eature/foo.txt`。
    {
      writeFileSync(join(wtA.path, 'feature', 'foo.txt'), 'hello again\n');
      const changes = await collectTaskChanges(wtA.path);
      assert.deepStrictEqual(changes.map((c) => c.path), ['feature/foo.txt'], '修改 tracked 檔必須回報完整路徑');
      assert.strictEqual(changes[0].status, 'modified');
      assert.doesNotThrow(() => validateTaskChanges(changes, ['feature/']), 'tracked 檔修改在 allowedPrefixes 內必須通過');
      g(['checkout', '--', 'feature/foo.txt'], wtA.path);
    }

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
    assert.strictEqual(ALLOWED_VERIFICATION_COMMANDS.length, 6, '固定字串形式應有 6 個（另外 2 個是帶 <name> 的樣板）');
    for (const cmd of [
      'npx tsc --noEmit',
      'npx tsc -p sim/tsconfig.json --noEmit',
      'npx tsx src/foo.test.ts',
      'npx tsx sim/foo.test.ts',
      'npm test',
      'npm run build',
      'git diff --check',
      'python3 -m pytest',
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
      'python3 -m pytest; rm -rf /',
      'python3 -c "import os"',
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
// seedWorktreeFiles：registry seedFiles 複製進 task worktree
// =============================================================================

async function runSeedFilesTests(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'sim-seed-files-'));
  const repoRoot = join(root, 'repo');
  const outside = join(root, 'outside.db');
  const g = (args: string[], cwd: string = repoRoot): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    mkdirSync(repoRoot);
    g(['init', '-q', '-b', 'master']);
    g(['config', 'user.email', 'seed-test@example.com']);
    g(['config', 'user.name', 'Seed Test']);
    writeFileSync(join(repoRoot, '.gitignore'), 'data/\n');
    writeFileSync(join(repoRoot, 'README.md'), 'root\n');
    g(['add', '.gitignore', 'README.md']);
    g(['commit', '-q', '-m', 'init']);
    mkdirSync(join(repoRoot, 'data'));
    writeFileSync(join(repoRoot, 'data', 'research.db'), 'main-db');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(repoRoot, 'data', 'link.db'));
    const wt = await ensureTaskWorktree(repoRoot, 'seed-task', g(['rev-parse', 'HEAD']));

    // 目標不存在、來源存在、目標被 git 忽略：複製，並建立父目錄。
    const first = await seedWorktreeFiles(repoRoot, wt.path, [{ from: 'data/research.db', to: 'data/_run.db' }]);
    assert.deepStrictEqual(first, { copied: ['data/_run.db'], problems: [] });
    assert.strictEqual(readFileSync(join(wt.path, 'data/_run.db'), 'utf8'), 'main-db');
    assert.strictEqual(g(['status', '--porcelain'], wt.path), '', '複製進來的 gitignored 檔不得出現在 git status');

    // 目標已存在（成員可能已改過）：不覆蓋。
    writeFileSync(join(wt.path, 'data/_run.db'), 'member-edited');
    const again = await seedWorktreeFiles(repoRoot, wt.path, [{ from: 'data/research.db', to: 'data/_run.db' }]);
    assert.deepStrictEqual(again, { copied: [], problems: [] });
    assert.strictEqual(readFileSync(join(wt.path, 'data/_run.db'), 'utf8'), 'member-edited', '已存在的目標不可被覆蓋');

    // 來源不存在：安靜略過。
    assert.deepStrictEqual(
      await seedWorktreeFiles(repoRoot, wt.path, [{ from: 'data/missing.db', to: 'data/_other.db' }]),
      { copied: [], problems: [] },
    );
    assert.strictEqual(existsSync(join(wt.path, 'data/_other.db')), false);

    // 目標不會被 git 忽略（commit 會把資料檔帶進 branch）：拒絕並回報。
    const tracked = await seedWorktreeFiles(repoRoot, wt.path, [{ from: 'data/research.db', to: 'docs/big.db' }]);
    assert.deepStrictEqual(tracked.copied, []);
    assert.match(tracked.problems[0] ?? '', /docs\/big\.db.*未被 git 忽略/u);
    assert.strictEqual(existsSync(join(wt.path, 'docs/big.db')), false, '被拒絕時不得留下檔案');

    // 來源是指向 repo 外的 symlink：拒絕。
    const escaped = await seedWorktreeFiles(repoRoot, wt.path, [{ from: 'data/link.db', to: 'data/_link.db' }]);
    assert.deepStrictEqual(escaped.copied, []);
    assert.match(escaped.problems[0] ?? '', /data\/link\.db/u);
    assert.strictEqual(existsSync(join(wt.path, 'data/_link.db')), false);

    // 一項失敗不影響後面的項目。
    const mixed = await seedWorktreeFiles(repoRoot, wt.path, [
      { from: 'data/research.db', to: 'docs/big.db' },
      { from: 'data/research.db', to: 'data/second.db' },
    ]);
    assert.deepStrictEqual(mixed.copied, ['data/second.db']);
    assert.strictEqual(mixed.problems.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

      // Python repo：registry 宣告 pytest 時，member 回報 pytest 不可被全域 allowlist 擋掉。
      writeFileSync(join(wt.path, 'feature', 'declared-allowlist-pytest.txt'), 'hello\n');
      const pytestResult = await runMemberSession({
        taskId,
        worktreePath: wt.path,
        allowedPrefixes,
        verificationCommandAllowlist: ['python3 -m pytest', 'git diff --check'],
        acceptanceCriteria: 'n/a',
        comments: [],
        previousBlocker: null,
        runner: makeRunner(0, makeOutput({ verificationCommands: ['python3 -m pytest'] })),
        runVerificationCommand: verify.run,
        driverActions: driver.actions,
      });
      assert.strictEqual(pytestResult.evidence.rejectedReason, null, 'Python repo 的 pytest 不應被 allowlist 擋掉');
      assert.ok(verify.calls.includes('python3 -m pytest'), 'pytest 必須真的被送去執行');
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

      const resultEmptySha = await runOwnerSession({
        taskId,
        acceptanceCriteria: 'n/a',
        comments: [],
        reviewedHeadSha: '',
        worktreePath: wt.path,
        runner: async () => ({
          exitCode: 0,
          decision: { action: 'accept', rationale: 'looks fine to me', evidenceCommentIds: [] },
        }),
      });
      assert.strictEqual(resultEmptySha.valid, false, 'reviewedHeadSha 空字串時 accept 必須被拒絕');
      assert.strictEqual(resultEmptySha.decision, null);

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

    // 登記為 deployment_not_required 的 repo 仍必須通過 CI、integration、merge，但不可誤用 task-tracker systemd/readback。
    {
      const taskId = 'deploy-not-required';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'docs only\n');
      let readbackCalls = 0;
      let liveCalls = 0;
      const integrationRunner = makeCountingIntegrationRunner();
      const result = await runDeployAcceptance({
        taskId, repoRoot, taskBranch, existingFatalError: null, deployment: 'not_required',
        runBranchCi: async () => ({ passed: true, detail: 'ok' }),
        runIntegrationCommand: integrationRunner.fn,
        integrationCommands: ['npx tsc --noEmit'],
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
        getSystemdReadback: async () => { readbackCalls++; return makeReadback(); },
        checkHealth: async () => makeHealth(),
        runTaskLiveAcceptance: async () => { liveCalls++; return { passed: true, detail: 'ok' }; },
        now: () => 0, sleep: noSleep,
      });
      assert.strictEqual(result.kind, 'deployed');
      assert.strictEqual(readbackCalls, 0);
      assert.strictEqual(liveCalls, 0);
      assert.deepStrictEqual(integrationRunner.calls, ['npx tsc --noEmit'], 'integration 必須使用 repo registry 登記的 checks');
      assert.match(g(['log', '-1', '--pretty=%B', 'master']), new RegExp(taskId));
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
      const conflictTraces: Array<{ event: string; args: Record<string, unknown> }> = [];

      const result = await runDeployAcceptance({
        taskId,
        repoRoot,
        taskBranch: branch,
        existingFatalError: null,
        trace: (event, args) => conflictTraces.push({ event, args: args as Record<string, unknown> }),
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
      assert.deepStrictEqual(result.kind === 'integration_conflict' ? result.conflictFiles : null, ['feature/conflict-target.txt']);
      const conflictCi = conflictTraces.find((t) => t.event === 'ci.checked' && t.args.reason === 'integration_conflict');
      assert.ok(conflictCi, 'runDeployAcceptance 的 integration_conflict 保險分支必須留 ci.checked trace');
      assert.strictEqual(conflictCi.args.outcome, 'fail');
      assert.match(String(conflictCi.args.detail), /feature\/conflict-target\.txt/);
      assert.strictEqual(g(['rev-parse', 'master']), masterBefore, 'integration conflict 之後 master 完全不得前進');
      assert.strictEqual(integrationRunner.calls.length, 0, '衝突偵測到後不得執行任何 integration command');
      assert.strictEqual(readbackCalls, 0, '衝突之後不得讀取 systemd readback');
      assert.strictEqual(existsSync(join(repoRoot, 'sim-work', 'integration', taskId)), false, '衝突之後必須清掉暫時 worktree');
      const worktreeList = g(['worktree', 'list', '--porcelain']);
      assert.ok(!worktreeList.includes(join(repoRoot, 'sim-work', 'integration', taskId)), '衝突之後 git 自己的 worktree 清單裡也不該再看到它');
    }

    // ---------------------------------------------------------------------------
    // B2b：崩潰復原——上一次 createIntegrationWorktree 建立的暫時 worktree，
    //     在 coordinator process 被中斷（OOM／host reboot／SIGKILL）、還沒跑到
    //     removeIntegrationWorktree 清理之前就殘留在原地。下一次對「同一個
    //     taskId」呼叫 createIntegrationWorktree 必須偵測到這個殘留、自動清掉，
    //     再從乾淨狀態重新建立——絕不能讓 `git worktree add` 直接對著已存在的
    //     路徑／已註冊的 worktree 拋出未結構化的 error，把這個 task 的部署路徑
    //     永久卡死到需要人工介入才能恢復。
    // ---------------------------------------------------------------------------
    {
      const taskId = 'deploy-stale-integration-worktree';
      const taskBranch = makeDeployTaskBranch(g, repoRoot, taskId, 'stale integration worktree content\n');
      const worktreePath = join(repoRoot, 'sim-work', 'integration', taskId);

      // 第一次呼叫：正常建立，但刻意不呼叫 removeIntegrationWorktree——模擬
      // process 在清理之前就被中斷，讓這個暫時 worktree 就地殘留。
      const first = await createIntegrationWorktree(repoRoot, taskId, taskBranch);
      assert.strictEqual(first.conflict, false);
      assert.ok(existsSync(worktreePath), '第一次呼叫之後，殘留的暫時 worktree 必須還在原地（模擬中斷前的狀態）');
      const worktreeListAfterFirst = g(['worktree', 'list', '--porcelain']);
      assert.ok(worktreeListAfterFirst.includes(`worktree ${worktreePath}`), '殘留的 worktree 必須仍然註冊在 git 的 worktree 清單裡');

      // 第二次呼叫（同一個 taskId／taskBranch，模擬 coordinator 重啟後對同一個 task
      // 重新跑一次 acceptance sequence）：不得拋出原始的 git error，必須偵測到殘留、
      // 自動清掉，再成功建立一個全新的暫時 worktree。
      const second = await createIntegrationWorktree(repoRoot, taskId, taskBranch);
      assert.strictEqual(second.conflict, false, '偵測到殘留 worktree 後，第二次呼叫必須成功清乾淨並重新建立，而不是丟出原始 git error');
      assert.strictEqual(second.path, worktreePath);
      assert.ok(existsSync(worktreePath), '清乾淨重建之後，worktree 目錄必須存在');

      await removeIntegrationWorktree(repoRoot, second);
      assert.strictEqual(existsSync(worktreePath), false, '正常清理之後，worktree 目錄不得殘留');
      const worktreeListAfterCleanup = g(['worktree', 'list', '--porcelain']);
      assert.ok(!worktreeListAfterCleanup.includes(`worktree ${worktreePath}`), '正常清理之後，git 的 worktree 清單裡也不得再看到它');
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

// =============================================================================
// completion.ts：任務 7 步驟 1-3——單一 task 的 SYSTEM 完成留言／user09
// notification readback／Review -> Done 轉移。全部用注入的假 CompletionOwnerClient／
// CompletionNotifierClient 測試（不需要真正的 HTTP server：這裡要驗證的是呼叫
// 順序、readback 優先、以及重試的冪等性，用輕量假物件最能精準控制每個分支）。
// =============================================================================

function makeCompletionTask(taskId: string, status: TaskStatus): TaskSnapshot {
  return {
    taskId,
    workspaceId: MAIN_WORKSPACE_ID,
    title: 'completion fixture',
    status,
    assigneeId: null,
    dueAt: null,
    updatedAt: null,
    version: 1,
  };
}

const COMPLETION_INPUT_DEFAULTS = {
  taskTitle: 'completion fixture task',
  summary: '修正驗證流程的 bug',
  verification: 'focused tests + integration + live acceptance 全部 PASS',
  deployRev: 'rev-fixture',
};

async function runCompletionTests(): Promise<void> {
  // -------------------------------------------------------------------------
  // 純函式：completionId／buildCompletionComment 必須逐字符合計畫模板。
  // -------------------------------------------------------------------------
  {
    assert.strictEqual(completionId('task-x', 'sha123'), 'task-x:sha123');
    assert.strictEqual(completionActionKey('task-x:sha123'), 'completion_comment:task-x:sha123');

    const content = buildCompletionComment({
      taskTitle: '範例任務',
      taskId: 'task-x',
      summary: '修正 XX bug',
      verification: 'focused tests + integration + live acceptance 全部 PASS',
      commitSha: 'sha123',
      deployRev: 'rev-9',
      completionId: 'task-x:sha123',
    });
    const expected = [
      '【SYSTEM完成】 @user09',
      'TASK：範例任務（task-x）',
      '功能／修改：修正 XX bug',
      '驗證：focused tests + integration + live acceptance 全部 PASS',
      'Commit：sha123',
      '部署版本：rev-9',
      '執行識別：task-x:sha123',
    ].join('\n');
    assert.strictEqual(content, expected, 'completion comment 必須逐字符合計畫模板');
  }

  // -------------------------------------------------------------------------
  // completion row 必須在留言 POST 之前就已經持久化（crash-recoverable 的核心保證）。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const taskId = 'completion-order-task';
    const headSha = 'headsha1';
    const id = completionId(taskId, headSha);

    let postCommentCalls = 0;
    let rowExistedAtPostTime: boolean | null = null;
    const comments: CommentSnapshot[] = [];
    let taskStatus: TaskStatus = 'Review';

    const ownerClient: CompletionOwnerClient = {
      async listComments() {
        return comments;
      },
      async postCommentOnce(_taskId, content) {
        postCommentCalls++;
        rowExistedAtPostTime = getCompletion(db, id) !== null;
        const commentId = 'comment-order-1';
        comments.push({ commentId, taskId, userId: 'user01-id', content, createdAt: '2026-07-23T00:00:01.000Z' });
        return commentId;
      },
      async getTask() {
        return makeCompletionTask(taskId, taskStatus);
      },
      async patchTaskField(_taskId, _field, value) {
        taskStatus = value as TaskStatus;
        return makeCompletionTask(taskId, taskStatus);
      },
    };
    const user09Client: CompletionNotifierClient = {
      async listNotifications() {
        return [
          {
            notificationId: 'notif-order-1',
            recipientId: 'user09-id',
            sourceTaskId: taskId,
            sourceCommentId: 'comment-order-1',
            snippet: '...',
            createdAt: '2026-07-23T00:00:00.000Z',
            readAt: null,
          },
        ];
      },
    };

    assert.strictEqual(getCompletion(db, id), null, '呼叫前不應該存在任何 completion row');

    const result = await postCompletionAndTransitionToDone({
      db,
      ownerClient,
      user09Client,
      user09Id: 'user09-id',
      taskId,
      acceptedHeadSha: headSha,
      ...COMPLETION_INPUT_DEFAULTS,
    });

    assert.strictEqual(postCommentCalls, 1);
    assert.strictEqual(rowExistedAtPostTime, true, 'completion row 必須在留言 POST 之前就已經持久化');
    assert.strictEqual(result.kind, 'done');
    const row = getCompletion(db, id);
    assert.ok(row, 'completion row 必須存在');
    assert.ok(row!.doneConfirmedAt, 'Done 確認後必須寫入 doneConfirmedAt');

    db.close();
  }

  // -------------------------------------------------------------------------
  // 模擬「crash」：postCommentOnce 明確失敗（比 UncertainMutationError 更粗暴的
  // 中止）。這必須回傳 `comment_failed`，不得 throw（見函式 JSDoc 的錯誤處理
  // 契約）；completion row 也不會因此消失——重新呼叫（模擬 process 重啟、用同一
  // 個持久化 db 重新驅動）必須能接續完成整個流程。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const taskId = 'completion-crash-resume';
    const headSha = 'headsha-crash';
    const id = completionId(taskId, headSha);

    let firstAttempt = true;
    const comments: CommentSnapshot[] = [];
    let taskStatus: TaskStatus = 'Review';

    const ownerClient: CompletionOwnerClient = {
      async listComments() {
        return comments;
      },
      async postCommentOnce(_taskId, content) {
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error('simulated process crash before any response'); // 明確失敗，不是 UncertainMutationError
        }
        const c = { commentId: 'comment-crash-resume', taskId, userId: 'user01-id', content, createdAt: 'x' };
        comments.push(c);
        return c.commentId;
      },
      async getTask() {
        return makeCompletionTask(taskId, taskStatus);
      },
      async patchTaskField(_taskId, _field, value) {
        taskStatus = value as TaskStatus;
        return makeCompletionTask(taskId, taskStatus);
      },
    };
    const user09Client: CompletionNotifierClient = {
      async listNotifications() {
        return [
          {
            notificationId: 'notif-crash-resume',
            recipientId: 'user09-id',
            sourceTaskId: taskId,
            sourceCommentId: 'comment-crash-resume',
            snippet: '...',
            createdAt: 'x',
            readAt: null,
          },
        ];
      },
    };

    const input = {
      db,
      ownerClient,
      user09Client,
      user09Id: 'user09-id',
      taskId,
      acceptedHeadSha: headSha,
      ...COMPLETION_INPUT_DEFAULTS,
    };

    const firstResult = await postCompletionAndTransitionToDone(input);
    assert.strictEqual(
      firstResult.kind,
      'comment_failed',
      '留言階段的明確失敗必須回傳 comment_failed，不得往上丟例外',
    );
    if (firstResult.kind === 'comment_failed') {
      assert.match(firstResult.reason, /simulated process crash/);
    }

    const rowAfterCrash = getCompletion(db, id);
    assert.ok(rowAfterCrash, 'crash 之後 completion row 必須仍然持久化著，可供重新驅動');
    assert.strictEqual(rowAfterCrash!.doneConfirmedAt, null, 'crash 當下還沒完成，不應該有 doneConfirmedAt');

    const result = await postCompletionAndTransitionToDone(input);
    assert.strictEqual(result.kind, 'done', '模擬 process 重啟後的重新呼叫必須能接續完成整個流程');

    db.close();
  }

  // -------------------------------------------------------------------------
  // 留言結果不確定、且 readback 也真的找不到相符的留言：必須回傳 comment_failed
  // （不是 throw），且不得繼續嘗試 PATCH、不得標記 Done。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const taskId = 'completion-comment-uncertain-unresolved';
    const headSha = 'headsha-unresolved';
    const id = completionId(taskId, headSha);

    let patchCalls = 0;
    const ownerClient: CompletionOwnerClient = {
      async listComments() {
        return []; // 不管重試幾次，readback 都找不到符合 marker 的留言
      },
      async postCommentOnce() {
        throw new UncertainMutationError('uncertain, never resolved');
      },
      async getTask() {
        return makeCompletionTask(taskId, 'Review');
      },
      async patchTaskField() {
        patchCalls++;
        throw new Error('patchTaskField must not be called when the comment stage failed');
      },
    };
    const user09Client: CompletionNotifierClient = {
      async listNotifications() {
        return [];
      },
    };

    const result = await postCompletionAndTransitionToDone({
      db,
      ownerClient,
      user09Client,
      user09Id: 'user09-id',
      taskId,
      acceptedHeadSha: headSha,
      ...COMPLETION_INPUT_DEFAULTS,
    });

    assert.strictEqual(
      result.kind,
      'comment_failed',
      '留言結果不確定且 readback 找不到相符留言時，必須回傳 comment_failed 而不是 throw',
    );
    if (result.kind === 'comment_failed') {
      assert.match(result.reason, /uncertain/);
    }
    assert.strictEqual(patchCalls, 0, '留言階段失敗時不得繼續嘗試 PATCH');

    const row = getCompletion(db, id);
    assert.ok(row, 'completion row 仍應該持久化著，供之後重試');
    assert.strictEqual(row!.doneConfirmedAt, null, '留言階段失敗時不得標記 Done');

    db.close();
  }

  // -------------------------------------------------------------------------
  // 不確定的 comment response：不得盲目重送，必須透過 marker／action key 對應的
  // readback 找回伺服器其實已經處理過的那則留言。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const taskId = 'completion-uncertain-task';
    const headSha = 'headsha2';
    const id = completionId(taskId, headSha);

    let postAttempts = 0;
    let listCommentsCalls = 0;
    const comments: CommentSnapshot[] = [];
    let taskStatus: TaskStatus = 'Review';

    const ownerClient: CompletionOwnerClient = {
      async listComments() {
        listCommentsCalls++;
        return comments;
      },
      async postCommentOnce(_taskId, content) {
        postAttempts++;
        // 模擬伺服器其實已經處理了這次 POST，但 response 在抵達 caller 前中斷。
        comments.push({ commentId: 'comment-uncertain', taskId, userId: 'user01-id', content, createdAt: 'x' });
        throw new UncertainMutationError('uncertain comment post');
      },
      async getTask() {
        return makeCompletionTask(taskId, taskStatus);
      },
      async patchTaskField(_taskId, _field, value) {
        taskStatus = value as TaskStatus;
        return makeCompletionTask(taskId, taskStatus);
      },
    };
    const user09Client: CompletionNotifierClient = {
      async listNotifications() {
        return [
          {
            notificationId: 'notif-uncertain-1',
            recipientId: 'user09-id',
            sourceTaskId: taskId,
            sourceCommentId: 'comment-uncertain',
            snippet: '...',
            createdAt: 'x',
            readAt: null,
          },
        ];
      },
    };

    const result = await postCompletionAndTransitionToDone({
      db,
      ownerClient,
      user09Client,
      user09Id: 'user09-id',
      taskId,
      acceptedHeadSha: headSha,
      ...COMPLETION_INPUT_DEFAULTS,
    });

    assert.strictEqual(postAttempts, 1, '結果不確定時不得自動重送同一個 POST');
    assert.ok(listCommentsCalls >= 2, '必須用 readback 找回不確定 response 背後其實已經落地的留言');
    assert.strictEqual(result.kind, 'done');
    if (result.kind === 'done') assert.strictEqual(result.commentId, 'comment-uncertain');

    db.close();
  }

  // -------------------------------------------------------------------------
  // user09 notification readback 必須早於 Review -> Done PATCH；user09Client
  // 的介面本身沒有任何「標記已讀」的方法可以呼叫。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const taskId = 'completion-order-notif';
    const headSha = 'headsha3';
    const callLog: string[] = [];
    const comments: CommentSnapshot[] = [];

    const ownerClient: CompletionOwnerClient = {
      async listComments() {
        callLog.push('listComments');
        return comments;
      },
      async postCommentOnce(_taskId, content) {
        callLog.push('postCommentOnce');
        const c = { commentId: 'comment-order-notif', taskId, userId: 'user01-id', content, createdAt: 'x' };
        comments.push(c);
        return c.commentId;
      },
      async getTask() {
        callLog.push('getTask');
        return makeCompletionTask(taskId, 'Review');
      },
      async patchTaskField() {
        callLog.push('patchTaskField');
        return makeCompletionTask(taskId, 'Done');
      },
    };
    const user09Client: CompletionNotifierClient = {
      async listNotifications() {
        callLog.push('listNotifications');
        return [
          {
            notificationId: 'notif-order-2',
            recipientId: 'user09-id',
            sourceTaskId: taskId,
            sourceCommentId: 'comment-order-notif',
            snippet: '...',
            createdAt: 'x',
            readAt: null,
          },
        ];
      },
    };

    await postCompletionAndTransitionToDone({
      db,
      ownerClient,
      user09Client,
      user09Id: 'user09-id',
      taskId,
      acceptedHeadSha: headSha,
      ...COMPLETION_INPUT_DEFAULTS,
    });

    const notifIndex = callLog.indexOf('listNotifications');
    const patchIndex = callLog.indexOf('patchTaskField');
    assert.notStrictEqual(notifIndex, -1);
    assert.notStrictEqual(patchIndex, -1);
    assert.ok(notifIndex < patchIndex, 'user09 notification readback 必須早於 Review -> Done PATCH');

    assert.deepStrictEqual(
      Object.keys(user09Client),
      ['listNotifications'],
      'user09Client 不得暴露任何「標記已讀」的方法可以被呼叫',
    );

    db.close();
  }

  // -------------------------------------------------------------------------
  // 找不到 user09 notification 時必須拒絕轉 Done（不得樂觀假設「應該已經有了」）。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const taskId = 'completion-missing-notif';
    const headSha = 'headsha4';

    const ownerClient: CompletionOwnerClient = {
      async listComments() {
        return [];
      },
      async postCommentOnce() {
        return 'comment-missing-notif';
      },
      async getTask() {
        return makeCompletionTask(taskId, 'Review');
      },
      async patchTaskField() {
        throw new Error('patchTaskField must not be called before notification readback succeeds');
      },
    };
    const user09Client: CompletionNotifierClient = {
      async listNotifications() {
        return [];
      },
    };

    await assert.rejects(
      () =>
        postCompletionAndTransitionToDone({
          db,
          ownerClient,
          user09Client,
          user09Id: 'user09-id',
          taskId,
          acceptedHeadSha: headSha,
          ...COMPLETION_INPUT_DEFAULTS,
        }),
      /no notification found/,
      '找不到 user09 notification 時必須拒絕轉 Done',
    );

    db.close();
  }

  // -------------------------------------------------------------------------
  // status failure 不會重複留言：第一次 PATCH 明確失敗，重試（第二次呼叫）只應
  // 該重打 PATCH，不得回頭重貼留言。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const taskId = 'completion-patch-retry';
    const headSha = 'headsha5';
    const comments: CommentSnapshot[] = [];
    let postCalls = 0;
    let patchCalls = 0;
    let shouldFailPatch = true;
    let taskStatus: TaskStatus = 'Review';

    const ownerClient: CompletionOwnerClient = {
      async listComments() {
        return comments;
      },
      async postCommentOnce(_taskId, content) {
        postCalls++;
        const c = { commentId: 'comment-patch-retry', taskId, userId: 'user01-id', content, createdAt: 'x' };
        comments.push(c);
        return c.commentId;
      },
      async getTask() {
        return makeCompletionTask(taskId, taskStatus);
      },
      async patchTaskField(_taskId, _field, value) {
        patchCalls++;
        if (shouldFailPatch) throw new Error('db write conflict'); // 明確失敗，不是 UncertainMutationError
        taskStatus = value as TaskStatus;
        return makeCompletionTask(taskId, taskStatus);
      },
    };
    const user09Client: CompletionNotifierClient = {
      async listNotifications() {
        return [
          {
            notificationId: 'notif-patch-retry',
            recipientId: 'user09-id',
            sourceTaskId: taskId,
            sourceCommentId: 'comment-patch-retry',
            snippet: '...',
            createdAt: 'x',
            readAt: null,
          },
        ];
      },
    };

    const input = {
      db,
      ownerClient,
      user09Client,
      user09Id: 'user09-id',
      taskId,
      acceptedHeadSha: headSha,
      ...COMPLETION_INPUT_DEFAULTS,
    };

    const firstResult = await postCompletionAndTransitionToDone(input);
    assert.strictEqual(firstResult.kind, 'patch_failed');
    assert.strictEqual(postCalls, 1, '第一次呼叫必須貼一次留言');
    assert.strictEqual(patchCalls, 1);

    shouldFailPatch = false;
    const secondResult = await postCompletionAndTransitionToDone(input);
    assert.strictEqual(secondResult.kind, 'done', 'PATCH 重試成功後應該完成 Done 轉移');
    assert.strictEqual(postCalls, 1, 'status PATCH 失敗後重試，不得重複留言');
    assert.strictEqual(patchCalls, 2, '重試只應該再打一次 PATCH');

    db.close();
  }

  // -------------------------------------------------------------------------
  // PATCH 結果不確定，但 readback 顯示伺服器其實已經套用（Done）：必須視為成功，
  // 不得再送第二次 PATCH。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const taskId = 'completion-patch-uncertain-success';
    const headSha = 'headsha5b';
    const comments: CommentSnapshot[] = [];
    let taskStatus: TaskStatus = 'Review';
    let patchCalls = 0;

    const ownerClient: CompletionOwnerClient = {
      async listComments() {
        return comments;
      },
      async postCommentOnce(_taskId, content) {
        const c = { commentId: 'comment-patch-unc', taskId, userId: 'user01-id', content, createdAt: 'x' };
        comments.push(c);
        return c.commentId;
      },
      async getTask() {
        return makeCompletionTask(taskId, taskStatus);
      },
      async patchTaskField() {
        patchCalls++;
        taskStatus = 'Done'; // 伺服器端其實已經套用了這次 mutation
        throw new UncertainMutationError('uncertain patch');
      },
    };
    const user09Client: CompletionNotifierClient = {
      async listNotifications() {
        return [
          {
            notificationId: 'notif-patch-unc',
            recipientId: 'user09-id',
            sourceTaskId: taskId,
            sourceCommentId: 'comment-patch-unc',
            snippet: '...',
            createdAt: 'x',
            readAt: null,
          },
        ];
      },
    };

    const result = await postCompletionAndTransitionToDone({
      db,
      ownerClient,
      user09Client,
      user09Id: 'user09-id',
      taskId,
      acceptedHeadSha: headSha,
      ...COMPLETION_INPUT_DEFAULTS,
    });
    assert.strictEqual(result.kind, 'done', 'PATCH 不確定但 readback 顯示已經 Done 時必須視為成功，不重送 PATCH');
    assert.strictEqual(patchCalls, 1);

    db.close();
  }

  // -------------------------------------------------------------------------
  // 完全成功之後的重呼叫（idempotent resume）：不得重貼留言，也不得重打 PATCH
  // （getTask readback 已經看到 Done）。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const taskId = 'completion-idempotent-full';
    const headSha = 'headsha6';
    const comments: CommentSnapshot[] = [];
    let postCalls = 0;
    let patchCalls = 0;
    let taskStatus: TaskStatus = 'Review';

    const ownerClient: CompletionOwnerClient = {
      async listComments() {
        return comments;
      },
      async postCommentOnce(_taskId, content) {
        postCalls++;
        const c = { commentId: 'comment-idem', taskId, userId: 'user01-id', content, createdAt: 'x' };
        comments.push(c);
        return c.commentId;
      },
      async getTask() {
        return makeCompletionTask(taskId, taskStatus);
      },
      async patchTaskField(_taskId, _field, value) {
        patchCalls++;
        taskStatus = value as TaskStatus;
        return makeCompletionTask(taskId, taskStatus);
      },
    };
    const user09Client: CompletionNotifierClient = {
      async listNotifications() {
        return [
          {
            notificationId: 'notif-idem',
            recipientId: 'user09-id',
            sourceTaskId: taskId,
            sourceCommentId: 'comment-idem',
            snippet: '...',
            createdAt: 'x',
            readAt: null,
          },
        ];
      },
    };
    const input = {
      db,
      ownerClient,
      user09Client,
      user09Id: 'user09-id',
      taskId,
      acceptedHeadSha: headSha,
      ...COMPLETION_INPUT_DEFAULTS,
    };

    const r1 = await postCompletionAndTransitionToDone(input);
    assert.strictEqual(r1.kind, 'done');
    const r2 = await postCompletionAndTransitionToDone(input);
    assert.strictEqual(r2.kind, 'done');

    assert.strictEqual(postCalls, 1, '完全成功後重呼叫不得重貼留言');
    assert.strictEqual(patchCalls, 1, '完全成功後重呼叫不得重複 PATCH（getTask readback 已經看到 Done）');

    db.close();
  }

  // -------------------------------------------------------------------------
  // 真實 HTTP + cookie jar 端到端：用 api.ts 真正的 TaskTrackerClient（分別以
  // user01／user09 身分登入）打一個假 node:http server，驗證整條流程在真實
  // HTTP 語意下也成立（不是只在手寫假物件底下成立）。
  // -------------------------------------------------------------------------
  {
    const taskId = 'completion-e2e-task';
    const headSha = 'e2e-sha-1';
    const user09Id = 'user09-canonical-id';

    let taskStatus: TaskStatus = 'Review';
    const comments: Array<{ comment_id: string; task_id: string; user_id: string; content: string; created_at: string }> = [];
    let postCommentCalls = 0;
    let patchCalls = 0;

    const { port, close } = await startFakeServer((req, res) => {
      const cookie = req.headers.cookie ?? '';
      const isUser09 = cookie.includes('tt_session=user09-session');

      if (req.url === '/api/auth/login' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const sessionCookie = body.email === 'user09@test.local' ? 'user09-session' : 'user01-session';
            res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `tt_session=${sessionCookie}; HttpOnly; Path=/` });
            res.end(JSON.stringify({ ok: true }));
          })
          .catch(() => {
            res.writeHead(400);
            res.end();
          });
        return;
      }
      if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(comments));
        return;
      }
      if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'POST') {
        postCommentCalls++;
        readJsonBody(req)
          .then((body) => {
            const commentId = 'e2e-comment-1';
            comments.push({ comment_id: commentId, task_id: taskId, user_id: 'user01-id', content: body.content, created_at: '2026-07-23T00:00:01.000Z' });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: commentId }));
          })
          .catch(() => {
            res.writeHead(400);
            res.end();
          });
        return;
      }
      if (req.url === '/api/notifications' && req.method === 'GET') {
        if (!isUser09) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthenticated' }));
          return;
        }
        const notifications = comments.length > 0
          ? [
              {
                notification_id: 'e2e-notif-1',
                recipient_id: user09Id,
                source_task_id: taskId,
                source_comment_id: comments[0].comment_id,
                snippet: '...',
                created_at: '2026-07-23T00:00:02.000Z',
                read_at: null,
              },
            ]
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(notifications));
        return;
      }
      if (req.url === `/api/tasks/${taskId}` && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            task_id: taskId,
            workspace_id: MAIN_WORKSPACE_ID,
            title: 'e2e completion fixture',
            status: taskStatus,
            assignee_id: null,
            due_at: null,
            version: 1,
            updated_at: null,
          }),
        );
        return;
      }
      if (req.url === `/api/tasks/${taskId}` && req.method === 'PATCH') {
        patchCalls++;
        readJsonBody(req)
          .then((body) => {
            taskStatus = body.status;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          })
          .catch(() => {
            res.writeHead(400);
            res.end();
          });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const db = openCoordinatorState(':memory:');
      const ownerClient = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 1, retryDelayMs: 5 });
      await ownerClient.login('user01@test.local', 'whatever');
      const user09Client = new TaskTrackerClient({ baseUrl: `http://127.0.0.1:${port}`, retries: 1, retryDelayMs: 5 });
      await user09Client.login('user09@test.local', 'whatever');

      const result = await postCompletionAndTransitionToDone({
        db,
        ownerClient,
        user09Client,
        user09Id,
        taskId,
        acceptedHeadSha: headSha,
        ...COMPLETION_INPUT_DEFAULTS,
      });

      assert.strictEqual(result.kind, 'done', '真實 HTTP client 底下整條流程也必須成功完成');
      assert.strictEqual(postCommentCalls, 1);
      assert.strictEqual(patchCalls, 1);
      assert.strictEqual(taskStatus, 'Done');
      if (result.kind === 'done') {
        assert.strictEqual(result.task.status, 'Done');
        assert.strictEqual(result.commentId, 'e2e-comment-1');
      }

      const row = getCompletion(db, completionId(taskId, headSha));
      assert.ok(row?.doneConfirmedAt, '真實 HTTP 流程完成後也必須寫入 doneConfirmedAt');

      db.close();
    } finally {
      await close();
    }
  }
}

// =============================================================================
// coordinator.ts：任務 7 步驟 4——Discord outbox 的 tick 級 batch／重試。
// completion.ts 對 Discord 一無所知，這裡也完全不碰任何 TaskTrackerClient——
// 只操作 completion_outbox（透過 state.ts）與注入的假 sendDiscordMessage。
// =============================================================================

async function runDiscordOutboxTests(): Promise<void> {
  // -------------------------------------------------------------------------
  // 同一 tick 的所有新 completion 形成單一 batch：三個已經 Done 確認、但尚未
  // batch 過的 completion，第一次呼叫就必須合併成同一個 batch_id，只送出一次
  // Discord 訊息（不是三則）。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const t0 = new Date('2026-07-23T10:00:00.000Z');
    for (const taskId of ['task-a', 'task-b', 'task-c']) {
      const id = completionId(taskId, `sha-${taskId}`);
      enqueueCompletion(db, { completionId: id, taskId }, t0);
      markCompletionDone(db, id, t0);
    }

    let sendCalls = 0;
    const sentPayloads: DiscordBatchMessage[] = [];
    const outcomes = await runDiscordOutboxTick({
      db,
      newBatchId: () => 'batch-1',
      sendDiscordMessage: async (msg) => {
        sendCalls++;
        sentPayloads.push(msg);
        return true;
      },
      now: t0,
    });

    assert.strictEqual(sendCalls, 1, '同一 tick 的所有新 completion 必須合併成單一 Discord 傳送');
    assert.strictEqual(sentPayloads[0]!.taskIds.length, 3);
    assert.deepStrictEqual([...sentPayloads[0]!.taskIds].sort(), ['task-a', 'task-b', 'task-c']);
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0]!.status, 'sent');

    for (const taskId of ['task-a', 'task-b', 'task-c']) {
      const id = completionId(taskId, `sha-${taskId}`);
      assert.strictEqual(getCompletion(db, id)!.batchId, 'batch-1');
      assert.strictEqual(getCompletion(db, id)!.status, 'sent');
    }

    db.close();
  }

  // -------------------------------------------------------------------------
  // Discord 最多嘗試三次：連續三個 tick 都失敗，第三次後轉 notify_failed，第四個
  // tick 不得再自動重試；task 的 Done 狀態（completion row 的 doneConfirmedAt）
  // 完全不受 Discord 失敗影響。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const t0 = new Date('2026-07-23T11:00:00.000Z');
    const taskId = 'task-retry-fail';
    const id = completionId(taskId, 'sha-retry');
    enqueueCompletion(db, { completionId: id, taskId }, t0);
    markCompletionDone(db, id, t0);

    let sendCalls = 0;
    const attempt = (tickN: number) =>
      runDiscordOutboxTick({
        db,
        newBatchId: () => 'batch-retry',
        sendDiscordMessage: async () => {
          sendCalls++;
          return false; // 每次都失敗
        },
        now: new Date(t0.getTime() + tickN * 60_000),
      });

    const tick1 = await attempt(1);
    assert.strictEqual(tick1[0]!.status, 'pending');
    assert.strictEqual(tick1[0]!.attemptCount, 1);

    const tick2 = await attempt(2);
    assert.strictEqual(tick2[0]!.status, 'pending');
    assert.strictEqual(tick2[0]!.attemptCount, 2);

    const tick3 = await attempt(3);
    assert.strictEqual(tick3[0]!.status, 'notify_failed', '第三次仍失敗後必須轉為 notify_failed');
    assert.strictEqual(tick3[0]!.attemptCount, 3);

    assert.strictEqual(sendCalls, 3, 'Discord 最多嘗試三次');

    const tick4 = await attempt(4);
    assert.strictEqual(tick4.length, 0, 'notify_failed 之後不得再自動重試');
    assert.strictEqual(sendCalls, 3, '第四次呼叫不得再多打一次 Discord');

    const finalRow = getCompletion(db, id)!;
    assert.ok(finalRow.doneConfirmedAt, 'Discord 通知失敗不得影響已經確認的 Done 狀態');
    assert.strictEqual(
      finalRow.doneConfirmedAt,
      t0.toISOString(),
      'doneConfirmedAt 不應該被 Discord 重試邏輯改動——最後 Discord 仍失敗時 task 保持 Done',
    );

    db.close();
  }

  // -------------------------------------------------------------------------
  // 舊 batch 還在重試視窗內時，新完成的 task 必須形成獨立的新 batch，不會被塞進
  // 尚未解決的舊 batch（batch 一旦形成就是封閉集合）。
  // -------------------------------------------------------------------------
  {
    const db = openCoordinatorState(':memory:');
    const t0 = new Date('2026-07-23T12:00:00.000Z');
    const idOld = completionId('task-old', 'sha-old');
    enqueueCompletion(db, { completionId: idOld, taskId: 'task-old' }, t0);
    markCompletionDone(db, idOld, t0);

    let batchCounter = 0;
    const newBatchId = () => `batch-${++batchCounter}`;

    const tick1 = await runDiscordOutboxTick({
      db,
      newBatchId,
      sendDiscordMessage: async () => false,
      now: t0,
    });
    assert.strictEqual(tick1.length, 1);
    assert.strictEqual(tick1[0]!.batchId, 'batch-1');
    assert.strictEqual(tick1[0]!.status, 'pending');

    const idNew = completionId('task-new', 'sha-new');
    enqueueCompletion(db, { completionId: idNew, taskId: 'task-new' }, t0);
    markCompletionDone(db, idNew, t0);

    const tick2 = await runDiscordOutboxTick({
      db,
      newBatchId,
      sendDiscordMessage: async () => true,
      now: new Date(t0.getTime() + 60_000),
    });

    assert.strictEqual(tick2.length, 2, '舊 batch 的重試與新 batch 的第一次嘗試必須各自獨立處理');
    const byBatch = new Map(tick2.map((o) => [o.batchId, o]));
    const oldOutcome = byBatch.get('batch-1')!;
    const newOutcome = [...byBatch.values()].find((o) => o.batchId !== 'batch-1')!;
    assert.deepStrictEqual(oldOutcome.taskIds, ['task-old']);
    assert.deepStrictEqual(newOutcome.taskIds, ['task-new']);
    assert.notStrictEqual(oldOutcome.batchId, newOutcome.batchId, '新完成的 task 不得被塞進尚未解決的舊 batch');

    db.close();
  }
}

// =============================================================================
// sim/production/migrate.ts（任務 9）：cutover manifest／generation-bound
// preflight／idempotent reconciliation。100% fakes——一個 fake board client（純
// in-memory plain object，呼應 completion.ts 既有的 CompletionOwnerClient／
// CompletionNotifierClient 慣例）+ 真實暫存 git repo（呼應 runGitTests／
// runDeployTests 既有慣例）。從不連 localhost:3000，也不碰真正的專案 git repo。
// =============================================================================

interface FakeBoardCalls {
  getTask: string[];
  listComments: string[];
  postCommentOnce: { taskId: string; content: string; actionKey: string }[];
  patchTaskField: { taskId: string; field: string; value: unknown }[];
  listMembers: string[];
  getAuditTrail: string[];
  whoAmI: number;
  health: number;
}

interface FakeBoardState {
  tasks: Map<string, TaskSnapshot>;
  comments: Map<string, CommentSnapshot[]>;
  members: MemberSnapshot[];
  auditTrails: Map<string, AuditEventSnapshot[]>;
  notifications: NotificationSnapshot[];
  healthRev: string;
  whoAmIId: string;
  /** 下一次 patchTaskField 是否要先拋一次 UncertainMutationError（測完即自動清除，只影響一次呼叫）。 */
  uncertainOnce: boolean;
}

function makeFakeBoardClient(state: FakeBoardState): { client: CutoverBoardClient; calls: FakeBoardCalls } {
  const calls: FakeBoardCalls = {
    getTask: [],
    listComments: [],
    postCommentOnce: [],
    patchTaskField: [],
    listMembers: [],
    getAuditTrail: [],
    whoAmI: 0,
    health: 0,
  };
  let commentSeq = 0;
  const client: CutoverBoardClient = {
    async getTask(taskId) {
      calls.getTask.push(taskId);
      const t = state.tasks.get(taskId);
      if (!t) throw new Error(`fake getTask: unknown task ${taskId}`);
      return t;
    },
    async listComments(taskId) {
      calls.listComments.push(taskId);
      return state.comments.get(taskId) ?? [];
    },
    async postCommentOnce(taskId, content, actionKey) {
      calls.postCommentOnce.push({ taskId, content, actionKey });
      const commentId = `fake-comment-${++commentSeq}`;
      const list = state.comments.get(taskId) ?? [];
      list.push({ commentId, taskId, userId: state.whoAmIId, content, createdAt: '2026-07-24T00:00:00.000Z' });
      state.comments.set(taskId, list);
      return commentId;
    },
    async patchTaskField(taskId, field, value) {
      calls.patchTaskField.push({ taskId, field, value });
      if (state.uncertainOnce) {
        state.uncertainOnce = false;
        // 先真的套用變更（模擬「其實成功了，只是回應不確定」），再拋出
        // UncertainMutationError——呼叫端必須靠 readback 發現它已經生效。
        const existing = state.tasks.get(taskId)!;
        const updated: TaskSnapshot =
          field === 'status'
            ? { ...existing, status: value as TaskStatus, version: existing.version + 1 }
            : { ...existing, assigneeId: value as string | null, version: existing.version + 1 };
        state.tasks.set(taskId, updated);
        throw new UncertainMutationError('fake uncertain mutation');
      }
      const existing = state.tasks.get(taskId);
      if (!existing) throw new Error(`fake patchTaskField: unknown task ${taskId}`);
      const updated: TaskSnapshot =
        field === 'status'
          ? { ...existing, status: value as TaskStatus, version: existing.version + 1 }
          : { ...existing, assigneeId: value as string | null, version: existing.version + 1 };
      state.tasks.set(taskId, updated);
      return updated;
    },
    async listMembers(workspaceId) {
      calls.listMembers.push(workspaceId);
      return state.members;
    },
    async getAuditTrail(aggregateId) {
      calls.getAuditTrail.push(aggregateId);
      return state.auditTrails.get(aggregateId) ?? [];
    },
    async whoAmI() {
      calls.whoAmI++;
      return { id: state.whoAmIId, email: 'user01@test.local', name: 'Owner' };
    },
    async health() {
      calls.health++;
      return { status: 'ok', db: true, rev: state.healthRev };
    },
  };
  return { client, calls };
}

function makeFakeNotificationClient(state: FakeBoardState): { client: CutoverNotificationClient; calls: { listNotifications: number } } {
  const calls = { listNotifications: 0 };
  return {
    client: {
      async listNotifications() {
        calls.listNotifications++;
        return state.notifications;
      },
    },
    calls,
  };
}

/** 逐字符合 production.ts `parseCompletionCommentFields` 的解析格式。 */
function buildTask1CompletionComment(fields: {
  task1AuthorizedAt: string;
  canonicalOwnerId: string;
  assignmentEventId: string;
  taskBranch: string;
  acceptedHeadSha: string;
  ownerAcceptanceId: string;
  mergeSha: string;
  liveRev: string;
}): string {
  return [
    '【SYSTEM完成】 @user09',
    `Task 1 授權時間：${fields.task1AuthorizedAt}`,
    `Canonical Owner ID：${fields.canonicalOwnerId}`,
    `Assignment audit event ID：${fields.assignmentEventId}`,
    `Task branch：${fields.taskBranch}`,
    `Accepted head：${fields.acceptedHeadSha}`,
    `Owner acceptance ID：${fields.ownerAcceptanceId}`,
    `Merge SHA：${fields.mergeSha}`,
    `部署版本／live rev：${fields.liveRev}`,
  ].join('\n');
}

function migrateTestRepo(): { repoRoot: string; g: (args: string[], cwd?: string) => string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'sim-production-migrate-'));
  const g = (args: string[], cwd: string = repoRoot): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'sim-migrate-test@example.com']);
  g(['config', 'user.name', 'Sim Migrate Test']);
  writeFileSync(join(repoRoot, 'README.md'), 'root\n');
  g(['add', 'README.md']);
  g(['commit', '-q', '-m', 'init']);
  return { repoRoot, g };
}

/** 建立 legacy `sim/user02`／`sim/user06` branch，內容含禁止重用的 marker（933b974／f94b69e）。 */
function seedLegacyBranches(g: (args: string[], cwd?: string) => string, repoRoot: string): void {
  for (const branch of ['sim/user02', 'sim/user06']) {
    g(['checkout', '-q', '-b', branch, 'master']);
    writeFileSync(join(repoRoot, `LEGACY-${branch.replace('/', '-')}.txt`), 'legacy dirty work referencing 933b974 and f94b69e\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', `legacy commit on ${branch} referencing 933b974 and f94b69e`]);
  }
  g(['checkout', '-q', 'master']);
}

/**
 * 在真實 git repo 上建立一組完全自洽、可通過 validatePrerequisiteEvidence 的
 * `00123ef0...` 完成證據（accepted head commit + Task-Id trailer + --no-ff merge），
 * 並回傳建置好的 FakeBoardState 基礎資料（其餘四個 cutover task 由呼叫端自己疊加）。
 */
function seedSatisfiedPrerequisite(
  g: (args: string[], cwd?: string) => string,
  repoRoot: string,
): { state: FakeBoardState; acceptedHeadSha: string; mergeSha: string } {
  const prereqTaskId = MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId;
  const branch = MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskBranch;
  g(['checkout', '-q', '-b', branch, 'master']);
  writeFileSync(join(repoRoot, 'task1-fix.txt'), 'fixed main discussion closure\n');
  g(['add', 'task1-fix.txt']);
  g(['commit', '-q', '-m', `fix: simplify main discussion closure\n\nTask-Id: ${prereqTaskId}`]);
  const acceptedHeadSha = g(['rev-parse', 'HEAD']);
  g(['checkout', '-q', 'master']);
  g(['merge', '--no-ff', branch, '-m', `merge ${prereqTaskId}`]);
  const mergeSha = g(['rev-parse', 'master']);

  const task1AuthorizedAt = '2026-07-20T00:00:00.000Z';
  const ownerId = USER_IDS['user01@test.local'];
  const user03Id = USER_IDS['user03@test.local'];
  const user09Id = USER_IDS['user09@test.local'];
  const assignmentEventId = '42';
  const ownerAcceptanceId = 'acceptance-comment-1';

  const completionContent = buildTask1CompletionComment({
    task1AuthorizedAt,
    canonicalOwnerId: ownerId,
    assignmentEventId,
    taskBranch: branch,
    acceptedHeadSha,
    ownerAcceptanceId,
    mergeSha,
    liveRev: mergeSha,
  });

  const prereqComments: CommentSnapshot[] = [
    {
      commentId: ownerAcceptanceId,
      taskId: prereqTaskId,
      userId: ownerId,
      content: `【OWNER驗收】accepted head ${acceptedHeadSha}`,
      createdAt: '2026-07-20T10:00:00.000Z',
    },
    { commentId: 'completion-comment-1', taskId: prereqTaskId, userId: ownerId, content: completionContent, createdAt: '2026-07-20T11:00:00.000Z' },
  ];

  const members: MemberSnapshot[] = [
    { userId: ownerId, role: 'Owner', email: 'user01@test.local', name: 'user01' },
    { userId: user03Id, role: 'Member', email: 'user03@test.local', name: 'user03' },
    { userId: USER_IDS['user05@test.local'], role: 'Member', email: 'user05@test.local', name: 'user05' },
    { userId: USER_IDS['user06@test.local'], role: 'Member', email: 'user06@test.local', name: 'user06' },
    { userId: user09Id, role: 'Member', email: 'user09@test.local', name: 'user09' },
  ];

  const auditTrails = new Map<string, AuditEventSnapshot[]>([
    [
      prereqTaskId,
      [
        {
          id: 42,
          aggregateId: prereqTaskId,
          aggregateVersion: 2,
          eventType: 'task.assignee_changed',
          payload: { assigneeId: user03Id },
          actorId: ownerId,
          occurredAt: '2026-07-20T00:30:00.000Z',
        },
      ],
    ],
  ]);

  const notifications: NotificationSnapshot[] = [
    {
      notificationId: 'notif-1',
      recipientId: user09Id,
      sourceTaskId: prereqTaskId,
      sourceCommentId: 'completion-comment-1',
      snippet: '...',
      createdAt: '2026-07-20T11:00:01.000Z',
      readAt: null,
    },
  ];

  const tasks = new Map<string, TaskSnapshot>();
  tasks.set(
    prereqTaskId,
    makeTask({ taskId: prereqTaskId, workspaceId: CANONICAL_WORKSPACE_ID, title: '00123ef0 fixture', status: 'Done', assigneeId: user03Id, version: 2 }),
  );

  const state: FakeBoardState = {
    tasks,
    comments: new Map([[prereqTaskId, prereqComments]]),
    members,
    auditTrails,
    notifications,
    healthRev: mergeSha,
    whoAmIId: ownerId,
    uncertainOnce: false,
  };

  return { state, acceptedHeadSha, mergeSha };
}

/** 把「四個固定 cutover task」疊加進一個已經有 satisfied prerequisite 的 FakeBoardState。 */
function seedFourCutoverTasks(
  state: FakeBoardState,
  overrides: {
    mainDiscussion?: Partial<TaskSnapshot>;
    activeReview?: Partial<TaskSnapshot>;
    queuedReview?: Partial<TaskSnapshot>;
    deferredAssignment?: Partial<TaskSnapshot>;
  } = {},
): void {
  const user06Id = USER_IDS['user06@test.local'];
  state.tasks.set(
    MIGRATE_CUTOVER_TASKS.mainDiscussion,
    makeTask({
      taskId: MIGRATE_CUTOVER_TASKS.mainDiscussion,
      workspaceId: MAIN_WORKSPACE_ID,
      title: '[討論] 範例新功能',
      status: 'Todo',
      assigneeId: null,
      dueAt: '2026-07-15T00:00:00.000Z',
      version: 1,
      ...overrides.mainDiscussion,
    }),
  );
  state.tasks.set(
    MIGRATE_CUTOVER_TASKS.activeReview.taskId,
    makeTask({
      taskId: MIGRATE_CUTOVER_TASKS.activeReview.taskId,
      workspaceId: CANONICAL_WORKSPACE_ID,
      title: 'activeReview fixture',
      status: 'Review',
      assigneeId: user06Id,
      version: 1,
      ...overrides.activeReview,
    }),
  );
  state.tasks.set(
    MIGRATE_CUTOVER_TASKS.queuedReview.taskId,
    makeTask({
      taskId: MIGRATE_CUTOVER_TASKS.queuedReview.taskId,
      workspaceId: CANONICAL_WORKSPACE_ID,
      title: 'queuedReview fixture',
      status: 'Review',
      assigneeId: user06Id,
      version: 1,
      ...overrides.queuedReview,
    }),
  );
  state.tasks.set(
    MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId,
    makeTask({
      taskId: MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId,
      workspaceId: CANONICAL_WORKSPACE_ID,
      title: 'deferredAssignment fixture',
      status: 'Todo',
      assigneeId: null,
      version: 1,
      ...overrides.deferredAssignment,
    }),
  );
  state.tasks.set(
    MIGRATE_CUTOVER_TASKS.mainPolicy,
    makeTask({ taskId: MIGRATE_CUTOVER_TASKS.mainPolicy, workspaceId: MAIN_WORKSPACE_ID, title: MAIN_POLICY_TITLE, status: 'Todo', version: 1 }),
  );
  state.tasks.set(
    MIGRATE_CUTOVER_TASKS.legacyCanonicalDiscussion,
    makeTask({
      taskId: MIGRATE_CUTOVER_TASKS.legacyCanonicalDiscussion,
      workspaceId: CANONICAL_WORKSPACE_ID,
      title: LEGACY_CANONICAL_DISCUSSION_TITLE,
      status: 'Todo',
      version: 1,
    }),
  );
}

async function runMigrateTests(): Promise<void> {
  // ---------------------------------------------------------------------------
  // CUTOVER_TASKS 必須是 policy.ts／migrate.ts 兩邊 import 同一個底層物件（同一個
  // 中立模組），不是各自維護一份「剛好相等」的副本。
  // ---------------------------------------------------------------------------
  {
    assert.strictEqual(MIGRATE_CUTOVER_TASKS, CUTOVER_TASKS, 'migrate.ts 與 policy.ts 的 CUTOVER_TASKS 必須是同一個物件參考（同一個來源模組）');
  }

  // ---------------------------------------------------------------------------
  // 任務特定驗收條件（純文字 manifest 稽核資料，不是自動化程式碼）。
  // ---------------------------------------------------------------------------
  {
    assert.ok(ACTIVE_REVIEW_ACCEPTANCE_CRITERIA.includes('冷啟動／重新整理 task URL'));
    assert.ok(ACTIVE_REVIEW_ACCEPTANCE_CRITERIA.includes('目前選到其他 workspace 時仍切到正確 workspace'));
    assert.ok(ACTIVE_REVIEW_ACCEPTANCE_CRITERIA.includes('task modal 與 comment anchor'));
    assert.ok(ACTIVE_REVIEW_ACCEPTANCE_CRITERIA.includes('403／404'));
    assert.ok(ACTIVE_REVIEW_ACCEPTANCE_CRITERIA.includes('既有 #/tasks 回歸'));
    assert.ok(ACTIVE_REVIEW_ACCEPTANCE_CRITERIA.includes('正式瀏覽器 smoke'));

    assert.ok(QUEUED_REVIEW_ACCEPTANCE_CRITERIA.some((s) => s.includes('938aa035') && s.includes('merge')));
    assert.ok(QUEUED_REVIEW_ACCEPTANCE_CRITERIA.includes('手機 menu toggle 後 badge 節點仍存在'));
    assert.ok(QUEUED_REVIEW_ACCEPTANCE_CRITERIA.includes('hidden tab 不執行 60 秒 polling'));
    assert.ok(QUEUED_REVIEW_ACCEPTANCE_CRITERIA.includes('來源 task／comment 真正開啟成功後才標已讀'));
    assert.ok(QUEUED_REVIEW_ACCEPTANCE_CRITERIA.includes('涵蓋 0／1／多筆'));
    assert.ok(QUEUED_REVIEW_ACCEPTANCE_CRITERIA.includes('403／404'));
    assert.ok(QUEUED_REVIEW_ACCEPTANCE_CRITERIA.includes('手動已讀'));
    assert.ok(QUEUED_REVIEW_ACCEPTANCE_CRITERIA.includes('桌機／手機 smoke'));
  }

  // ===========================================================================
  // 四階段序列（計畫步驟 1 fixture）：全部發生在同一個暫存 git repo／同一個
  // coordinator db 上，因為這正是計畫描述的「重跑」語意——不是四個互相獨立的情境。
  // ===========================================================================
  {
    const { repoRoot, g } = migrateTestRepo();
    seedLegacyBranches(g, repoRoot);
    const { state, acceptedHeadSha: prereqAcceptedHead, mergeSha: prereqMergeSha } = seedSatisfiedPrerequisite(g, repoRoot);
    seedFourCutoverTasks(state);

    const db = openCoordinatorState(':memory:');
    const now = new Date('2026-07-24T00:00:00.000Z');

    try {
      // -------- Phase 1：初次 apply。--------
      const { client: ownerClient, calls: ownerCalls } = makeFakeBoardClient(state);
      const { client: user09Client } = makeFakeNotificationClient(state);

      const phase1 = await applyCutoverReconciliation({ db, ownerClient, user09Client, repoRoot, now: () => now });
      assert.strictEqual(phase1.kind, 'applied', 'prerequisite 已滿足時 phase1 必須真正執行 reconciliation');
      if (phase1.kind !== 'applied') throw new Error('unreachable');

      assert.strictEqual(phase1.summary.mainDiscussionClosed, true, '10e65231 必須在 phase1 恰好機械式結案一次');
      assert.strictEqual(phase1.summary.aiCalls, 0, 'migrate.ts 的 apply 永遠不呼叫 AI');
      assert.strictEqual(state.tasks.get(MIGRATE_CUTOVER_TASKS.mainDiscussion)!.status, 'Done');

      assert.strictEqual(state.tasks.get(MIGRATE_CUTOVER_TASKS.activeReview.taskId)!.status, 'Doing', '938aa035 必須從 Review 被 PATCH 到 Doing');
      assert.strictEqual(
        state.tasks.get(MIGRATE_CUTOVER_TASKS.activeReview.taskId)!.assigneeId,
        USER_IDS['user06@test.local'],
        '938aa035 必須維持 user06 assignee',
      );
      assert.ok(phase1.summary.activeReviewBranch, '938aa035 必須建立 per-task branch');
      assert.strictEqual(existsSync(taskWorktreePath(repoRoot, MIGRATE_CUTOVER_TASKS.activeReview.taskId)), true);

      const queued1 = state.tasks.get(MIGRATE_CUTOVER_TASKS.queuedReview.taskId)!;
      assert.strictEqual(queued1.status, 'Todo', '6384b6f4 三步退回後必須是 Todo');
      assert.strictEqual(queued1.assigneeId, null, '6384b6f4 三步退回後必須 unassigned');
      assert.strictEqual(phase1.summary.queuedReviewFinalStatus, 'Todo');
      assert.strictEqual(getTaskRun(db, MIGRATE_CUTOVER_TASKS.queuedReview.taskId)!.phase, 'queued');
      assert.strictEqual(getTaskRun(db, MIGRATE_CUTOVER_TASKS.queuedReview.taskId)!.branch, null, '6384b6f4 不得取得 branch');
      assert.strictEqual(existsSync(taskWorktreePath(repoRoot, MIGRATE_CUTOVER_TASKS.queuedReview.taskId)), false, '6384b6f4 不得建立 worktree');

      const deferred1 = state.tasks.get(MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId)!;
      assert.strictEqual(deferred1.status, 'Todo', '027c0052 在 938aa035 尚未 Done 時必須維持 Todo');
      assert.strictEqual(deferred1.assigneeId, null, '027c0052 在 938aa035 尚未 Done 時必須維持 unassigned');
      assert.strictEqual(getTaskRun(db, MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId)!.phase, 'queued');
      assert.strictEqual(existsSync(taskWorktreePath(repoRoot, MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId)), false, '027c0052 不得建立 worktree');

      // action key 各恰好使用一次：queuedReview 三步。
      for (let step = 1 as 1 | 2 | 3; step <= 3; step++) {
        const key = `cutover:queued_review:step${step}:${MIGRATE_CUTOVER_TASKS.queuedReview.taskId}`;
        const entry = getAction(db, key);
        assert.ok(entry, `queuedReview step${step} action key 必須存在`);
        assert.strictEqual(entry!.status, 'completed');
      }

      // PATCH／comment 呼叫數精確符合預期：mainDiscussion(1 patch) + activeReview(1 patch,
      // assignee 本來就是 user06 所以只有 status PATCH + 1 comment) + queuedReview(3 patch)。
      const patchCallsAfterPhase1 = ownerCalls.patchTaskField.length;
      const commentCallsAfterPhase1 = ownerCalls.postCommentOnce.length;
      assert.strictEqual(patchCallsAfterPhase1, 5, `mainDiscussion(1) + activeReview(1) + queuedReview(3) = 5 次 PATCH，實際 ${patchCallsAfterPhase1}`);
      assert.strictEqual(commentCallsAfterPhase1, 1, 'activeReview 的固定 reset 說明是這個階段唯一一則留言');

      // 舊 legacy branch／commit 內容不得出現在任何新建立的 branch 裡。
      const activeReviewBranchLog = g(['log', '-p', `sim/task/${MIGRATE_CUTOVER_TASKS.activeReview.taskId}`]);
      assert.ok(!activeReviewBranchLog.includes('933b974'), '938aa035 新 branch 不得含舊 SHA 933b974');
      assert.ok(!activeReviewBranchLog.includes('f94b69e'), '938aa035 新 branch 不得含舊 SHA f94b69e');
      assert.ok(!activeReviewBranchLog.includes('sim/user02'), '938aa035 新 branch 不得提及 sim/user02');
      assert.ok(!activeReviewBranchLog.includes('sim/user06'), '938aa035 新 branch 不得提及 sim/user06');
      const activeReviewDiffFromMaster = g(['diff', 'master', `sim/task/${MIGRATE_CUTOVER_TASKS.activeReview.taskId}`]);
      assert.strictEqual(activeReviewDiffFromMaster, '', '938aa035 新 worktree 對 base 的初始 diff 必須為空');

      // -------- Phase 2：狀態未變時重跑，不得重複任何 mutation。--------
      const phase2 = await applyCutoverReconciliation({ db, ownerClient, user09Client, repoRoot, now: () => new Date(now.getTime() + 1000) });
      assert.strictEqual(phase2.kind, 'applied');
      if (phase2.kind !== 'applied') throw new Error('unreachable');
      assert.strictEqual(phase2.summary.mainDiscussionClosed, false, '重跑時 10e65231 已經是 Done，不得產生第二次 closure');
      assert.strictEqual(state.tasks.get(MIGRATE_CUTOVER_TASKS.mainDiscussion)!.status, 'Done');
      assert.strictEqual(ownerCalls.patchTaskField.length, patchCallsAfterPhase1, '狀態未變時重跑不得產生任何新 PATCH');
      assert.strictEqual(ownerCalls.postCommentOnce.length, commentCallsAfterPhase1, '狀態未變時重跑不得產生任何新留言');

      // -------- Phase 3：938aa035 Done 且 master 已包含其 accepted merge 後重跑。--------
      // 這個 task branch 是 phase1 apply 用 ensureTaskWorktree 建立的 linked worktree
      // （見上方 activeReviewBranch），因此不能在 repoRoot 上 `git checkout` 它——同一個
      // branch 不能同時被兩個 worktree checkout。直接在它自己的 worktree 目錄裡工作。
      const activeReviewBranch = `sim/task/${MIGRATE_CUTOVER_TASKS.activeReview.taskId}`;
      const activeReviewWorktreePath = taskWorktreePath(repoRoot, MIGRATE_CUTOVER_TASKS.activeReview.taskId);
      writeFileSync(join(activeReviewWorktreePath, 'feature-938.txt'), 'work on 938\n');
      g(['add', 'feature-938.txt'], activeReviewWorktreePath);
      g(['commit', '-q', '-m', `feat: fix 938\n\nTask-Id: ${MIGRATE_CUTOVER_TASKS.activeReview.taskId}`], activeReviewWorktreePath);
      const acceptedHead938 = g(['rev-parse', 'HEAD'], activeReviewWorktreePath);
      g(['merge', '--no-ff', activeReviewBranch, '-m', `merge ${MIGRATE_CUTOVER_TASKS.activeReview.taskId}`], repoRoot);
      const masterAfter938Merge = g(['rev-parse', 'master'], repoRoot);

      // 模擬「一般流程」已經把 938aa035 帶到 Done，並在 coordinator 自己的 checkpoint
      // 留下 accepted head（見 migrate.ts 的 isActiveReviewGateOpen 註解：為什麼用
      // task_runs.headSha 而不是重新解析完成留言）。
      state.tasks.set(MIGRATE_CUTOVER_TASKS.activeReview.taskId, { ...state.tasks.get(MIGRATE_CUTOVER_TASKS.activeReview.taskId)!, status: 'Done' });
      const preRun = getTaskRun(db, MIGRATE_CUTOVER_TASKS.activeReview.taskId)!;
      upsertTaskCheckpoint(
        db,
        { taskId: MIGRATE_CUTOVER_TASKS.activeReview.taskId, workspaceId: preRun.workspaceId, phase: 'done', headSha: acceptedHead938, evidenceFingerprint: preRun.evidenceFingerprint },
        now,
      );

      const patchCallsBeforePhase3 = ownerCalls.patchTaskField.length;
      const phase3 = await applyCutoverReconciliation({ db, ownerClient, user09Client, repoRoot, now: () => new Date(now.getTime() + 2000) });
      assert.strictEqual(phase3.kind, 'applied');
      if (phase3.kind !== 'applied') throw new Error('unreachable');
      assert.strictEqual(phase3.summary.queuedReviewDispatched, true, '938aa035 Done+merged 後，6384b6f4 必須恰好一次取得派工');
      assert.strictEqual(phase3.summary.deferredAssignmentDispatched, true, '938aa035 Done+merged 後，027c0052 必須恰好一次取得派工');

      const queued3 = state.tasks.get(MIGRATE_CUTOVER_TASKS.queuedReview.taskId)!;
      assert.strictEqual(queued3.status, 'Doing');
      assert.strictEqual(queued3.assigneeId, USER_IDS['user06@test.local'], '6384b6f4 解除依賴後固定回到 user06');
      const deferred3 = state.tasks.get(MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId)!;
      assert.strictEqual(deferred3.status, 'Doing');
      assert.strictEqual(deferred3.assigneeId, USER_IDS['user05@test.local'], '027c0052 解除依賴後固定交給 user05');

      // 兩條新 branch 都以「包含 938aa035 accepted merge 的新版 master」為 base。
      const queuedRun3 = getTaskRun(db, MIGRATE_CUTOVER_TASKS.queuedReview.taskId)!;
      const deferredRun3 = getTaskRun(db, MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId)!;
      assert.strictEqual(queuedRun3.baseSha, masterAfter938Merge);
      assert.strictEqual(deferredRun3.baseSha, masterAfter938Merge);
      assert.ok(await isAncestor(repoRoot, acceptedHead938, queuedRun3.headSha!), '6384b6f4 新 branch 必須包含 938aa035 accepted merge（branch base 已包含 938aa035 merge）');
      assert.ok(await isAncestor(repoRoot, acceptedHead938, deferredRun3.headSha!), '027c0052 新 branch 必須包含 938aa035 accepted merge');

      // 恰好一次：queuedReview／deferredAssignment 各自的 assign+status action key 都只跑一次。
      assert.strictEqual(getAction(db, `cutover:queued_review:dispatch:assign:${MIGRATE_CUTOVER_TASKS.queuedReview.taskId}`)?.status, 'completed');
      assert.strictEqual(getAction(db, `cutover:deferred_assignment:dispatch:assign:${MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId}`)?.status, 'completed');

      const patchCallsAfterPhase3 = ownerCalls.patchTaskField.length;
      assert.strictEqual(patchCallsAfterPhase3 - patchCallsBeforePhase3, 4, '恰好 2 個 task × (assign + status) = 4 次新 PATCH');

      // 再次重跑：不得重複派工。
      const phase4rerun = await applyCutoverReconciliation({ db, ownerClient, user09Client, repoRoot, now: () => new Date(now.getTime() + 3000) });
      if (phase4rerun.kind !== 'applied') throw new Error('unreachable');
      assert.strictEqual(phase4rerun.summary.queuedReviewDispatched, false, '已經派工過，重跑不得再次派工');
      assert.strictEqual(phase4rerun.summary.deferredAssignmentDispatched, false);
      assert.strictEqual(ownerCalls.patchTaskField.length, patchCallsAfterPhase3, '重跑不得產生任何新 PATCH');

      // 從頭到尾，legacy branch／commit 都完全沒被合併、cherry-pick 或引用進任何新 branch。
      for (const branch of [`sim/task/${MIGRATE_CUTOVER_TASKS.queuedReview.taskId}`, `sim/task/${MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId}`]) {
        const log = g(['log', '-p', branch]);
        assert.ok(!log.includes('933b974') && !log.includes('f94b69e') && !log.includes('sim/user02') && !log.includes('sim/user06'), `${branch} 不得含任何舊 legacy 內容`);
      }
      void prereqAcceptedHead;
      void prereqMergeSha;
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  // ===========================================================================
  // Phase 4（獨立情境）：938aa035 為 human_blocked／Doing／Review 時，兩筆
  // dependent task 都繼續 queued，不得取得派工。
  // ===========================================================================
  for (const scenario of [
    { label: 'Review（尚未進 Doing）', status: 'Review' as TaskStatus, phase: 'review' as const },
    { label: 'Doing（正在處理）', status: 'Doing' as TaskStatus, phase: 'doing' as const },
    { label: 'human_blocked（coordinator 內部卡關）', status: 'Doing' as TaskStatus, phase: 'human_blocked' as const },
  ]) {
    const { repoRoot, g } = migrateTestRepo();
    const { state } = seedSatisfiedPrerequisite(g, repoRoot);
    seedFourCutoverTasks(state, {
      activeReview: { status: scenario.status },
      queuedReview: { status: 'Todo', assigneeId: null }, // 已經完成三步退回，處於 queued baseline
      deferredAssignment: { status: 'Todo', assigneeId: null },
    });

    const db = openCoordinatorState(':memory:');
    const now = new Date('2026-07-24T00:00:00.000Z');
    // 預先把兩個 dependent task 的 checkpoint 設成 queued（模擬 phase1 已經跑過）。
    for (const taskId of [MIGRATE_CUTOVER_TASKS.queuedReview.taskId, MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId]) {
      upsertTaskCheckpoint(db, { taskId, workspaceId: CANONICAL_WORKSPACE_ID, phase: 'queued', evidenceFingerprint: '' }, now);
    }
    upsertTaskCheckpoint(
      db,
      { taskId: MIGRATE_CUTOVER_TASKS.activeReview.taskId, workspaceId: CANONICAL_WORKSPACE_ID, phase: scenario.phase, evidenceFingerprint: '' },
      now,
    );
    // mainDiscussion 已結案過（避免這個獨立情境重複計算 phase1 的其他副作用，聚焦測試 gate 本身）。
    state.tasks.set(MIGRATE_CUTOVER_TASKS.mainDiscussion, { ...state.tasks.get(MIGRATE_CUTOVER_TASKS.mainDiscussion)!, status: 'Done' });

    try {
      const { client: ownerClient, calls } = makeFakeBoardClient(state);
      const { client: user09Client } = makeFakeNotificationClient(state);
      const result = await applyCutoverReconciliation({ db, ownerClient, user09Client, repoRoot, now: () => now });
      assert.strictEqual(result.kind, 'applied');
      if (result.kind !== 'applied') throw new Error('unreachable');
      assert.strictEqual(result.summary.queuedReviewDispatched, false, `938aa035 為 ${scenario.label} 時，6384b6f4 不得取得派工`);
      assert.strictEqual(result.summary.deferredAssignmentDispatched, false, `938aa035 為 ${scenario.label} 時，027c0052 不得取得派工`);
      assert.strictEqual(state.tasks.get(MIGRATE_CUTOVER_TASKS.queuedReview.taskId)!.status, 'Todo');
      assert.strictEqual(state.tasks.get(MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId)!.status, 'Todo');
      assert.strictEqual(getTaskRun(db, MIGRATE_CUTOVER_TASKS.queuedReview.taskId)!.phase, 'queued');
      assert.strictEqual(getTaskRun(db, MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId)!.phase, 'queued');
      assert.strictEqual(calls.patchTaskField.filter((c) => c.taskId === MIGRATE_CUTOVER_TASKS.queuedReview.taskId).length, 0);
      assert.strictEqual(calls.patchTaskField.filter((c) => c.taskId === MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId).length, 0);
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  // ===========================================================================
  // CutoverPrerequisiteMissing：任一環節缺漏或不相符都必須讓 apply／manifest 回傳
  // 缺漏，且 task／Git／AI mutation adapter 呼叫數為零，10e65231 完全不變。
  // ===========================================================================
  {
    const scenarios: { label: string; corrupt: (state: FakeBoardState) => void }[] = [
      {
        label: 'completedPrerequisite 狀態是 Doing（尚未 Done）',
        corrupt: (state) => {
          const t = state.tasks.get(MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId)!;
          state.tasks.set(MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId, { ...t, status: 'Doing' });
        },
      },
      {
        label: 'completedPrerequisite 狀態是 Review',
        corrupt: (state) => {
          const t = state.tasks.get(MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId)!;
          state.tasks.set(MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId, { ...t, status: 'Review' });
        },
      },
      {
        label: '完成留言缺漏',
        corrupt: (state) => {
          state.comments.set(
            MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId,
            (state.comments.get(MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId) ?? []).filter((c) => !c.content.startsWith('【SYSTEM完成】')),
          );
        },
      },
      {
        label: 'assignment audit event actor 不是 canonical Owner',
        corrupt: (state) => {
          const audit = state.auditTrails.get(MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId)!;
          state.auditTrails.set(
            MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId,
            audit.map((e) => ({ ...e, actorId: 'someone-else' })),
          );
        },
      },
      {
        label: 'assignment audit event 早於 Task 1 授權時間',
        corrupt: (state) => {
          const audit = state.auditTrails.get(MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId)!;
          state.auditTrails.set(
            MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId,
            audit.map((e) => ({ ...e, occurredAt: '2026-01-01T00:00:00.000Z' })),
          );
        },
      },
      {
        label: 'notification recipient 不是 user09',
        corrupt: (state) => {
          state.notifications = state.notifications.map((n) => ({ ...n, recipientId: 'someone-else' }));
        },
      },
      {
        label: 'notification 完全缺漏',
        corrupt: (state) => {
          state.notifications = [];
        },
      },
    ];

    for (const scenario of scenarios) {
      const { repoRoot, g } = migrateTestRepo();
      const { state } = seedSatisfiedPrerequisite(g, repoRoot);
      seedFourCutoverTasks(state);
      scenario.corrupt(state);

      const db = openCoordinatorState(':memory:');
      try {
        const { client: ownerClient, calls } = makeFakeBoardClient(state);
        const { client: user09Client } = makeFakeNotificationClient(state);

        const applyResult = await applyCutoverReconciliation({ db, ownerClient, user09Client, repoRoot, now: () => new Date('2026-07-24T00:00:00.000Z') });
        assert.strictEqual(applyResult.kind, 'prerequisite_missing', `情境「${scenario.label}」必須回傳 prerequisite_missing`);
        assert.strictEqual(calls.patchTaskField.length, 0, `情境「${scenario.label}」：task mutation adapter 呼叫數必須為零`);
        assert.strictEqual(calls.postCommentOnce.length, 0, `情境「${scenario.label}」：comment mutation 呼叫數必須為零`);
        assert.strictEqual(
          existsSync(taskWorktreePath(repoRoot, MIGRATE_CUTOVER_TASKS.activeReview.taskId)),
          false,
          `情境「${scenario.label}」：Git adapter 不得建立任何新 worktree／branch`,
        );
        assert.strictEqual(getTaskRun(db, MIGRATE_CUTOVER_TASKS.mainDiscussion), null, `情境「${scenario.label}」：10e65231 完全不變（連 checkpoint 都不該被建立)`);

        const manifest = await buildManifest({ db, ownerClient, user09Client, repoRoot });
        assert.strictEqual(manifest.readyForApply, false, `情境「${scenario.label}」：manifest 必須回報 readyForApply=false`);
        assert.strictEqual(manifest.errorCode, 'CutoverPrerequisiteMissing');
      } finally {
        db.close();
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  }

  // ===========================================================================
  // 唯讀 manifest：欄位完整性、excluded readback、寫檔。
  // ===========================================================================
  {
    const { repoRoot, g } = migrateTestRepo();
    const { state } = seedSatisfiedPrerequisite(g, repoRoot);
    seedFourCutoverTasks(state);
    const db = openCoordinatorState(':memory:');
    try {
      const { client: ownerClient } = makeFakeBoardClient(state);
      const { client: user09Client } = makeFakeNotificationClient(state);
      const manifest = await buildManifest({ db, ownerClient, user09Client, repoRoot, now: () => new Date('2026-07-24T00:00:00.000Z') });

      assert.strictEqual(manifest.readyForApply, true);
      assert.strictEqual(manifest.errorCode, null);
      assert.strictEqual(manifest.prerequisite.taskId, MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId);
      assert.strictEqual(manifest.prerequisite.satisfied, true);
      assert.ok(manifest.prerequisite.fingerprint.length > 0);
      assert.strictEqual(manifest.prerequisite.task1AuthorizedAt, '2026-07-20T00:00:00.000Z');
      assert.strictEqual(manifest.prerequisite.canonicalOwnerId, USER_IDS['user01@test.local']);
      assert.strictEqual(manifest.prerequisite.user03CanonicalId, USER_IDS['user03@test.local']);
      assert.strictEqual(manifest.prerequisite.assignmentEventId, '42');
      assert.strictEqual(manifest.prerequisite.assignmentActorId, USER_IDS['user01@test.local']);
      assert.strictEqual(manifest.prerequisite.assignmentAggregateVersion, 2);
      assert.strictEqual(manifest.prerequisite.assignmentBaselineVersion, 1);
      assert.ok(manifest.prerequisite.acceptedHeadSha);
      assert.ok(manifest.prerequisite.mergeSha);
      assert.strictEqual(manifest.prerequisite.ownerAcceptanceId, 'acceptance-comment-1');
      assert.strictEqual(manifest.prerequisite.completionCommentId, 'completion-comment-1');
      assert.strictEqual(manifest.prerequisite.notificationId, 'notif-1');

      assert.strictEqual(manifest.tasks.length, 5);
      const byId = new Map(manifest.tasks.map((t) => [t.taskId, t] as const));
      assert.ok(byId.has(MIGRATE_CUTOVER_TASKS.mainDiscussion));
      assert.ok(byId.has(MIGRATE_CUTOVER_TASKS.activeReview.taskId));
      assert.ok(byId.has(MIGRATE_CUTOVER_TASKS.queuedReview.taskId));
      assert.ok(byId.has(MIGRATE_CUTOVER_TASKS.completedPrerequisite.taskId));
      assert.ok(byId.has(MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId));
      assert.strictEqual(byId.get(MIGRATE_CUTOVER_TASKS.activeReview.taskId)!.fixedAssigneeEmail, 'user06@test.local');
      assert.strictEqual(byId.get(MIGRATE_CUTOVER_TASKS.deferredAssignment.taskId)!.releaseDependency, MIGRATE_CUTOVER_TASKS.activeReview.taskId);
      assert.deepStrictEqual([...byId.get(MIGRATE_CUTOVER_TASKS.activeReview.taskId)!.acceptanceCriteria], [...ACTIVE_REVIEW_ACCEPTANCE_CRITERIA]);
      assert.deepStrictEqual([...byId.get(MIGRATE_CUTOVER_TASKS.queuedReview.taskId)!.acceptanceCriteria], [...QUEUED_REVIEW_ACCEPTANCE_CRITERIA]);

      // excluded readback：mainPolicy／legacyCanonicalDiscussion 都出現，isExcluded=true。
      assert.strictEqual(manifest.excluded.length, 2);
      const excludedIds = manifest.excluded.map((e) => e.taskId).sort();
      assert.deepStrictEqual(excludedIds, [MIGRATE_CUTOVER_TASKS.legacyCanonicalDiscussion, MIGRATE_CUTOVER_TASKS.mainPolicy].sort());
      for (const e of manifest.excluded) assert.strictEqual(e.isExcluded, true, `${e.taskId} 必須被正確判定為 excluded`);

      assert.strictEqual(manifest.notificationCursor.count, 1);
      assert.strictEqual(manifest.notificationCursor.lastId, 'notif-1');
      assert.strictEqual(manifest.outboxCursor.count, 0);
      assert.ok(manifest.cutoverGeneration >= 1);
      assert.ok(manifest.manifestFingerprint.length > 0);

      // 唯讀：manifest 建構過程完全不得呼叫任何 mutation adapter。
      const { calls: readonlyCalls } = makeFakeBoardClient(state);
      void readonlyCalls;

      // 寫檔：路徑落在 sim-logs/ 底下（已被 .gitignore 排除），內容是合法 JSON。
      const logsRoot = mkdtempSync(join(tmpdir(), 'sim-migrate-logs-'));
      try {
        const path = writeManifestFile(manifest, logsRoot);
        assert.ok(path.startsWith(logsRoot));
        assert.ok(path.includes('cutover-'));
        const written = JSON.parse(readFileSync(path, 'utf8')) as CutoverManifest;
        assert.strictEqual(written.cutoverGeneration, manifest.cutoverGeneration);
        assert.strictEqual(written.readyForApply, true);
      } finally {
        rmSync(logsRoot, { recursive: true, force: true });
      }
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  // ===========================================================================
  // 不得 mutate 任何 task／Git／AI adapter 的唯讀性驗證：manifest／preflight 對
  // 一個具備完整 mutation 能力的 fake client 執行，事後斷言呼叫記錄裡完全沒有
  // patchTaskField／postCommentOnce。
  // ===========================================================================
  {
    const { repoRoot, g } = migrateTestRepo();
    const { state } = seedSatisfiedPrerequisite(g, repoRoot);
    seedFourCutoverTasks(state);
    const db = openCoordinatorState(':memory:');
    try {
      const { client: ownerClient, calls } = makeFakeBoardClient(state);
      const { client: user09Client } = makeFakeNotificationClient(state);
      await buildManifest({ db, ownerClient, user09Client, repoRoot });
      assert.strictEqual(calls.patchTaskField.length, 0, 'buildManifest 絕不能呼叫任何 PATCH');
      assert.strictEqual(calls.postCommentOnce.length, 0, 'buildManifest 絕不能貼任何留言');
      assert.strictEqual(existsSync(taskWorktreePath(repoRoot, MIGRATE_CUTOVER_TASKS.activeReview.taskId)), false, 'buildManifest 絕不能建立 worktree');
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  // ===========================================================================
  // Generation-bound preflight：manifest generation／task version／notification
  // cursor／live rev 任一漂移都必須 exit 非零（這裡以 ok:false 表達），且零 mutation。
  // ===========================================================================
  {
    const { repoRoot, g } = migrateTestRepo();
    const { state } = seedSatisfiedPrerequisite(g, repoRoot);
    seedFourCutoverTasks(state);
    const db = openCoordinatorState(':memory:');
    try {
      const { client: ownerClient } = makeFakeBoardClient(state);
      const { client: user09Client } = makeFakeNotificationClient(state);
      const manifest = await buildManifest({ db, ownerClient, user09Client, repoRoot });

      // 完全相符：preflight 必須 ok。
      {
        const { client: freshOwnerClient, calls } = makeFakeBoardClient(state);
        const { client: freshUser09Client } = makeFakeNotificationClient(state);
        const check = await checkGenerationMatches({ db, ownerClient: freshOwnerClient, user09Client: freshUser09Client, repoRoot, expectGeneration: manifest.cutoverGeneration });
        assert.strictEqual(check.ok, true, '完全相符時 preflight 必須通過');
        assert.strictEqual(calls.patchTaskField.length, 0);
      }

      // generation 不符（呼叫端手上的舊 generation）。
      {
        const { client: freshOwnerClient, calls } = makeFakeBoardClient(state);
        const { client: freshUser09Client } = makeFakeNotificationClient(state);
        const check = await checkGenerationMatches({ db, ownerClient: freshOwnerClient, user09Client: freshUser09Client, repoRoot, expectGeneration: manifest.cutoverGeneration - 1 });
        assert.strictEqual(check.ok, false);
        assert.strictEqual(calls.patchTaskField.length, 0, 'generation 不符時零 mutation');
      }

      // task version 漂移（例如有人在 manifest 產生後又動了看板）。
      {
        const drifted = state.tasks.get(MIGRATE_CUTOVER_TASKS.activeReview.taskId)!;
        state.tasks.set(MIGRATE_CUTOVER_TASKS.activeReview.taskId, { ...drifted, version: drifted.version + 1 });
        const { client: freshOwnerClient, calls } = makeFakeBoardClient(state);
        const { client: freshUser09Client } = makeFakeNotificationClient(state);
        const check = await checkGenerationMatches({ db, ownerClient: freshOwnerClient, user09Client: freshUser09Client, repoRoot, expectGeneration: manifest.cutoverGeneration });
        assert.strictEqual(check.ok, false, 'task version 漂移必須讓 preflight 失敗');
        assert.strictEqual(calls.patchTaskField.length, 0);
        state.tasks.set(MIGRATE_CUTOVER_TASKS.activeReview.taskId, drifted); // 復原
      }

      // notification cursor 漂移。
      {
        state.notifications = [
          ...state.notifications,
          { notificationId: 'notif-extra', recipientId: USER_IDS['user09@test.local'], sourceTaskId: 'x', sourceCommentId: 'y', snippet: '', createdAt: '2026-07-24T00:00:02.000Z', readAt: null },
        ];
        const { client: freshOwnerClient, calls } = makeFakeBoardClient(state);
        const { client: freshUser09Client } = makeFakeNotificationClient(state);
        const check = await checkGenerationMatches({ db, ownerClient: freshOwnerClient, user09Client: freshUser09Client, repoRoot, expectGeneration: manifest.cutoverGeneration });
        assert.strictEqual(check.ok, false, 'notification cursor 漂移必須讓 preflight 失敗');
        assert.strictEqual(calls.patchTaskField.length, 0);
        state.notifications = state.notifications.filter((n) => n.notificationId !== 'notif-extra');
      }

      // live rev 漂移。
      {
        state.healthRev = 'some-other-rev-not-descendant';
        const { client: freshOwnerClient, calls } = makeFakeBoardClient(state);
        const { client: freshUser09Client } = makeFakeNotificationClient(state);
        const check = await checkGenerationMatches({ db, ownerClient: freshOwnerClient, user09Client: freshUser09Client, repoRoot, expectGeneration: manifest.cutoverGeneration });
        assert.strictEqual(check.ok, false, 'live rev 漂移必須讓 preflight 失敗（liveRevIsMergeOrDescendant 也會連帶失敗）');
        assert.strictEqual(calls.patchTaskField.length, 0);
      }
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  // ===========================================================================
  // runApply：generation 不符時完全不進入 reconciliation（零 mutation）；相符時
  // 委派給 applyCutoverReconciliation。
  // ===========================================================================
  {
    const { repoRoot, g } = migrateTestRepo();
    const { state } = seedSatisfiedPrerequisite(g, repoRoot);
    seedFourCutoverTasks(state);
    const db = openCoordinatorState(':memory:');
    try {
      const { client: ownerClientForManifest } = makeFakeBoardClient(state);
      const { client: user09ClientForManifest } = makeFakeNotificationClient(state);
      const manifest = await buildManifest({ db, ownerClient: ownerClientForManifest, user09Client: user09ClientForManifest, repoRoot });

      const { client: ownerClient, calls } = makeFakeBoardClient(state);
      const { client: user09Client } = makeFakeNotificationClient(state);
      const mismatch = await runApply({ db, ownerClient, user09Client, repoRoot, expectGeneration: manifest.cutoverGeneration + 1 });
      assert.strictEqual(mismatch.kind, 'generation_mismatch');
      assert.strictEqual(calls.patchTaskField.length, 0);
      assert.strictEqual(calls.postCommentOnce.length, 0);

      const match = await runApply({ db, ownerClient, user09Client, repoRoot, expectGeneration: manifest.cutoverGeneration });
      assert.strictEqual(match.kind, 'applied');
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  // ===========================================================================
  // UncertainMutationError 的 readback-first 復原：PATCH 回應不確定，但 readback
  // 發現其實已經生效——不得因此當成失敗，也不得重送第二次同語意的 PATCH。
  // ===========================================================================
  {
    const { repoRoot, g } = migrateTestRepo();
    const { state } = seedSatisfiedPrerequisite(g, repoRoot);
    seedFourCutoverTasks(state);
    state.uncertainOnce = true; // 只影響下一次 patchTaskField 呼叫
    const db = openCoordinatorState(':memory:');
    try {
      const { client: ownerClient, calls } = makeFakeBoardClient(state);
      const { client: user09Client } = makeFakeNotificationClient(state);
      const result = await applyCutoverReconciliation({ db, ownerClient, user09Client, repoRoot, now: () => new Date('2026-07-24T00:00:00.000Z') });
      assert.strictEqual(result.kind, 'applied', 'UncertainMutationError 後 readback 發現已生效，不得整體失敗');
      assert.strictEqual(state.tasks.get(MIGRATE_CUTOVER_TASKS.mainDiscussion)!.status, 'Done');
      // 第一次 mainDiscussion PATCH 呼叫因為 uncertainOnce 拋錯，但 readback 之後不會再送第二次
      // 同語意的 PATCH（mainDiscussion 只有唯一一個 status PATCH 呼叫點）。
      const mainDiscussionPatches = calls.patchTaskField.filter((c) => c.taskId === MIGRATE_CUTOVER_TASKS.mainDiscussion);
      assert.strictEqual(mainDiscussionPatches.length, 1, 'UncertainMutationError 之後不得盲目重送同一個 PATCH');
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Goal Task attempt：假 task.blocked 與同 tick 多 Task 的 heartbeat 去重
// ---------------------------------------------------------------------------
async function runGoalAttemptTests(): Promise<void> {
  // A1：從 human_blocked 恢復且這次 progressed 的 attempt（phase 仍是 human_blocked，只有計數歸零）
  // 不得再記 task.blocked；沒有進展的 attempt 仍要記。
  const attemptResult = (evidenceChanged: boolean): MemberSessionResult => ({
    outcome: evidenceChanged ? 'progressed' : 'retryable_failure',
    exitCode: 0,
    output: { summary: 'done', changedPaths: [], verificationCommands: [], blocker: evidenceChanged ? null : 'still stuck' },
    evidence: {
      commitSha: null, commitChangedPaths: [], verificationPassed: false, verificationRanCommands: [],
      reviewTransitionConfirmed: false, reviewStatus: null, summaryCommentId: null, blockerRepeated: false, rejectedReason: null,
    },
    evidenceChanged,
  });
  for (const evidenceChanged of [true, false]) {
    const db = openCoordinatorState(':memory:');
    try {
      const recorded: Array<{ taskId: string; kind: string; detail: string }> = [];
      const deps = {
        db,
        ownerClient: {
          listComments: async () => [],
          recordDeliveryEvidence: async (taskId: string, input: { kind: string; detail: string }) => { recorded.push({ taskId, ...input }); },
          postCommentOnce: async () => 'comment-1',
        },
        now: () => NOW,
        tracer: () => () => undefined,
      } as never;
      const run = makeTaskRun({ taskId: 'a1-task', workspaceId: 'ws-a1', phase: 'human_blocked', ownerIntervened: true, noProgressCount: 3, evidenceFingerprint: 'old' });
      const task = makeTask({ taskId: 'a1-task', workspaceId: 'ws-a1', status: 'Doing', goalId: 'goal-a1', goalStatus: 'Executing' });
      const transition = await applyMemberAttemptTransition(deps, { taskId: 'a1-task', workspaceId: 'ws-a1' } as never, run, attemptResult(evidenceChanged), task);
      assert.strictEqual(transition.run.phase, 'human_blocked', 'policy 的 phase 語意不變：progressed 只歸零計數');
      if (evidenceChanged) {
        assert.deepStrictEqual(recorded, [], '從 human_blocked 恢復且 progressed 的 attempt 不得記錄 task.blocked evidence');
      } else {
        assert.strictEqual(recorded.length, 1, '沒有進展的 attempt 仍要記 task.blocked');
        assert.strictEqual(recorded[0].kind, 'task.blocked');
      }
    } finally {
      db.close();
    }
  }

  // B4：runner 丟例外時，原始錯誤（截到 200 字）要跟著結果出去，不能只剩 errorCategory "runner"
  const failing = await productionMemberAdapter(
    { runner: 'codex', model: 'm' },
    async () => { throw new Error(`run 不存在或狀態不可完成${'x'.repeat(300)}`); },
    {} as never, () => 'same', false,
  ).run({ prompt: '', cwd: '', model: 'm' });
  assert.strictEqual(failing.errorCategory, 'runner');
  assert.match(failing.errorDetail ?? '', /run 不存在或狀態不可完成/);
  assert.ok((failing.errorDetail ?? '').length <= 200, 'errorDetail 要截到 200 字');

  // B1：同一 tick 同一 Agent 的兩個 Goal Task 要各自拿到自己的 heartbeat／run，第二個 Task 的 finishRun 才不會失敗。
  const database = new DatabaseSync(':memory:');
  runMigrations(database);
  try {
    const recorder = {
      quotaSnapshot: async () => '{}',
      prepareRun: async (input: Record<string, unknown>) => {
        const heartbeatId = enqueueHeartbeat({
          scopeId: input.goalId, goalId: input.goalId, phase: input.phase, agentId: input.agentId, revision: 1, triggerRef: input.triggerRef,
        }, database);
        const runId = prepareRun({ ...input, heartbeatId } as unknown as PrepareRunInput, database);
        markRunRunning(runId, database);
        return runId;
      },
      finishRun: async (runId: string, input: Record<string, unknown>) => {
        finishRun(runId, { ...input, actualCost: null, credibleBilling: false, evidenceRef: null } as unknown as FinishRunInput, database);
      },
    };
    const runIds: string[] = [];
    // 第三次是同一 tick 再派一次 b1-task-1（無進展重試或 owner 退回後重跑）
    for (const taskId of ['b1-task-1', 'b1-task-2', 'b1-task-1']) {
      await trackGoalRunAttempt({
        recorder: { ...recorder, prepareRun: async (input) => { const id = await recorder.prepareRun(input); runIds.push(id); return id; } },
        goalId: 'goal-b1', taskId, agentId: 'agent-b1', phase: 'implementation', adapter: 'codex', model: 'm', attempt: 'primary',
        triggerRef: goalRunTriggerRef('tick-1', taskId), prompt: 'x', estimatedOutputTokens: 1,
        invoke: async () => ({ exitCode: 0 }),
      });
    }
    assert.strictEqual(new Set(runIds).size, 3, '同一 tick 的不同 Task、或同一 Task 再派一次，都不得共用同一個 run');
    const heartbeats = database.prepare("SELECT status FROM goal_heartbeats WHERE goal_id = 'goal-b1'").all() as Array<{ status: string }>;
    assert.deepStrictEqual(heartbeats.map((row) => row.status), ['succeeded', 'succeeded', 'succeeded'], '每次派工各有一個 succeeded heartbeat');
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// 審查前整合衝突：不跑 Owner session，driver 把 master 合進 task worktree、退回 Doing 請成員解衝突
// ---------------------------------------------------------------------------
async function runIntegrationConflictTests(): Promise<void> {
  const TASK_ID = 'conflict-task';
  const WORKSPACE_ID = 'ws-conflict';

  /** master 與 task branch 都改了 src/app.txt 同一行（kind=conflict），或 master 只動別的檔案（kind=clean）。 */
  async function setup(kind: 'conflict' | 'clean', onBranchCi?: (repoRoot: string) => void) {
    const { repoRoot, g } = initDeployTestRepo();
    mkdirSync(join(repoRoot, 'src'));
    writeFileSync(join(repoRoot, 'src', 'app.txt'), 'top\nshared\nbottom\n');
    g(['add', 'src/app.txt']);
    g(['commit', '-q', '-m', 'base']);
    const baseSha = g(['rev-parse', 'master']);
    const worktree = (await ensureTaskWorktree(repoRoot, TASK_ID, baseSha)).path;
    writeFileSync(join(worktree, 'src', 'app.txt'), 'top\ntask version\nbottom\n');
    g(['add', 'src/app.txt'], worktree);
    g(['commit', '-q', '-m', `task change\n\nTask-Id: ${TASK_ID}`], worktree);
    const headSha = g(['rev-parse', 'HEAD'], worktree);
    // master 前進：docs/master-only.txt 在 allowedPrefixes（src/）之外，用來驗證 master 帶進來的檔案不會被當成成員的越界改動。
    mkdirSync(join(repoRoot, 'docs'));
    writeFileSync(join(repoRoot, 'docs', 'master-only.txt'), 'from master \n');
    if (kind === 'conflict') writeFileSync(join(repoRoot, 'src', 'app.txt'), 'top\nmaster version\nbottom\n');
    g(['add', '-A', 'docs', 'src']);
    g(['commit', '-q', '-m', 'master moves on']);

    const board = { status: 'Review', comments: [] as CommentSnapshot[], patches: [] as string[] };
    const ownerClient = {
      getTask: async () => makeTask({ taskId: TASK_ID, workspaceId: WORKSPACE_ID, status: board.status as TaskStatus, assigneeId: 'member-1' }),
      listComments: async () => board.comments,
      postCommentOnce: async (_taskId: string, content: string, key: string) => {
        const found = board.comments.find((c) => c.content.includes(key));
        if (found) return found.commentId;
        const commentId = `c-${board.comments.length + 1}`;
        board.comments.push({ commentId, taskId: TASK_ID, userId: 'owner', content, createdAt: `2026-07-23T00:00:0${board.comments.length}.000Z` });
        return commentId;
      },
      patchTaskField: async (_taskId: string, field: string, value: string) => {
        board.patches.push(`${field}=${value}`);
        board.status = value;
        return { status: value };
      },
      recordDeliveryEvidence: async () => undefined,
    };
    const db = openCoordinatorState(':memory:');
    const traces: Array<{ event: string; args: Record<string, unknown> }> = [];
    let ownerCalls = 0;
    const deps = {
      db, ownerClient, repoRoot, now: () => NOW, allowedPrefixes: ['src/'], useAgentRoutes: false,
      tracer: () => (event: string, args: Record<string, unknown>) => traces.push({ event, args }),
      runOwnerSession: async (context: { reviewedHeadSha: string }) => {
        ownerCalls++;
        // 預設引用不到 head（decision 無效、no_change）；onBranchCi 有給時才真的 accept
        return { exitCode: 0, decision: { action: 'accept' as const, rationale: onBranchCi ? `ok ${context.reviewedHeadSha}` : 'no head cited', evidenceCommentIds: [] } };
      },
      runBranchCi: async () => {
        onBranchCi?.(repoRoot);
        return { passed: true, detail: 'ok' };
      },
      runIntegrationCommand: async () => ({ exitCode: 0, output: 'ok' }),
      runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }),
      getSystemdReadback: async () => makeReadback(),
      checkHealth: async () => makeHealth(),
      runTaskLiveAcceptance: async () => ({ passed: true, detail: 'ok' }),
      sleep: noSleep,
    } as unknown as Parameters<typeof dispatchOwnerReview>[0];
    upsertTaskCheckpoint(db, {
      taskId: TASK_ID, workspaceId: WORKSPACE_ID, phase: 'review', workerId: null, branch: taskBranchName(TASK_ID),
      baseSha, headSha, evidenceFingerprint: '', noProgressCount: 0, ownerIntervened: false,
    }, NOW);
    const action = { kind: 'owner_review' as const, taskId: TASK_ID, workspaceId: WORKSPACE_ID, assigneeId: 'member-1', reason: 'test' };
    const snapshot = baseSnapshot({ tasks: [makeTask({ taskId: TASK_ID, workspaceId: WORKSPACE_ID, status: 'Review', deployment: 'not_required' })] });
    const review = () => dispatchOwnerReview(deps, action, getTaskRun(db, TASK_ID)!, snapshot);
    const sendBack = () => sendBackIntegrationConflict(deps, action, getTaskRun(db, TASK_ID)!, makeTask({ taskId: TASK_ID, workspaceId: WORKSPACE_ID, status: 'Review' }));
    const memberSession = (edit: (worktreePath: string) => void) => runMemberSession({
      taskId: TASK_ID, worktreePath: worktree, allowedPrefixes: ['src/'], acceptanceCriteria: 'x', comments: board.comments.map((c) => c.content),
      previousBlocker: null,
      runner: async (context) => {
        edit(context.worktreePath);
        return { exitCode: 0, output: { summary: 'resolved conflict', changedPaths: ['src/app.txt'], verificationCommands: ['npx tsc --noEmit'], blocker: null } };
      },
      runVerificationCommand: async () => ({ exitCode: 0, output: 'ok' }),
      driverActions: {
        confirmReviewTransition: async () => { board.status = 'Review'; return 'Review' as TaskStatus; },
        createSummaryComment: async () => ({ commentId: 'summary-1' }),
      },
    });
    return { repoRoot, g, worktree, headSha, board, db, traces, deps, review, sendBack, memberSession, ownerCalls: () => ownerCalls, cleanup: () => { db.close(); rmSync(repoRoot, { recursive: true, force: true }); } };
  }
  const mergeHead = (f: { g: (args: string[], cwd?: string) => string; worktree: string }): string | null => {
    try { return f.g(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], f.worktree); } catch { return null; }
  };

  // ---- 1) 審查前偵測到衝突：Owner session 不跑；task 回 Doing、留言、worktree 留下衝突標記與 MERGE_HEAD ----
  {
    const f = await setup('conflict');
    try {
      const masterBefore = f.g(['rev-parse', 'master']);
      assert.strictEqual(await f.review(), 'progressed');
      assert.strictEqual(f.ownerCalls(), 0, '審查前偵測到衝突時不得呼叫 Owner session');
      assert.strictEqual(f.board.status, 'Doing');
      assert.deepStrictEqual(f.board.patches, ['status=Doing'], '單欄位 PATCH 一次');
      assert.strictEqual(f.board.comments.length, 1);
      const comment = f.board.comments[0].content;
      for (const expected of ['【整合衝突】', 'docs/master-only.txt', 'src/app.txt', 'master moves on', '不要執行任何 git 寫入', 'action_key: integration_conflict:']) {
        assert.ok(comment.includes(expected), `留言必須含 ${expected}：\n${comment}`);
      }
      assert.ok(mergeHead(f), 'worktree 必須保留 MERGE_HEAD');
      assert.match(readFileSync(join(f.worktree, 'src', 'app.txt'), 'utf8'), /<<<<<<< /, 'worktree 必須保留衝突標記');
      assert.strictEqual(readFileSync(join(f.worktree, 'docs', 'master-only.txt'), 'utf8'), 'from master \n', 'master 的其他變更要一起合進 worktree');
      const ci = f.traces.find((t) => t.event === 'ci.checked');
      assert.ok(ci, '必須留 ci.checked trace');
      assert.deepStrictEqual([ci.args.outcome, ci.args.reason], ['fail', 'integration_conflict']);
      assert.match(String(ci.args.detail), /src\/app\.txt/);
      assert.strictEqual(getTaskRun(f.db, TASK_ID)?.phase, 'doing');
      assert.strictEqual(f.g(['rev-parse', 'master']), masterBefore, 'master 不得被動到');
      assert.strictEqual(existsSync(join(f.repoRoot, 'sim-work', 'integration', TASK_ID)), false, '臨時 integration worktree 必須清掉');

      // ---- 2) 成員解掉衝突：driver commit 成 merge commit，回到 Review，最後可以整合 ----
      const masterSha = f.g(['rev-parse', 'master']);
      const session = await f.memberSession((wt) => {
        writeFileSync(join(wt, 'src', 'app.txt'), 'top\nmerged version\nbottom\n');
        writeFileSync(join(wt, 'src', 'helper.txt'), 'new helper\n'); // 解衝突時新增的檔案（未追蹤）也要算成員的改動
      });
      assert.strictEqual(session.outcome, 'progressed', JSON.stringify(session.evidence));
      assert.strictEqual(f.board.status, 'Review');
      const parents = f.g(['rev-list', '--parents', '-n', '1', 'HEAD'], f.worktree).split(' ').slice(1);
      assert.strictEqual(parents.length, 2, '解完衝突的 commit 必須是 merge commit');
      assert.ok(parents.includes(f.headSha) && parents.includes(masterSha));
      assert.strictEqual(mergeHead(f), null);
      assert.strictEqual(f.g(['status', '--porcelain'], f.worktree), '');
      assert.ok(f.g(['log', '-1', '--format=%B'], f.worktree).includes(`Task-Id: ${TASK_ID}`));
      assert.deepStrictEqual([...session.evidence.commitChangedPaths].sort(), ['src/app.txt', 'src/helper.txt'], 'master 帶進來的檔案不算成員的改動；成員新建的未追蹤檔要算');
      const integration = await createIntegrationWorktree(f.repoRoot, TASK_ID, taskBranchName(TASK_ID));
      await removeIntegrationWorktree(f.repoRoot, integration);
      assert.strictEqual(integration.conflict, false, '解完後必須能乾淨整合');
      const accepted = await runDeployAcceptance({
        taskId: TASK_ID, repoRoot: f.repoRoot, taskBranch: taskBranchName(TASK_ID), existingFatalError: null, deployment: 'not_required',
        runBranchCi: async () => ({ passed: true, detail: 'ok' }), runIntegrationCommand: makeCountingIntegrationRunner().fn,
        runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }), getSystemdReadback: async () => makeReadback(),
        checkHealth: async () => makeHealth(), runTaskLiveAcceptance: async () => ({ passed: true, detail: 'ok' }), now: () => 0, sleep: noSleep,
      });
      assert.strictEqual(accepted.kind, 'deployed');
      assert.strictEqual(f.g(['show', 'master:src/app.txt']), 'top\nmerged version\nbottom');
      assert.strictEqual(f.g(['show', 'master:src/helper.txt']), 'new helper', '新建檔案必須一路合進 master');
    } finally {
      f.cleanup();
    }
  }

  // ---- 2b) 解完衝突後下一次審查：預檢通過，Owner session 才會被呼叫 ----
  {
    const f = await setup('conflict');
    try {
      await f.review();
      // 成員整份採用 master 的版本（內容跟 MERGE_HEAD 完全一樣，仍要被當成已解的衝突檔 add 進 merge commit）
      const session = await f.memberSession((wt) => writeFileSync(join(wt, 'src', 'app.txt'), 'top\nmaster version\nbottom\n'));
      assert.strictEqual(session.outcome, 'progressed', JSON.stringify(session.evidence));
      upsertTaskCheckpoint(f.db, { ...getTaskRun(f.db, TASK_ID)!, phase: 'review', headSha: f.g(['rev-parse', 'HEAD'], f.worktree) }, NOW);
      // fixture 的 Owner 回的是無效決策（accept 沒引用 head SHA）：不能再當 no_change 讓下個 tick 重審
      assert.strictEqual(await f.review(), 'progressed');
      assert.strictEqual(f.ownerCalls(), 1, '沒有衝突時照常跑 Owner session');
      assert.strictEqual(getTaskRun(f.db, TASK_ID)?.phase, 'human_blocked', '無效的 Owner 決策要停下來交給人');
      assert.ok(f.board.comments.some((c) => c.content.includes('@user09') && c.content.includes('head SHA')), '通知要寫出無效原因');
    } finally {
      f.cleanup();
    }
  }

  // ---- 3) 衝突標記沒解：commit 失敗、HEAD 不動、累計 noProgress，最後 Owner 介入再到 human_blocked ----
  {
    const f = await setup('conflict');
    try {
      await f.review();
      const headBefore = f.g(['rev-parse', 'HEAD'], f.worktree);
      let run = getTaskRun(f.db, TASK_ID)!;
      const evidence = makeEvidence({ taskId: TASK_ID, status: 'Doing' });
      const expected = [[1, false, 'doing'], [2, true, 'doing'], [3, true, 'human_blocked']] as const;
      for (const [count, intervened, phase] of expected) {
        const session = await f.memberSession(() => undefined); // 什麼都沒解
        assert.strictEqual(session.outcome, 'retryable_failure');
        assert.match(session.evidence.rejectedReason ?? '', /check|conflict/i, '標記沒解必須是 commit 階段的失敗');
        assert.strictEqual(f.g(['rev-parse', 'HEAD'], f.worktree), headBefore, '沒解完不得產生 commit');
        assert.ok(mergeHead(f), 'MERGE_HEAD 必須還在');
        const transition = recordMemberSessionAttempt(run, session, evidence);
        run = transition.run;
        assert.deepStrictEqual([run.noProgressCount, run.ownerIntervened, run.phase], [count, intervened, phase]);
        assert.strictEqual(transition.humanBlockedNotice !== null, phase === 'human_blocked');
      }
      // 之後補解掉就能 commit（staged 殘留的標記不會被放行，解掉才過）
      const fixed = await f.memberSession((wt) => writeFileSync(join(wt, 'src', 'app.txt'), 'top\nmerged version\nbottom\n'));
      assert.strictEqual(fixed.outcome, 'progressed');
    } finally {
      f.cleanup();
    }
  }

  // ---- 4) 同一個 head 對同一個 master 反覆衝突：不重做、不重複留言，走無進展狀態機直到 human_blocked ----
  {
    const f = await setup('conflict');
    try {
      await f.review();
      for (const [count, phase] of [[1, 'review'], [2, 'review'], [3, 'human_blocked']] as const) {
        f.board.status = 'Review'; // 成員沒解就被人搬回 Review
        const before = getTaskRun(f.db, TASK_ID)!;
        upsertTaskCheckpoint(f.db, { ...before, phase: before.phase === 'doing' ? 'review' : before.phase }, NOW);
        assert.strictEqual(await f.review(), 'no_change');
        const run = getTaskRun(f.db, TASK_ID)!;
        assert.deepStrictEqual([run.noProgressCount, run.phase], [count, phase]);
        assert.strictEqual(f.ownerCalls(), 0, 'Owner session 從頭到尾都不得被呼叫');
      }
      assert.strictEqual(f.board.comments.filter((c) => c.content.includes('【整合衝突】')).length, 1, '同一組 head／master 只留一則整合衝突留言');
      assert.ok(f.board.comments.some((c) => c.content.includes('@user09')), 'human_blocked 後必須通知人');
    } finally {
      f.cleanup();
    }
  }

  // ---- 5) master 乾淨前進（沒有衝突）：driver 自動 merge，不退回，task 留在 Review ----
  {
    const f = await setup('clean');
    try {
      assert.strictEqual(await f.sendBack(), 'progressed');
      assert.strictEqual(f.board.status, 'Review');
      assert.deepStrictEqual(f.board.patches, []);
      assert.strictEqual(f.board.comments.length, 0, '乾淨合併不打擾成員');
      const parents = f.g(['rev-list', '--parents', '-n', '1', 'HEAD'], f.worktree).split(' ').slice(1);
      assert.strictEqual(parents.length, 2, 'driver 直接 commit 成 merge commit');
      assert.strictEqual(mergeHead(f), null);
      assert.strictEqual(getTaskRun(f.db, TASK_ID)?.headSha, f.g(['rev-parse', 'HEAD'], f.worktree), 'run 的 head 要追上新的 merge commit');
      assert.strictEqual(getTaskRun(f.db, TASK_ID)?.phase, 'review');
      assert.strictEqual(f.ownerCalls(), 0);
    } finally {
      f.cleanup();
    }
  }

  // ---- 6) 保險：預檢通過、Owner accept 之後 master 又前進造成衝突（競態）：同樣留 trace、退回 Doing，不留給下個 tick 重跑 Owner ----
  {
    const f = await setup('clean', (repoRoot) => {
      writeFileSync(join(repoRoot, 'src', 'app.txt'), 'top\nmaster raced\nbottom\n');
      f.g(['add', 'src/app.txt']);
      f.g(['commit', '-q', '-m', 'master races ahead']);
    });
    try {
      assert.strictEqual(await f.review(), 'progressed');
      assert.strictEqual(f.ownerCalls(), 1, '預檢當下沒有衝突，Owner 照常審查一次');
      assert.strictEqual(f.board.status, 'Doing');
      assert.ok(mergeHead(f), 'worktree 必須保留 MERGE_HEAD');
      assert.ok(f.board.comments.some((c) => c.content.includes('【整合衝突】') && c.content.includes('src/app.txt')));
      assert.ok(f.traces.some((t) => t.event === 'ci.checked' && t.args.reason === 'integration_conflict' && t.args.outcome === 'fail'));
      assert.strictEqual(getTaskRun(f.db, TASK_ID)?.phase, 'doing');
    } finally {
      f.cleanup();
    }
  }

  // ---- 7) Owner 回 intervene（非 accept／reject）：轉 human_blocked、@user09 留言、之後不再重跑 Owner；人工留言後才恢復 ----
  {
    const f = await setup('clean');
    try {
      let calls = 0;
      let nextAction: 'intervene' | 'reject' = 'intervene';
      const longRationale = `pytest 沒有真的跑過 ${'很長的理由'.repeat(600)}`;
      (f.deps as unknown as { runOwnerSession: unknown }).runOwnerSession = async () => {
        calls++;
        return { exitCode: 0, decision: { action: nextAction, rationale: nextAction === 'reject' ? '請補測試' : longRationale, evidenceCommentIds: [] } };
      };
      // 下一個 tick 的 coordinator 規劃：證據照 board 上實際的狀態組（與 gatherSnapshot 同形）
      const nextTickReviews = () => {
        const run = getTaskRun(f.db, TASK_ID)!;
        const last = f.board.comments.at(-1) ?? null;
        const task = makeTask({ taskId: TASK_ID, workspaceId: CANONICAL_WORKSPACE_ID, status: f.board.status as TaskStatus, assigneeId: 'member-1' });
        const evidence = makeEvidence({ taskId: TASK_ID, status: f.board.status as TaskStatus, assigneeId: 'member-1', commentCount: f.board.comments.length, lastCommentId: last?.commentId ?? null, lastCommentAt: last?.createdAt ?? null });
        return selectCoordinatorActions(baseSnapshot({ tasks: [task], taskRuns: { [TASK_ID]: run }, taskEvidence: { [TASK_ID]: evidence } }), NOW)
          .filter((a) => a.kind === 'owner_review' && a.taskId === TASK_ID).length;
      };
      assert.strictEqual(nextTickReviews(), 1, '前提：Review 且沒被擋時會排入 owner_review');

      assert.strictEqual(await f.review(), 'progressed');
      assert.strictEqual(calls, 1);
      assert.strictEqual(getTaskRun(f.db, TASK_ID)?.phase, 'human_blocked');
      assert.strictEqual(f.board.status, 'Review', 'task 維持 Review');
      assert.deepStrictEqual(f.board.patches, [], '不動看板狀態');
      assert.strictEqual(f.board.comments.length, 1);
      const notice = f.board.comments[0].content;
      assert.ok(notice.startsWith('@user09 ') && notice.includes('intervene') && notice.includes('pytest 沒有真的跑過'), notice);
      assert.ok(notice.includes('已截斷') && notice.length < 1_800, `rationale 要截斷：${notice.length}`);
      assert.ok(notice.includes('action_key: human_blocked_notice:'));
      assert.ok(f.traces.some((t) => t.event === 'task.phase_changed' && t.args.to === 'human_blocked'));
      assert.strictEqual(nextTickReviews(), 0, '證據沒變：下一個 tick 不得再排 owner_review');
      assert.strictEqual(calls, 1, 'Owner 沒有被再叫');

      // 人工留言：證據變了，恢復審查；Owner 這次 reject → 照舊退回 Doing
      f.board.comments.push({ commentId: 'human-1', taskId: TASK_ID, userId: 'user09', content: '請用 .venv/bin/python 跑 pytest', createdAt: '2026-07-23T01:00:00.000Z' });
      assert.strictEqual(nextTickReviews(), 1, '有人留言後必須恢復');
      nextAction = 'reject';
      assert.strictEqual(await f.review(), 'progressed');
      assert.strictEqual(calls, 2);
      assert.strictEqual(getTaskRun(f.db, TASK_ID)?.phase, 'doing');
      assert.strictEqual(f.board.status, 'Doing');

      // 恢復後 Owner 又回 intervene：新的留言（不是被舊 key 吃掉）、再次停下
      f.board.status = 'Review';
      nextAction = 'intervene';
      assert.strictEqual(await f.review(), 'progressed');
      assert.strictEqual(calls, 3);
      assert.strictEqual(getTaskRun(f.db, TASK_ID)?.phase, 'human_blocked');
      assert.strictEqual(f.board.comments.filter((c) => c.content.startsWith('@user09 Owner')).length, 2, '第二次 intervene 要有新的通知');
      assert.strictEqual(nextTickReviews(), 0);
    } finally {
      f.cleanup();
    }
  }

  // ---- 7b) Owner 審查期間有人留言：那則留言不能被吞進 fingerprint；不停下，下次帶著它重審 ----
  {
    const f = await setup('clean');
    try {
      let calls = 0;
      (f.deps as unknown as { runOwnerSession: unknown }).runOwnerSession = async () => {
        calls++;
        if (calls === 1) {
          f.board.comments.push({ commentId: 'human-during', taskId: TASK_ID, userId: 'user09', content: '我剛補了說明', createdAt: '2026-07-23T00:30:00.000Z' });
        }
        return { exitCode: 0, decision: { action: 'intervene', rationale: '需要人', evidenceCommentIds: [] } };
      };
      assert.strictEqual(await f.review(), 'no_change', '有 Owner 沒看過的留言時不得停下');
      assert.notStrictEqual(getTaskRun(f.db, TASK_ID)?.phase, 'human_blocked');
      assert.ok(f.traces.some((t) => t.event === 'gate.skipped' && t.args.reason === 'unseen_comments'));
      // 下一次審查：Owner 這次看得到那則留言；沒有新留言就照常停下
      assert.strictEqual(await f.review(), 'progressed');
      assert.strictEqual(calls, 2, 'Owner 要帶著新留言重審一次');
      assert.strictEqual(getTaskRun(f.db, TASK_ID)?.phase, 'human_blocked');
    } finally {
      f.cleanup();
    }
  }
}

async function main(): Promise<void> {
  await runG1Tests();
  await runF5Tests();
  await runGoalAttemptTests();
  await runCoordinatorEnvironmentTest();
  await runApiTests();
  await runGitTests();
  await runSeedFilesTests();
  await runAgentTests();
  runCoordinatorTests();
  await runDeployTests();
  await runIntegrationConflictTests();
  await runCompletionTests();
  await runDiscordOutboxTests();
  await runMigrateTests();
}

main()
  .then(() => console.log('production.test.ts OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
