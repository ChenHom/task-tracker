import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { CommandError } from './eventStore';
import { createComment, listComments } from './comment';
import {
  getMainDiscussionWindow,
  recordMainDiscussionWindowForComment,
  resolveMainDiscussionConclusion,
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
請在固定期限內提出意見。`;
const LEGACY_FIXED_REQUEST = `【全員回覆：24小時】
@user02 @user03 @user04 @user05 @user06 @user09
請在期限內提出意見。`;

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

function seedCreatedTask(taskId: string, creatorId: string): void {
  seedTask(taskId);
  db.prepare(
    `INSERT INTO event_store
       (aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, metadata_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'Task',
    taskId,
    1,
    'task.created',
    JSON.stringify({ workspaceId: MAIN_WORKSPACE_ID }),
    JSON.stringify({ actor_id: creatorId }),
    OPENED_AT,
  );
}

function openForConclusion(taskId: string, creatorId: string): { thoughtId: string; requestId: string } {
  seedCreatedTask(taskId, creatorId);
  const thoughtId = `${taskId}-thought`;
  const requestId = `${taskId}-request`;
  addThought(taskId, thoughtId);
  addRequest(taskId, TWO_DAY_REQUEST, 'owner', requestId);
  recordMainDiscussionWindowForComment({
    taskId,
    userId: 'owner',
    commentId: requestId,
    content: TWO_DAY_REQUEST,
    createdAt: OPENED_AT,
  }, db);
  assert.ok(getMainDiscussionWindow(taskId, db));
  return { thoughtId, requestId };
}

