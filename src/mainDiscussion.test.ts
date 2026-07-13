import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { CommandError } from './eventStore';
import {
  getMainDiscussionWindow,
  recordMainDiscussionWindowForComment,
} from './mainDiscussion';
import {
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_TITLE,
  MAIN_WORKSPACE_ID,
} from './mainWorkspacePolicy';

const db = new DatabaseSync(':memory:');
runMigrations(db);

const OPENED_AT = '2026-07-14T08:00:00.000Z';
const OWNER_THOUGHT = `【OWNER想法】
現況／問題：流程沒有收斂點
預期價值：讓討論能準時結束
風險與反對理由：可能壓縮複雜議題
現行可替代方案：人工提醒
初步判斷：先採固定窗口
希望成員確認的問題：兩天是否足夠`;
const TWO_DAY_REQUEST = `【全員回覆：2天】
@user02 @user03 @user04 @user05 @user06 @user09
請補充或表示已閱讀。`;

db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
  .run(MAIN_WORKSPACE_ID, '主協作工作區', 'active', '2026-07-01T00:00:00.000Z');
const insertUser = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
insertUser.run('owner', MAIN_OWNER_EMAIL, 'Owner', 'hash');
insertUser.run('user02', 'user02@test.local', 'User 02', 'hash');
insertUser.run('user03', 'user03@test.local', 'User 03', 'hash');
const insertMember = db.prepare(
  'INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
);
insertMember.run(MAIN_WORKSPACE_ID, 'owner', 'Owner', OPENED_AT);
insertMember.run(MAIN_WORKSPACE_ID, 'user02', 'Commenter', OPENED_AT);
insertMember.run(MAIN_WORKSPACE_ID, 'user03', 'Commenter', OPENED_AT);

