import assert from 'node:assert';
import {
  extractJsonBlock,
  memberPrompt,
  ownerPrompt,
  parseMemberOutput,
  parseOwnerDecision,
} from './runner';

// ── extractJsonBlock ────────────────────────────────────────────────
assert.deepStrictEqual(
  extractJsonBlock('先講一下想法\n```json\n{"a":1}\n```\n'),
  { a: 1 },
  'fenced json 區塊要能取出',
);
assert.deepStrictEqual(
  extractJsonBlock('```\n{"a":1}\n```'),
  { a: 1 },
  '沒標 json 的 fence 也要能取出',
);
assert.deepStrictEqual(
  extractJsonBlock('```json\n{"a":1}\n```\n中間講話\n```json\n{"a":2}\n```'),
  { a: 2 },
  '多個區塊時以最後一個為準',
);
assert.deepStrictEqual(
  extractJsonBlock('```json\n這不是 json\n```\n```json\n{"a":3}\n```'),
  { a: 3 },
  '壞掉的 fence 要被跳過',
);
assert.deepStrictEqual(extractJsonBlock('{"a":4}'), { a: 4 }, '沒有 fence 時整段當物件解析');
assert.strictEqual(extractJsonBlock('完全沒有 json'), null, '沒有可解析內容要回 null');
assert.strictEqual(extractJsonBlock(''), null, '空輸出要回 null');

// ── parseMemberOutput ───────────────────────────────────────────────
assert.deepStrictEqual(
  parseMemberOutput(
    { summary: '修好了', changedPaths: ['src/a.ts'], verificationCommands: ['npm test'], blocker: null },
    'w',
  ),
  { summary: '修好了', changedPaths: ['src/a.ts'], verificationCommands: ['npm test'], blocker: null },
);
assert.strictEqual(
  parseMemberOutput({ summary: 's', changedPaths: [], verificationCommands: [], blocker: '' }, 'w').blocker,
  null,
  '空字串 blocker 正規化成 null',
);
assert.strictEqual(
  parseMemberOutput({ summary: 's', changedPaths: [], verificationCommands: [], blocker: '卡住' }, 'w').blocker,
  '卡住',
);
for (const [bad, why] of [
  [{ changedPaths: [], verificationCommands: [], blocker: null }, '缺 summary'],
  [{ summary: '', changedPaths: [], verificationCommands: [], blocker: null }, 'summary 空字串'],
  [{ summary: 's', changedPaths: 'x', verificationCommands: [], blocker: null }, 'changedPaths 不是陣列'],
  [{ summary: 's', changedPaths: [1], verificationCommands: [], blocker: null }, 'changedPaths 元素不是字串'],
  [{ summary: 's', changedPaths: [], verificationCommands: [], blocker: 7 }, 'blocker 型別錯'],
  ['字串不是物件', '不是物件'],
  [null, 'null'],
  [[], '陣列'],
] as const) {
  assert.throws(() => parseMemberOutput(bad, 'w'), Error, `應該擋下：${why}`);
}

// ── parseOwnerDecision ──────────────────────────────────────────────
assert.deepStrictEqual(
  parseOwnerDecision({ action: 'accept', rationale: 'head abc123 通過', evidenceCommentIds: ['c1'] }, 'w'),
  { action: 'accept', rationale: 'head abc123 通過', evidenceCommentIds: ['c1'] },
);
assert.strictEqual(
  parseOwnerDecision(
    { action: 'classify', rationale: 'r', evidenceCommentIds: [], classification: 'bug' },
    'w',
  ).classification,
  'bug',
);
assert.strictEqual(
  parseOwnerDecision(
    { action: 'conclude-discussion', rationale: 'r', evidenceCommentIds: [], outcome: 'no_consensus' },
    'w',
  ).outcome,
  'no_consensus',
);
// null 的可選欄位視為未提供，不得變成非法值
assert.strictEqual(
  'classification' in parseOwnerDecision(
    { action: 'dispatch', rationale: 'r', evidenceCommentIds: [], classification: null, outcome: null },
    'w',
  ),
  false,
  'classification: null 不應該進到決策物件',
);
for (const [bad, why] of [
  [{ action: 'approve', rationale: 'r', evidenceCommentIds: [] }, 'action 不在允許清單'],
  [{ action: 'accept', evidenceCommentIds: [] }, '缺 rationale'],
  [{ action: 'accept', rationale: 'r' }, '缺 evidenceCommentIds'],
  [{ action: 'accept', rationale: 'r', evidenceCommentIds: [3] }, 'evidenceCommentIds 元素不是字串'],
  [{ action: 'classify', rationale: 'r', evidenceCommentIds: [], classification: 'urgent' }, 'classification 不在清單'],
  [{ action: 'conclude-discussion', rationale: 'r', evidenceCommentIds: [], outcome: 'done' }, 'outcome 不在清單'],
] as const) {
  assert.throws(() => parseOwnerDecision(bad, 'w'), Error, `應該擋下：${why}`);
}

