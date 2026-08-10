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

export type NotificationFilter = 'all' | 'unread' | 'read';

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

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

export function deleteNotificationsByTask(taskId: string, database = db): void {
  database.prepare('DELETE FROM notifications_read_model WHERE source_task_id = ?').run(taskId);
}

export function listNotifications(
  userId: string,
  database = db,
  filterRaw: string | null = 'all',
  now = new Date(),
): NotificationRow[] {
  const filter = parseNotificationFilter(filterRaw);
  const cutoff = readCutoff(now);
  const visibilityParams = filter === 'unread' ? [] : [cutoff];
  return database
    .prepare(
      `SELECT notification_id, recipient_id, source_task_id, source_comment_id, snippet, created_at, read_at
         FROM notifications_read_model
        WHERE recipient_id = ? AND ${filterClause(filter)}
        ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END, created_at DESC, notification_id DESC`,
    )
    .all(userId, ...visibilityParams) as unknown as NotificationRow[];
}

export interface NotificationPage {
  items: NotificationRow[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  unreadTotal: number;
}

const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1_000_000;

function parseNotificationFilter(raw: string | null | undefined): NotificationFilter {
  const value = raw ?? 'all';
  if (value === 'all' || value === 'unread' || value === 'read') return value;
  throw new CommandError('filter 參數不合法');
}

function filterClause(filter: NotificationFilter): string {
  if (filter === 'unread') return 'read_at IS NULL';
  if (filter === 'read') return 'read_at IS NOT NULL AND read_at > ?';
  return '(read_at IS NULL OR read_at > ?)';
}

function readCutoff(now: Date): string {
  return new Date(now.getTime() - TEN_DAYS_MS).toISOString();
}

function parsePositiveInt(raw: string, max: number, label: string): number {
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > max) {
    throw new CommandError(`${label} 參數不合法`);
  }
  return Number(raw);
}

// opt-in 分頁：page 必填、pageSize 選填（預設 15）。排序固定 created_at DESC、
// notification_id DESC 作穩定次排序，與 listNotifications() 的「未讀優先」排序刻意不同，
// 避免標記已讀把項目移到清單後段導致分頁跳動。
export function listNotificationsPage(
  userId: string,
  pageRaw: string,
  pageSizeRaw: string | null,
  database = db,
  filterRaw: string | null = 'all',
  now = new Date(),
): NotificationPage {
  const filter = parseNotificationFilter(filterRaw);
  const pageSize = pageSizeRaw === null ? DEFAULT_PAGE_SIZE : parsePositiveInt(pageSizeRaw, MAX_PAGE_SIZE, 'pageSize');
  const page = parsePositiveInt(pageRaw, MAX_PAGE, 'page');
  const cutoff = readCutoff(now);
  const where = filterClause(filter);
  const visibilityParams = filter === 'unread' ? [] : [cutoff];

  const totalCount = (
    database
      .prepare(`SELECT COUNT(*) AS c FROM notifications_read_model WHERE recipient_id = ? AND ${where}`)
      .get(userId, ...visibilityParams) as { c: number }
  ).c;
  const unreadTotal = (
    database
      .prepare('SELECT COUNT(*) AS c FROM notifications_read_model WHERE recipient_id = ? AND read_at IS NULL')
      .get(userId) as { c: number }
  ).c;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  if (page > totalPages) throw new CommandError('page 超出範圍');

  const items = database
    .prepare(
      `SELECT notification_id, recipient_id, source_task_id, source_comment_id, snippet, created_at, read_at
         FROM notifications_read_model
        WHERE recipient_id = ? AND ${where}
        ORDER BY created_at DESC, notification_id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(userId, ...visibilityParams, pageSize, (page - 1) * pageSize) as unknown as NotificationRow[];

  return { items, page, pageSize, totalCount, totalPages, unreadTotal };
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
