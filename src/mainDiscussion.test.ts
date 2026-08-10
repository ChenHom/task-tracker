import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { CommandError } from './eventStore';
import { resolveMainDiscussionConclusion } from './mainDiscussion';
import {
  AGREE_MARKER,
  MAIN_BOSS_EMAIL,
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
insertUser.run('user03', 'user03@test.local', 'User 03', 'hash');
insertUser.run('user04', 'user04@test.local', 'User 04', 'hash');
insertUser.run('user05', 'user05@test.local', 'User 05', 'hash');
insertUser.run('boss', MAIN_BOSS_EMAIL, 'Boss', 'hash');
const insertMember = db.prepare(
  'INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
);
insertMember.run(MAIN_WORKSPACE_ID, 'owner', 'Owner', AT);
insertMember.run(MAIN_WORKSPACE_ID, 'user02', 'Commenter', AT);
insertMember.run(MAIN_WORKSPACE_ID, 'user03', 'Commenter', AT);
insertMember.run(MAIN_WORKSPACE_ID, 'user04', 'Commenter', AT);
insertMember.run(MAIN_WORKSPACE_ID, 'user05', 'Commenter', AT);
insertMember.run(MAIN_WORKSPACE_ID, 'boss', 'Admin', AT);

function seedTask(taskId: string, status = 'Todo', title = `[討論] ${taskId}`): void {
  db.prepare(
    'INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, version) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(taskId, MAIN_WORKSPACE_ID, title, status, 'Medium', 1);
}

function addComment(taskId: string, commentId: string, userId: string, content: string, createdAt = AT): void {
  db.prepare(
    'INSERT INTO comments (comment_id, task_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(commentId, taskId, userId, content, createdAt);
}

// 討論的收尾前置：owner 留過完整的 OWNER想法；走 implement 時還要老闆（user09）的【同意】。
// bossAgrees 預設 true，因為多數既有案例驗的是 implement 以外的規則，不該被這道閘門干擾。
function seedDiscussion(taskId: string, thoughtContent = OWNER_THOUGHT, bossAgrees = true): string {
  seedTask(taskId);
  const thoughtId = `${taskId}-thought`;
  addComment(taskId, thoughtId, 'owner', thoughtContent);
  if (bossAgrees) addComment(taskId, `${taskId}-boss-agree`, 'boss', `${AGREE_MARKER}\n可以做。`);
  return thoughtId;
}

// ── 已過固定期限的既有討論可收尾 ────────────────────────────────────
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
  'OWNER想法已超過固定期限時可依完整結論收尾',
);

// ── 固定兩天期限或四票（含 user09）是三種 outcome 共用的後端閘門 ─────
const BEFORE_DEADLINE = new Date('2026-07-15T08:00:00.000Z');
const AFTER_DEADLINE = new Date('2026-07-16T08:00:00.000Z');

function addDecision(taskId: string, outcome: 'implement' | 'no_implementation' | 'no_consensus'): void {
  if (outcome === 'implement') {
    addComment(taskId, `${taskId}-decision`, 'owner', '【結論】\n採用。');
    addComment(taskId, `${taskId}-handoff`, 'owner', '【實作任務】工作區：Task Tracker｜TASK：驗證收尾 gate');
    return;
  }
  if (outcome === 'no_implementation') {
    addComment(taskId, `${taskId}-decision`, 'owner', '【結論：不實作】\n先不做。');
    return;
  }
  addComment(taskId, `${taskId}-decision`, 'owner', `【未達共識】
尚未解決的分歧：意見不同
缺少的確認或資訊：缺少資料
下次重新思考前的建議：補齊資料`);
}

for (const outcome of ['implement', 'no_implementation', 'no_consensus'] as const) {
  const taskId = `task-${outcome}-before-deadline`;
  seedDiscussion(taskId);
  addDecision(taskId, outcome);
  assert.throws(
    () => resolveMainDiscussionConclusion(taskId, 'owner', db, BEFORE_DEADLINE),
    { name: 'CommandError', message: /尚未達成四位不同成員的「【同意】」/ },
    `未滿兩天且同意票不足時，${outcome} 不可收尾`,
  );
}

for (const outcome of ['implement', 'no_implementation', 'no_consensus'] as const) {
  const taskId = `task-${outcome}-after-deadline`;
  seedDiscussion(taskId, OWNER_THOUGHT, false);
  addDecision(taskId, outcome);
  assert.strictEqual(
    resolveMainDiscussionConclusion(taskId, 'owner', db, AFTER_DEADLINE).outcome,
    outcome,
    `剛滿兩天時，${outcome} 可依既有完整證據收尾`,
  );
}

const consensusThought = seedDiscussion('task-consensus-before-deadline', OWNER_THOUGHT, false);
for (const userId of ['user02', 'user03', 'user04', 'boss']) {
  addComment('task-consensus-before-deadline', `task-consensus-before-deadline-${userId}`, userId, `${AGREE_MARKER}\n同意。`);
}
addDecision('task-consensus-before-deadline', 'no_implementation');
assert.strictEqual(
  resolveMainDiscussionConclusion('task-consensus-before-deadline', 'owner', db, BEFORE_DEADLINE).ownerThoughtCommentId,
  consensusThought,
  '未滿兩天時，四位不同成員同意且含 user09 可收尾',
);

seedDiscussion('task-duplicate-votes-before-deadline', OWNER_THOUGHT, false);
for (const [index, userId] of ['user02', 'user02', 'user03', 'boss'].entries()) {
  addComment('task-duplicate-votes-before-deadline', `task-duplicate-votes-before-deadline-${index}`, userId, `${AGREE_MARKER}\n同意。`);
}
addDecision('task-duplicate-votes-before-deadline', 'no_implementation');
assert.throws(
  () => resolveMainDiscussionConclusion('task-duplicate-votes-before-deadline', 'owner', db, BEFORE_DEADLINE),
  { name: 'CommandError', message: /尚未達成四位不同成員的「【同意】」/ },
  '同一人重複留言不得灌票',
);

seedDiscussion('task-renewed-thought-before-deadline', OWNER_THOUGHT, false);
for (const userId of ['user02', 'user03', 'user04', 'boss']) {
  addComment('task-renewed-thought-before-deadline', `task-renewed-thought-before-deadline-old-${userId}`, userId, `${AGREE_MARKER}\n同意。`);
}
addComment('task-renewed-thought-before-deadline', 'task-renewed-thought-before-deadline-new-thought', 'owner', OWNER_THOUGHT);
addDecision('task-renewed-thought-before-deadline', 'no_implementation');
assert.throws(
  () => resolveMainDiscussionConclusion('task-renewed-thought-before-deadline', 'owner', db, BEFORE_DEADLINE),
  { name: 'CommandError', message: /尚未達成四位不同成員的「【同意】」/ },
  '新一輪 OWNER想法不得沿用舊輪同意票',
);
assert.strictEqual(
  resolveMainDiscussionConclusion('task-renewed-thought-before-deadline', 'owner', db, AFTER_DEADLINE).ownerThoughtCommentId,
  'task-renewed-thought-before-deadline-new-thought',
  '固定期限到達後不受票數影響，且仍以最新完整 OWNER想法為準',
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

// 四票裡缺 user09 不得提早收尾；user09 的【疑慮】也不計為同意。
seedDiscussion('task-missing-boss-before-deadline', OWNER_THOUGHT, false);
for (const userId of ['user02', 'user03', 'user04', 'user05']) {
  addComment('task-missing-boss-before-deadline', `task-missing-boss-before-deadline-${userId}`, userId, `${AGREE_MARKER}\n同意。`);
}
addComment('task-missing-boss-before-deadline', 'task-missing-boss-before-deadline-boss-concern', 'boss', '【疑慮】\n先別做。');
addDecision('task-missing-boss-before-deadline', 'no_implementation');
assert.throws(
  () => resolveMainDiscussionConclusion('task-missing-boss-before-deadline', 'owner', db, BEFORE_DEADLINE),
  { name: 'CommandError', message: /須含 user09@test\.local/ },
  '未滿兩天時，四票缺少 user09 的【同意】仍不可收尾',
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
