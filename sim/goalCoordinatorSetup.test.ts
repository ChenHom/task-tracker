import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resetProjections } from '../src/eventStore';
import { blockGoal, createGoal, startDiscussion } from '../src/goal';
import type { RepoRegistry } from '../src/repoRegistry';
import { runMigrations } from '../src/schema';
import { initializeGoalCoordinatorProjections } from './goalCoordinatorSetup';

const database = new DatabaseSync(':memory:');
runMigrations(database);
resetProjections();
initializeGoalCoordinatorProjections();
database.prepare("INSERT INTO workspaces_read_model VALUES ('ws','W','active','t',NULL)").run();
database.prepare("INSERT INTO users (id,email,name,password_hash) VALUES ('human','human@test','Human','hash'),('owner-user','owner@test','Owner','hash')").run();
database.prepare("INSERT INTO workspace_members_read_model VALUES ('ws','human','Admin','t'),('ws','owner-user','Owner','t')").run();
database.prepare("INSERT INTO projects_read_model (project_id,workspace_id,name,status,target_repo,created_at,updated_at) VALUES ('p','ws','P','active','/repo','t','t')").run();
database.prepare(`INSERT INTO agents
  (agent_id,user_id,email,name,role,skill_profile_json,primary_adapter,primary_model,status,created_at,updated_at)
  VALUES ('owner','owner-user','owner@test','Owner','owner','{}','claude','m','active','t','t')`).run();
const repos: RepoRegistry = new Map([['/repo', { targetRepo: '/repo', checks: [], deployment: 'not_required' }]]);
const goalId = createGoal('human', {
  workspaceId: 'ws', projectId: 'p', objective: 'blocked setup', successCriteria: 'human resolves', ownerAgentId: 'owner',
}, database, repos);
startDiscussion('owner', goalId, database);
blockGoal('owner', goalId, 'setup notification', database);
assert.deepStrictEqual(database.prepare(
  'SELECT recipient_id, source_goal_id FROM notifications_read_model',
).all().map((row) => ({ ...row })), [{ recipient_id: 'human', source_goal_id: goalId }]);
database.close();
console.log('goalCoordinatorSetup.test.ts OK');