// ── prompt 契約 ─────────────────────────────────────────────────────
// prompt 教 AI 產出的樣板，必須真的能通過自己的 parser——這是 prompt 與 validator
// 之間的 round-trip 守門，同一條縫在 src/ ↔ sim/ 之間已經斷過兩次。
const mPrompt = memberPrompt({
  taskId: 'task-1234abcd',
  acceptanceCriteria: '要能跑',
  comments: ['留言一'],
  allowedPrefixes: ['src/'],
  verificationCommandAllowlist: ['npm test'],
  worktreePath: '/tmp/wt',
});
assert.deepStrictEqual(
  parseMemberOutput(extractJsonBlock(mPrompt), 'member prompt 樣板'),
  { summary: '你做了什麼，一到三句', changedPaths: ['實際改過的檔案路徑'], verificationCommands: ['你實際跑過的驗證指令'], blocker: null },
  'member prompt 的 JSON 樣板必須通過 parseMemberOutput',
);
assert.ok(mPrompt.includes('/tmp/wt'), 'member prompt 必須指明 worktree');
assert.ok(mPrompt.includes('src/'), 'member prompt 必須列出 allowedPrefixes');
assert.ok(mPrompt.includes('npm test'), 'member prompt 必須列出 verification allowlist');
assert.ok(/不要執行任何 git 寫入/u.test(mPrompt), 'member prompt 必須禁止 git 寫入');

const oPrompt = ownerPrompt({
  taskId: 'task-5678efgh',
  acceptanceCriteria: '要能驗收',
  comments: [],
  reviewedHeadSha: 'deadbeefcafe',
  worktreePath: '/tmp/wt',
});
assert.deepStrictEqual(
  parseOwnerDecision(extractJsonBlock(oPrompt), 'owner prompt 樣板'),
  { action: 'accept', rationale: '為什麼，必要時引用 head SHA', evidenceCommentIds: ['#0'] },
  'owner prompt 的 JSON 樣板必須通過 parseOwnerDecision',
);
// 2026-07-29 實測：只寫「填留言 id」時 codex 會回數字 0（context 根本沒帶 id）。
// prompt 必須明講是 #編號 字串，樣板也要示範字串形式。
assert.ok(oPrompt.includes('["#0","#2"]'), 'owner prompt 必須示範 evidenceCommentIds 的字串格式');
assert.ok(
  ownerPrompt({
    taskId: 't', acceptanceCriteria: 'a', comments: ['第一則', '第二則'],
    reviewedHeadSha: 'sha', worktreePath: '/tmp/wt',
  }).includes('#1 第二則'),
  'owner prompt 的留言必須以 #編號 標示，AI 才有東西可引用',
);
assert.ok(oPrompt.includes('deadbeefcafe'), 'owner prompt 必須帶入 reviewedHeadSha');
assert.ok(/唯讀/u.test(oPrompt), 'owner prompt 必須聲明唯讀契約');
// agent.ts 會在 accept 時要求 rationale 引用 head SHA，prompt 必須先講清楚
assert.ok(oPrompt.includes(`引用 head SHA deadbeefcafe`), 'owner prompt 必須要求 accept 引用 head SHA');

console.log('sim/production/runner.test.ts OK');