// 模擬既有窗口：直接寫 DB，不經過 recordMainDiscussionWindowForComment。
// due_at 固定設為已過期的 OPENED_AT，因為收尾時的內容再驗證發生在期限檢查之後，
// 不需要以 wait_half_days 反推真實到期時間。
function seedLegacyWindow(
  taskId: string,
  creatorId: string,
  requestContent: string,
  dbWaitHalfDays: number,
): { thoughtId: string; requestId: string } {
  seedCreatedTask(taskId, creatorId);
  const thoughtId = `${taskId}-thought`;
  const requestId = `${taskId}-request`;
  addThought(taskId, thoughtId);
  addRequest(taskId, requestContent, 'owner', requestId);
  db.prepare(
    `INSERT INTO main_discussion_windows
       (task_id, owner_thought_comment_id, request_comment_id, opened_at, wait_half_days, due_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(taskId, thoughtId, requestId, OPENED_AT, dbWaitHalfDays, OPENED_AT);
  return { thoughtId, requestId };
}

const CLOSE_NOW = '2026-07-17T08:00:00.000Z';

// ── 2 天窗口：開啟 ─────────────────────────────────────────────────
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

// ── 已存在的 24 小時 marker 不得再開啟新窗口 ────────────────────────
seedTask('task-2');
addThought('task-2');
const legacyNewAttemptId = addRequest('task-2', LEGACY_FIXED_REQUEST);
assert.throws(
  () => recordMainDiscussionWindowForComment({
    taskId: 'task-2',
    userId: 'owner',
    commentId: legacyNewAttemptId,
    content: LEGACY_FIXED_REQUEST,
    createdAt: OPENED_AT,
  }, db),
  { name: 'CommandError', message: '全員回覆期限必須是 2 到 7 天，並以 0.5 天遞增' },
  '舊 24 小時 marker 不得用來開啟新窗口',
);
assert.strictEqual(getMainDiscussionWindow('task-2', db), null, '被拒絕的嘗試不可留下窗口');

// ── 唯讀 legacy parser：既有 24 小時窗口仍可收尾 ────────────────────
const legacyRegression = seedLegacyWindow('task-legacy-regression', 'user02', LEGACY_FIXED_REQUEST, 2);
addComment('task-legacy-regression', 'task-legacy-regression-decision', 'owner', '【結論】\n採用此方向。');
addComment('task-legacy-regression', 'task-legacy-regression-handoff', 'owner', '【實作任務】工作區：Task Tracker｜TASK：既有 legacy 窗口收尾回歸');
assert.deepStrictEqual(
  resolveMainDiscussionConclusion('task-legacy-regression', 'owner', new Date(CLOSE_NOW), db),
  {
    status: 'Done',
    outcome: 'implement',
    windowOpenedAt: OPENED_AT,
    windowDueAt: OPENED_AT,
    ownerThoughtCommentId: legacyRegression.thoughtId,
    requestCommentId: legacyRegression.requestId,
    decisionCommentId: 'task-legacy-regression-decision',
    confirmationCommentId: null,
    handoffCommentId: 'task-legacy-regression-handoff',
    implementationWorkspaceName: 'Task Tracker',
    implementationTaskName: '既有 legacy 窗口收尾回歸',
    implementationTasks: [{ workspaceName: 'Task Tracker', taskName: '既有 legacy 窗口收尾回歸' }],
  },
  '既有 wait_half_days:2 且 request 為舊 24 小時 marker 的窗口，到期後仍可機械式收尾',
);

// ── 新窗口接受半天遞增與較長期限理由 ────────────────────────────────
seedTask('task-2.5');
addThought('task-2.5');
const twoAndHalfRequest = addRequest(
  'task-2.5',
  `【全員回覆：2.5天】
較長期限理由：近期成員已有大量事務需要處理。`,
);
assert.deepStrictEqual(
  recordMainDiscussionWindowForComment({
    taskId: 'task-2.5', userId: 'owner', commentId: twoAndHalfRequest,
    content: `【全員回覆：2.5天】\n較長期限理由：近期成員已有大量事務需要處理。`, createdAt: OPENED_AT,
  }, db),
  {
    taskId: 'task-2.5', ownerThoughtCommentId: 'task-2.5-thought', requestCommentId: 'task-2.5-request',
    openedAt: OPENED_AT, waitHalfDays: 5, dueAt: '2026-07-16T20:00:00.000Z',
  },
  '2.5 天應可開啟新窗口，且期限須依半天遞增計算',
);

// ── 新窗口會擋下缺少較長期限理由的 N 天 marker ──────────────────────
seedTask('task-missing-reason');
addThought('task-missing-reason');
const missingReasonRequest = addRequest('task-missing-reason', '【全員回覆：3天】');
assert.throws(
  () => recordMainDiscussionWindowForComment({
    taskId: 'task-missing-reason', userId: 'owner', commentId: missingReasonRequest,
    content: '【全員回覆：3天】', createdAt: OPENED_AT,
  }, db),
  { name: 'CommandError', message: '超過 2 天必須填寫較長期限理由' },
  '缺少較長期限理由的通知不得開啟新窗口',
);

const legacyBelowMinimum = seedLegacyWindow('task-legacy-below-minimum', 'user02', '【全員回覆：1.5天】', 4);
assert.throws(
  () => resolveMainDiscussionConclusion('task-legacy-below-minimum', 'owner', new Date(CLOSE_NOW), db),
  { name: 'CommandError', message: '全員回覆期限必須是 2 到 7 天，並以 0.5 天遞增' },
  '低於 2 天的舊內容應被擋下',
);
assert.ok(legacyBelowMinimum);

const legacyAboveMaximum = seedLegacyWindow('task-legacy-above-maximum', 'user02', '【全員回覆：8天】', 4);
assert.throws(
  () => resolveMainDiscussionConclusion('task-legacy-above-maximum', 'owner', new Date(CLOSE_NOW), db),
  { name: 'CommandError', message: '全員回覆期限必須是 2 到 7 天，並以 0.5 天遞增' },
  '超過 7 天的舊內容應被擋下',
);
assert.ok(legacyAboveMaximum);

// ── 開窗前置條件（thought、owner、狀態、重複開窗）不受期限格式影響 ──
seedTask('task-7');
addThought('task-7');
const malformedContent = '【全員回覆：24小時】 這是一般留言';
const malformedId = addRequest('task-7', malformedContent);
assert.strictEqual(
  recordMainDiscussionWindowForComment({
    taskId: 'task-7',
    userId: 'owner',
    commentId: malformedId,
    content: malformedContent,
    createdAt: OPENED_AT,
  }, db),
  null,
  'marker 後未接換行即視為一般留言',
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
  {
    name: 'CommandError',
    message: '全員通知前必須先留下完整的 OWNER想法，缺少：風險與反對理由、現行可替代方案、初步判斷、希望成員確認的問題',
  },
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

seedTask('task-15');
createComment('task-15', 'owner', OWNER_THOUGHT, db, new Date(OPENED_AT));
createComment('task-15', 'owner', TWO_DAY_REQUEST, db, new Date(OPENED_AT));
assert.ok(getMainDiscussionWindow('task-15', db), '合法通知應由 createComment 建立窗口');

seedTask('task-16');
assert.throws(
  () => createComment('task-16', 'owner', TWO_DAY_REQUEST, db, new Date(OPENED_AT)),
  { name: 'CommandError', message: '全員通知前必須先留下完整的 OWNER想法' },
  '缺少 thought 的通知應整體失敗',
);
assert.strictEqual(listComments('task-16', db).length, 0, '失敗通知不可留下 comment');
assert.strictEqual(getMainDiscussionWindow('task-16', db), null, '失敗通知不可留下 window');

// ── 收尾：期限、結論、交接（不再要求任何確認留言）───────────────────

const implementEvidence = openForConclusion('task-implement', 'user02');
const implementConclusionId = 'task-implement-conclusion';
const implementHandoffId = 'task-implement-handoff';
addComment('task-implement', implementConclusionId, 'owner', '【結論】\n採用此方向。');
addComment('task-implement', implementHandoffId, 'owner', '【實作任務】工作區：Task Tracker｜TASK：加入主工作區收尾守門');
assert.deepStrictEqual(
  resolveMainDiscussionConclusion('task-implement', 'owner', new Date(CLOSE_NOW), db),
  {
    status: 'Done',
    outcome: 'implement',
    windowOpenedAt: OPENED_AT,
    windowDueAt: '2026-07-16T08:00:00.000Z',
    ownerThoughtCommentId: implementEvidence.thoughtId,
    requestCommentId: implementEvidence.requestId,
    decisionCommentId: implementConclusionId,
    confirmationCommentId: null,
    handoffCommentId: implementHandoffId,
    implementationWorkspaceName: 'Task Tracker',
    implementationTaskName: '加入主工作區收尾守門',
    implementationTasks: [{ workspaceName: 'Task Tracker', taskName: '加入主工作區收尾守門' }],
  },
  '期限後即使沒有【確認結論】也能成功收尾',
);

const multipleHandoffEvidence = openForConclusion('task-multiple-handoff', 'user02');
addComment('task-multiple-handoff', 'task-multiple-handoff-decision', 'owner', '【結論】\n採用此方向。');
addComment('task-multiple-handoff', 'task-multiple-handoff-handoff-1', 'owner', '【實作任務】工作區：Task Tracker｜TASK：前端部分');
addComment('task-multiple-handoff', 'task-multiple-handoff-handoff-2', 'owner', '【實作任務】工作區：Task Tracker｜TASK：後端部分');
const multipleHandoffResult = resolveMainDiscussionConclusion('task-multiple-handoff', 'owner', new Date(CLOSE_NOW), db);
assert.strictEqual(multipleHandoffResult.handoffCommentId, 'task-multiple-handoff-handoff-1', '單一 handoff 欄位取第一筆，維持歷史 audit reader 相容');
assert.strictEqual(multipleHandoffResult.implementationTaskName, '前端部分');
assert.deepStrictEqual(
  multipleHandoffResult.implementationTasks,
  [
    { workspaceName: 'Task Tracker', taskName: '前端部分' },
    { workspaceName: 'Task Tracker', taskName: '後端部分' },
  ],
  '多筆 handoff 全部由 implementationTasks 承載',
);
assert.ok(multipleHandoffEvidence);

const noImplementationEvidence = openForConclusion('task-no-implementation', 'user02');
const noImplementationConclusionId = 'task-no-implementation-conclusion';
addComment('task-no-implementation', noImplementationConclusionId, 'owner', '【結論：不實作】\n沿用現行替代方案。');
assert.deepStrictEqual(
  resolveMainDiscussionConclusion('task-no-implementation', 'owner', new Date(CLOSE_NOW), db),
  {
    status: 'Done',
    outcome: 'no_implementation',
    windowOpenedAt: OPENED_AT,
    windowDueAt: '2026-07-16T08:00:00.000Z',
    ownerThoughtCommentId: noImplementationEvidence.thoughtId,
    requestCommentId: noImplementationEvidence.requestId,
    decisionCommentId: noImplementationConclusionId,
    confirmationCommentId: null,
    handoffCommentId: null,
    implementationWorkspaceName: null,
    implementationTaskName: null,
    implementationTasks: [],
  },
  '不實作結論不再需要任何確認留言',
);

const noConsensusEvidence = openForConclusion('task-no-consensus', 'user02');
const noConsensusId = 'task-no-consensus-decision';
const taskCountBeforeNoConsensus = (db.prepare('SELECT COUNT(*) c FROM tasks_read_model').get() as { c: number }).c;
addComment('task-no-consensus', noConsensusId, 'owner', `【未達共識】
尚未解決的分歧：對風險仍有不同判斷
缺少的確認或資訊：需要實際數據
下次重新思考前的建議：補齊數據後另開新 TASK`);
assert.deepStrictEqual(
  resolveMainDiscussionConclusion('task-no-consensus', 'owner', new Date(CLOSE_NOW), db),
  {
    status: 'Done',
    outcome: 'no_consensus',
    windowOpenedAt: OPENED_AT,
    windowDueAt: '2026-07-16T08:00:00.000Z',
    ownerThoughtCommentId: noConsensusEvidence.thoughtId,
    requestCommentId: noConsensusEvidence.requestId,
    decisionCommentId: noConsensusId,
    confirmationCommentId: null,
    handoffCommentId: null,
    implementationWorkspaceName: null,
    implementationTaskName: null,
    implementationTasks: [],
  },
  '沒有成員回覆仍可在期限後走未達共識',
);
assert.strictEqual(
  (db.prepare('SELECT COUNT(*) c FROM tasks_read_model').get() as { c: number }).c,
  taskCountBeforeNoConsensus,
  '未達共識收尾不得建立 target task',
);

const beforeDeadlineEvidence = openForConclusion('task-before-deadline', 'user02');
addComment('task-before-deadline', 'task-before-deadline-decision', 'owner', '【未達共識】\n尚未解決的分歧：x\n缺少的確認或資訊：x\n下次重新思考前的建議：x');
assert.throws(
  () => resolveMainDiscussionConclusion('task-before-deadline', 'owner', new Date('2026-07-14T20:00:00.000Z'), db),
  { name: 'CommandError', message: '討論期限尚未到達：2026-07-16T08:00:00.000Z' },
  '截止前不可完成',
);
assert.ok(beforeDeadlineEvidence);

const invalidImplementationMarkerEvidence = openForConclusion('task-invalid-implementation-marker', 'user02');
addComment('task-invalid-implementation-marker', 'task-invalid-implementation-marker-decision', 'owner', '【結論：實作】\n採用此方向。');
assert.throws(
  () => resolveMainDiscussionConclusion('task-invalid-implementation-marker', 'owner', new Date(CLOSE_NOW), db),
  {
    name: 'CommandError',
    message: '尚未留下合法的主工作區結論；實作請依序留下「【結論】」→「【實作任務】工作區：...｜TASK：...」',
  },
  '實作結論 marker 錯誤時應回傳可直接修正的格式',
);
assert.ok(invalidImplementationMarkerEvidence);

const missingHandoffEvidence = openForConclusion('task-missing-handoff', 'user02');
addComment('task-missing-handoff', 'task-missing-handoff-decision', 'owner', '【結論】\n採用此方向。');
assert.throws(
  () => resolveMainDiscussionConclusion('task-missing-handoff', 'owner', new Date(CLOSE_NOW), db),
  { name: 'CommandError', message: '尚未留下合法的實作任務交接' },
  'implement 結論必須在決議後至少有一筆 Owner handoff',
);
assert.ok(missingHandoffEvidence);

const naturalLanguageMemberCommentEvidence = openForConclusion('task-natural-language-member-comment', 'user02');
addComment('task-natural-language-member-comment', 'task-natural-language-member-comment-reply', 'user02', '這看起來可以，沒什麼問題的話等時間到就安排下去吧');
addComment('task-natural-language-member-comment', 'task-natural-language-member-comment-decision', 'owner', '【結論】\n採用此方向。');
addComment('task-natural-language-member-comment', 'task-natural-language-member-comment-handoff', 'owner', '【實作任務】工作區：Task Tracker｜TASK：前端通知中心');
assert.deepStrictEqual(
  resolveMainDiscussionConclusion('task-natural-language-member-comment', 'owner', new Date(CLOSE_NOW), db),
  {
    status: 'Done',
    outcome: 'implement',
    windowOpenedAt: OPENED_AT,
    windowDueAt: '2026-07-16T08:00:00.000Z',
    ownerThoughtCommentId: naturalLanguageMemberCommentEvidence.thoughtId,
    requestCommentId: naturalLanguageMemberCommentEvidence.requestId,
    decisionCommentId: 'task-natural-language-member-comment-decision',
    confirmationCommentId: null,
    handoffCommentId: 'task-natural-language-member-comment-handoff',
    implementationWorkspaceName: 'Task Tracker',
    implementationTaskName: '前端通知中心',
    implementationTasks: [{ workspaceName: 'Task Tracker', taskName: '前端通知中心' }],
  },
  '成員的自然語句留言不再被解讀成核准，也不再是收尾的必要或充分條件',
);

const ownerCreatedEvidence = openForConclusion('task-owner-created', 'owner');
const ownerCreatedConclusionId = 'task-owner-created-conclusion';
addComment('task-owner-created', ownerCreatedConclusionId, 'owner', '【結論：不實作】\n沿用現行方案。');
assert.strictEqual(
  resolveMainDiscussionConclusion('task-owner-created', 'owner', new Date(CLOSE_NOW), db).outcome,
  'no_implementation',
  'OWNER 自建的討論同樣不需要任何確認即可收尾',
);

const invalidHandoffEvidence = openForConclusion('task-invalid-handoff', 'user02');
addComment('task-invalid-handoff', 'task-invalid-handoff-conclusion', 'owner', '【結論】\n採用。');
addComment('task-invalid-handoff', 'task-invalid-handoff-link', 'owner', '【實作任務】工作區：https://192.168.50.109/tracker｜TASK：不能提供連結');
assert.throws(
  () => resolveMainDiscussionConclusion('task-invalid-handoff', 'owner', new Date(CLOSE_NOW), db),
  CommandError,
  '實作交接不得是 URL',
);
assert.ok(invalidHandoffEvidence);

const editedRequiredEvidence = openForConclusion('task-edited-required', 'user02');
db.prepare('UPDATE comments SET content = ? WHERE comment_id = ?').run('普通留言', editedRequiredEvidence.requestId);
addComment('task-edited-required', 'task-edited-required-decision', 'owner', '【未達共識】\n尚未解決的分歧：x\n缺少的確認或資訊：x\n下次重新思考前的建議：x');
assert.throws(
  () => resolveMainDiscussionConclusion('task-edited-required', 'owner', new Date(CLOSE_NOW), db),
  CommandError,
  '必要 request 被修改後不可收尾',
);

console.log('mainDiscussion.test.ts OK');
