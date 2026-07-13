import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import {
  appendEvent,
  appendEventInTransaction,
  loadEvents,
  registerProjection,
  CommandError,
  type StoredEvent,
} from './eventStore';
import { buildMetadata as meta } from './requestContext';

export interface NotificationRow {
  notification_id: string;
  recipient_id: string;
  source_task_id: string;
  source_comment_id: string;
  snippet: string;
  created_at: string;
  read_at: string | null;
}

function trimHandleToken(token: string): string {
  return token.replace(/[.,，。！？!?;；:：)\]}>`"'”’]+$/u, '').trim();
}

function extractHandles(content: string): string[] {
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const match of content.match(/@([^\s@]+)/g) ?? []) {
    const handle = trimHandleToken(match.slice(1));
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    handles.push(handle);
  }
  return handles;
}

function resolveUserId(handle: string, database: DatabaseSync): string | null {
  const row = database
    .prepare(
      `SELECT id
         FROM users
        WHERE lower(name) = lower(?)
           OR lower(substr(email, 1, instr(email, '@') - 1)) = lower(?)
        ORDER BY email
        LIMIT 1`,
    )
    .get(handle, handle) as { id: string } | undefined;
  return row?.id ?? null;
}

function snippet(content: string): string {
  return content.length > 120 ? content.slice(0, 120) : content;
}

export function emitMentionNotifications(
  actorId: string,
  taskId: string,
  commentId: string,
  content: string,
  database = db,
): void {
  const handleIds = extractHandles(content)
    .map((handle) => resolveUserId(handle, database))
    .filter((userId): userId is string => Boolean(userId) && userId !== actorId);
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
}

export function registerNotificationProjections(): void {
  registerProjection('notification.created', (e, database) => {
    const p = e.payload as {
      recipientId: string;
      sourceTaskId: string;
      sourceCommentId: string;
      snippet: string;
    };
    database
      .prepare(
        `INSERT INTO notifications_read_model
           (notification_id, recipient_id, source_task_id, source_comment_id, snippet, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.aggregate_id, p.recipientId, p.sourceTaskId, p.sourceCommentId, p.snippet, e.occurred_at, null);
  });
  registerProjection('notification.read', (e, database) => {
    const p = e.payload as { readAt: string };
    database
      .prepare('UPDATE notifications_read_model SET read_at = ? WHERE notification_id = ?')
      .run(p.readAt, e.aggregate_id);
  });
}

export function deleteNotificationsByComment(commentId: string, database = db): void {
  database.prepare('DELETE FROM notifications_read_model WHERE source_comment_id = ?').run(commentId);
}

export function deleteNotificationsByTask(taskId: string, database = db): void {
  database.prepare('DELETE FROM notifications_read_model WHERE source_task_id = ?').run(taskId);
}

export function listNotifications(userId: string, database = db): NotificationRow[] {
  return database
    .prepare(
      `SELECT notification_id, recipient_id, source_task_id, source_comment_id, snippet, created_at, read_at
         FROM notifications_read_model
        WHERE recipient_id = ?
        ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END, created_at DESC, notification_id DESC`,
    )
    .all(userId) as unknown as NotificationRow[];
}

export function getNotification(notificationId: string, userId: string, database = db): NotificationRow | null {
  const row = database
    .prepare(
      `SELECT notification_id, recipient_id, source_task_id, source_comment_id, snippet, created_at, read_at
         FROM notifications_read_model
        WHERE notification_id = ? AND recipient_id = ?`,
    )
    .get(notificationId, userId) as NotificationRow | undefined;
  return row ?? null;
}

export function markNotificationRead(actorId: string, notificationId: string, database = db): void {
  const row = getNotification(notificationId, actorId, database);
  if (!row) throw new CommandError('notification 不存在');
  if (row.read_at) return;
  const events = loadEvents(notificationId, database);
  appendEvent('Notification', notificationId, events.length, 'notification.read', { readAt: new Date().toISOString() }, meta(actorId), database);
}
