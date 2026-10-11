import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import {
  addContribution,
  addParticipation,
  enqueueHeartbeat,
  finishRun,
  getRun,
  listContributions,
  listHeartbeats,
  listParticipations,
  markRunRunning,
  prepareRun,
} from './goalRun';
import { runMigrations } from './schema';

const db = new DatabaseSync(':memory:');
runMigrations(db);

const heartbeatInput = {
  scopeId: 'goal-1',
  goalId: 'goal-1',
  phase: 'round_1',
  agentId: 'agent-2',
  revision: 1,
  triggerRef: 'phase',
};
const heartbeat = enqueueHeartbeat(heartbeatInput, db);
assert.strictEqual(enqueueHeartbeat(heartbeatInput, db), heartbeat, '相同 trigger 必須冪等');
const mentionA = enqueueHeartbeat({ ...heartbeatInput, phase: 'owner_comment', triggerRef: 'comment-a' }, db);
const mentionB = enqueueHeartbeat({ ...heartbeatInput, phase: 'owner_comment', triggerRef: 'comment-b' }, db);
assert.notStrictEqual(mentionA, mentionB, '兩則 @Owner 留言不可互相吞掉');
assert.strictEqual(listHeartbeats('goal-1', db).length, 3);

const run = prepareRun({
  heartbeatId: heartbeat,
  goalId: 'goal-1',
  taskId: null,
  agentId: 'agent-2',
  phase: 'round_1',
  adapter: 'claude',
  model: 'claude-sonnet-5-5',
  attempt: 'primary',
  estimatedInputTokens: 500,
  estimatedOutputTokens: 200,
  estimateBasis: 'bounded_context_chars',
  estimateConfidence: 'medium',
  quotaSnapshotJson: '{"cachedAt":"t"}',
}, db);
assert.strictEqual(getRun(run, db)?.status, 'pending', 'Run 必須先以 estimate/quota 持久化');
assert.throws(() => markRunRunning('missing', db), /run 不存在/);
markRunRunning(run, db);
finishRun(run, {
  status: 'succeeded',
  actualInputTokens: null,
  actualOutputTokens: null,
  actualCost: null,
  credibleBilling: false,
  outcome: 'valid_contribution',
  errorCategory: null,
  evidenceRef: 'contribution:1',
  sideEffectState: 'none',
}, db);
assert.strictEqual(getRun(run, db)?.actual_input_tokens, null, '缺少 usage 不可寫成零');

const fallback = prepareRun({
  ...{
    heartbeatId: heartbeat, goalId: 'goal-1', taskId: null, agentId: 'agent-2', phase: 'round_1',
    adapter: 'codex', model: 'gpt-5.6-sol', attempt: 'fallback', estimatedInputTokens: 500,
    estimatedOutputTokens: 200, estimateBasis: 'bounded_context_chars', estimateConfidence: 'medium',
    quotaSnapshotJson: '{"cachedAt":"t"}',
  },
}, db);
assert.notStrictEqual(run, fallback, 'primary/fallback 是不同 Run');
assert.throws(() => finishRun(fallback, {
  status: 'failed', actualInputTokens: null, actualOutputTokens: null, actualCost: 1,
  credibleBilling: false, outcome: null, errorCategory: 'quota', evidenceRef: null, sideEffectState: 'none',
}, db), /可信 billing/);

addParticipation({
  goalId: 'goal-1', revision: 1, agentId: 'agent-2', reason: 'backend fit',
  assignment: 'review API boundary', selectedLoad: 0,
}, db);
assert.throws(() => addParticipation({
  goalId: 'goal-1', revision: 1, agentId: 'agent-2', reason: 'duplicate',
  assignment: 'again', selectedLoad: 0,
}, db), /已存在/);
assert.strictEqual(listParticipations('goal-1', 1, db).length, 1);

addContribution({
  goalId: 'goal-1', revision: 1, round: 'round_1', agentId: 'agent-2',
  stance: 'analysis', claim: 'Validate project ownership', reason: 'Prevents cross-workspace writes',
  evidenceRefs: ['src/project.ts'],
}, db);
assert.throws(() => addContribution({
  goalId: 'goal-1', revision: 1, round: 'round_2', agentId: 'agent-3',
  stance: 'agree', claim: '收到', reason: '了解', evidenceRefs: [],
}, db), /實質內容/);
assert.strictEqual(listContributions('goal-1', 1, db).length, 1);

console.log('goalRun.test.ts OK');
