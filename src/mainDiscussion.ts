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
