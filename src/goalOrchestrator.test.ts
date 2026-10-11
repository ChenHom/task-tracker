import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { getUserIdByEmail } from './auth';
import { resetProjections } from './eventStore';
import { cancelGoal, createGoal, getGoal, registerGoalProjections, startDiscussion } from './goal';
import {
  advanceGoalDiscussion, createFollowupGoal, getGoalSynthesis, materializeGoalTasks, selectGoalParticipants, storeGoalSynthesis, verifyGoalDelivery,
  type DiscussionOutput,
} from './goalOrchestrator';
import { runMigrations } from './schema';
import { seedUsers } from './seed';
import { registerTaskProjections } from './task';
import { recordDeliveryEvidence } from './deliveryEvidence';
import { enqueueHeartbeat, markRunRunning, prepareRun } from './goalRun';

async function main(): Promise<void> {
  const db = new DatabaseSync(':memory:');
  runMigrations(db); resetProjections(); registerGoalProjections(); registerTaskProjections(); seedUsers(db);
  const owner = getUserIdByEmail('user01@test.local', db)!;
  const a2 = getUserIdByEmail('user02@test.local', db)!;
  const a3 = getUserIdByEmail('user03@test.local', db)!;
  db.prepare("INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES ('ws', 'W', 'active', 't')").run();
  for (const id of [owner, a2, a3]) db.prepare("INSERT INTO workspace_members_read_model VALUES ('ws', ?, 'Member', 't')").run(id);
  db.prepare(`INSERT INTO projects_read_model
    (project_id, workspace_id, name, status, target_repo, created_at, updated_at)
    VALUES ('p', 'ws', 'P', 'active', '/srv/test', 't', 't')`).run();
  const makeGoal = (name: string) => {
    const id = createGoal('human', { workspaceId: 'ws', projectId: 'p', objective: name, successCriteria: 'passes', ownerAgentId: owner }, db);
    startDiscussion(owner, id, db); return id;
  };
  const outputs = new Map<string, DiscussionOutput>([
    [a2, { stance: 'analysis', claim: 'API boundary', reason: 'Prevents cross-scope writes', evidenceRefs: ['src/server.ts'] }],
    [a3, { stance: 'analysis', claim: 'State boundary', reason: 'Keeps transitions explicit', evidenceRefs: ['src/goal.ts'] }],
  ]);
  const deps = {
    database: db, quotaSnapshot: () => '{"remaining":100}',
    invoke: async ({ agentId, round }: { agentId: string; round: 'round_1' | 'round_2' }) => {
      const base = outputs.get(agentId); if (!base) throw new Error('fail');
      return round === 'round_1' ? base : { ...base, stance: 'agree' as const };
    },
  };

  const normal = makeGoal('normal');
  assert.throws(() => selectGoalParticipants(owner, normal, [], db), /1–5/);
  assert.throws(() => selectGoalParticipants(owner, normal, [{ agentId: owner, reason: 'x', assignment: 'x', selectedLoad: 0 }], db), /資格/);
  selectGoalParticipants(owner, normal, [
    { agentId: a2, reason: 'API', assignment: 'independent API review', selectedLoad: 0 },
    { agentId: a3, reason: 'state', assignment: 'independent state review', selectedLoad: 0 },
  ], db);
  assert.strictEqual(await advanceGoalDiscussion(normal, deps), 'round_2');
  assert.strictEqual(await advanceGoalDiscussion(normal, deps), 'awaiting_lease');
  storeGoalSynthesis(normal, {
    summary: 'Implement project ownership',
    taskPlans: [{ title: 'Implement', description: 'Do work', assigneeId: a2, acceptanceCriteria: 'tests pass', rollbackCondition: 'tests fail' }],
    evidenceRefs: ['src/goal.ts'],
  }, db);
  assert.ok(getGoalSynthesis(normal, 1, db));
  storeGoalSynthesis(normal, { summary: 'duplicate ignored', taskPlans: [], evidenceRefs: [] }, db);
  const taskIds = materializeGoalTasks(owner, normal, db);
  assert.deepStrictEqual(materializeGoalTasks(owner, normal, db), taskIds, 'materialization crash retry 不可重複建 Task');
  assert.strictEqual(taskIds.length, 1);
  assert.deepStrictEqual({ ...db.prepare('SELECT project_id, goal_id, assignee_id FROM tasks_read_model WHERE task_id = ?').get(taskIds[0]) },
    { project_id: 'p', goal_id: normal, assignee_id: a2 });
  assert.strictEqual(getGoal(normal, db)?.status, 'Executing');
  db.prepare("UPDATE tasks_read_model SET status = 'Done' WHERE goal_id = ?").run(normal);
  for (const kind of ['ci.checked', 'merge.integrated', 'deployment_not_required'] as const) recordDeliveryEvidence(taskIds[0], { kind, ref: kind }, db);
  assert.strictEqual(verifyGoalDelivery(owner, normal, { passed: true, evidenceRefs: ['health:200'], deployment: 'not_required' }, db), 'done');
  assert.strictEqual(getGoal(normal, db)?.status, 'Done');
  assert.strictEqual((db.prepare("SELECT COUNT(*) AS n FROM goal_heartbeats WHERE goal_id = ? AND phase = 'followup'").get(normal) as { n: number }).n, 1);
  assert.throws(() => createFollowupGoal(owner, normal, { objective: 'same', successCriteria: 'passes', reason: 'x', evidenceRefs: ['new'] }, db), /不同成功條件/);
  const child = createFollowupGoal(owner, normal, { objective: 'follow', successCriteria: 'new pass', reason: 'new evidence', evidenceRefs: ['commit:new'] }, db);
  assert.strictEqual(getGoal(child, db)?.parent_goal_id, normal);
  assert.strictEqual(createFollowupGoal(owner, normal, { objective: 'follow', successCriteria: 'new pass', reason: 'again', evidenceRefs: ['commit:new'] }, db), child);
  cancelGoal(owner, child, db);

  const solo = makeGoal('solo');
  selectGoalParticipants(owner, solo, [{ agentId: a2, reason: 'API', assignment: 'review', selectedLoad: 0 }], db);
  assert.strictEqual(await advanceGoalDiscussion(solo, deps), 'awaiting_lease');
  assert.deepStrictEqual({ ...db.prepare("SELECT status, reason FROM goal_rounds WHERE goal_id = ? AND round = 'round_2'").get(solo) },
    { status: 'skipped', reason: 'insufficient_peers' });
  const soloPlan = { summary: 'solo', taskPlans: [{ title: 'T', description: 'D', assigneeId: a2, acceptanceCriteria: 'pass', rollbackCondition: 'fail' }], evidenceRefs: ['x'] };
  storeGoalSynthesis(solo, soloPlan, db); const soloTaskIds = materializeGoalTasks(owner, solo, db);
  db.prepare("UPDATE tasks_read_model SET status = 'Done' WHERE goal_id = ?").run(solo);
  for (const kind of ['ci.checked', 'merge.integrated', 'deployment_not_required'] as const) recordDeliveryEvidence(soloTaskIds[0], { kind, ref: kind }, db);
  assert.strictEqual(verifyGoalDelivery(owner, solo, { passed: false, evidenceRefs: ['fail:1'], deployment: 'not_required' }, db), 'retry');
  assert.strictEqual(getGoal(solo, db)?.discussion_phase, 'owner_synthesis');
  storeGoalSynthesis(solo, soloPlan, db); materializeGoalTasks(owner, solo, db);
  db.prepare("UPDATE tasks_read_model SET status = 'Done' WHERE goal_id = ?").run(solo);
  for (const task of db.prepare('SELECT task_id FROM tasks_read_model WHERE goal_id = ?').all(solo) as unknown as Array<{ task_id: string }>) {
    for (const kind of ['ci.checked', 'merge.integrated', 'deployment_not_required'] as const) recordDeliveryEvidence(task.task_id, { kind, ref: kind }, db);
  }
  assert.strictEqual(verifyGoalDelivery(owner, solo, { passed: false, evidenceRefs: ['fail:2'], deployment: 'not_required' }, db), 'blocked');
  assert.strictEqual(getGoal(solo, db)?.status, 'Blocked');
  cancelGoal('human', solo, db);

  const failed = makeGoal('failed');
  const failing = { ...deps, invoke: async () => { throw new Error('runner failed'); } };
  selectGoalParticipants(owner, failed, [{ agentId: a2, reason: 'first', assignment: 'first scope', selectedLoad: 0 }], db);
  assert.strictEqual(await advanceGoalDiscussion(failed, failing), 'reconciled');
  assert.strictEqual(getGoal(failed, db)?.revision, 2);
  selectGoalParticipants(owner, failed, [{ agentId: a3, reason: 'changed', assignment: 'changed scope', selectedLoad: 0 }], db);
  assert.strictEqual(await advanceGoalDiscussion(failed, failing), 'blocked');
  assert.strictEqual(getGoal(failed, db)?.status, 'Blocked');
  assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM goal_runs').get() as { n: number }).n, 7, '每次模型呼叫前都建立 Run');

  const recovering = makeGoal('recovering');
  selectGoalParticipants(owner, recovering, [{ agentId: a2, reason: 'recovery', assignment: 'recover safely', selectedLoad: 0 }], db);
  const heartbeatId = enqueueHeartbeat({ scopeId: recovering, goalId: recovering, phase: 'round_1', agentId: a2, revision: 1, triggerRef: 'phase' }, db);
  const runId = prepareRun({ heartbeatId, goalId: recovering, agentId: a2, phase: 'round_1', adapter: 'claude', model: 'safe', attempt: 'primary', estimatedInputTokens: 1, estimatedOutputTokens: 1, estimateBasis: 'test', estimateConfidence: 'high', quotaSnapshotJson: '{}' }, db);
  markRunRunning(runId, db);
  assert.strictEqual(await advanceGoalDiscussion(recovering, deps), 'waiting', '未過期 running Run 不可封存 round');
  db.prepare("UPDATE goal_runs SET started_at = '2000-01-01T00:00:00.000Z' WHERE run_id = ?").run(runId);
  assert.strictEqual(await advanceGoalDiscussion(recovering, deps), 'reconciled', '過期 Run 先標 uncertain 再進 reconciliation');
  cancelGoal(owner, recovering, db);
}

main().then(() => console.log('goalOrchestrator.test.ts OK'));
