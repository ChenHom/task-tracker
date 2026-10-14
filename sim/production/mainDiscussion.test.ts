import assert from 'node:assert/strict';

import { dispatchMainDiscussion } from '../production';
import {
  MAIN_WORKSPACE_ID,
  mainDiscussionEvidenceFingerprint,
  selectCoordinatorActions,
  type CommentSnapshot,
  type CoordinatorAction,
  type CoordinatorSnapshot,
  type TaskEvidence,
  type TaskSnapshot,
} from './policy';
import { getTaskRun, openCoordinatorState, upsertTaskCheckpoint } from './state';

const now = new Date('2026-10-14T01:00:00.000Z');
const task: TaskSnapshot = {
  taskId: 'main-discussion-dispatch-g2',
  workspaceId: MAIN_WORKSPACE_ID,
  title: 'G2 main discussion',
  status: 'Todo',
  assigneeId: null,
  dueAt: null,
  updatedAt: now.toISOString(),
  version: 1,
};
const action: CoordinatorAction = {
  kind: 'main_discussion_owner',
  taskId: task.taskId,
  workspaceId: task.workspaceId,
  reason: 'test',
};

function evidence(comments: CommentSnapshot[]): TaskEvidence {
  const last = comments.at(-1) ?? null;
  return {
    taskId: task.taskId,
    status: task.status,
    assigneeId: task.assigneeId,
    dueAt: task.dueAt,
    commentCount: comments.length,
    lastCommentId: last?.commentId ?? null,
    lastCommentAt: last?.createdAt ?? null,
  };
}

async function testInterveneCheckpointsEvidence(): Promise<void> {
  const db = openCoordinatorState(':memory:');
  const comments: CommentSnapshot[] = [{
    commentId: 'comment-1', taskId: task.taskId, userId: 'user', content: 'first', createdAt: now.toISOString(),
  }];
  const run = upsertTaskCheckpoint(db, {
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    phase: 'doing',
    evidenceFingerprint: '',
  }, now);
  const deps = {
    db,
    now: () => now,
    tracer: () => () => undefined,
    ownerClient: {
      getTask: async () => task,
      listComments: async () => comments,
      postCommentOnce: async () => { throw new Error('intervene 不應由 driver 貼留言'); },
      patchTaskField: async () => { throw new Error('主討論不得改 task status'); },
    },
    runOwnerSession: async () => ({
      exitCode: 0,
      decision: { action: 'intervene', rationale: '需要人類補充', evidenceCommentIds: [] },
    }),
  } as never;

  assert.strictEqual(await dispatchMainDiscussion(deps, action, run), 'no_change');
  const checkpoint = getTaskRun(db, task.taskId)!;
  assert.strictEqual(checkpoint.phase, 'doing', '主討論 checkpoint 必須保留既有 phase');
  assert.strictEqual(checkpoint.evidenceFingerprint, mainDiscussionEvidenceFingerprint(evidence(comments), now));

  const snapshot: CoordinatorSnapshot = {
    tasks: [task],
    taskRuns: { [task.taskId]: checkpoint },
    taskEvidence: { [task.taskId]: evidence(comments) },
    prerequisiteEvidence: null,
    userIdsByEmail: {},
  };
  assert.deepStrictEqual(
    selectCoordinatorActions(snapshot, now).filter(({ taskId }) => taskId === task.taskId),
    [],
    'intervene 後相同證據不得再次排程',
  );

  comments.push({
    commentId: 'comment-2', taskId: task.taskId, userId: 'user', content: 'new evidence', createdAt: now.toISOString(),
  });
  snapshot.taskEvidence[task.taskId] = evidence(comments);
  assert.strictEqual(
    selectCoordinatorActions(snapshot, now).some(({ taskId, kind }) => taskId === task.taskId && kind === 'main_discussion_owner'),
    true,
    '新增留言後必須再次排程',
  );
  db.close();
}

async function testConclusionFingerprintsPostedCommentWithoutChangingStatus(): Promise<void> {
  const db = openCoordinatorState(':memory:');
  const comments: CommentSnapshot[] = [];
  const run = upsertTaskCheckpoint(db, {
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    phase: 'doing',
    evidenceFingerprint: '',
  }, now);
  let statusPatchCalls = 0;
  const deps = {
    db,
    now: () => now,
    tracer: () => () => undefined,
    ownerClient: {
      getTask: async () => task,
      listComments: async () => comments,
      postCommentOnce: async (_taskId: string, content: string) => {
        comments.push({
          commentId: 'conclusion-comment', taskId: task.taskId, userId: 'owner', content, createdAt: now.toISOString(),
        });
      },
      patchTaskField: async () => { statusPatchCalls++; },
    },
    runOwnerSession: async () => ({
      exitCode: 0,
      decision: {
        action: 'conclude-discussion', rationale: '已形成結論', evidenceCommentIds: [], outcome: 'implement',
      },
    }),
  } as never;

  assert.strictEqual(await dispatchMainDiscussion(deps, action, run), 'progressed');
  assert.strictEqual(statusPatchCalls, 0, '主討論不得把 Todo 改成其他狀態');
  assert.strictEqual(comments.length, 1, '結論留言必須成功建立');
  assert.strictEqual(
    getTaskRun(db, task.taskId)?.evidenceFingerprint,
    mainDiscussionEvidenceFingerprint(evidence(comments), now),
    'checkpoint 必須納入 action 自己貼出的留言',
  );
  db.close();
}

async function main(): Promise<void> {
  await testInterveneCheckpointsEvidence();
  await testConclusionFingerprintsPostedCommentWithoutChangingStatus();
}

main()
  .then(() => console.log('production/mainDiscussion.test.ts OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
