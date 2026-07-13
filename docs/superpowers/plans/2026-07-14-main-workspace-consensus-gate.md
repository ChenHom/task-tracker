# Main Workspace Consensus Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將主協作工作區改成固定期限、雙方確認、截止後由 OWNER 直接 `Todo -> Done` 的討論收斂流程，同時不增加截止時間或回覆追蹤 UI。

**Architecture:** 新增 `src/mainDiscussion.ts` 作為主工作區專用 domain service，負責解析結構化留言、建立不可變討論窗口及解析三種收尾證據；`comment.ts` 在同一 SQLite transaction 內保存通知留言與窗口，`task.ts` 只在收尾證據完整且期限已到時追加 `task.main_discussion_concluded`。一般工作區繼續使用既有四階段狀態機，前端只對主工作區調整建立範本、欄位與狀態按鈕，sweep 只透過既有 task/comment API 執行政策。

**Tech Stack:** TypeScript、Node.js `node:sqlite`、event store/projection、原生瀏覽器 JavaScript/CSS、Node assert 測試、ESLint、systemd user service

---

## 規格基準與不可擴張範圍

實作前先讀 [主工作區討論收斂流程設計](../specs/2026-07-13-main-workspace-consensus-gate-design.md)，並以下列條件作為驗收邊界：

- 主工作區目前固定為唯一 OWNER `user01@test.local`，以及 `user02-06@test.local`、`user09@test.local` 六位 Commenter；不在本次增加動態名單設定。
- 七位成員都可建立主工作區討論與留言；規則 TASK 不進入討論窗口。
- 主工作區討論只允許 OWNER 在期限後執行 `Todo -> Done`，不使用 `Doing`、`Review`，也不從 `Done` 回退。
- 全員通知必須在一則較早且結構完整的 `【OWNER想法】` 之後；等待期限寫在留言中，不新增選擇器。
- 等待期限為 `2` 至 `7` 天，最小單位 `0.5` 天；一天是連續 24 小時，半天是連續 12 小時。
- 期限從合法 `【全員回覆：N天】` 留言建立時計算，開窗後不可延長、縮短或重開；提前形成共識也不能提前完成。
- `N > 2` 時同一留言必須有非空白 `較長期限理由：`；系統不檢查六位人員是否全部被 `@`。
- 所有人都應留言，但系統不新增回覆表、缺席名單、逾時回覆狀態或自動完成。
- OWNER 的實作／不實作結論必須由建立者確認；若 OWNER 自己是建立者，改由任一目前的 Commenter 確認。
- 有共識且要實作時，在目標工作區另建 TASK；原討論只留 `【實作任務】工作區：...｜TASK：...`，不存、不產生 URL。
- 未達共識時記錄三個非空白欄位後完成，不要求建立者確認；日後重新思考時建立新的主工作區討論。
- 前端不顯示期限、逾期、回覆、缺席或留言格式提示；不新增討論窗口查詢 API。
- 留言更新／刪除沿用現有權限。窗口時間不隨修改而變；收尾前若必要留言已被改壞或刪除，`Done` 必須被拒絕。
- 不執行 live AI run、`npm run sim`、任何 `sim --sweep` 或 timer 啟用操作。

## 資料與控制流

```text
OWNER 留下完整想法
        |
        v
OWNER 留下全員通知 ---- 同一 transaction ----> comment + mentions + fixed window
        |
        | 2–7 天，12 小時為一單位；期間可討論與提出結論
        v
OWNER PATCH status=Done
        |
        +-- 尚未到期 ------------------------> 400，回傳 UTC 截止時間
        |
        +-- 結論 + 合格確認 + 實作交接 ------> outcome=implement
        |
        +-- 不實作結論 + 合格確認 ------------> outcome=no_implementation
        |
        +-- 完整未達共識 --------------------> outcome=no_consensus
        |
        v
task.main_discussion_concluded -> projection: status=Done, assignee_id=NULL
```

## Task 1：建立不可變討論窗口資料表

**Files:**

- Modify: `src/schema.test.ts`
- Modify: `src/schema.ts`

- [ ] **Step 1: 先寫 schema 約束失敗測試**

在 `src/schema.test.ts` 增加下列測試。測試只驗本次真正需要的 DB invariant：每個 TASK 最多一個窗口、每則通知最多開一個窗口，以及 `wait_half_days` 只能是 `4..14` 的整數。

