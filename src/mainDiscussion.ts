import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { CommandError } from './eventStore';
import {
  CONCLUSION_MARKER,
  handoffLine,
  LEGACY_FIXED_REPLY_WINDOW_MARKER,
  LONGER_WINDOW_REASON_FIELD,
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_TITLE,
  MAIN_WORKSPACE_ID,
  NO_CONSENSUS_FIELDS,
  NO_CONSENSUS_MARKER,
  NO_IMPLEMENTATION_MARKER,
  REPLY_WINDOW_MAX_DAYS,
  REPLY_WINDOW_MIN_DAYS,
  REQUIRED_THOUGHT_FIELDS,
  replyWindowMarker,
  THOUGHT_MARKER,
} from './mainWorkspacePolicy';

const HALF_DAY_MS = 12 * 60 * 60 * 1000;
const WINDOW_RANGE_ERROR = `全員回覆期限必須是 ${REPLY_WINDOW_MIN_DAYS} 到 ${REPLY_WINDOW_MAX_DAYS} 天，並以 0.5 天遞增`;

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

const THOUGHT_MARKER_RE = new RegExp(`^${THOUGHT_MARKER}(?:\\r?\\n|$)`, 'u');

function isStructuredOwnerThought(content: string): boolean {
  if (!THOUGHT_MARKER_RE.test(content)) return false;
  return missingOwnerThoughtFields(content).length === 0;
}

export function missingOwnerThoughtFields(content: string): readonly string[] {
  if (!THOUGHT_MARKER_RE.test(content)) return REQUIRED_THOUGHT_FIELDS;
  return REQUIRED_THOUGHT_FIELDS.filter((label) => lineValue(content, label) === null);
}

const LEGACY_FIXED_REQUEST_MARKER = new RegExp(`^${LEGACY_FIXED_REPLY_WINDOW_MARKER}(?:\\r?\\n|$)`, 'u');
const REQUEST_MARKER = new RegExp(`^${replyWindowMarker('(\\d+(?:\\.5)?)')}(?:\\r?\\n|$)`, 'u');

export function parseNewWaitHalfDays(content: string): number | null {
  if (LEGACY_FIXED_REQUEST_MARKER.test(content)) throw new CommandError(WINDOW_RANGE_ERROR);
  return parseWaitHalfDays(content);
}

function parseWaitHalfDays(content: string): number | null {
  const match = content.match(REQUEST_MARKER);
  if (!match) return null;

  const waitHalfDays = Number(match[1]) * 2;
  const minHalfDays = REPLY_WINDOW_MIN_DAYS * 2;
  const maxHalfDays = REPLY_WINDOW_MAX_DAYS * 2;
  if (!Number.isInteger(waitHalfDays) || waitHalfDays < minHalfDays || waitHalfDays > maxHalfDays) {
    throw new CommandError(WINDOW_RANGE_ERROR);
  }
  if (waitHalfDays > minHalfDays && lineValue(content, LONGER_WINDOW_REASON_FIELD) === null) {
    throw new CommandError(`超過 ${REPLY_WINDOW_MIN_DAYS} 天必須填寫${LONGER_WINDOW_REASON_FIELD}`);
  }
  return waitHalfDays;
}

// 既有 24 小時窗口收尾時仍可驗證，避免改寫歷史留言；新窗口一律使用 N 天 marker。
function parseStoredWaitHalfDays(content: string): number | null {
  if (LEGACY_FIXED_REQUEST_MARKER.test(content)) return 2;
  return parseWaitHalfDays(content);
}

