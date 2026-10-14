import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import {
  eligibleMemberAgents,
  getAgent,
  listAgents,
  listWorkspaceAgents,
  listWorkspaceAgentSummaries,
  syncAgents,
  updateAgent,
} from './agent';
import { runMigrations } from './schema';
import { seedUsers } from './seed';
import { enqueueHeartbeat, finishRun, markRunRunning, prepareRun } from './goalRun';

const db = new DatabaseSync(':memory:');
runMigrations(db);
seedUsers(db);
syncAgents(db);

const agents = listAgents(db);
assert.deepStrictEqual(
  agents.map((agent) => agent.email),
  [
    'user01@test.local', 'user02@test.local', 'user03@test.local',
    'user04@test.local', 'user05@test.local', 'user06@test.local',
  ],
  '只有 user01-user06 是 Agent resource',
);
assert.strictEqual(agents[0].role, 'owner');
assert.strictEqual(agents.some((agent) => agent.email === 'user09@test.local'), false, 'user09 必須保持人類');
assert.ok(agents.every((agent) => JSON.parse(agent.skill_profile_json).summary), '每位 Agent 都有 skill_profile');

const member = agents.find((agent) => agent.email === 'user03@test.local')!;
updateAgent(member.agent_id, { status: 'paused' }, db);
assert.strictEqual(getAgent(member.agent_id, db)?.status, 'paused');
assert.strictEqual(eligibleMemberAgents(db).some((agent) => agent.agent_id === member.agent_id), false);
assert.strictEqual(eligibleMemberAgents(db).some((agent) => agent.role === 'owner'), false, 'Owner 不列入參與者候選');

updateAgent(member.agent_id, { status: 'active' }, db);
updateAgent(member.agent_id, {
  primaryAdapter: 'agy',
  primaryModel: 'Gemini 3.7 Flash (High)',
}, db);
assert.deepStrictEqual(
  { adapter: getAgent(member.agent_id, db)?.primary_adapter, model: getAgent(member.agent_id, db)?.primary_model },
  { adapter: 'agy', model: 'Gemini 3.7 Flash (High)' },
  'route 修改從下一次讀取生效',
);
assert.throws(() => updateAgent(member.agent_id, { status: 'deleted' }, db), /status/);
assert.throws(() => updateAgent(member.agent_id, { primaryAdapter: 'shell' }, db), /adapter/);

syncAgents(db);
assert.strictEqual(listAgents(db).length, 6, '同步必須 idempotent 且保留人工 route 修改');
assert.strictEqual(getAgent(member.agent_id, db)?.primary_adapter, 'agy');

db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
  .run('ws-agents', 'Agents', 'active', 't');
db.prepare('INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
  .run('ws-agents', member.user_id, 'Member', 't');
assert.deepStrictEqual(listWorkspaceAgents('ws-agents', db).map((agent) => agent.agent_id), [member.agent_id]);
function createSummaryRun(triggerRef: string, attempt: 'primary' | 'fallback'): string {
  const heartbeatId = enqueueHeartbeat({
    scopeId: 'g', goalId: 'g', phase: 'implementation', agentId: member.agent_id, revision: 1, triggerRef,
  }, db);
  return prepareRun({
    heartbeatId, goalId: 'g', taskId: 'task-1', agentId: member.agent_id, phase: 'implementation',
    adapter: attempt === 'fallback' ? 'claude' : 'codex', model: 'm', attempt,
    estimatedInputTokens: 1, estimatedOutputTokens: 1, estimateBasis: 'test', estimateConfidence: 'high',
    quotaSnapshotJson: '{}',
  }, db);
}
function completeSummaryRun(runId: string, status: 'succeeded' | 'failed', errorCategory: string | null): void {
  markRunRunning(runId, db);
  finishRun(runId, {
    status, actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
    outcome: status, errorCategory, evidenceRef: null, sideEffectState: 'none',
  }, db);
}
completeSummaryRun(createSummaryRun('t', 'primary'), 'succeeded', null);
completeSummaryRun(createSummaryRun('f', 'fallback'), 'failed', 'quota');
const preflightRun = createSummaryRun('p', 'primary');
completeSummaryRun(preflightRun, 'failed', 'preflight');
const pendingRun = createSummaryRun('pending', 'primary');
const summaries = listWorkspaceAgentSummaries('ws-agents', db);
assert.strictEqual(summaries.length, 6, 'Agents 頁固定列出 user01–06，不受目前 workspace membership 限制');
const summary = summaries.find(agent => agent.agent_id === member.agent_id)!;
assert.strictEqual(summary.fallback_count, 1);
assert.strictEqual(summary.unknown_usage_count, 3);
assert.strictEqual((summary.latest_run as { run_id: string }).run_id, pendingRun);
assert.strictEqual((summary.latest_preflight as { run_id: string }).run_id, preflightRun);

console.log('agent.test.ts OK');
