import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from './schema';
import { CommandError } from './eventStore';
import {
  createAttachment,
  listAttachments,
  readAttachment,
  deleteAttachment,
  getAttachmentContext,
  ATTACH_DIR,
} from './attachment';

const db = new DatabaseSync(':memory:');
runMigrations(db);
db.prepare('INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, version) VALUES (?, ?, ?, ?, ?, ?)')
  .run('t1', 'ws-1', 'T', 'Todo', 'Medium', 1);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('imagedata')]);
const created: string[] = [];

// ── 上傳有效 PNG → 存檔 + metadata；原始檔名 sanitize ──
const id = createAttachment('t1', '../../etc/passwd.png', 'image/png', PNG, db);
created.push(id);
let rows = listAttachments('t1', db);
assert.strictEqual(rows.length, 1);
assert.strictEqual(rows[0].original_name, 'passwd.png', '原始檔名應只取 basename（不信任路徑）');
assert.strictEqual(rows[0].mime_type, 'image/png');
assert.strictEqual(rows[0].size, PNG.length);

// ── ATTACHMENT_MAX_BYTES：設定後上限要真的跟著變 ──
const oldMaxBytes = process.env.ATTACHMENT_MAX_BYTES;
try {
  process.env.ATTACHMENT_MAX_BYTES = '16';
  assert.throws(
    () => createAttachment('t1', 'tiny.png', 'image/png', PNG, db),
    CommandError,
    'ATTACHMENT_MAX_BYTES 應能調小上限',
  );
} finally {
  if (oldMaxBytes === undefined) delete process.env.ATTACHMENT_MAX_BYTES;
  else process.env.ATTACHMENT_MAX_BYTES = oldMaxBytes;
}

// ── 下載：內容與 metadata 相符 ──
const file = readAttachment(id, db)!;
assert.ok(file.data.equals(PNG), '下載內容應與上傳一致');
assert.strictEqual(file.mime, 'image/png');
assert.strictEqual(file.originalName, 'passwd.png');

// ── context：經 task JOIN 拿到 workspace（權限用）──
assert.strictEqual(getAttachmentContext(id, db)!.workspace_id, 'ws-1');

// ── MIME 白名單 / magic bytes ──
assert.throws(() => createAttachment('t1', 'x.exe', 'application/x-msdownload', PNG, db), CommandError, '非白名單型別應拒');
assert.throws(() => createAttachment('t1', 'fake.png', 'image/png', Buffer.from('not a png'), db), CommandError, 'magic 不符應拒');

// ── 其他輸入驗證 ──
assert.throws(() => createAttachment('t1', 'empty.png', 'image/png', Buffer.alloc(0), db), CommandError, '空檔應拒');
assert.throws(() => createAttachment('no-task', 'x.png', 'image/png', PNG, db), CommandError, '不存在的 task 應拒');

// ── symlink 守門：attachments 目錄裡指向外部的 symlink 必須被擋（字串比對擋不住）──
const outside = join(tmpdir(), `secret-${randomUUID()}.txt`);
writeFileSync(outside, 'TOPSECRET');
const evilStored = randomUUID();
symlinkSync(outside, join(ATTACH_DIR, evilStored));
db.prepare('INSERT INTO attachments (attachment_id, task_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)')
  .run('evil-att', 't1', 'innocent.txt', evilStored, 'text/plain', 9);
assert.throws(() => readAttachment('evil-att', db), CommandError, 'symlink 指向目錄外應被 realpath 守門擋下');
assert.throws(() => deleteAttachment('evil-att', db), CommandError, 'symlink 指向目錄外刪除時也應被 realpath 守門擋下');
unlinkSync(join(ATTACH_DIR, evilStored));
unlinkSync(outside);
db.prepare('DELETE FROM attachments WHERE attachment_id = ?').run('evil-att'); // 清掉 symlink 測試的 fixture

// ── delete：清 DB + 實體檔；重複刪拒 ──
deleteAttachment(id, db);
created.pop();
assert.strictEqual(listAttachments('t1', db).length, 0, 'delete 後 metadata 移除');
assert.strictEqual(readAttachment(id, db), null, 'delete 後查不到');
assert.throws(() => deleteAttachment(id, db), CommandError, '重複 delete 應拒');

// 清理任何殘留實體檔
for (const cid of created) {
  try {
    deleteAttachment(cid, db);
  } catch {
    /* already gone */
  }
}

console.log('attachment.test.ts OK');
