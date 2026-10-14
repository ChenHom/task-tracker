import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { getUserIdByEmail } from './auth';
import { resetProjections } from './eventStore';
import { cancelGoal, createGoal, getGoal, registerGoalProjections, resumeGoal, reviseGoal, startDiscussion } from './goal';
import {
  advanceGoalDiscussion, createFollowupGoal, eligibleGoalParticipants, getGoalSynthesis, materializeGoalTasks, saveFollowupCandidate, selectGoalParticipants, storeGoalSynthesis, verifyGoalDelivery,
  type DiscussionOutput,
} from './goalOrchestrator';
import { runMigrations } from './schema';
import { seedUsers } from './seed';
import { registerTaskProjections } from './task';
import { recordDeliveryEvidence } from './deliveryEvidence';
import type { RepoRegistry } from './repoRegistry';
import { enqueueHeartbeat, markRunRunning, prepareRun } from './goalRun';
import { registerNotificationProjections } from './notification';

async function main(): Promise<void> {
  const db = new DatabaseSync(':memory:');
  runMigrations(db); resetProjections(); registerGoalProjections(); registerTaskProjections(); registerNotificationProjections(); seedUsers(db);
  const owner = getUserIdByEmail('user01@test.local', db)!;
  const a2 = getUserIdByEmail('user02@test.local', db)!;
  const a3 = getUserIdByEmail('user03@test.local', db)!;
  const a4 = getUserIdByEmail('user04@test.local', db)!;
  const a5 = getUserIdByEmail('user05@test.local', db)!;
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('human-admin', 'human-admin@test', 'Human Admin', 'hash')").run();
  db.prepare("INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES ('ws', 'W', 'active', 't')").run();
  for (const id of [owner, a2, a3, a4, a5]) db.prepare("INSERT INTO workspace_members_read_model VALUES ('ws', ?, ?, 't')").run(id, id === owner ? 'Owner' : 'Member');
  db.prepare("INSERT INTO workspace_members_read_model VALUES ('ws', 'human-admin', 'Admin', 't')").run();
  db.prepare(`INSERT INTO projects_read_model
    (project_id, workspace_id, name, status, target_repo, created_at, updated_at)
    VALUES ('p', 'ws', 'P', 'active', '/srv/test', 't', 't')`).run();
  const repos: RepoRegistry = new Map([['/srv/test', { targetRepo: '/srv/test', checks: ['npm test'], deployment: 'not_required' }]]);
  const makeGoal = (name: string) => {
    const id = createGoal('human', { workspaceId: 'ws', projectId: 'p', objective: name, successCriteria: 'passes', ownerAgentId: owner }, db, repos);
    startDiscussion(owner, id, db); return id;
  };
  const outputs = new Map<string, DiscussionOutput>([
    [a2, { stance: 'analysis', claim: 'API boundary', reason: 'Prevents cross-scope writes', evidenceRefs: ['src/server.ts'] }],
    [a3, { stance: 'analysis', claim: 'State boundary', reason: 'Keeps transitions explicit', evidenceRefs: ['src/goal.ts'] }],
  ]);
  let activeInvokes = 0; let maxActiveInvokes = 0; let quotaCalls = 0;
  const deps = {
    database: db, quotaSnapshot: async () => JSON.stringify({ call: ++quotaCalls }),
    invoke: async ({ agentId, round }: { agentId: string; round: 'round_1' | 'round_2' }) => {
      activeInvokes += 1; maxActiveInvokes = Math.max(maxActiveInvokes, activeInvokes);
      await new Promise((resolve) => setImmediate(resolve));
      activeInvokes -= 1;
      const base = outputs.get(agentId); if (!base) throw new Error('fail');
      return round === 'round_1' ? base : { ...base, stance: 'agree' as const };
    },
  };

  const normal = makeGoal('normal');
  const originalProfile = db.prepare('SELECT skill_profile_json FROM agents WHERE agent_id = ?').get(a2) as { skill_profile_json: string };
  db.prepare("UPDATE agents SET repo_access_json = '[]' WHERE agent_id = ?").run(a2);
  const noRepo = makeGoal('repo access');
  assert.throws(() => selectGoalParticipants(owner, noRepo, [{ agentId: a2, reason: 'x', assignment: 'x', selectedLoad: 0 }], db), /repo 權限/);
  cancelGoal(owner, noRepo, db);
  db.prepare("UPDATE agents SET repo_access_json = '[\"*\"]' WHERE agent_id = ?").run(a2);

  db.prepare("UPDATE agents SET skill_profile_json = '{\"summary\":\"security\",\"skills\":[\"security\"]}' WHERE agent_id = ?").run(a2);
  const wrongSkill = makeGoal('frontend browser work');
  assert.throws(() => selectGoalParticipants(owner, wrongSkill, [{ agentId: a2, reason: 'x', assignment: 'x', selectedLoad: 0 }], db), /skill_profile/);
  cancelGoal(owner, wrongSkill, db);
  db.prepare('UPDATE agents SET skill_profile_json = ? WHERE agent_id = ?').run(originalProfile.skill_profile_json, a2);

  const busyGoal = makeGoal('busy source');
  db.prepare("INSERT INTO goal_participations (participation_id, goal_id, revision, agent_id, reason, assignment, selected_load, created_at) VALUES ('busy-p', ?, 1, ?, 'busy', 'busy', 0, 't')").run(busyGoal, a2);
  const busyCandidate = makeGoal('busy target');
  assert.throws(() => selectGoalParticipants(owner, busyCandidate, [{ agentId: a2, reason: 'x', assignment: 'x', selectedLoad: 0 }], db), /不可並行/);
  cancelGoal(owner, busyCandidate, db);
  cancelGoal(owner, busyGoal, db);
  db.prepare("DELETE FROM goal_participations WHERE participation_id = 'busy-p'").run();

  const executingGoal = makeGoal('executing source');
  db.prepare("INSERT INTO goal_participations (participation_id, goal_id, revision, agent_id, reason, assignment, selected_load, created_at) VALUES ('executing-p', ?, 1, ?, 'done', 'done', 0, 't')").run(executingGoal, a2);
  db.prepare("UPDATE goals_read_model SET status = 'Executing', discussion_phase = 'awaiting_lease' WHERE goal_id = ?").run(executingGoal);
  const roundOneGoal = makeGoal('round one source');
  db.prepare("INSERT INTO goal_participations (participation_id, goal_id, revision, agent_id, reason, assignment, selected_load, created_at) VALUES ('round-one-p', ?, 1, ?, 'busy', 'busy', 0, 't')").run(roundOneGoal, a3);
  db.prepare("UPDATE goals_read_model SET discussion_phase = 'round_1' WHERE goal_id = ?").run(roundOneGoal);
  db.prepare("INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, assignee_id, version) VALUES ('doing-task', 'ws', 'Doing', 'Doing', 'Medium', ?, 1)").run(a4);
  const reconciledGoal = makeGoal('reconciled source');
  db.prepare("INSERT INTO goal_participations (participation_id, goal_id, revision, agent_id, reason, assignment, selected_load, created_at) VALUES ('old-revision-p', ?, 1, ?, 'old', 'old', 0, 't')").run(reconciledGoal, a5);
  db.prepare("UPDATE goals_read_model SET revision = 2 WHERE goal_id = ?").run(reconciledGoal);
  const parallelCandidate = makeGoal('parallel candidate');
  const eligible = new Map(eligibleGoalParticipants(parallelCandidate, db).map((item) => [item.agent.agent_id, item.selectedLoad]));
  assert.strictEqual(eligible.get(a2), 0, 'Executing Goal 的既有 Participation 不再算負載');
  assert.strictEqual(eligible.has(a3), false, '當前 revision 的 round_1 Participation 必須算負載');
  assert.strictEqual(eligible.has(a4), false, 'Doing Task assignee 必須算負載');
  assert.strictEqual(eligible.get(a5), 0, '舊 revision Participation 不再算負載');
  for (const goalId of [executingGoal, roundOneGoal, reconciledGoal, parallelCandidate]) cancelGoal(owner, goalId, db);
  db.prepare("DELETE FROM tasks_read_model WHERE task_id = 'doing-task'").run();

  assert.throws(() => selectGoalParticipants(owner, normal, [], db), /1–5/);
  assert.throws(() => selectGoalParticipants(owner, normal, [
    { agentId: a2, reason: 'valid first', assignment: 'must roll back', selectedLoad: 0 },
    { agentId: owner, reason: 'invalid second', assignment: 'invalid', selectedLoad: 0 },
  ], db), /資格/);
  assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM goal_participations WHERE goal_id = ?').get(normal) as { n: number }).n, 0,
    '整批名單有一人不合格時不得留下 Participation');
  assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM goal_heartbeats WHERE goal_id = ?').get(normal) as { n: number }).n, 0,
    '整批名單失敗不得留下 heartbeat');
  const normalSelections = [
    { agentId: a2, reason: 'API', assignment: 'independent API review', selectedLoad: 999 },
    { agentId: a3, reason: 'state', assignment: 'independent state review', selectedLoad: 0 },
  ];
  selectGoalParticipants(owner, normal, normalSelections, db);
  selectGoalParticipants(owner, normal, normalSelections, db);
  assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM goal_participations WHERE goal_id = ?').get(normal) as { n: number }).n, 2,
    '同 revision 同名單重送必須冪等');
  assert.strictEqual((db.prepare('SELECT selected_load FROM goal_participations WHERE goal_id = ? AND agent_id = ?').get(normal, a2) as { selected_load: number }).selected_load, 0,
    'selectedLoad 必須由系統計算，不可信任 Owner output');
  assert.strictEqual(await advanceGoalDiscussion(normal, deps), 'round_2');
  assert.strictEqual(maxActiveInvokes, 2, 'Round 1 必須平行執行');
  assert.strictEqual(quotaCalls, 2, 'Round 1 每位 Agent 必須各自取得 quota snapshot');
  assert.strictEqual(await advanceGoalDiscussion(normal, deps), 'awaiting_lease');
  storeGoalSynthesis(normal, {
    summary: 'Implement project ownership',
    decisionRationale: '採納有來源的 API 建議，拒絕未佐證替代方案', changeScope: 'src/goal.ts', uncertainties: ['production timing'],
    taskPlans: [{ title: 'Implement', description: 'Do work', assigneeId: a2, dependsOn: ['design approved'], deploymentNotRequired: false, acceptanceCriteria: 'tests pass', rollbackCondition: 'tests fail' }],
    evidenceRefs: ['src/goal.ts'],
  }, db);
  const storedSynthesis = getGoalSynthesis(normal, 1, db)!;
  assert.strictEqual(storedSynthesis.decision_rationale, '採納有來源的 API 建議，拒絕未佐證替代方案');
  assert.strictEqual(storedSynthesis.change_scope, 'src/goal.ts');
  assert.deepStrictEqual(JSON.parse(String(storedSynthesis.uncertainties_json)), ['production timing']);
  storeGoalSynthesis(normal, { summary: 'duplicate ignored', decisionRationale: 'ignored', changeScope: 'none', uncertainties: [], taskPlans: [], evidenceRefs: [] }, db);
  const taskIds = materializeGoalTasks(owner, normal, db);
  assert.deepStrictEqual(materializeGoalTasks(owner, normal, db), taskIds, 'materialization crash retry 不可重複建 Task');
  assert.strictEqual(taskIds.length, 1);
  assert.deepStrictEqual({ ...db.prepare('SELECT project_id, goal_id, assignee_id, deployment_not_required FROM tasks_read_model WHERE task_id = ?').get(taskIds[0]) },
    { project_id: 'p', goal_id: normal, assignee_id: a2, deployment_not_required: 0 });
  assert.match(String((db.prepare('SELECT description FROM tasks_read_model WHERE task_id = ?').get(taskIds[0]) as { description: string }).description), /Depends on: design approved/,
    'materialize 不得丟失 dependsOn');
  assert.strictEqual(getGoal(normal, db)?.status, 'Executing');
  db.prepare("UPDATE tasks_read_model SET status = 'Done' WHERE goal_id = ?").run(normal);
  for (const kind of ['ci.checked', 'merge.integrated', 'deployment_not_required'] as const) recordDeliveryEvidence(taskIds[0], { kind, ref: kind, detail: kind === 'ci.checked' ? 'passed: branch CI completed' : '' }, db);
  const deployedRepos: RepoRegistry = new Map([['/srv/test', { targetRepo: '/srv/test', checks: ['npm test'], deployment: 'task-tracker' }]]);
  assert.throws(() => verifyGoalDelivery(owner, normal, { passed: true, evidenceRefs: ['health:200'], deployment: 'not_required' }, db, deployedRepos), /deployment\.verified/);
  assert.strictEqual(verifyGoalDelivery(owner, normal, { passed: true, evidenceRefs: ['health:200'], deployment: 'not_required' }, db, repos), 'done');
  assert.strictEqual(getGoal(normal, db)?.status, 'Done');
  assert.strictEqual((db.prepare("SELECT COUNT(*) AS n FROM goal_heartbeats WHERE goal_id = ? AND phase = 'followup'").get(normal) as { n: number }).n, 1);
  assert.throws(() => createFollowupGoal(owner, normal, { objective: 'same', successCriteria: 'passes', reason: 'x', evidenceRefs: ['new'] }, db, repos), /不同成功條件/);
  assert.strictEqual(saveFollowupCandidate(owner, normal, {
    objective: 'candidate', successCriteria: 'candidate passes', reason: 'save for later', evidenceRefs: ['candidate:evidence'],
  }, db), 'saved');
  assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM goals_read_model WHERE parent_goal_id = ?').get(normal) as { n: number }).n, 0,
    '保存候選不得建立 Goal');
  const child = createFollowupGoal(owner, normal, { objective: 'follow', successCriteria: 'new pass', reason: 'new evidence', evidenceRefs: ['commit:new'] }, db, repos);
  assert.strictEqual(getGoal(child, db)?.parent_goal_id, normal);
  assert.throws(() => createFollowupGoal(owner, normal, { objective: 'follow', successCriteria: 'new pass', reason: 'again', evidenceRefs: ['commit:new'] }, db, repos), /重複/);
  cancelGoal(owner, child, db);
  const autonomousBlocker = makeGoal('active autonomous');
  db.prepare("UPDATE goals_read_model SET source = 'owner_discovery' WHERE goal_id = ?").run(autonomousBlocker);
  assert.throws(() => createFollowupGoal(owner, normal, {
    objective: 'blocked follow', successCriteria: 'another pass', reason: 'must use createGoal guard', evidenceRefs: ['commit:other'],
  }, db, repos), /active 自治 Goal/);
  cancelGoal(owner, autonomousBlocker, db);

  const solo = makeGoal('solo');
  selectGoalParticipants(owner, solo, [{ agentId: a2, reason: 'API', assignment: 'review', selectedLoad: 0 }], db);
  assert.strictEqual(await advanceGoalDiscussion(solo, deps), 'awaiting_lease');
  assert.deepStrictEqual({ ...db.prepare("SELECT status, reason FROM goal_rounds WHERE goal_id = ? AND round = 'round_2'").get(solo) },
    { status: 'skipped', reason: 'insufficient_peers' });
  const soloPlan = { summary: 'solo', decisionRationale: '採納唯一有效方案', changeScope: 'src/', uncertainties: [], taskPlans: [{ title: 'T', description: 'D', assigneeId: a2, dependsOn: [], deploymentNotRequired: false, acceptanceCriteria: 'pass', rollbackCondition: 'fail' }], evidenceRefs: ['x'] };
  storeGoalSynthesis(solo, soloPlan, db); const soloTaskIds = materializeGoalTasks(owner, solo, db);
  db.prepare("UPDATE tasks_read_model SET status = 'Done' WHERE goal_id = ?").run(solo);
  for (const kind of ['ci.checked', 'merge.integrated', 'deployment.verified'] as const) recordDeliveryEvidence(soloTaskIds[0], { kind, ref: kind, detail: kind === 'ci.checked' ? 'passed: branch CI completed' : '' }, db);
  assert.strictEqual(verifyGoalDelivery(owner, solo, { passed: false, evidenceRefs: ['fail:1'], deployment: 'not_required' }, db), 'retry');
  assert.strictEqual(getGoal(solo, db)?.discussion_phase, 'owner_synthesis');
  storeGoalSynthesis(solo, soloPlan, db); materializeGoalTasks(owner, solo, db);
  db.prepare("UPDATE tasks_read_model SET status = 'Done' WHERE goal_id = ?").run(solo);
  for (const task of db.prepare('SELECT task_id FROM tasks_read_model WHERE goal_id = ?').all(solo) as unknown as Array<{ task_id: string }>) {
    for (const kind of ['ci.checked', 'merge.integrated', 'deployment.verified'] as const) recordDeliveryEvidence(task.task_id, { kind, ref: kind, detail: kind === 'ci.checked' ? 'passed: branch CI completed' : '' }, db);
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
  resumeGoal('human', failed, '改用可用的 API reviewer', db);
  assert.deepStrictEqual(
    { phase: getGoal(failed, db)?.discussion_phase, revision: getGoal(failed, db)?.revision },
    { phase: 'owner_scoping', revision: 3 },
  );
  assert.strictEqual(selectGoalParticipants(owner, failed, [{ agentId: a3, reason: 'changed', assignment: 'changed scope', selectedLoad: 0 }], db), 'selected',
    '人類恢復後可沿用上一 revision 的同一組人與分工');
  assert.strictEqual(await advanceGoalDiscussion(failed, deps), 'awaiting_lease', '新 revision 的 reconciliation 次數必須重新計算');
  cancelGoal('human', failed, db);

  const humanRevised = makeGoal('human revised discussion');
  const repeatedSelection = [{ agentId: a2, reason: 'same', assignment: 'same scope', selectedLoad: 0 }];
  selectGoalParticipants(owner, humanRevised, repeatedSelection, db);
  reviseGoal('human', humanRevised, 'revised acceptance', db);
  assert.strictEqual(selectGoalParticipants(owner, humanRevised, repeatedSelection, db), 'selected',
    '人類修訂後可重新選擇原分工');
  assert.strictEqual(await advanceGoalDiscussion(humanRevised, { ...deps, invoke: async () => { throw new Error('runner failed'); } }), 'reconciled',
    '人類修訂不得耗掉唯一一次 Round 1 reconciliation');
  cancelGoal('human', humanRevised, db);

  const unchanged = makeGoal('unchanged reconciliation');
  const unchangedSelection = [{ agentId: a2, reason: 'same', assignment: 'same scope', selectedLoad: 0 }];
  selectGoalParticipants(owner, unchanged, unchangedSelection, db);
  assert.strictEqual(await advanceGoalDiscussion(unchanged, failing), 'reconciled');
  assert.strictEqual(selectGoalParticipants(owner, unchanged, unchangedSelection, db), 'blocked', 'reconciliation 完全相同時必須直接 Blocked');
  assert.strictEqual(getGoal(unchanged, db)?.status, 'Blocked');
  assert.deepStrictEqual(db.prepare(
    'SELECT recipient_id, source_task_id, source_goal_id FROM notifications_read_model WHERE source_goal_id = ?',
  ).all(unchanged).map((row) => ({ ...row })), [{ recipient_id: 'human-admin', source_task_id: '', source_goal_id: unchanged }]);
  cancelGoal('human', unchanged, db);

  const recovering = makeGoal('recovering');
  selectGoalParticipants(owner, recovering, [{ agentId: a2, reason: 'recovery', assignment: 'recover safely', selectedLoad: 0 }], db);
  const heartbeatId = enqueueHeartbeat({ scopeId: recovering, goalId: recovering, phase: 'round_1', agentId: a2, revision: 1, triggerRef: 'phase' }, db);
  const runId = prepareRun({ heartbeatId, goalId: recovering, agentId: a2, phase: 'round_1', adapter: 'claude', model: 'safe', attempt: 'primary', estimatedInputTokens: 1, estimatedOutputTokens: 1, estimateBasis: 'test', estimateConfidence: 'high', quotaSnapshotJson: '{}' }, db);
  markRunRunning(runId, db);
  assert.strictEqual(await advanceGoalDiscussion(recovering, deps), 'waiting', '未過期 running Run 不可封存 round');
  db.prepare("UPDATE goal_runs SET started_at = '2000-01-01T00:00:00.000Z' WHERE run_id = ?").run(runId);
  assert.strictEqual(await advanceGoalDiscussion(recovering, deps), 'reconciled', '過期 Run 先標 uncertain 再進 reconciliation');
  cancelGoal(owner, recovering, db);

  const makeDeliveryReadyGoal = async (name: string) => {
    const goalId = makeGoal(name);
    selectGoalParticipants(owner, goalId, [{ agentId: a2, reason: 'delivery', assignment: 'delivery verification', selectedLoad: 0 }], db);
    assert.strictEqual(await advanceGoalDiscussion(goalId, deps), 'awaiting_lease');
    storeGoalSynthesis(goalId, {
      summary: name, decisionRationale: 'delivery evidence test', changeScope: 'src/', uncertainties: [],
      taskPlans: [{ title: name, description: 'D', assigneeId: a2, dependsOn: [], deploymentNotRequired: true, acceptanceCriteria: 'pass', rollbackCondition: 'fail' }],
      evidenceRefs: ['test:evidence'],
    }, db);
    const [taskId] = materializeGoalTasks(owner, goalId, db);
    db.prepare("UPDATE tasks_read_model SET status = 'Done' WHERE task_id = ?").run(taskId);
    recordDeliveryEvidence(taskId, { kind: 'merge.integrated', ref: `${name}-merge` }, db);
    recordDeliveryEvidence(taskId, { kind: 'deployment_not_required', ref: `${name}-policy` }, db);
    return { goalId, taskId };
  };

  const recoveredCi = await makeDeliveryReadyGoal('latest CI passed');
  recordDeliveryEvidence(recoveredCi.taskId, { kind: 'ci.checked', ref: 'branch@sha-a', detail: 'failed: npm test exit 1' }, db);
  recordDeliveryEvidence(recoveredCi.taskId, { kind: 'ci.checked', ref: 'branch@sha-b', detail: 'passed: branch CI completed' }, db);
  assert.strictEqual(verifyGoalDelivery(owner, recoveredCi.goalId, { passed: true, evidenceRefs: ['ci:sha-b'], deployment: 'not_required' }, db, repos), 'done');

  const regressedCi = await makeDeliveryReadyGoal('latest CI failed');
  recordDeliveryEvidence(regressedCi.taskId, { kind: 'ci.checked', ref: 'branch@sha-a', detail: 'passed: branch CI completed' }, db);
  recordDeliveryEvidence(regressedCi.taskId, { kind: 'ci.checked', ref: 'branch@sha-b', detail: 'failed: npm test exit 1' }, db);
  assert.throws(
    () => verifyGoalDelivery(owner, regressedCi.goalId, { passed: true, evidenceRefs: ['ci:sha-b'], deployment: 'not_required' }, db, repos),
    /缺少 ci\.checked/,
  );
  cancelGoal('human', regressedCi.goalId, db);
}

main().then(() => console.log('goalOrchestrator.test.ts OK'));
