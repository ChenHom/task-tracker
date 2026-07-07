import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { db } from './db';
import { CommandError } from './eventStore';
import { getTaskWorkspaceId } from './task';

// 實體檔目錄。stored_name（uuid）才是磁碟檔名，original_name 只存 DB 供顯示。
export const ATTACH_DIR = join(__dirname, '../data/attachments');
mkdirSync(ATTACH_DIR, { recursive: true });
const ATTACH_REAL = realpathSync(ATTACH_DIR); // 解析一次當基準，之後拿它比對

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export function attachmentMaxBytes(): number {
  const raw = process.env.ATTACHMENT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const maxBytes = Number(raw);
  return Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// MIME 白名單 + magic bytes：client 宣告的 Content-Type 不可信，必須與內容簽章相符。
const ALLOWED: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  'application/pdf': (b) => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-',
  'text/plain': () => true, // 無 magic；下載時 nosniff + attachment 已防止被當可執行內容
};

function validateMime(declared: unknown, data: Buffer): string {
  const mime = typeof declared === 'string' ? declared.split(';')[0].trim().toLowerCase() : '';
  const check = ALLOWED[mime];
  if (!check) throw new CommandError(`不支援的檔案型別：${mime || '(未提供)'}`);
  if (!check(data)) throw new CommandError('檔案內容與宣告的型別不符');
  return mime;
}

// 原始檔名只取 basename、去控制字元與引號（防 header injection / 路徑），限長。絕不當磁碟路徑。
function sanitizeFilename(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const base = raw
    .replace(/^.*[\\/]/, '')
    .replace(/[\r\n"\x00-\x1f]/g, '')
    .trim();
  return (base || 'file').slice(0, 255);
}

// symlink 守門：storedName 必為 uuid；解析真實路徑後必須仍在 ATTACH_REAL 內（字串比對擋不住 symlink）。
function resolveInside(storedName: string): string {
  if (!UUID_RE.test(storedName)) throw new CommandError('非法的 stored_name');
  let real: string;
  try {
    real = realpathSync(join(ATTACH_REAL, storedName));
  } catch {
    throw new CommandError('attachment 檔案不存在');
  }
  if (real !== join(ATTACH_REAL, storedName) && !real.startsWith(ATTACH_REAL + sep)) {
    throw new CommandError('attachment 路徑越界');
  }
  return real;
}

export interface AttachmentRow {
  attachment_id: string;
  task_id: string;
  original_name: string;
  mime_type: string;
  size: number;
}

export function createAttachment(taskId: string, originalName: unknown, declaredMime: unknown, data: Buffer, database = db): string {
  if (getTaskWorkspaceId(taskId, database) === null) throw new CommandError('task 不存在');
  if (data.length === 0) throw new CommandError('檔案為空');
  const maxBytes = attachmentMaxBytes();
  if (data.length > maxBytes) throw new CommandError('檔案過大');
  const mime = validateMime(declaredMime, data);
  const original = sanitizeFilename(originalName);
  const id = randomUUID();
  const storedName = randomUUID(); // 磁碟檔名與 attachment_id 分開：URL 不洩漏磁碟名
  writeFileSync(join(ATTACH_REAL, storedName), data);
  database
    .prepare('INSERT INTO attachments (attachment_id, task_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, taskId, original, storedName, mime, data.length);
  return id;
}

export function listAttachments(taskId: string, database = db): AttachmentRow[] {
  return database
    .prepare('SELECT attachment_id, task_id, original_name, mime_type, size FROM attachments WHERE task_id = ? ORDER BY rowid')
    .all(taskId) as unknown as AttachmentRow[];
}

export function readAttachment(
  attachmentId: string,
  database = db,
): { data: Buffer; mime: string; originalName: string } | null {
  const row = database
    .prepare('SELECT stored_name, mime_type, original_name FROM attachments WHERE attachment_id = ?')
    .get(attachmentId) as { stored_name: string; mime_type: string; original_name: string } | undefined;
  if (!row) return null;
  const data = readFileSync(resolveInside(row.stored_name)); // 守門在 resolveInside
  return { data, mime: row.mime_type, originalName: row.original_name };
}

export function deleteAttachment(attachmentId: string, database = db): void {
  const row = database.prepare('SELECT stored_name FROM attachments WHERE attachment_id = ?').get(attachmentId) as
    | { stored_name: string }
    | undefined;
  if (!row) throw new CommandError('attachment 不存在');
  const path = resolveInside(row.stored_name);
  try {
    unlinkSync(path);
  } catch {
    // 檔案可能已不在；DB 記錄仍要清掉，不讓孤兒 metadata 殘留
  }
  database.prepare('DELETE FROM attachments WHERE attachment_id = ?').run(attachmentId);
}

// download / delete 用：一次拿到 workspace 做權限檢查。JOIN task；task 已刪則查不到 → null → 404。
export function getAttachmentContext(
  attachmentId: string,
  database = db,
): { attachment_id: string; task_id: string; workspace_id: string } | null {
  const row = database
    .prepare(
      `SELECT a.attachment_id, a.task_id, t.workspace_id
         FROM attachments a JOIN tasks_read_model t ON t.task_id = a.task_id
        WHERE a.attachment_id = ?`,
    )
    .get(attachmentId) as { attachment_id: string; task_id: string; workspace_id: string } | undefined;
  return row ?? null;
}