```ts
const insertWindow = db.prepare(`
  INSERT INTO main_discussion_windows
    (task_id, owner_thought_comment_id, request_comment_id, opened_at, wait_half_days, due_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

insertWindow.run(
  'task-1',
  'thought-1',
  'request-1',
  '2026-07-14T00:00:00.000Z',
  4,
  '2026-07-16T00:00:00.000Z',
);

assert.throws(
  () => insertWindow.run('task-1', 'thought-2', 'request-2', '2026-07-14T00:00:00.000Z', 4, '2026-07-16T00:00:00.000Z'),
  /UNIQUE/,
  '同一 task 不可重開窗口',
);
assert.throws(
  () => insertWindow.run('task-2', 'thought-2', 'request-1', '2026-07-14T00:00:00.000Z', 4, '2026-07-16T00:00:00.000Z'),
  /UNIQUE/,
  '同一通知留言不可對應多個窗口',
);
assert.throws(
  () => insertWindow.run('task-3', 'thought-3', 'request-3', '2026-07-14T00:00:00.000Z', 3, '2026-07-16T00:00:00.000Z'),
  /CHECK/,
  '最短只能是 4 個 half-days',
);
assert.throws(
  () => insertWindow.run('task-4', 'thought-4', 'request-4', '2026-07-14T00:00:00.000Z', 15, '2026-07-16T00:00:00.000Z'),
  /CHECK/,
  '最長只能是 14 個 half-days',
);
```

- [ ] **Step 2: 執行 schema 測試並確認失敗原因**

Run: `npx tsx src/schema.test.ts`

Expected: `no such table: main_discussion_windows`。

- [ ] **Step 3: 新增最小資料表**

在 `runMigrations()` 的 `db.exec()` 建表區塊中、`comments` 之後加入：

```sql
CREATE TABLE IF NOT EXISTS main_discussion_windows (
  task_id                  TEXT PRIMARY KEY,
  owner_thought_comment_id TEXT NOT NULL,
  request_comment_id       TEXT NOT NULL UNIQUE,
  opened_at                TEXT NOT NULL,
  wait_half_days           INTEGER NOT NULL CHECK (wait_half_days BETWEEN 4 AND 14),
  due_at                   TEXT NOT NULL
);
```

不要為 comment id 加 foreign key：必要留言在收尾前仍可依既有權限更新或刪除，窗口本身則必須保留，不能因 `ON DELETE CASCADE` 被刪掉後重新開窗。TASK 真正刪除時改由 task projection 明確清除窗口，安排在 Task 5。

- [ ] **Step 4: 重跑 focused test**

Run: `npx tsx src/schema.test.ts`

Expected: `schema.test.ts OK`。

- [ ] **Step 5: 提交資料表變更**

```bash
git add src/schema.ts src/schema.test.ts
git commit -m "feat: add main discussion windows"
```

## Task 2：讓 event append 可加入既有 transaction

**Files:**

- Modify: `src/eventStore.test.ts`
- Modify: `src/eventStore.ts`

這一步只提供明確的「caller 已開始 transaction」寫入入口，讓留言、通知 event projection 與窗口可以一起 commit／rollback；既有 `appendEvent()` 的外部行為不變。

- [ ] **Step 1: 寫 transaction-owned append 測試**

將 `appendEventInTransaction` 加到 `src/eventStore.test.ts` import，並加入：

```ts
assert.throws(
  () => appendEventInTransaction('Demo', 'tx-outside', 0, 'demo.incremented', {}, {}, db),
  /active transaction/,
  'caller 未開 transaction 時不可使用內層 append',
);

db.exec('BEGIN IMMEDIATE');
appendEventInTransaction('Demo', 'tx-rollback', 0, 'demo.incremented', {}, {}, db);
db.exec('ROLLBACK');
assert.strictEqual(loadEvents('tx-rollback', db).length, 0, '外層 rollback 應移除 event');
assert.strictEqual(
  db.prepare('SELECT count FROM demo_rm WHERE aggregate_id = ?').get('tx-rollback'),
  undefined,
  '外層 rollback 應一併移除 projection',
);

db.exec('BEGIN IMMEDIATE');
appendEventInTransaction('Demo', 'tx-commit', 0, 'demo.incremented', {}, {}, db);
db.exec('COMMIT');
assert.strictEqual(loadEvents('tx-commit', db).length, 1, '外層 commit 應保存 event');
```

- [ ] **Step 2: 執行測試並確認 export 尚不存在**

Run: `npx tsx src/eventStore.test.ts`

Expected: TypeScript/載入失敗，指出 `appendEventInTransaction` 尚未由 `eventStore.ts` 匯出。

- [ ] **Step 3: 抽出不管理 transaction 的 event 寫入核心**

在 `src/eventStore.ts` 將目前 `appendEvent()` 中的 version 檢查、INSERT、StoredEvent 建構與 projection 呼叫抽成以下 private helper：

```ts
function appendEventRecord(
  aggregateType: string,
  aggregateId: string,
  expectedVersion: number,
  eventType: string,
  payload: unknown,
  metadata: unknown,
  database: DatabaseSync,
): StoredEvent {
  const actual = currentVersion(aggregateId, database);
  if (actual !== expectedVersion) throw new ConcurrencyError(aggregateId, expectedVersion, actual);

  const version = expectedVersion + 1;
  const occurredAt = new Date().toISOString();
  const info = database.prepare(
    `INSERT INTO event_store
       (aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, metadata_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    aggregateType,
    aggregateId,
    version,
    eventType,
    JSON.stringify(payload),
    JSON.stringify(metadata),
    occurredAt,
  );

  const event: StoredEvent = {
    id: Number(info.lastInsertRowid),
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    aggregate_version: version,
    event_type: eventType,
    payload,
    metadata,
    occurred_at: occurredAt,
  };
  projections.get(eventType)?.(event, database);
  return event;
}
```

- [ ] **Step 4: 新增 caller-owned API，並讓原 API 繼續自行管理 transaction**

```ts
export function appendEventInTransaction(
  aggregateType: string,
  aggregateId: string,
  expectedVersion: number,
  eventType: string,
  payload: unknown,
  metadata: unknown = {},
  database = db,
): StoredEvent {
  if (!database.isTransaction) throw new Error('appendEventInTransaction requires an active transaction');
  return appendEventRecord(aggregateType, aggregateId, expectedVersion, eventType, payload, metadata, database);
}

export function appendEvent(
  aggregateType: string,
  aggregateId: string,
  expectedVersion: number,
  eventType: string,
  payload: unknown,
  metadata: unknown = {},
  database = db,
): StoredEvent {
  database.exec('BEGIN IMMEDIATE');
  try {
    const event = appendEventRecord(
      aggregateType,
      aggregateId,
      expectedVersion,
      eventType,
      payload,
      metadata,
      database,
    );
    database.exec('COMMIT');
    return event;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
```

- [ ] **Step 5: 驗證原本與新增 transaction 語意**

Run: `npx tsx src/eventStore.test.ts`

Expected: `eventStore.test.ts OK`，既有 concurrency rollback assertions 也仍通過。

- [ ] **Step 6: 提交 transaction primitive**

```bash
git add src/eventStore.ts src/eventStore.test.ts
git commit -m "refactor: support event append in caller transaction"
```

## Task 3：解析 OWNER 想法並建立固定討論窗口

**Files:**

- Create: `src/mainDiscussion.ts`
- Create: `src/mainDiscussion.test.ts`
- Modify: `src/test.ts`

- [ ] **Step 1: 建立 domain 測試 fixture**

在 `src/mainDiscussion.test.ts` 使用獨立 in-memory DB，建立主工作區、OWNER、建立者與一位 Commenter。以 `task.created` event metadata 保存建立者，task read model 保持 `Todo`。測試 fixture 使用固定時間，禁止使用 sleep：

```ts
const OPENED_AT = new Date('2026-07-14T08:00:00.000Z');
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
```

先針對下列 case 寫 assertions：

1. `2` 天得到 `wait_half_days=4`，`due_at=2026-07-16T08:00:00.000Z`。
2. `2.5` 天得到 `wait_half_days=5`，截止時間精確增加 60 小時，證明不是工作日。
3. `3` 天但缺少非空白 `較長期限理由：` 時丟 `CommandError`。
4. `1.5`、`7.5`、`8` 等超出範圍的可辨識通知丟 `CommandError`；`2.25`、`兩` 等不符合 header grammar 的留言視為一般留言並回傳 `null`。
5. 非 OWNER、規則 TASK、非 `Todo` TASK 都不能開窗。
6. 沒有較早的 OWNER 想法、想法不是 OWNER 留下、缺少任一必要欄位或欄位空白時都不能開窗。
7. 第二次合法通知丟 `CommandError`，原 `opened_at`、`wait_half_days`、`due_at` 完全不變。
8. 不驗證 `@` 數量；合法 header 與 thought 足以開窗。

- [ ] **Step 2: 執行新測試並確認 module 尚不存在**

Run: `npx tsx src/mainDiscussion.test.ts`

Expected: module resolution 失敗，指出 `./mainDiscussion` 尚不存在。

- [ ] **Step 3: 建立明確的 window API 與型別**

在 `src/mainDiscussion.ts` 定義：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { CommandError } from './eventStore';
import { MAIN_OWNER_EMAIL, MAIN_POLICY_TITLE, MAIN_WORKSPACE_ID } from './mainWorkspacePolicy';

const HALF_DAY_MS = 12 * 60 * 60 * 1000;
const REQUIRED_THOUGHT_FIELDS = [
  '現況／問題',
  '預期價值',
  '風險與反對理由',
  '現行可替代方案',
  '初步判斷',
  '希望成員確認的問題',
] as const;

export interface MainDiscussionWindow {
  taskId: string;
  ownerThoughtCommentId: string;
  requestCommentId: string;
  openedAt: string;
  waitHalfDays: number;
  dueAt: string;
}

export interface RecordMainDiscussionCommentInput {
  taskId: string;
  userId: string;
  commentId: string;
  content: string;
  createdAt: string;
}
```

- [ ] **Step 4: 實作精確 parser**

使用以第一行開頭為準的 marker，不把 marker 出現在引文或段落中間視為命令：

```ts
function lineValue(content: string, label: string): string | null {
  const match = content.match(new RegExp(`^${label}：\\s*(.+?)\\s*$`, 'mu'));
  return match?.[1]?.trim() || null;
}

function isStructuredOwnerThought(content: string): boolean {
  if (!/^【OWNER想法】(?:\r?\n|$)/u.test(content)) return false;
  return REQUIRED_THOUGHT_FIELDS.every((label) => lineValue(content, label) !== null);
}

function parseWaitHalfDays(content: string): number | null {
  const match = content.match(/^【全員回覆：(\d+(?:\.5)?)天】(?:\r?\n|$)/u);
  if (!match) return null;
  const waitHalfDays = Number(match[1]) * 2;
  if (!Number.isInteger(waitHalfDays) || waitHalfDays < 4 || waitHalfDays > 14) {
    throw new CommandError('全員回覆期限必須是 2 到 7 天，並以 0.5 天遞增');
  }
  if (waitHalfDays > 4 && lineValue(content, '較長期限理由') === null) {
    throw new CommandError('超過 2 天必須填寫較長期限理由');
  }
  return waitHalfDays;
}
```

`2.25` 因為不符合 header grammar，回傳 `null` 並保存為一般留言；`8` 符合 grammar 但超出允許範圍，回傳明確錯誤，避免 OWNER 誤以為已成功開窗。

- [ ] **Step 5: 實作窗口寫入與讀取**

`recordMainDiscussionWindowForComment()` 只在 `parseWaitHalfDays()` 回傳數字時進入 command validation。以 `comments.rowid` 找出目前 request 之前、由 runtime OWNER 留下的最新完整想法：

```ts
export function recordMainDiscussionWindowForComment(
  input: RecordMainDiscussionCommentInput,
  database = db,
): MainDiscussionWindow | null {
  const waitHalfDays = parseWaitHalfDays(input.content);
  if (waitHalfDays === null) return null;

  const task = database.prepare(
    'SELECT workspace_id, title, status FROM tasks_read_model WHERE task_id = ?',
  ).get(input.taskId) as { workspace_id: string; title: string; status: string } | undefined;
  if (!task || task.workspace_id !== MAIN_WORKSPACE_ID || task.title === MAIN_POLICY_TITLE || task.status !== 'Todo') {
    throw new CommandError('只有主工作區 Todo 討論可以開啟回覆窗口');
  }

  const owner = database.prepare(
    `SELECT u.id
       FROM users u
       JOIN workspace_members_read_model m ON m.user_id = u.id
      WHERE u.email = ? AND m.workspace_id = ? AND m.role = 'Owner'`,
  ).get(MAIN_OWNER_EMAIL, MAIN_WORKSPACE_ID) as { id: string } | undefined;
  if (!owner || input.userId !== owner.id) throw new CommandError('只有 user01 可以開啟主工作區回覆窗口');

  const existing = database.prepare(
    'SELECT task_id FROM main_discussion_windows WHERE task_id = ?',
  ).get(input.taskId);
  if (existing) throw new CommandError('主工作區回覆窗口已開啟，期限不可變更');

  const requestRow = database.prepare(
    'SELECT rowid FROM comments WHERE comment_id = ? AND task_id = ?',
  ).get(input.commentId, input.taskId) as { rowid: number } | undefined;
  if (!requestRow) throw new CommandError('全員回覆留言尚未保存');

  const prior = database.prepare(
    `SELECT comment_id, user_id, content
       FROM comments
      WHERE task_id = ? AND rowid < ?
      ORDER BY rowid DESC`,
  ).all(input.taskId, requestRow.rowid) as unknown as Array<{
    comment_id: string;
    user_id: string;
    content: string;
  }>;
  const thought = prior.find((row) => row.user_id === owner.id && isStructuredOwnerThought(row.content));
  if (!thought) throw new CommandError('全員通知前必須先留下完整的 OWNER想法');

  const openedAtMs = Date.parse(input.createdAt);
  if (Number.isNaN(openedAtMs)) throw new CommandError('留言建立時間不合法');
  const openedAt = new Date(openedAtMs).toISOString();
  const dueAt = new Date(openedAtMs + waitHalfDays * HALF_DAY_MS).toISOString();
  database.prepare(
    `INSERT INTO main_discussion_windows
       (task_id, owner_thought_comment_id, request_comment_id, opened_at, wait_half_days, due_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.taskId, thought.comment_id, input.commentId, openedAt, waitHalfDays, dueAt);

  return {
    taskId: input.taskId,
    ownerThoughtCommentId: thought.comment_id,
    requestCommentId: input.commentId,
    openedAt,
    waitHalfDays,
    dueAt,
  };
}

export function getMainDiscussionWindow(taskId: string, database = db): MainDiscussionWindow | null {
  const row = database.prepare(
    `SELECT task_id, owner_thought_comment_id, request_comment_id, opened_at, wait_half_days, due_at
       FROM main_discussion_windows WHERE task_id = ?`,
  ).get(taskId) as {
    task_id: string;
    owner_thought_comment_id: string;
    request_comment_id: string;
    opened_at: string;
    wait_half_days: number;
    due_at: string;
  } | undefined;
  return row ? {
    taskId: row.task_id,
    ownerThoughtCommentId: row.owner_thought_comment_id,
    requestCommentId: row.request_comment_id,
    openedAt: row.opened_at,
    waitHalfDays: row.wait_half_days,
    dueAt: row.due_at,
  } : null;
}
```

- [ ] **Step 6: 驗證所有 window cases，並加入聚合測試入口**

Run: `npx tsx src/mainDiscussion.test.ts`

Expected: `mainDiscussion.test.ts OK`。

在 `src/test.ts` 的 `mainWorkspace.test` 與 `task.test` 之間加入：

```ts
import './mainDiscussion.test';
```

Run: `node --import tsx src/test.ts`

Expected: 全部 domain/frontend aggregate tests 通過，沒有 projection 重複註冊。

- [ ] **Step 7: 提交窗口 domain**

```bash
git add src/mainDiscussion.ts src/mainDiscussion.test.ts src/test.ts
git commit -m "feat: open fixed main discussion windows"
```

## Task 4：原子保存通知留言、mention 與窗口

**Files:**

- Modify: `src/notification.ts`
- Modify: `src/comment.ts`
- Modify: `src/comment.test.ts`
- Modify: `src/mainDiscussion.test.ts`

- [ ] **Step 1: 寫 comment integration 的失敗測試**

在 `src/comment.test.ts` 增加固定 `now` 的一般留言 assertion，確認新增參數不改變既有 caller：

```ts
const fixedCommentId = createComment(
  't2',
  'bob',
  'fixed time',
  db,
  new Date('2026-07-14T09:00:00.000Z'),
);
assert.strictEqual(
  getCommentContext(fixedCommentId, db)?.task_id,
  't2',
  '既有一般留言流程仍可使用同一 API',
);
assert.strictEqual(
  listComments('t2', db).find((row) => row.comment_id === fixedCommentId)?.created_at,
  '2026-07-14T09:00:00.000Z',
);
```

在 `src/mainDiscussion.test.ts` 改用 `createComment()` 走完整入口，增加：

1. 有完整 thought 的通知留言會同時出現在 `comments` 與 `main_discussion_windows`。
2. 缺少 thought 的可辨識通知被拒絕，`comments` 與 window 都沒有殘留。
3. 註冊一個會在 `notification.created` projection 丟錯的測試 projection，再送出包含真實 `@user02` 的合法通知；assert comment、window、notification event/read model 全部 rollback。
4. 通知成功後更新 request 內容不改 `opened_at` 或 `due_at`；第二則通知仍不能重開窗口。

- [ ] **Step 2: 執行兩個 focused tests 並確認目前不是原子操作**

Run: `npx tsx src/comment.test.ts`

Run: `npx tsx src/mainDiscussion.test.ts`

Expected: 新 assertions 失敗；目前 `createComment()` 不接受固定時間，也不寫窗口。

- [ ] **Step 3: notification 在外層 transaction 中使用新 append API**

在 `src/notification.ts` import `appendEventInTransaction`，並在 `emitMentionNotifications()` 中選擇正確入口：

```ts
const append = database.isTransaction ? appendEventInTransaction : appendEvent;

for (const recipientId of new Set(handleIds)) {
  const notificationId = randomUUID();
  append(
    'Notification',
    notificationId,
    0,
    'notification.created',
    {
      recipientId,
      sourceTaskId: taskId,
      sourceCommentId: commentId,
      snippet: snippet(content),
    },
    meta(actorId),
    database,
  );
}
```

`emitMentionNotifications()` 在其他 caller 中仍用原本會自行 transaction 的 `appendEvent()`；只有 `createComment()` 已開 transaction 時才走 caller-owned 入口。

- [ ] **Step 4: 將 createComment 改為單一 transaction**

在 `src/comment.ts` import `recordMainDiscussionWindowForComment`，將 function signature 與 body 改成：

```ts
export function createComment(
  taskId: string,
  userId: string,
  content: unknown,
  database = db,
  now = new Date(),
): string {
  const clean = validateContent(content);
  const id = randomUUID();
  const createdAt = now.toISOString();

  database.exec('BEGIN IMMEDIATE');
  try {
    if (getTaskWorkspaceId(taskId, database) === null) throw new CommandError('task 不存在');
    database.prepare(
      'INSERT INTO comments (comment_id, task_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, taskId, userId, clean, createdAt);
    recordMainDiscussionWindowForComment(
      { taskId, userId, commentId: id, content: clean, createdAt },
      database,
    );
    emitMentionNotifications(userId, taskId, id, clean, database);
    database.exec('COMMIT');
    return id;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
```

移除舊有「notification 失敗後只 DELETE comment」補償邏輯，避免 window 或 notification event 殘留。一般留言也走同一 transaction，確保既有行為不分叉。

- [ ] **Step 5: 驗證 comment、window 與 mentions 一起 commit／rollback**

Run: `npx tsx src/comment.test.ts`

Run: `npx tsx src/mainDiscussion.test.ts`

Run: `npx tsx src/notification.test.ts`

Expected: 三個測試都通過；外層 transaction 失敗時沒有任何部分寫入。

- [ ] **Step 6: 提交原子留言流程**

```bash
git add src/comment.ts src/comment.test.ts src/mainDiscussion.test.ts src/notification.ts
git commit -m "feat: atomically start main discussion window"
```

## Task 5：以留言證據守住 `Todo -> Done`

**Files:**

- Modify: `src/mainDiscussion.ts`
- Modify: `src/mainDiscussion.test.ts`
- Modify: `src/task.ts`
- Modify: `src/task.test.ts`

- [ ] **Step 1: 先寫收尾解析測試**

在 `src/mainDiscussion.test.ts` 為三種 outcome 建立獨立 TASK fixture，每個 fixture 都以固定 window 時間開窗。逐項驗證：

1. `now < due_at` 一律丟錯，錯誤訊息包含完整 UTC `due_at`。
2. 一般建立者 TASK：OWNER `【結論】` 後必須由該建立者留下較晚的 `【確認結論】`；其他 Commenter 或 OWNER 自己確認都不算。
3. OWNER 自建 TASK：OWNER `【結論】` 後必須由任一目前角色為 `Commenter` 的成員確認；OWNER 自己或非 Commenter 不算。
4. `implement` 還必須有更晚、由 OWNER 留下且完全符合 `【實作任務】工作區：<名稱>｜TASK：<名稱>` 的純文字交接。
5. workspace/TASK 名稱空白、缺少全形分隔符 `｜`、交接含 `http://` 或 `https://` 都不合法。
6. `no_implementation` 使用 `【結論：不實作】` 加正確確認，不要求交接。
7. `no_consensus` 使用 OWNER 的 `【未達共識】`，且 `尚未解決的分歧`、`缺少的確認或資訊`、`下次重新思考前的建議` 三欄皆非空白；不要求確認，也不要求任何 Commenter 回覆。
8. 以最新一則 OWNER terminal decision 為準；較早已完整的結論不能蓋過較晚但尚未確認的新結論。
9. decision、confirmation、handoff 都必須在 request 之後，且依上述順序出現。
10. window 指向的 thought/request 若被刪除或修改成不合法內容，收尾被拒；窗口的固定時間仍存在且不重算。

預期 payload 做完整 deep equality，不只檢查 outcome：

```ts
assert.deepStrictEqual(result, {
  status: 'Done',
  outcome: 'implement',
  windowOpenedAt: '2026-07-14T08:00:00.000Z',
  windowDueAt: '2026-07-16T08:00:00.000Z',
  ownerThoughtCommentId: thoughtId,
  requestCommentId: requestId,
  decisionCommentId: conclusionId,
  confirmationCommentId: confirmationId,
  handoffCommentId: handoffId,
  implementationWorkspaceName: 'Task Tracker',
  implementationTaskName: '加入主工作區收尾守門',
});
```

- [ ] **Step 2: 在 task tests 先改寫主工作區狀態案例**

移除 `src/task.test.ts` 中把主討論推進 `Doing -> Review` 的現行 assertions，改寫為：

1. 非 OWNER 不能執行主討論 status mutation。
2. OWNER 也不能把主討論改成 `Doing` 或 `Review`。
3. 沒窗口、截止前、缺少合法 terminal evidence 時都不能 `Done`，且不追加 event。
4. 三種合法 outcome 都只追加一個 `task.main_discussion_concluded`，read model 直接成為 `Done`、`assignee_id=null`。
5. `Done` 不可回退。
6. 規則 TASK 不可走 discussion conclusion。
7. TASK delete projection 清掉對應窗口。
8. 一般工作區的 `Todo -> Doing -> Review -> Done` 與一步回退測試保持原樣。
9. 歷史 `task.discussion_started` event 仍可 replay，但新 command 不再產生它。
10. legacy 主工作區 `Doing`／`Review` 在 `normalizeMainDiscussion()` 時回到 `Todo` 並清空 assignee；`Done`／`Archived` 不重開。

為避免時間測試依賴系統時鐘，將 `changeTaskStatus` 增加最後一個參數 `now = new Date()`；現有第四參數 `database` 的 caller 不需修改。

- [ ] **Step 3: 執行兩個 focused tests 並確認舊狀態機失敗**

Run: `npx tsx src/mainDiscussion.test.ts`

Run: `npx tsx src/task.test.ts`

Expected: conclusion API 尚不存在，且主工作區仍只接受舊 `Todo -> Doing`。

- [ ] **Step 4: 實作 conclusion payload 與證據解析**

在 `src/mainDiscussion.ts` 加入：

```ts
export type MainDiscussionOutcome = 'implement' | 'no_implementation' | 'no_consensus';

export interface MainDiscussionConcludedPayload {
  status: 'Done';
  outcome: MainDiscussionOutcome;
  windowOpenedAt: string;
  windowDueAt: string;
  ownerThoughtCommentId: string;
  requestCommentId: string;
  decisionCommentId: string;
  confirmationCommentId: string | null;
  handoffCommentId: string | null;
  implementationWorkspaceName: string | null;
  implementationTaskName: string | null;
}

interface OrderedComment {
  rowid: number;
  comment_id: string;
  user_id: string;
  content: string;
}
```

`resolveMainDiscussionConclusion(taskId, actorId, now, database)` 依序完成以下查詢與驗證：

1. 讀取 task、runtime OWNER 與 window；拒絕非主討論、規則 TASK、非 OWNER。
2. 用 `Date.parse()` 比較 UTC instant；未到期時拋 `討論期限尚未到達：<due_at>`。
3. 重新讀取 window 所指向的 thought/request，確認作者、完整 thought、合法 request header、原始 `wait_half_days` 與內容一致；只驗證 marker，不重算或更新 window。
4. 以 `ORDER BY rowid` 取得 request 之後的留言，找出最新 OWNER terminal decision。
5. `【未達共識】` 直接驗三欄並回 `no_consensus`。
6. 其他兩種結論尋找較晚且作者合格的第一則 `【確認結論】`。
7. `【結論】` 再尋找確認後的 OWNER handoff；`【結論：不實作】` 不尋找 handoff。

handoff 使用完整字串 regex 並拒絕 URL：

```ts
function parseImplementationHandoff(content: string): {
  workspaceName: string;
  taskName: string;
} | null {
  const match = content.match(/^【實作任務】工作區：(.+?)｜TASK：(.+?)\s*$/u);
  if (!match) return null;
  const workspaceName = match[1].trim();
  const taskName = match[2].trim();
  if (!workspaceName || !taskName || /https?:\/\//iu.test(content)) return null;
  return { workspaceName, taskName };
}
```

建立者從 `task.created` 的 `metadata_json.actor_id` 取得；不要從目前 assignee 推測。OWNER 自建時的確認者必須在收尾當下仍是主工作區 `Commenter`。

- [ ] **Step 5: 將 task command 切成 main 與 general 兩條路**

在 `src/task.ts` import `resolveMainDiscussionConclusion` 與 payload type。`changeTaskStatus()` 必須先判斷 main workspace，再套一般 `TRANSITIONS`，避免 `Todo -> Done` 在進入 main gate 前就被一般狀態機拒絕：

```ts
export function changeTaskStatus(
  actorId: string,
  taskId: string,
  status: unknown,
  database = db,
  now = new Date(),
): void {
  const { state, version } = loadEditableTask(taskId, database);
  const target = validateTargetStatus(status);

  if (getTaskWorkspaceId(taskId, database) === MAIN_WORKSPACE_ID) {
    const task = getTask(taskId, database)!;
    const ownerId = getUserIdByEmail(MAIN_OWNER_EMAIL, database);
    if (actorId !== ownerId) throw new CommandError('只有 user01 可以改變主工作區 task 狀態');
    if (task.title === MAIN_POLICY_TITLE) throw new CommandError('主工作區規則 task 不使用討論收尾流程');
    if (state.status !== 'Todo' || target !== 'Done') {
      throw new CommandError(`主工作區討論只允許 Todo → Done：${state.status} → ${target}`);
    }
    const payload = resolveMainDiscussionConclusion(taskId, actorId, now, database);
    appendEvent(
      'Task',
      taskId,
      version,
      'task.main_discussion_concluded',
      payload,
      meta(actorId),
      database,
    );
    return;
  }

  const allowed = TRANSITIONS[state.status as ActiveStatus];
  if (!allowed.includes(target)) throw new CommandError(`不允許的狀態轉換：${state.status} → ${target}`);
  appendEvent('Task', taskId, version, 'task.status_changed', { status: target }, meta(actorId), database);
}
```

- [ ] **Step 6: 增加 reducer、projection 與 delete cleanup**

`reduce()` 對新 event 回傳 payload status。`registerTaskProjections()` 增加：

```ts
registerProjection('task.main_discussion_concluded', (event, database) => {
  const payload = event.payload as MainDiscussionConcludedPayload;
  database.prepare(
    `UPDATE tasks_read_model
        SET status = ?, assignee_id = NULL, version = ?, updated_at = ?
      WHERE task_id = ?`,
  ).run(payload.status, event.aggregate_version, event.occurred_at, event.aggregate_id);
});
```

在既有 `task.deleted` projection 追加：

```ts
database.prepare('DELETE FROM main_discussion_windows WHERE task_id = ?').run(e.aggregate_id);
```

保留 `task.discussion_started` reducer/projection 只為歷史 event replay，相同 event type 不再由新 command 產生。

- [ ] **Step 7: 收斂 legacy normalization**

`normalizeMainDiscussion()` 對主工作區非規則討論使用：

```ts
const normalizedStatus = task.status === 'Doing' || task.status === 'Review' ? 'Todo' : task.status;
const assigneeId = null;
```

將 `status: normalizedStatus` 放入 `task.main_discussion_normalized` payload。projection 使用 `status = ?` 更新；reducer 也讀取此 status，確保事件流與 read model 一致。只處理非 Archived 討論，`Done` 維持 `Done`，不建立窗口、不重開討論。

- [ ] **Step 8: 驗證收尾與一般狀態機隔離**

Run: `npx tsx src/mainDiscussion.test.ts`

Run: `npx tsx src/task.test.ts`

Run: `npx tsx src/audit.test.ts`

Expected: 三種 outcome、截止守門、legacy replay、一般四階段狀態機全部通過；audit 可讀到 `task.main_discussion_concluded` payload。

- [ ] **Step 9: 提交 domain gate**

```bash
git add src/mainDiscussion.ts src/mainDiscussion.test.ts src/task.ts src/task.test.ts
git commit -m "feat: gate main discussion completion on consensus"
```

## Task 6：只調整主工作區必要 UI

**Files:**

- Modify: `public/js/state.js`
- Modify: `public/js/views/kanban.js`
- Modify: `public/js/views/task-detail.js`
- Modify: `public/css/kanban.css`
- Modify: `src/frontend.test.ts`

- [ ] **Step 1: 先寫 frontend 行為與 absence assertions**

在 `src/frontend.test.ts` 增加：

1. `state.js` 匯出三行描述範本，順序與標點完全一致。
2. 主工作區 inline form 有可編輯 textarea，POST body 使用 textarea 當下值；一般工作區仍傳空 description。
3. 主工作區 board markup 不產生 `Doing`／`Review` 欄；一般工作區仍有四欄。
4. 主工作區 OWNER 檢視一般 `Todo` 討論時只有 `→ Done`，沒有 `→ Doing`；`Done` 沒有 rollback button。
5. 規則 TASK 沒有 `→ Done`。
6. Commenter 仍可留言但沒有 status controls。
7. `kanban.js` 與 `task-detail.js` 不包含等待天數 selector、截止／逾期元件、回覆／缺席清單或 `【OWNER想法】` 等留言格式快捷提示。

DOM assertion 使用既有 `openTaskDetailModal()` harness。OWNER case 的核心檢查為：

```ts
const doneButton = findElement(
  ownerOverlay,
  (node) => node.classList.contains('status-change-btn') && node.textContent === '→ Done',
);
assert.ok(doneButton, '主工作區 OWNER 可在 Todo 送出 Done');
assert.strictEqual(
  findElement(ownerOverlay, (node) => node.textContent === '→ Doing'),
  null,
  '主工作區不顯示 Doing transition',
);
```

- [ ] **Step 2: 執行 frontend test 並確認舊 UI 失敗**

Run: `npx tsx src/frontend.test.ts`

Expected: 主工作區目前仍顯示四欄、`→ Doing`，且 inline form 沒有描述 textarea。

- [ ] **Step 3: 新增唯一的前端描述範本常數**

在 `public/js/state.js` 加入：

```js
export const MAIN_DISCUSSION_DESCRIPTION_TEMPLATE = `問題／優化想法：
目前情況或影響：
希望改善的結果：`;
```

在 `kanban.js` import 此常數，避免 template 文案散落兩份。

- [ ] **Step 4: 主工作區 inline form 顯示可編輯 description**

建立 title input 後，主工作區才建立 textarea：

```js
const descriptionInput = isMainWorkspace
  ? el('textarea', {
      class: 'column-add-task-description',
      rows: '4',
      'aria-label': '討論描述'
    })
  : null;
if (descriptionInput) descriptionInput.value = MAIN_DISCUSSION_DESCRIPTION_TEMPLATE;
```

依序 append title、description、按鈕；POST body 的兩個 role branch 都使用同一變數：

```js
const description = descriptionInput ? descriptionInput.value : '';
const body = hasRole(currentRole, 'Member')
  ? {
      title,
      description,
      priority: 'Medium',
      status: colStatus,
      projectId,
      assigneeId: null,
      dueAt: null
    }
  : { title, description };
```

CSS 只讓 inline form 容納 textarea，不新增留言提示區：

```css
.column-add-task-form {
  flex-wrap: wrap;
}

.column-add-task-description {
  flex: 1 0 100%;
  min-height: 5.5rem;
  resize: vertical;
  font: inherit;
}
```

- [ ] **Step 5: 主工作區只 render Todo／Done 欄**

將 board 加上 `main-discussion-board` class，並用 `isMainWorkspace` 省略 Doing/Review markup。Archived 保持獨立 archive flow：

```css
.kanban-board.main-discussion-board {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.kanban-board.main-discussion-board.show-archived-col {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
```

`clearInlineAdders()`、`renderKanbanCards()` 已對不存在的 DOM container 做 null check，不需新增假的 Doing/Review container。

- [ ] **Step 6: 收斂兩處 status controls**

在 kanban card 與 task detail 都先分 main branch：

```js
if (isMainWorkspace) {
  if (task.title !== MAIN_POLICY_TITLE && task.status === 'Todo') {
    flowRight.appendChild(createStateBtn('→ Done', 'Done'));
  }
} else if (task.status === 'Todo') {
  flowRight.appendChild(createStateBtn('→ Doing', 'Doing'));
} else if (task.status === 'Doing') {
  flowLeft.appendChild(createStateBtn('← Todo', 'Todo'));
  flowRight.appendChild(createStateBtn('Review →', 'Review'));
} else if (task.status === 'Review') {
  flowLeft.appendChild(createStateBtn('← Doing', 'Doing'));
  flowRight.appendChild(createStateBtn('Done →', 'Done'));
} else if (task.status === 'Done') {
  flowLeft.appendChild(createStateBtn('← Review', 'Review'));
}
```

task detail 使用 `currentTask` 和 `createTransitionBtn()` 做相同分支。保留 backend 為最終權威：按下 `→ Done` 後，尚未到期或證據不足的 `400` 直接顯示既有錯誤訊息，不在前端重做 domain 判斷。

- [ ] **Step 7: 更新主工作區頂部短政策文字**

移除「開始處理時自動指派 user01」及「回寫連結」，改成不帶操作按鈕的簡短文字：所有人可提案與留言、OWNER 先評估再通知、期限後直接完成、實作另開於目標工作區、原討論只記工作區與 TASK 名稱。

- [ ] **Step 8: 驗證 UI 且確認沒有被排除的元件**

Run: `npx tsx src/frontend.test.ts`

Run: `npm run lint`

Expected: frontend tests 與 ESLint 全通過；前端 source 沒有 deadline、overdue、reply tracker、absence 或 comment format shortcut。

- [ ] **Step 9: 提交最小 UI**

```bash
git add public/js/state.js public/js/views/kanban.js public/js/views/task-detail.js public/css/kanban.css src/frontend.test.ts
git commit -m "feat: simplify main discussion task ui"
```

## Task 7：同步固定政策與 OWNER sweep

**Files:**

- Modify: `src/mainWorkspacePolicy.ts`
- Modify: `src/mainWorkspace.test.ts`
- Modify: `sim/run.ts`
- Modify: `sim/run.test.ts`

- [ ] **Step 1: 先把舊政策 assertions 改成新規則**

在 `src/mainWorkspace.test.ts` 除了 equality，也明確驗證 policy description：

```ts
assert.match(MAIN_POLICY_DESCRIPTION, /先留下 OWNER想法，再通知 user02-06 與 user09/);
assert.match(MAIN_POLICY_DESCRIPTION, /2 至 7 天/);
assert.match(MAIN_POLICY_DESCRIPTION, /Todo 直接完成為 Done/);
assert.match(MAIN_POLICY_DESCRIPTION, /工作區與 TASK 名稱/);
assert.doesNotMatch(MAIN_POLICY_DESCRIPTION, /完整連結|Doing|Review|缺席名單/);
```

在 `sim/run.test.ts` 移除 `MAIN_HANDOFF_PENDING` 與 URL assertions，改驗：

- main prompt 只讀 `Todo` 討論。
- OWNER 先發完整想法，再發獨立全員通知。
- 通知明列 `@user02 @user03 @user04 @user05 @user06 @user09`，不 `@user01`。
- 預設 2 天，只有成員近期大量事務時可用較長期限並寫理由。
- 一天 24 小時、半天 12 小時、窗口不可調整。
- 到期前不 PATCH status；到期後三種結果都 PATCH `Done`。
- 實作交接只有 workspace/task 名稱，prompt 不含 `${BASE}/#/task/` 或 `HANDOFF-PENDING`。
- 不追缺席者；無回覆也照樣收尾。
- main owner session 仍只允許 curl，且不占 repo/worktree slot。

- [ ] **Step 2: 執行 tests 並確認仍引用舊流程**

Run: `npx tsx src/mainWorkspace.test.ts`

Run: `npx tsx sim/run.test.ts`

Expected: assertions 顯示目前政策仍使用 `Doing/Review`、URL 與 handoff marker。

- [ ] **Step 3: 更新 canonical policy description**

將 `MAIN_POLICY_DESCRIPTION` 改為精簡但完整的固定政策：

```ts
export const MAIN_POLICY_DESCRIPTION = [
  '此處供目前七位成員提出工作問題、改善方向與優化想法；只討論，不直接實作。',
  '所有成員都可建立 Todo 討論與留言；user01 先留下 OWNER想法，再通知 user02-06 與 user09。',
  '回覆期限為連續 2 至 7 天、以半天為單位，通知送出後開始且不可調整；預設使用 2 天。',
  '所有 Commenter 都應留言；系統不追蹤回覆或缺席，也不因未回覆阻擋收尾。',
  '結論需由 OWNER 與建立者雙方確認；OWNER 自建時由任一 Commenter 確認。',
  '截止後由 user01 將 Todo 直接完成為 Done；未達共識則記錄分歧後完成，不實作。',
  '需要實作時在對應工作區另建 TASK，原討論只記錄工作區與 TASK 名稱，不提供連結。',
].join('\n');
```

不修改固定 UUID、OWNER email 或六位 Commenter whitelist。

- [ ] **Step 4: 簡化 main sweep candidate 判斷**

刪除 `MAIN_HANDOFF_PENDING`。將 helper 收斂為：

```ts
export function mainDiscussionNeedsOwner(status: string): boolean {
  return status === 'Todo';
}
```

main workspace query 只取 `status = 'Todo'`；其他 workspace 仍取 `Todo/Doing/Review`。main `ownerNeeded` 不再依最後留言作者或 URL marker 判斷，任何 active Todo 討論都需要 OWNER 巡檢，以便到期時收尾。

- [ ] **Step 5: 完整替換 main owner prompt**

main prompt 必須按以下順序描述既有 API 操作，不新增 route：

1. GET 主工作區 tasks，忽略規則 TASK，只讀 `[討論]` 且 `status=Todo` 的 TASK 與 comments。
2. TASK 建立後盡量在 24 小時內，先獨立 POST `【OWNER想法】` 六欄內容；全面評估價值、風險、反對理由與現行替代方案。
3. 再獨立 POST `【全員回覆：2天】`，手動列出六位固定 Commenter；OWNER 不 mention 自己。只有近期大量事務才選 `2.5..7` 天並填較長期限理由。
4. 從 request comment `created_at` 加上 `N * 24` 小時計算截止時間；半天是 12 小時。不要調整期限，不要在截止前 PATCH status。
5. 等待期間讀取新留言、回覆疑問並提出 OWNER 結論；所有人提前回覆也保持 Todo 到期。
6. 一般 TASK 要等建立者在 OWNER 結論後確認；OWNER 自建則等任一 Commenter 確認。
7. 到期後走 implement、no implementation、no consensus 三條精確 marker 路徑；沒人回覆不追逐、不列缺席者。
8. implement 先查目標 workspace 內是否已有同名實作 TASK，避免 crash retry 重複建立；需要時才建立，原討論只 POST 純文字工作區/TASK 名稱。
9. 最後只 PATCH `{"status":"Done"}`；若 API 拒絕，依錯誤補齊留言證據，不改 deadline。

保留「API-only、不得編輯／commit／merge 程式碼」、「先辨識 target repo」及 canonical workspace mapping。移除完整 URL、來源 URL、`HANDOFF-PENDING`、相鄰推進狀態與主工作區自動指派內容。

- [ ] **Step 6: 驗證政策與 prompt**

Run: `npx tsx src/mainWorkspace.test.ts`

Run: `npx tsx sim/run.test.ts`

Expected: 新流程 assertions 全通過；測試過程不啟動任何 AI session。

- [ ] **Step 7: 提交政策與 sweep 更新**

```bash
git add src/mainWorkspacePolicy.ts src/mainWorkspace.test.ts sim/run.ts sim/run.test.ts
git commit -m "feat: align owner sweep with consensus window"
```

## Task 8：同步 API、設計、營運與 current-state 文件

**Files:**

- Modify: `docs/api.md`
- Modify: `design.md`
- Modify: `docs/operations.md`
- Modify: `docs/tasks/current.md`

- [ ] **Step 1: 更新 API contract**

在 `docs/api.md` 的 comment POST 與 task PATCH 段落寫清楚：

- API path 與 request body 不變，沒有 window GET endpoint。
- 主工作區精確 notification marker 會在同一 transaction 建立窗口。
- 範圍 `2..7`、半天單位、`N>2` 理由、UTC `opened_at/due_at`、窗口不可變。
- 主工作區 status 只有 OWNER 可從 `Todo` PATCH `Done`，且期限與三種 evidence 由 backend 驗證。
- 截止前錯誤含 UTC 截止時間；一般 domain error 維持 `400`。
- 一般工作區仍是相鄰四階段狀態機。
- 沒有回覆／缺席 API，handoff 只有純文字名稱。

將 request example 補上主工作區唯一 status mutation：

```json
{ "status": "Done" }
```

- [ ] **Step 2: 更新 design baseline**

在 `design.md` 狀態機段落保留一般流程，再加主工作區例外。資料模型列出 `main_discussion_windows` 六欄與 `task.main_discussion_concluded` 三種 outcome；註明 comment 仍為傳統 CRUD、window 只保存 gate metadata。

- [ ] **Step 3: 更新 operations 現行政策，不改寫歷史 rollout 證據**

在 `docs/operations.md` 的「主協作工作區」現行規則改成新流程，加入部署後 readback：

```bash
sqlite3 data/dev.db "SELECT task_id, opened_at, wait_half_days, due_at FROM main_discussion_windows ORDER BY opened_at DESC LIMIT 20;"
```

保留 `2026-07-12 rollout 驗收` 為明確標示日期的歷史紀錄，不把當時實際做過的 `Doing/Review`、URL smoke 改寫成新流程。

- [ ] **Step 4: 在 current state 新增獨立 phase**

在 `docs/tasks/current.md` 新增「Phase 18 — 主工作區固定期限共識收斂」，於實作完成後勾選：

- 七位成員共同提案與 description template。
- OWNER thought + fixed request window。
- 三種 evidence-based conclusion event。
- main-only Todo/Done UI，無 deadline/reply/absence UI。
- sweep/policy/docs 同步。
- focused/full tests、build、service health。

保留 Phase 15 與其 rollout 文字作歷史紀錄；「live owner sweep」仍保持未勾選，因本計畫不授權執行。

- [ ] **Step 5: 搜尋並人工分類殘留舊文案**

Run:

```bash
rg -n "task\.discussion_started|HANDOFF-PENDING|完整 task URL|回寫完整|Todo.*Doing.*Review.*Done|自動指派 user01" docs design.md src/mainWorkspacePolicy.ts sim/run.ts public/js/views
```

Expected: 只允許以下殘留：

- `task.ts` 的歷史 event replay handler。
- `docs/tasks/current.md` 與 `docs/operations.md` 中明確標示日期的 2026-07-12 歷史 rollout。
- 一般工作區的四階段狀態機與非 main sweep prompt。

任何未標示為歷史、卻仍描述主工作區舊流程的結果都必須修正。

- [ ] **Step 6: 提交現行文件**

```bash
git add docs/api.md design.md docs/operations.md docs/tasks/current.md
git commit -m "docs: document main workspace consensus gate"
```

## Task 9：完整驗證、部署與只讀健康檢查

**Files:**

- Verify only: all files changed in Tasks 1–8

- [ ] **Step 1: 執行直接相關測試**

```bash
npx tsx src/schema.test.ts
npx tsx src/eventStore.test.ts
npx tsx src/comment.test.ts
npx tsx src/notification.test.ts
npx tsx src/mainDiscussion.test.ts
npx tsx src/task.test.ts
npx tsx src/mainWorkspace.test.ts
npx tsx src/frontend.test.ts
npx tsx sim/run.test.ts
```

Expected: 每個檔案都輸出自己的 `OK`，沒有 AI run 或網路模型請求。

- [ ] **Step 2: 執行 repo 標準驗證**

```bash
npx tsc --noEmit
npm test
npm run build
git diff --check
```

Expected: 四個 command exit 0。`npm test` 只執行測試，不執行 `npm run sim`。

- [ ] **Step 3: 檢查規格覆蓋與禁止項目**

逐項對照本文件最前面的不可擴張範圍，並執行：

```bash
rg -n "main_discussion_(replies|absences)|missing_members|reply_status|extend.*window|deadline.*(button|input|select)|overdue" src public sim
rg -n "T[B]D|TO[D]O|implement la[t]er|add valida[t]ion|add error handl[i]ng" docs/superpowers/plans/2026-07-14-main-workspace-consensus-gate.md
```

Expected: 第一個搜尋沒有新增回覆／缺席／延長／期限 UI 實作；第二個搜尋沒有未完成占位描述。`Todo` 是產品狀態名稱，不是占位文字。

- [ ] **Step 4: 重啟正式 user service**

只有 Tasks 1–8 全部通過後執行：

```bash
systemctl --user restart task-tracker.service
systemctl --user status task-tracker.service --no-pager
curl -fsS http://localhost:3000/api/health
```

Expected: service 為 `active (running)`；health 回 HTTP 200 與 `{"status":"ok","db":true}`。

- [ ] **Step 5: 只讀確認 migration 與主工作區現況**

```bash
sqlite3 data/dev.db "PRAGMA table_info(main_discussion_windows);"
sqlite3 data/dev.db "SELECT status, COUNT(*) FROM tasks_read_model WHERE workspace_id = '11a82028-fc50-466a-a723-e002032cd9a6' GROUP BY status ORDER BY status;"
```

Expected: window table 有六個規劃欄位；startup normalization 後 active 主討論不再停在 `Doing`／`Review`。`Archived` 仍可作獨立 archive 歷史狀態。

- [ ] **Step 6: 不建立假的正式討論，確認工作樹與提交**

不要為 smoke test 在正式主工作區建立或回填 2 天窗口；時間與 outcome 行為已由固定時鐘的 in-memory tests 覆蓋。執行：

```bash
git status --short
git log --oneline -10
```

Expected: 工作樹乾淨，Tasks 1–8 的小步提交都存在；沒有 live sim/timer 產物。

## 完成定義

- 合法通知建立後，comment、mention events/projections 與 window 同時成功或同時 rollback。
- `opened_at` 與 `due_at` 只由第一則合法通知決定，comment edit 不會重算，第二次通知不能覆蓋。
- backend 以 UTC instant 阻止提前完成，並只接受三種精確、依留言順序成立的收尾證據。
- `task.main_discussion_concluded` payload 足以從 audit 還原 outcome、窗口、證據 comment ids，以及 implement 的工作區/TASK 名稱。
- 主工作區 read model 直接由 `Todo` 到 `Done` 且不指派 OWNER；一般工作區狀態機完全不變。
- 前端只有描述範本、主工作區 Todo/Done 欄及 `→ Done` 控制；沒有 deadline、overdue、reply、absence、format shortcut。
- sweep 與政策使用相同的 24 小時啟動提醒、2–7 天固定窗口、雙方確認及三種收尾規則，不產生 URL。
- 文件、focused tests、full tests、build、health 與 migration readback 都通過；未執行 live AI sweep。
