import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { CommandError } from './eventStore';
import { resolveMainDiscussionConclusion } from './mainDiscussion';
import {
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_TITLE,
  MAIN_WORKSPACE_ID,
} from './mainWorkspacePolicy';

const db = new DatabaseSync(':memory:');
runMigrations(db);

const AT = '2026-07-14T08:00:00.000Z';
const OWNER_THOUGHT = `【OWNER想法】
現況／問題：流程沒有收斂點
預期價值：讓討論能收束
風險與反對理由：可能壓縮複雜議題
現行可替代方案：人工提醒
初步判斷：先讓 owner 自行判斷時機
希望成員確認的問題：這樣夠不夠`;

db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
  .run(MAIN_WORKSPACE_ID, '主協作工作區', 'active', '2026-07-01T00:00:00.000Z');
const insertUser = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
insertUser.run('owner', MAIN_OWNER_EMAIL, 'Owner', 'hash');
insertUser.run('user02', 'user02@test.local', 'User 02', 'hash');
const insertMember = db.prepare(
  'INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
);
insertMember.run(MAIN_WORKSPACE_ID, 'owner', 'Owner', AT);
insertMember.run(MAIN_WORKSPACE_ID, 'user02', 'Commenter', AT);

function seedTask(taskId: string, status = 'Todo', title = `[討論] ${taskId}`): void {
  db.prepare(
    'INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, version) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(taskId, MAIN_WORKSPACE_ID, title, status, 'Medium', 1);
}

function addComment(taskId: string, commentId: string, userId: string, content: string): void {
  db.prepare(
    'INSERT INTO comments (comment_id, task_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(commentId, taskId, userId, content, AT);
}

// 討論的收尾前置只剩「owner 留過完整的 OWNER想法」，沒有窗口、沒有期限。
function seedDiscussion(taskId: string, thoughtContent = OWNER_THOUGHT): string {
  seedTask(taskId);
  const thoughtId = `${taskId}-thought`;
  addComment(taskId, thoughtId, 'owner', thoughtContent);
  return thoughtId;
}

// ── 核心變更：沒有等待期，留完想法就能立刻收尾 ──────────────────────
const implementThought = seedDiscussion('task-implement');
addComment('task-implement', 'task-implement-decision', 'owner', '【結論】\n採用此方向。');
addComment('task-implement', 'task-implement-handoff', 'owner', '【實作任務】工作區：Task Tracker｜TASK：加入主工作區收尾守門');
assert.deepStrictEqual(
  resolveMainDiscussionConclusion('task-implement', 'owner', db),
  {
    status: 'Done',
    outcome: 'implement',
    ownerThoughtCommentId: implementThought,
    decisionCommentId: 'task-implement-decision',
    confirmationCommentId: null,
    handoffCommentId: 'task-implement-handoff',
    implementationWorkspaceName: 'Task Tracker',
    implementationTaskName: '加入主工作區收尾守門',
    implementationTasks: [{ workspaceName: 'Task Tracker', taskName: '加入主工作區收尾守門' }],
  },
  '留完想法與結論即可收尾，不需要等待任何期限',
);

// ── 三種 outcome ────────────────────────────────────────────────────
const noImplThought = seedDiscussion('task-no-implementation');
addComment('task-no-implementation', 'task-no-implementation-decision', 'owner', '【結論：不實作】\n沿用現行替代方案。');
assert.deepStrictEqual(
  resolveMainDiscussionConclusion('task-no-implementation', 'owner', db),
  {
    status: 'Done',
    outcome: 'no_implementation',
    ownerThoughtCommentId: noImplThought,
    decisionCommentId: 'task-no-implementation-decision',
    confirmationCommentId: null,
    handoffCommentId: null,
    implementationWorkspaceName: null,
    implementationTaskName: null,
    implementationTasks: [],
  },
  '不實作結論不需要交接也不需要確認留言',
);

const noConsensusThought = seedDiscussion('task-no-consensus');
const taskCountBefore = (db.prepare('SELECT COUNT(*) c FROM tasks_read_model').get() as { c: number }).c;
addComment('task-no-consensus', 'task-no-consensus-decision', 'owner', `【未達共識】
尚未解決的分歧：對風險仍有不同判斷
缺少的確認或資訊：需要實際數據
下次重新思考前的建議：補齊數據後另開新 TASK`);
assert.deepStrictEqual(
  resolveMainDiscussionConclusion('task-no-consensus', 'owner', db),
  {
    status: 'Done',
    outcome: 'no_consensus',
    ownerThoughtCommentId: noConsensusThought,
    decisionCommentId: 'task-no-consensus-decision',
    confirmationCommentId: null,
    handoffCommentId: null,
    implementationWorkspaceName: null,
    implementationTaskName: null,
    implementationTasks: [],
  },
  '無人回覆仍可走未達共識',
);
assert.strictEqual(
  (db.prepare('SELECT COUNT(*) c FROM tasks_read_model').get() as { c: number }).c,
  taskCountBefore,
  '未達共識收尾不得建立 target task',
);

// 未達共識缺欄位時不算合法結論。
seedDiscussion('task-no-consensus-missing-fields');
addComment('task-no-consensus-missing-fields', 'task-no-consensus-missing-fields-decision', 'owner', '【未達共識】\n尚未解決的分歧：只填一欄');
assert.throws(
  () => resolveMainDiscussionConclusion('task-no-consensus-missing-fields', 'owner', db),
  CommandError,
  '未達共識必須逐行填滿三個欄位',
);

// ── 順序仍然固定：結論必須在想法之後 ────────────────────────────────
seedTask('task-decision-before-thought');
addComment('task-decision-before-thought', 'task-decision-before-thought-decision', 'owner', '【結論：不實作】\n先不做。');
addComment('task-decision-before-thought', 'task-decision-before-thought-thought', 'owner', OWNER_THOUGHT);
assert.throws(
  () => resolveMainDiscussionConclusion('task-decision-before-thought', 'owner', db),
  CommandError,
  '想法之前留的結論不算數',
);

// ── 想法本身的守門 ──────────────────────────────────────────────────
seedTask('task-no-thought');
addComment('task-no-thought', 'task-no-thought-decision', 'owner', '【結論：不實作】\n先不做。');
assert.throws(
  () => resolveMainDiscussionConclusion('task-no-thought', 'owner', db),
  { name: 'CommandError', message: '收尾前必須留下完整的 OWNER想法' },
  '沒有想法不可收尾',
);

seedDiscussion('task-incomplete-thought', '【OWNER想法】\n現況／問題：有問題\n預期價值：有價值');
addComment('task-incomplete-thought', 'task-incomplete-thought-decision', 'owner', '【結論：不實作】\n先不做。');
assert.throws(
  () => resolveMainDiscussionConclusion('task-incomplete-thought', 'owner', db),
  { name: 'CommandError', message: '收尾前必須留下完整的 OWNER想法' },
  '六欄不齊的想法不可收尾',
);

seedTask('task-member-thought');
addComment('task-member-thought', 'task-member-thought-thought', 'user02', OWNER_THOUGHT);
addComment('task-member-thought', 'task-member-thought-decision', 'owner', '【結論：不實作】\n先不做。');
assert.throws(
  () => resolveMainDiscussionConclusion('task-member-thought', 'owner', db),
  { name: 'CommandError', message: '收尾前必須留下完整的 OWNER想法' },
  '成員留的想法不算 OWNER想法',
);

// ── 結論與交接的格式守門 ────────────────────────────────────────────
seedDiscussion('task-invalid-implementation-marker');
addComment('task-invalid-implementation-marker', 'task-invalid-implementation-marker-decision', 'owner', '【結論：實作】\n採用此方向。');
assert.throws(
  () => resolveMainDiscussionConclusion('task-invalid-implementation-marker', 'owner', db),
  {
    name: 'CommandError',
    message: '尚未留下合法的主工作區結論；實作請依序留下「【結論】」→「【實作任務】工作區：...｜TASK：...」',
  },
  '實作結論 marker 錯誤時應回傳可直接修正的格式',
);

seedDiscussion('task-missing-handoff');
addComment('task-missing-handoff', 'task-missing-handoff-decision', 'owner', '【結論】\n採用此方向。');
assert.throws(
  () => resolveMainDiscussionConclusion('task-missing-handoff', 'owner', db),
  { name: 'CommandError', message: '尚未留下合法的實作任務交接' },
  'implement 結論必須在決議後至少有一筆 Owner handoff',
);

seedDiscussion('task-invalid-handoff');
addComment('task-invalid-handoff', 'task-invalid-handoff-decision', 'owner', '【結論】\n採用。');
addComment('task-invalid-handoff', 'task-invalid-handoff-link', 'owner', '【實作任務】工作區：https://192.168.50.109/tracker｜TASK：不能提供連結');
assert.throws(
  () => resolveMainDiscussionConclusion('task-invalid-handoff', 'owner', db),
  CommandError,
  '實作交接不得是 URL',
);

seedDiscussion('task-multiple-handoff');
addComment('task-multiple-handoff', 'task-multiple-handoff-decision', 'owner', '【結論】\n採用此方向。');
addComment('task-multiple-handoff', 'task-multiple-handoff-handoff-1', 'owner', '【實作任務】工作區：Task Tracker｜TASK：前端部分');
addComment('task-multiple-handoff', 'task-multiple-handoff-handoff-2', 'owner', '【實作任務】工作區：Task Tracker｜TASK：後端部分');
const multipleHandoff = resolveMainDiscussionConclusion('task-multiple-handoff', 'owner', db);
assert.strictEqual(multipleHandoff.handoffCommentId, 'task-multiple-handoff-handoff-1', '單一 handoff 欄位取第一筆，維持歷史 audit reader 相容');
assert.deepStrictEqual(
  multipleHandoff.implementationTasks,
  [
    { workspaceName: 'Task Tracker', taskName: '前端部分' },
    { workspaceName: 'Task Tracker', taskName: '後端部分' },
  ],
  '多筆 handoff 全部由 implementationTasks 承載',
);

// ── 成員留言不影響收尾 ──────────────────────────────────────────────
seedDiscussion('task-member-comment');
addComment('task-member-comment', 'task-member-comment-reply', 'user02', '這看起來可以，沒什麼問題的話就安排下去吧');
addComment('task-member-comment', 'task-member-comment-decision', 'owner', '【結論：不實作】\n再想想。');
assert.strictEqual(
  resolveMainDiscussionConclusion('task-member-comment', 'owner', db).outcome,
  'no_implementation',
  '成員的自然語句留言不被解讀成核准，也不是收尾的必要或充分條件',
);

// ── 誰能收尾、哪些 task 能收尾 ──────────────────────────────────────
seedDiscussion('task-non-owner');
addComment('task-non-owner', 'task-non-owner-decision', 'owner', '【結論：不實作】\n先不做。');
assert.throws(
  () => resolveMainDiscussionConclusion('task-non-owner', 'user02', db),
  { name: 'CommandError', message: '只有 user01 可以收尾主工作區討論' },
);

seedTask('task-policy', 'Todo', MAIN_POLICY_TITLE);
addComment('task-policy', 'task-policy-thought', 'owner', OWNER_THOUGHT);
addComment('task-policy', 'task-policy-decision', 'owner', '【結論：不實作】\n先不做。');
assert.throws(
  () => resolveMainDiscussionConclusion('task-policy', 'owner', db),
  { name: 'CommandError', message: '不是可收尾的主工作區討論' },
  '規則 task 不使用討論收尾流程',
);

assert.throws(
  () => resolveMainDiscussionConclusion('task-does-not-exist', 'owner', db),
  { name: 'CommandError', message: '不是可收尾的主工作區討論' },
);

// ── 等待窗口已移除：資料表不該再存在 ────────────────────────────────
assert.strictEqual(
  (db.prepare(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = 'main_discussion_windows'",
  ).get() as { c: number }).c,
  0,
  'runMigrations 之後不得再有 main_discussion_windows 資料表',
);

console.log('mainDiscussion.test.ts OK');
