import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { CommandError } from './eventStore';
import {
  AGREE_MARKER,
  CONCLUSION_MARKER,
  handoffLine,
  MAIN_BOSS_EMAIL,
  MAIN_DISCUSSION_WAIT_DAYS,
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_TITLE,
  MAIN_WORKSPACE_ID,
  NO_CONSENSUS_FIELDS,
  NO_CONSENSUS_MARKER,
  NO_IMPLEMENTATION_MARKER,
  REQUIRED_THOUGHT_FIELDS,
  THOUGHT_MARKER,
} from './mainWorkspacePolicy';

const MAIN_DISCUSSION_WAIT_MS = MAIN_DISCUSSION_WAIT_DAYS * 24 * 60 * 60 * 1000;

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

export type MainDiscussionOutcome = 'implement' | 'no_implementation' | 'no_consensus';

export interface MainDiscussionImplementationTask {
  workspaceName: string;
  taskName: string;
}

export interface MainDiscussionConcludedPayload {
  status: 'Done';
  outcome: MainDiscussionOutcome;
  ownerThoughtCommentId: string;
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

// 老闆固定為主工作區 Admin，但查詢不硬綁角色，投票資格仍由 getEligibleVoterIds 統一判斷。
function getMainBossId(database: DatabaseSync): string | null {
  const row = database.prepare(
    `SELECT u.id
       FROM users u
       JOIN workspace_members_read_model m ON m.user_id = u.id
      WHERE u.email = ? AND m.workspace_id = ?`,
  ).get(MAIN_BOSS_EMAIL, MAIN_WORKSPACE_ID) as { id: string } | undefined;
  return row?.id ?? null;
}

function getEligibleVoterIds(database: DatabaseSync): ReadonlySet<string> {
  return new Set(
    (database.prepare(
      `SELECT user_id
         FROM workspace_members_read_model
        WHERE workspace_id = ? AND role IN ('Commenter', 'Admin')`,
    ).all(MAIN_WORKSPACE_ID) as { user_id: string }[]).map((row) => row.user_id),
  );
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
  database = db,
  now = new Date(),
): MainDiscussionConcludedPayload {
  const task = database.prepare(
    'SELECT workspace_id, title FROM tasks_read_model WHERE task_id = ?',
  ).get(taskId) as MainTaskContext | undefined;
  if (!task || task.workspace_id !== MAIN_WORKSPACE_ID || task.title === MAIN_POLICY_TITLE) {
    throw new CommandError('不是可收尾的主工作區討論');
  }

  const ownerId = getMainOwnerId(database);
  if (!ownerId || actorId !== ownerId) throw new CommandError('只有 user01 可以收尾主工作區討論');

  const comments = loadOrderedComments(taskId, database);
  const thought = comments
    .filter((comment) => comment.user_id === ownerId && isStructuredOwnerThought(comment.content))
    .at(-1);
  if (!thought) throw new CommandError('收尾前必須留下完整的 OWNER想法');

  const laterComments = comments.filter((comment) => comment.rowid > thought.rowid);
  const decisions = laterComments
    .filter((comment) => comment.user_id === ownerId)
    .map((comment) => ({ comment, outcome: parseDecision(comment.content) }))
    .filter((entry): entry is { comment: OrderedComment; outcome: MainDiscussionOutcome } => entry.outcome !== null);
  const latestDecision = decisions.at(-1);
  if (!latestDecision) {
    throw new CommandError(`尚未留下合法的主工作區結論；實作請依序留下「${CONCLUSION_MARKER}」→「${handoffLine('...', '...')}」`);
  }

  const deadlineAt = Date.parse(thought.created_at) + MAIN_DISCUSSION_WAIT_MS;
  const eligibleVoterIds = getEligibleVoterIds(database);
  const agreeingVoterIds = new Set(
    laterComments
      .filter((comment) => eligibleVoterIds.has(comment.user_id) && isMarker(comment.content, AGREE_MARKER))
      .map((comment) => comment.user_id),
  );
  const bossId = getMainBossId(database);
  const hasEarlyConsensus = bossId !== null && agreeingVoterIds.has(bossId) && agreeingVoterIds.size >= 4;
  if (!Number.isFinite(deadlineAt) || (now.getTime() < deadlineAt && !hasEarlyConsensus)) {
    throw new CommandError(`主工作區討論尚未達成四位不同成員的「${AGREE_MARKER}」（須含 ${MAIN_BOSS_EMAIL}），請等待固定 ${MAIN_DISCUSSION_WAIT_DAYS} 天期限到達`);
  }

  const base = {
    status: 'Done',
    outcome: latestDecision.outcome,
    ownerThoughtCommentId: thought.comment_id,
    decisionCommentId: latestDecision.comment.comment_id,
    confirmationCommentId: null,
  } as const;

  if (latestDecision.outcome !== 'implement') {
    return {
      ...base,
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
    ...base,
    handoffCommentId: firstHandoff.comment.comment_id,
    implementationWorkspaceName: firstHandoff.handoff.workspaceName,
    implementationTaskName: firstHandoff.handoff.taskName,
    implementationTasks: handoffs.map((entry) => entry.handoff),
  };
}