export function recordMainDiscussionWindowForComment(
  input: RecordMainDiscussionCommentInput,
  database = db,
): MainDiscussionWindow | null {
  const waitHalfDays = parseNewWaitHalfDays(input.content);
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
  if (!thought) {
    const incompleteThought = prior.find((row) => row.user_id === owner.id && THOUGHT_MARKER_RE.test(row.content));
    if (incompleteThought) {
      throw new CommandError(`全員通知前必須先留下完整的 OWNER想法，缺少：${missingOwnerThoughtFields(incompleteThought.content).join('、')}`);
    }
    throw new CommandError('全員通知前必須先留下完整的 OWNER想法');
  }

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

export type MainDiscussionOutcome = 'implement' | 'no_implementation' | 'no_consensus';

export interface MainDiscussionImplementationTask {
  workspaceName: string;
  taskName: string;
}

export interface MainDiscussionConcludedPayload {
  status: 'Done';
  outcome: MainDiscussionOutcome;
  windowOpenedAt: string;
  windowDueAt: string;
  ownerThoughtCommentId: string;
  requestCommentId: string;
  decisionCommentId: string;
  confirmationCommentId: null;
  handoffCommentId: string | null;
  implementationWorkspaceName: string | null;
  implementationTaskName: string | null;
  implementationTasks: MainDiscussionImplementationTask[];
}

interface OrderedComment {
  rowid: number;
  comment_id: string;
  user_id: string;
  content: string;
  created_at: string;
}

interface MainTaskContext {
  workspace_id: string;
  title: string;
}

function getMainOwnerId(database: DatabaseSync): string | null {
  const row = database.prepare(
    `SELECT u.id
       FROM users u
       JOIN workspace_members_read_model m ON m.user_id = u.id
      WHERE u.email = ? AND m.workspace_id = ? AND m.role = 'Owner'`,
  ).get(MAIN_OWNER_EMAIL, MAIN_WORKSPACE_ID) as { id: string } | undefined;
  return row?.id ?? null;
}

function isMarker(content: string, marker: string): boolean {
  return content.startsWith(marker);
}

export function parseDecision(content: string): MainDiscussionOutcome | null {
  if (isMarker(content, NO_CONSENSUS_MARKER)) {
    if (NO_CONSENSUS_FIELDS.every((field) => lineValue(content, field) !== null)) return 'no_consensus';
    return null;
  }
  if (isMarker(content, NO_IMPLEMENTATION_MARKER)) return 'no_implementation';
  if (isMarker(content, CONCLUSION_MARKER)) return 'implement';
  return null;
}

const HANDOFF_RE = new RegExp(`^${handoffLine('(.+?)', '(.+?)')}\\s*$`, 'u');

export function parseImplementationHandoff(content: string): {
  workspaceName: string;
  taskName: string;
} | null {
  const match = content.match(HANDOFF_RE);
  if (!match) return null;
  const workspaceName = match[1].trim();
  const taskName = match[2].trim();
  if (!workspaceName || !taskName || /https?:\/\//iu.test(content)) return null;
  return { workspaceName, taskName };
}

function loadOrderedComments(taskId: string, database: DatabaseSync): OrderedComment[] {
  return database.prepare(
    `SELECT rowid, comment_id, user_id, content, created_at
       FROM comments
      WHERE task_id = ?
      ORDER BY rowid`,
  ).all(taskId) as unknown as OrderedComment[];
}

export function resolveMainDiscussionConclusion(
  taskId: string,
  actorId: string,
  now: Date,
  database = db,
): MainDiscussionConcludedPayload {
  const task = database.prepare(
    'SELECT workspace_id, title FROM tasks_read_model WHERE task_id = ?',
  ).get(taskId) as MainTaskContext | undefined;
  if (!task || task.workspace_id !== MAIN_WORKSPACE_ID || task.title === MAIN_POLICY_TITLE) {
    throw new CommandError('不是可收尾的主工作區討論');
  }

  const ownerId = getMainOwnerId(database);
  if (!ownerId || actorId !== ownerId) throw new CommandError('只有 user01 可以收尾主工作區討論');

  const window = getMainDiscussionWindow(taskId, database);
  if (!window) throw new CommandError('主工作區討論尚未開啟回覆窗口');

  const dueMs = Date.parse(window.dueAt);
  const nowMs = now.getTime();
  if (Number.isNaN(dueMs) || Number.isNaN(nowMs)) throw new CommandError('討論窗口時間不合法');
  if (nowMs < dueMs) throw new CommandError(`討論期限尚未到達：${window.dueAt}`);

  const comments = loadOrderedComments(taskId, database);
  const thought = comments.find((comment) => comment.comment_id === window.ownerThoughtCommentId);
  const request = comments.find((comment) => comment.comment_id === window.requestCommentId);
  if (!thought || thought.user_id !== ownerId || !isStructuredOwnerThought(thought.content)) {
    throw new CommandError('收尾前必須保留完整的 OWNER想法');
  }
  if (!request || request.user_id !== ownerId || parseStoredWaitHalfDays(request.content) !== window.waitHalfDays) {
    throw new CommandError('收尾前必須保留合法的全員回覆通知');
  }

  const laterComments = comments.filter((comment) => comment.rowid > request.rowid);
  const decisions = laterComments
    .filter((comment) => comment.user_id === ownerId)
    .map((comment) => ({ comment, outcome: parseDecision(comment.content) }))
    .filter((entry): entry is { comment: OrderedComment; outcome: MainDiscussionOutcome } => entry.outcome !== null);
  const latestDecision = decisions.at(-1);
  if (!latestDecision) {
    throw new CommandError(`尚未留下合法的主工作區結論；實作請依序留下「${CONCLUSION_MARKER}」→「${handoffLine('...', '...')}」`);
  }

  if (latestDecision.outcome === 'no_consensus') {
    return {
      status: 'Done',
      outcome: latestDecision.outcome,
      windowOpenedAt: window.openedAt,
      windowDueAt: window.dueAt,
      ownerThoughtCommentId: window.ownerThoughtCommentId,
      requestCommentId: window.requestCommentId,
      decisionCommentId: latestDecision.comment.comment_id,
      confirmationCommentId: null,
      handoffCommentId: null,
      implementationWorkspaceName: null,
      implementationTaskName: null,
      implementationTasks: [],
    };
  }

  if (latestDecision.outcome === 'no_implementation') {
    return {
      status: 'Done',
      outcome: latestDecision.outcome,
      windowOpenedAt: window.openedAt,
      windowDueAt: window.dueAt,
      ownerThoughtCommentId: window.ownerThoughtCommentId,
      requestCommentId: window.requestCommentId,
      decisionCommentId: latestDecision.comment.comment_id,
      confirmationCommentId: null,
      handoffCommentId: null,
      implementationWorkspaceName: null,
      implementationTaskName: null,
      implementationTasks: [],
    };
  }

  const handoffs = laterComments
    .filter((comment) => comment.rowid > latestDecision.comment.rowid && comment.user_id === ownerId)
    .map((comment) => ({ comment, handoff: parseImplementationHandoff(comment.content) }))
    .filter((entry): entry is { comment: OrderedComment; handoff: MainDiscussionImplementationTask } => entry.handoff !== null);
  const firstHandoff = handoffs[0];
  if (!firstHandoff) throw new CommandError('尚未留下合法的實作任務交接');

  return {
    status: 'Done',
    outcome: latestDecision.outcome,
    windowOpenedAt: window.openedAt,
    windowDueAt: window.dueAt,
    ownerThoughtCommentId: window.ownerThoughtCommentId,
    requestCommentId: window.requestCommentId,
    decisionCommentId: latestDecision.comment.comment_id,
    confirmationCommentId: null,
    handoffCommentId: firstHandoff.comment.comment_id,
    implementationWorkspaceName: firstHandoff.handoff.workspaceName,
    implementationTaskName: firstHandoff.handoff.taskName,
    implementationTasks: handoffs.map((entry) => entry.handoff),
  };
}
