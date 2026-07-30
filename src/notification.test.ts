import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { resetProjections, CommandError } from './eventStore';
import { createComment } from './comment';
import { listNotifications, listNotificationsPage, markNotificationRead, registerNotificationProjections } from './notification';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerNotificationProjections();

db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('alice', 'alice@test.local', 'Alice', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('bob', 'bob@test.local', 'Bob', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('carol', 'carol@test.local', 'Carol', 'x');
db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
  .run('ws-1', 'ws-1', 'active', '2026-07-12T00:00:00.000Z');
db.prepare('INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, version) VALUES (?, ?, ?, ?, ?, ?)')
  .run('task-1', 'ws-1', 'Task 1', 'Todo', 'Medium', 1);

const comment1 = createComment('task-1', 'alice', 'Hi @Bob, @missing, @Bob, @Alice', db);
let bobRows = listNotifications('bob', db);
assert.strictEqual(bobRows.length, 1, '同留言重複 mention 同一人只應發一筆');
assert.strictEqual(bobRows[0].recipient_id, 'bob');
assert.strictEqual(bobRows[0].source_task_id, 'task-1');
assert.strictEqual(bobRows[0].source_comment_id, comment1);
assert.strictEqual(bobRows[0].read_at, null, '新通知預設未讀');
assert.strictEqual(listNotifications('alice', db).length, 0, '@ 自己不應收到通知');

const comment2 = createComment('task-1', 'carol', 'Reply to @Bob and again @Bob', db);
assert.strictEqual(comment2.length > 0, true);
bobRows = listNotifications('bob', db);
assert.strictEqual(bobRows.length, 2, '第二次 mention 應再新增一筆通知');

markNotificationRead('bob', bobRows[1].notification_id, db);
bobRows = listNotifications('bob', db);
assert.strictEqual(bobRows[0].read_at, null, '未讀應排序在前');
assert.ok(bobRows[1].read_at, '已讀通知應有 read_at');

assert.throws(() => markNotificationRead('alice', bobRows[1].notification_id, db), CommandError, '不能讀別人的通知');

// ── listNotificationsPage：opt-in 分頁 ───────────────────────────
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('dave', 'dave@test.local', 'Dave', 'x');

function insertNotification(id: string, createdAt: string, readAt: string | null = null): void {
  db.prepare(
    `INSERT INTO notifications_read_model
       (notification_id, recipient_id, source_task_id, source_comment_id, snippet, created_at, read_at)
     VALUES (?, 'dave', 'task-1', 'c-x', 'snippet', ?, ?)`,
  ).run(id, createdAt, readAt);
}

// 0 筆：page=1 應回空清單，totalPages 至少為 1
let page = listNotificationsPage('dave', '1', null, db);
assert.strictEqual(page.items.length, 0);
assert.strictEqual(page.totalCount, 0);
assert.strictEqual(page.totalPages, 1);
assert.strictEqual(page.unreadTotal, 0);

// 1 筆
insertNotification('d01', '2026-07-01T00:00:00.000Z');
page = listNotificationsPage('dave', '1', null, db);
assert.strictEqual(page.items.length, 1);
assert.strictEqual(page.totalPages, 1);
assert.strictEqual(page.unreadTotal, 1);

// 補到 15 筆（含剛剛那 1 筆，再補 14 筆，created_at 遞增避免與後面同一秒衝突）
for (let i = 2; i <= 15; i++) {
  insertNotification(`d${String(i).padStart(2, '0')}`, `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z`);
}
page = listNotificationsPage('dave', '1', null, db);
assert.strictEqual(page.items.length, 15, '15 筆應剛好塞滿一頁');
assert.strictEqual(page.totalPages, 1);

// 第 16 筆：應多出第 2 頁
insertNotification('d16', '2026-07-01T00:00:16.000Z');
page = listNotificationsPage('dave', '1', null, db);
assert.strictEqual(page.items.length, 15, '第一頁仍固定 15 筆');
assert.strictEqual(page.totalPages, 2);
const page2 = listNotificationsPage('dave', '2', null, db);
assert.strictEqual(page2.items.length, 1, '第二頁應有溢出的 1 筆');
assert.strictEqual(page2.items[0].notification_id, 'd01', 'created_at DESC 排序下最舊的一筆落在最後一頁');

// 同一秒建立多筆：notification_id 作穩定次排序，兩頁合計不重複、不遺漏
insertNotification('same-b', '2026-07-02T00:00:00.000Z');
insertNotification('same-a', '2026-07-02T00:00:00.000Z');
const allPaged: string[] = [];
const totalPagesNow = listNotificationsPage('dave', '1', '9', db).totalPages;
for (let p = 1; p <= totalPagesNow; p++) {
  allPaged.push(...listNotificationsPage('dave', String(p), '9', db).items.map(n => n.notification_id));
}
assert.strictEqual(new Set(allPaged).size, allPaged.length, '跨頁不應重複');
assert.strictEqual(allPaged.length, 18, '跨頁合計應等於總筆數（18 筆）');

// 非法頁碼
assert.throws(() => listNotificationsPage('dave', '0', null, db), CommandError, 'page=0 不合法');
assert.throws(() => listNotificationsPage('dave', '-1', null, db), CommandError, '負數頁碼不合法');
assert.throws(() => listNotificationsPage('dave', 'abc', null, db), CommandError, '非數字頁碼不合法');
assert.throws(() => listNotificationsPage('dave', '1.5', null, db), CommandError, '非整數頁碼不合法');
assert.throws(() => listNotificationsPage('dave', '1', '0', db), CommandError, 'pageSize=0 不合法');
assert.throws(() => listNotificationsPage('dave', '1', '101', db), CommandError, 'pageSize 超上限不合法');

// 越界頁碼
const totalPages = listNotificationsPage('dave', '1', null, db).totalPages;
assert.throws(() => listNotificationsPage('dave', String(totalPages + 1), null, db), CommandError, '超過總頁數應報錯');

// 跨頁標記已讀後，未讀總數不論查哪一頁都應正確反映
const unreadBefore = listNotificationsPage('dave', '1', null, db).unreadTotal;
markNotificationRead('dave', 'd16', db);
const afterPage1 = listNotificationsPage('dave', '1', null, db);
const afterPage2 = listNotificationsPage('dave', String(afterPage1.totalPages), null, db);
assert.strictEqual(afterPage1.unreadTotal, unreadBefore - 1, '標記已讀後，第一頁看到的未讀總數應減少');
assert.strictEqual(afterPage2.unreadTotal, afterPage1.unreadTotal, '不論查哪一頁，未讀總數應一致');

console.log('notification.test.ts OK');
