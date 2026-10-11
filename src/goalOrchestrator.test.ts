import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { getUserIdByEmail } from './auth';
import { resetProjections } from './eventStore';
import { cancelGoal, createGoal, getGoal, registerGoalProjections, startDiscussion } from './goal';
import {
  advanceGoalDiscussion, getGoalSynthesis, selectGoalParticipants, storeGoalSynthesis,
  type DiscussionOutput,
} from './goalOrchestrator';
import { runMigrations } from './schema';
import { seedUsers } from './seed';

async function main(): Promise<void> {
  const db = new DatabaseSync(':memory:');
  runMigrations(db); resetProjections(); registerGoalProjections(); seedUsers(db);
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
  assert.throws(() => storeGoalSynthesis(normal, { summary: 'duplicate', taskPlans: [], evidenceRefs: [] }, db), /等待 lease|已存在/);
  cancelGoal('human', normal, db);

  const solo = makeGoal('solo');
  selectGoalParticipants(owner, solo, [{ agentId: a2, reason: 'API', assignment: 'review', selectedLoad: 0 }], db);
  assert.strictEqual(await advanceGoalDiscussion(solo, deps), 'awaiting_lease');
  assert.deepStrictEqual({ ...db.prepare("SELECT status, reason FROM goal_rounds WHERE goal_id = ? AND round = 'round_2'").get(solo) },
    { status: 'skipped', reason: 'insufficient_peers' });
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
}

main().then(() => console.log('goalOrchestrator.test.ts OK'));
