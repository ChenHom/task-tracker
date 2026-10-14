import assert from 'node:assert';
import {
  CUTOVER_TASKS,
  MAIN_WORKSPACE_ID,
  mainDiscussionEvidenceFingerprint,
  selectCoordinatorActions,
  taskEvidenceFingerprint,
  type CoordinatorSnapshot,
  type TaskEvidence,
  type TaskSnapshot,
} from './policy';

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

const boardTask = (taskId: string, status: TaskSnapshot['status'], assigneeId: string | null = null): TaskSnapshot => ({
  taskId,
  workspaceId: MAIN_WORKSPACE_ID,
  title: taskId,
  status,
  assigneeId,
  dueAt: null,
  updatedAt: '2026-10-14T00:00:00.000Z',
  version: 1,
});

const cutoverTasks = (statusById: Partial<Record<string, TaskSnapshot['status']>> = {}): TaskSnapshot[] => [
  boardTask(CUTOVER_TASKS.mainDiscussion, statusById[CUTOVER_TASKS.mainDiscussion] ?? 'Archived'),
  boardTask(CUTOVER_TASKS.activeReview.taskId, statusById[CUTOVER_TASKS.activeReview.taskId] ?? 'Archived', 'user06'),
  boardTask(CUTOVER_TASKS.queuedReview.taskId, statusById[CUTOVER_TASKS.queuedReview.taskId] ?? 'Archived'),
  boardTask(CUTOVER_TASKS.completedPrerequisite.taskId, statusById[CUTOVER_TASKS.completedPrerequisite.taskId] ?? 'Archived'),
  boardTask(CUTOVER_TASKS.deferredAssignment.taskId, statusById[CUTOVER_TASKS.deferredAssignment.taskId] ?? 'Archived'),
];

const cutoverSnapshot = (tasks: TaskSnapshot[]): CoordinatorSnapshot => ({
  tasks,
  taskRuns: {},
  taskEvidence: {},
  prerequisiteEvidence: null,
  userIdsByEmail: { 'user06@test.local': 'user06', 'user05@test.local': 'user05' },
});

const archivedCutoverIds = new Set(cutoverTasks().map(({ taskId }) => taskId));
const settledActions = selectCoordinatorActions(cutoverSnapshot([
  ...cutoverTasks(),
  boardTask('current-review', 'Review', 'reviewer'),
  boardTask('current-todo', 'Todo'),
]), now);
assert.strictEqual(
  settledActions.some(({ kind }) => kind === 'cutover_prerequisite_missing'),
  false,
  '五筆 cutover task 全部 Archived 時不得再要求舊證據鏈',
);
assert.strictEqual(
  settledActions.some(({ taskId }) => archivedCutoverIds.has(taskId)),
  false,
  '五筆 cutover task 全部結案時不得再產生固定處置',
);
assert.deepStrictEqual(
  settledActions.map(({ kind, taskId }) => ({ kind, taskId })),
  [
    { kind: 'main_discussion_owner', taskId: 'current-todo' },
  ],
  'cutover 結案後主工作區的非固定 ID Todo 應走主討論流程',
);

assert.strictEqual(
  settledActions.some(({ taskId }) => taskId === 'current-review'),
  false,
  '沒有 coordinator task_run branch 的 Review task 不得排 owner_review',
);

const missingEvidenceActions = selectCoordinatorActions(cutoverSnapshot(cutoverTasks({
  [CUTOVER_TASKS.completedPrerequisite.taskId]: 'Doing',
})), now);
assert.strictEqual(
  missingEvidenceActions.some(({ kind }) => kind === 'cutover_prerequisite_missing'),
  true,
  '任一 cutover task 尚未終態時仍須驗證 completedPrerequisite 證據鏈',
);

const activeReviewSnapshot = cutoverSnapshot(cutoverTasks({
  [CUTOVER_TASKS.activeReview.taskId]: 'Review',
}));
activeReviewSnapshot.taskRuns[CUTOVER_TASKS.activeReview.taskId] = {
  taskId: CUTOVER_TASKS.activeReview.taskId,
  workspaceId: MAIN_WORKSPACE_ID,
  phase: 'review',
  workerId: null,
  branch: 'task/active-review',
  baseSha: 'base',
  headSha: 'head',
  evidenceFingerprint: '',
  noProgressCount: 0,
  ownerIntervened: false,
  leaseUntil: null,
  updatedAt: now.toISOString(),
};
const activeReviewActions = selectCoordinatorActions(activeReviewSnapshot, now);
assert.strictEqual(
  activeReviewActions.some(({ taskId, kind, reason }) => (
    taskId === CUTOVER_TASKS.activeReview.taskId
    && kind === 'owner_review'
    && reason.includes('fixed cutover disposition')
  )),
  true,
  'activeReview 尚未終態時仍須套用固定處置',
);

const discussionTask = boardTask('main-discussion-g2', 'Todo');
const discussionEvidence: TaskEvidence = {
  taskId: discussionTask.taskId,
  status: 'Todo',
  assigneeId: null,
  dueAt: null,
  commentCount: 1,
  lastCommentId: 'comment-1',
  lastCommentAt: '2026-10-14T00:00:00.000Z',
};
const discussionSnapshot = cutoverSnapshot([
  ...cutoverTasks(),
  discussionTask,
]);
discussionSnapshot.taskEvidence[discussionTask.taskId] = discussionEvidence;
discussionSnapshot.taskRuns[discussionTask.taskId] = {
  taskId: discussionTask.taskId,
  workspaceId: MAIN_WORKSPACE_ID,
  phase: 'doing',
  workerId: null,
  branch: null,
  baseSha: null,
  headSha: null,
  evidenceFingerprint: taskEvidenceFingerprint(discussionEvidence),
  noProgressCount: 0,
  ownerIntervened: false,
  leaseUntil: null,
  updatedAt: now.toISOString(),
};
assert.deepStrictEqual(
  selectCoordinatorActions(discussionSnapshot, now).filter(({ taskId }) => taskId === discussionTask.taskId),
  [],
  'Owner intervene 後證據未變，不得再次排主討論',
);

discussionSnapshot.taskEvidence[discussionTask.taskId] = {
  ...discussionEvidence,
  commentCount: 2,
  lastCommentId: 'comment-2',
  lastCommentAt: '2026-10-14T00:01:00.000Z',
};
assert.strictEqual(
  selectCoordinatorActions(discussionSnapshot, now).some(({ taskId, kind }) => (
    taskId === discussionTask.taskId && kind === 'main_discussion_owner'
  )),
  true,
  '新增留言後應再次排主討論',
);

const overdueTask = { ...boardTask('main-discussion-overdue-g2', 'Todo'), dueAt: '2026-10-13T00:00:00.000Z' };
const overdueEvidence: TaskEvidence = { ...discussionEvidence, taskId: overdueTask.taskId, dueAt: overdueTask.dueAt };
const overdueSnapshot = cutoverSnapshot([...cutoverTasks(), overdueTask]);
overdueSnapshot.taskEvidence[overdueTask.taskId] = overdueEvidence;
overdueSnapshot.taskRuns[overdueTask.taskId] = {
  ...discussionSnapshot.taskRuns[discussionTask.taskId]!,
  taskId: overdueTask.taskId,
  evidenceFingerprint: mainDiscussionEvidenceFingerprint(overdueEvidence, now),
};
assert.deepStrictEqual(
  selectCoordinatorActions(overdueSnapshot, now).filter(({ taskId }) => taskId === overdueTask.taskId),
  [],
  '同一 dueAt 已處理且證據未變，不得再次排主討論',
);

console.log('production/policy.test.ts OK');
