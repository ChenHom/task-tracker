import assert from 'node:assert';
import { selectCoordinatorActions, type CoordinatorSnapshot, type TaskSnapshot } from './policy';

const task = (status: 'Todo' | 'Doing'): TaskSnapshot => ({
  taskId: `paused-${status.toLowerCase()}`,
  workspaceId: 'external-workspace',
  title: `paused ${status}`,
  status,
  assigneeId: 'agent-user',
  dueAt: null,
  updatedAt: '2026-10-12T00:00:00.000Z',
  version: 1,
  goalId: 'paused-goal',
  goalStatus: 'Executing',
  goalPauseRequested: true,
  targetRepo: '/registered/repo',
});

const snapshot = (goalTask: TaskSnapshot): CoordinatorSnapshot => ({
  tasks: [goalTask],
  taskRuns: {},
  taskEvidence: {},
  prerequisiteEvidence: null,
  userIdsByEmail: {},
  agentIds: ['agent-user'],
});

const now = new Date('2026-10-12T00:00:00.000Z');
assert.deepStrictEqual(selectCoordinatorActions(snapshot(task('Todo')), now), [], 'pause_requested Goal 不得開始 Todo Task');
assert.strictEqual(selectCoordinatorActions(snapshot(task('Doing')), now)[0]?.kind, 'member_work', 'Doing Task 應繼續到安全 checkpoint');

console.log('production/policy.test.ts OK');