function seedTask(taskId: string, status = 'Todo', title = `[討論] ${taskId}`): void {
  db.prepare(
    'INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, version) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(taskId, MAIN_WORKSPACE_ID, title, status, 'Medium', 1);
}

function addComment(taskId: string, commentId: string, userId: string, content: string): void {
  db.prepare(
    'INSERT INTO comments (comment_id, task_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(commentId, taskId, userId, content, OPENED_AT);
}

function addThought(taskId: string, commentId = `${taskId}-thought`, userId = 'owner', content = OWNER_THOUGHT): void {
  addComment(taskId, commentId, userId, content);
}

function addRequest(taskId: string, content: string, userId = 'owner', commentId = `${taskId}-request`): string {
  addComment(taskId, commentId, userId, content);
  return commentId;
}

seedTask('task-1');
addThought('task-1');
const requestId = addRequest('task-1', TWO_DAY_REQUEST);
const opened = recordMainDiscussionWindowForComment(
  {
    taskId: 'task-1',
    userId: 'owner',
    commentId: requestId,
    content: TWO_DAY_REQUEST,
    createdAt: OPENED_AT,
  },
  db,
);
assert.deepStrictEqual(opened, {
  taskId: 'task-1',
  ownerThoughtCommentId: 'task-1-thought',
  requestCommentId: 'task-1-request',
  openedAt: OPENED_AT,
  waitHalfDays: 4,
  dueAt: '2026-07-16T08:00:00.000Z',
});
assert.deepStrictEqual(getMainDiscussionWindow('task-1', db), opened);

seedTask('task-2');
addThought('task-2');
const halfDayRequest = `【全員回覆：2.5天】
較長期限理由：近期成員已有大量事務需要處理。`;
const halfDayRequestId = addRequest('task-2', halfDayRequest);
assert.strictEqual(
  recordMainDiscussionWindowForComment(
    {
      taskId: 'task-2',
      userId: 'owner',
      commentId: halfDayRequestId,
      content: halfDayRequest,
      createdAt: OPENED_AT,
    },
    db,
  )?.dueAt,
  '2026-07-16T20:00:00.000Z',
  '2.5 天應增加連續 60 小時',
);

seedTask('task-3');
addThought('task-3');
const missingReason = addRequest('task-3', '【全員回覆：3天】');
assert.throws(
  () => recordMainDiscussionWindowForComment({
    taskId: 'task-3',
    userId: 'owner',
    commentId: missingReason,
    content: '【全員回覆：3天】',
    createdAt: OPENED_AT,
  }, db),
  { name: 'CommandError', message: '超過 2 天必須填寫較長期限理由' },
);

for (const [taskId, content] of [
  ['task-4', '【全員回覆：1.5天】'],
  ['task-5', '【全員回覆：7.5天】'],
  ['task-6', '【全員回覆：8天】'],
] as const) {
  seedTask(taskId);
  addThought(taskId);
  const commentId = addRequest(taskId, content);
  assert.throws(
    () => recordMainDiscussionWindowForComment({ taskId, userId: 'owner', commentId, content, createdAt: OPENED_AT }, db),
    CommandError,
    `${content} 應拒絕`,
  );
}

seedTask('task-7');
addThought('task-7');
const ordinaryContent = '【全員回覆：2.25天】 這是一般留言';
const ordinaryId = addRequest('task-7', ordinaryContent);
assert.strictEqual(
  recordMainDiscussionWindowForComment({
    taskId: 'task-7',
    userId: 'owner',
    commentId: ordinaryId,
    content: ordinaryContent,
    createdAt: OPENED_AT,
  }, db),
  null,
);

seedTask('task-8');
addThought('task-8');
const nonOwnerRequest = addRequest('task-8', TWO_DAY_REQUEST, 'user02');
assert.throws(
  () => recordMainDiscussionWindowForComment({
    taskId: 'task-8',
    userId: 'user02',
    commentId: nonOwnerRequest,
    content: TWO_DAY_REQUEST,
    createdAt: OPENED_AT,
  }, db),
  { name: 'CommandError', message: '只有 user01 可以開啟主工作區回覆窗口' },
);

seedTask('task-9', 'Todo', MAIN_POLICY_TITLE);
addThought('task-9');
const policyRequest = addRequest('task-9', TWO_DAY_REQUEST);
assert.throws(
  () => recordMainDiscussionWindowForComment({
    taskId: 'task-9',
    userId: 'owner',
    commentId: policyRequest,
    content: TWO_DAY_REQUEST,
    createdAt: OPENED_AT,
  }, db),
  { name: 'CommandError', message: '只有主工作區 Todo 討論可以開啟回覆窗口' },
);

seedTask('task-10', 'Doing');
addThought('task-10');
const doingRequest = addRequest('task-10', TWO_DAY_REQUEST);
assert.throws(
  () => recordMainDiscussionWindowForComment({
    taskId: 'task-10',
    userId: 'owner',
    commentId: doingRequest,
    content: TWO_DAY_REQUEST,
    createdAt: OPENED_AT,
  }, db),
  CommandError,
);

seedTask('task-11');
const noThoughtRequest = addRequest('task-11', TWO_DAY_REQUEST);
assert.throws(
  () => recordMainDiscussionWindowForComment({
    taskId: 'task-11',
    userId: 'owner',
    commentId: noThoughtRequest,
    content: TWO_DAY_REQUEST,
    createdAt: OPENED_AT,
  }, db),
  { name: 'CommandError', message: '全員通知前必須先留下完整的 OWNER想法' },
);

seedTask('task-12');
addThought('task-12', 'task-12-user-thought', 'user02');
const wrongAuthorRequest = addRequest('task-12', TWO_DAY_REQUEST);
assert.throws(
  () => recordMainDiscussionWindowForComment({
    taskId: 'task-12',
    userId: 'owner',
    commentId: wrongAuthorRequest,
    content: TWO_DAY_REQUEST,
    createdAt: OPENED_AT,
  }, db),
  CommandError,
);

seedTask('task-13');
addThought('task-13', 'task-13-thought', 'owner', `【OWNER想法】
現況／問題：有問題
預期價值：有價值`);
const incompleteThoughtRequest = addRequest('task-13', TWO_DAY_REQUEST);
assert.throws(
  () => recordMainDiscussionWindowForComment({
    taskId: 'task-13',
    userId: 'owner',
    commentId: incompleteThoughtRequest,
    content: TWO_DAY_REQUEST,
    createdAt: OPENED_AT,
  }, db),
  CommandError,
);

const duplicateRequest = addRequest('task-1', TWO_DAY_REQUEST, 'owner', 'task-1-request-2');
assert.throws(
  () => recordMainDiscussionWindowForComment({
    taskId: 'task-1',
    userId: 'owner',
    commentId: duplicateRequest,
    content: TWO_DAY_REQUEST,
    createdAt: '2026-07-15T08:00:00.000Z',
  }, db),
  { name: 'CommandError', message: '主工作區回覆窗口已開啟，期限不可變更' },
);
assert.deepStrictEqual(getMainDiscussionWindow('task-1', db), opened);

seedTask('task-14');
addThought('task-14');
const noMentionRequest = addRequest('task-14', '【全員回覆：2天】\n請留言表示已閱讀。');
assert.ok(recordMainDiscussionWindowForComment({
  taskId: 'task-14',
  userId: 'owner',
  commentId: noMentionRequest,
  content: '【全員回覆：2天】\n請留言表示已閱讀。',
  createdAt: OPENED_AT,
}, db));

console.log('mainDiscussion.test.ts OK');
