import { randomUUID } from 'node:crypto';
import { db } from './db';
import { CommandError } from './eventStore';
import { getTaskWorkspaceId } from './task';
import { emitMentionNotifications, deleteNotificationsByComment } from './notification';

// Comment 不走 Event Sourcing（DESIGN 指定）：傳統 CRUD 直接讀寫 comments。
// 權限分兩層，都在 server 層做：workspace 角色（requirePermission）+ ownership（只能改/刪自己的留言）。

function validateContent(content: unknown): string {
  if (typeof content !== 'string') throw new CommandError('content 必須是字串');
  const t = content.trim();
  if (!t) throw new CommandError('content 不可為空');
  if (t.length > 5000) throw new CommandError('content 過長（上限 5000 字）');
  return t;
}

export interface CommentRow {
  comment_id: string;
  task_id: string;
  user_id: string;
  content: string;
  created_at: string;
}

export function createComment(taskId: string, userId: string, content: unknown, database = db): string {
  if (getTaskWorkspaceId(taskId, database) === null) throw new CommandError('task 不存在'); // 不對孤兒 task 留言
  const clean = validateContent(content);
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare('INSERT INTO comments (comment_id, task_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)').run(id, taskId, userId, clean, now);
  try {
    emitMentionNotifications(userId, taskId, id, clean, database);
  } catch (e) {
    database.prepare('DELETE FROM comments WHERE comment_id = ?').run(id);
    throw e;
  }
  return id;
}

export function listComments(taskId: string, database = db): CommentRow[] {
  return database
    .prepare('SELECT comment_id, task_id, user_id, content, created_at FROM comments WHERE task_id = ? ORDER BY rowid')
    .all(taskId) as unknown as CommentRow[];
}

export function updateComment(commentId: string, content: unknown, database = db): void {
  const clean = validateContent(content);
  const info = database.prepare('UPDATE comments SET content = ? WHERE comment_id = ?').run(clean, commentId);
  if (info.changes === 0) throw new CommandError('comment 不存在');
}

export function deleteComment(commentId: string, database = db): void {
  const info = database.prepare('DELETE FROM comments WHERE comment_id = ?').run(commentId);
  if (info.changes === 0) throw new CommandError('comment 不存在');
  deleteNotificationsByComment(commentId, database);
}

// PATCH / DELETE 用：一次拿到 workspace（權限）與 author（ownership）。
// JOIN task read model 取 workspace_id；task 已被刪則查不到 → null → 404。
export interface CommentContext {
  comment_id: string;
  task_id: string;
  user_id: string;
  workspace_id: string;
}
export function getCommentContext(commentId: string, database = db): CommentContext | null {
  const row = database
    .prepare(
      `SELECT c.comment_id, c.task_id, c.user_id, t.workspace_id
         FROM comments c JOIN tasks_read_model t ON t.task_id = c.task_id
        WHERE c.comment_id = ?`,
    )
    .get(commentId) as CommentContext | undefined;
  return row ?? null;
}
