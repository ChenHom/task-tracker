import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { getUserIdByEmail } from '../src/auth';
import { resetProjections } from '../src/eventStore';
import { cancelGoal, createGoal, listGoals, registerGoalProjections, startDiscussion, setDiscussionPhase, acquireRepoLease, startExecution } from '../src/goal';
import { runMigrations } from '../src/schema';
import { seedUsers } from '../src/seed';
import { evidenceFingerprint, patrolSlot, runGoalPatrol, runLiveDiscovery } from './goalPatrol';

const db = new DatabaseSync(':memory:'); runMigrations(db); resetProjections(); registerGoalProjections(); seedUsers(db);
const owner = getUserIdByEmail('user01@test.local', db)!;
db.prepare("INSERT INTO workspaces_read_model VALUES ('ws', 'W', 'active', 't', NULL)").run();
db.prepare("INSERT INTO projects_read_model (project_id, workspace_id, name, status, target_repo, created_at, updated_at) VALUES ('p','ws','P','active','/repo','t','t')").run();
assert.strictEqual(patrolSlot(new Date('2026-10-11T03:59:00Z')), '2026-10-11T00:00+08:00');
const fingerprint = evidenceFingerprint(['commit:a']);
assert.strictEqual(runGoalPatrol({ workspaceId: 'ws', evidenceFingerprint: fingerprint, now: new Date('2026-10-11T00:00:00Z'), database: db }).status, 'eligible');
assert.strictEqual(runGoalPatrol({ workspaceId: 'ws', evidenceFingerprint: fingerprint, now: new Date('2026-10-11T12:00:00Z'), database: db }).reason, 'evidence_unchanged');
const auto = createGoal(owner, { workspaceId: 'ws', projectId: 'p', source: 'owner_discovery', objective: 'auto', successCriteria: 'done', ownerAgentId: owner }, db);
assert.strictEqual(runGoalPatrol({ workspaceId: 'ws', evidenceFingerprint: evidenceFingerprint(['commit:b']), now: new Date('2026-10-12T00:00:00Z'), database: db }).reason, 'active_autonomous_goal');
cancelGoal(owner, auto, db);
const human = createGoal('human', { workspaceId: 'ws', projectId: 'p', objective: 'human', successCriteria: 'done', ownerAgentId: owner }, db);
startDiscussion(owner, human, db); setDiscussionPhase(owner, human, 'round_1', db); setDiscussionPhase(owner, human, 'awaiting_lease', db); acquireRepoLease(owner, human, db); startExecution(owner, human, db);
assert.strictEqual(runGoalPatrol({ workspaceId: 'ws', evidenceFingerprint: evidenceFingerprint(['commit:c']), now: new Date('2026-10-12T12:00:00Z'), database: db }).reason, 'human_goal_executing');

void (async () => {
const liveDb = new DatabaseSync(':memory:'); runMigrations(liveDb); seedUsers(liveDb);
const liveOwner = getUserIdByEmail('user01@test.local', liveDb)!;
liveDb.prepare("INSERT INTO workspaces_read_model VALUES ('live-ws', 'Live', 'active', 't', NULL)").run();
liveDb.prepare("INSERT INTO projects_read_model (project_id, workspace_id, name, status, target_repo, created_at, updated_at) VALUES ('live-p','live-ws','Existing','active','/repo','t','t')").run();
const livePatrol = runGoalPatrol({ workspaceId: 'live-ws', evidenceFingerprint: evidenceFingerprint(['new']), now: new Date('2026-10-11T00:00:00Z'), database: liveDb, keepEligiblePending: true });
let invokes = 0;
const outcome = await runLiveDiscovery('live-ws', livePatrol.heartbeatId, liveDb, {
  quotaSnapshot: async () => '{}',
  invoke: async () => { invokes++; return JSON.stringify({ action: 'create', projectId: 'live-p', objective: 'Improve existing project', successCriteria: 'verified' }); },
});
assert.match(outcome, /^goal:/);
assert.strictEqual(invokes, 1);
assert.strictEqual(listGoals('live-ws', liveDb)[0].source, 'owner_discovery');
assert.strictEqual(listGoals('live-ws', liveDb)[0].owner_agent_id, liveOwner);
assert.strictEqual(listGoals('live-ws', liveDb)[0].status, 'Discussing', 'discovery Goal 必須立即啟動');
assert.ok(liveDb.prepare("SELECT 1 FROM goal_heartbeats WHERE goal_id = ? AND phase = 'owner_scoping' AND status = 'pending'").get(listGoals('live-ws', liveDb)[0].goal_id));
assert.strictEqual(await runLiveDiscovery('live-ws', livePatrol.heartbeatId, liveDb, {
  quotaSnapshot: async () => '{}', invoke: async () => { invokes++; throw new Error('不應重叫模型'); },
}), outcome, 'crash replay 應沿用已儲存輸出');
assert.strictEqual(invokes, 1);
assert.strictEqual(runGoalPatrol({ workspaceId: 'live-ws', evidenceFingerprint: evidenceFingerprint(['newer']), now: new Date('2026-10-11T12:00:00Z'), database: liveDb }).reason, 'active_autonomous_goal');
console.log('goalPatrol.test.ts OK');
})();
