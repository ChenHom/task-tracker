import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import {
  appendEvent,
  appendEventInTransaction,
  CommandError,
  ConflictError,
  loadEvents,
  registerProjection,
  type StoredEvent,
} from './eventStore';
import { getProject, requireActiveProject } from './project';
import { buildMetadata as meta } from './requestContext';
import { getUserIdByEmail } from './auth';
import { MAIN_OWNER_EMAIL } from './mainWorkspacePolicy';
import { archiveTask } from './task';
import { getAgent } from './agent';
import { getMemberRole, hasPermission } from './member';
import { loadRepoRegistry, type RepoRegistry } from './repoRegistry';
import { notifyWorkspaceHumanAdmins } from './notification';

export type GoalSource = 'human' | 'owner_discovery' | 'followup';
export type GoalStatus = 'Queued' | 'Discussing' | 'Executing' | 'Verifying' | 'Paused' | 'Blocked' | 'Done' | 'Cancelled';
export type DiscussionPhase = 'owner_scoping' | 'round_1' | 'round_2' | 'awaiting_lease' | 'owner_synthesis';

export interface CreateGoalInput {
  workspaceId: string;
  projectId: unknown;
  parentGoalId?: unknown;
  source?: unknown;
  objective?: unknown;
  successCriteria?: unknown;
  dataScope?: unknown;
  ownerAgentId?: unknown;
}

export interface GoalRow {
  goal_id: string;
  workspace_id: string;
  project_id: string;
  parent_goal_id: string | null;
  source: GoalSource;
  objective: string;
  success_criteria: string;
  data_scope: string;
  status: GoalStatus;
  discussion_phase: DiscussionPhase | null;
  revision: number;
  created_by: string;
  owner_agent_id: string;
  paused_from_status: GoalStatus | null;
  paused_from_phase: DiscussionPhase | null;
  blocked_from_status: GoalStatus | null;
  blocked_from_phase: DiscussionPhase | null;
  pause_requested: number;
  evidence_refs_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface GoalState {
  exists: boolean;
  status: GoalStatus;
  phase: DiscussionPhase | null;
  revision: number;
  pausedFromStatus: GoalStatus | null;
  pausedFromPhase: DiscussionPhase | null;
  preemptedFromStatus: GoalStatus | null;
  preemptedFromPhase: DiscussionPhase | null;
  blockedFromStatus: GoalStatus | null;
  blockedFromPhase: DiscussionPhase | null;
  pauseRequested: boolean;
}

const INITIAL: GoalState = {
  exists: false,
  status: 'Queued',
  phase: null,
  revision: 0,
  pausedFromStatus: null,
  pausedFromPhase: null,
  preemptedFromStatus: null,
  preemptedFromPhase: null,
  blockedFromStatus: null,
  blockedFromPhase: null,
  pauseRequested: false,
};

const TERMINAL = new Set<GoalStatus>(['Done', 'Cancelled']);

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new CommandError(`${field} 必須是字串`);
  const clean = value.trim();
  if (!clean) throw new CommandError(`${field} 不可為空`);
  if (clean.length > max) throw new CommandError(`${field} 過長（上限 ${max} 字）`);
  return clean;
}

function optionalId(value: unknown, field: string): string | null {
  if (value == null) return null;
  return requiredText(value, field, 200);
}

function parseSource(value: unknown): GoalSource {
  const source = value ?? 'human';
  if (source !== 'human' && source !== 'owner_discovery' && source !== 'followup') {
    throw new CommandError('Goal source 不合法');
  }
  return source;
}

function requireCoordinatorOwnerAgent(ownerAgentId: string, workspaceId: string, database: DatabaseSync): void {
  const ownerAgent = getAgent(ownerAgentId, database);
  if (ownerAgent?.role !== 'owner') throw new CommandError('ownerAgentId 必須是 Owner Agent');
  const workspaceRole = getMemberRole(workspaceId, ownerAgent.user_id, database);
  if (!workspaceRole || !hasPermission(workspaceRole, 'Admin')) {
    throw new CommandError('Owner Agent 不是此 Workspace 的 Admin，coordinator 無法處理');
  }
}

function reduce(state: GoalState, event: StoredEvent): GoalState {
  const payload = event.payload as Record<string, unknown>;
  switch (event.event_type) {
    case 'goal.created':
      return { ...INITIAL, exists: true, revision: 1 };
    case 'goal.discussion_started':
      return { ...state, status: 'Discussing', phase: 'owner_scoping' };
    case 'goal.discussion_phase_changed':
      return { ...state, phase: payload.phase as DiscussionPhase };
    case 'goal.lease_acquired':
      return { ...state, status: 'Discussing', phase: 'owner_synthesis' };
    case 'goal.execution_started':
      return { ...state, status: 'Executing', phase: null };
    case 'goal.verification_started':
      return { ...state, status: 'Verifying', phase: null };
    case 'goal.completed':
      return { ...state, status: 'Done', phase: null, pauseRequested: false };
    case 'goal.paused':
      return {
        ...state,
        status: 'Paused',
        phase: null,
        pausedFromStatus: payload.fromStatus as GoalStatus,
        pausedFromPhase: (payload.fromPhase as DiscussionPhase | null) ?? null,
        pauseRequested: false,
      };
    case 'goal.pause_requested':
      return { ...state, pauseRequested: true };
    case 'goal.resumed':
      return {
        ...state,
        status: payload.status as GoalStatus,
        phase: (payload.phase as DiscussionPhase | null) ?? null,
        revision: Number(payload.revision),
        pausedFromStatus: null,
        pausedFromPhase: null,
        blockedFromStatus: null,
        blockedFromPhase: null,
      };
    case 'goal.blocked':
      return {
        ...state,
        status: 'Blocked',
        phase: null,
        blockedFromStatus: payload.fromStatus as GoalStatus,
        blockedFromPhase: (payload.fromPhase as DiscussionPhase | null) ?? null,
        pauseRequested: false,
      };
    case 'goal.cancelled':
      return { ...state, status: 'Cancelled', phase: null, pauseRequested: false };
    case 'goal.revised':
      return {
        ...state,
        status: payload.status as GoalStatus,
        phase: (payload.phase as DiscussionPhase | null) ?? null,
        revision: Number(payload.revision),
      };
    case 'goal.discussion_reconciled':
      return { ...state, status: 'Discussing', phase: 'owner_scoping', revision: Number(payload.revision) };
    case 'goal.preempted':
      return {
        ...state,
        status: 'Queued',
        phase: null,
        preemptedFromStatus: payload.fromStatus as GoalStatus,
        preemptedFromPhase: (payload.fromPhase as DiscussionPhase | null) ?? null,
        pauseRequested: false,
      };
    case 'goal.preemption_released':
      return {
        ...state,
        status: state.preemptedFromStatus ?? state.status,
        phase: state.preemptedFromPhase,
        preemptedFromStatus: null,
        preemptedFromPhase: null,
        pauseRequested: false,
      };
    default:
      return state;
  }
}

function load(goalId: string, database: DatabaseSync): { state: GoalState; version: number } {
  const events = loadEvents(goalId, database);
  return {
    state: events.reduce(reduce, INITIAL),
    version: events.at(-1)?.aggregate_version ?? 0,
  };
}

function requireGoal(goalId: string, database: DatabaseSync): { row: GoalRow; state: GoalState; version: number } {
  const row = getGoal(goalId, database);
  const loaded = load(goalId, database);
  if (!row || !loaded.state.exists) throw new CommandError('goal 不存在');
  return { row, ...loaded };
}

function requireActive(state: GoalState): void {
  if (TERMINAL.has(state.status)) throw new CommandError(`goal 狀態 ${state.status} 不可再修改`);
}

function withTransaction<T>(database: DatabaseSync, action: () => T): T {
  if (database.isTransaction) return action();
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function hasLease(goalId: string, database: DatabaseSync): boolean {
  return Boolean(database.prepare('SELECT 1 FROM repo_leases WHERE goal_id = ?').get(goalId));
}

function skipPendingGoalHeartbeats(goalId: string, database: DatabaseSync): void {
  database.prepare("UPDATE goal_heartbeats SET status = 'skipped', updated_at = ? WHERE goal_id = ? AND status = 'pending'")
    .run(new Date().toISOString(), goalId);
}

function resumePreemptedGoals(humanGoalId: string, database: DatabaseSync): void {
  const rows = database.prepare(
    'SELECT autonomous_goal_id FROM goal_preemptions WHERE human_goal_id = ? AND resumed_at IS NULL',
  ).all(humanGoalId) as unknown as Array<{ autonomous_goal_id: string }>;
  for (const row of rows) {
    const goal = getGoal(row.autonomous_goal_id, database);
    if (!goal || goal.status === 'Done' || goal.status === 'Cancelled' || goal.status === 'Blocked') continue;
    if (goal.status === 'Paused') {
      resumeGoal(goal.owner_agent_id, goal.goal_id, undefined, database);
    } else if (goal.status === 'Queued') {
      releaseGoalPreemption(goal.owner_agent_id, goal.goal_id, database);
    } else if (goal.pause_requested) {
      appendEventInTransaction('Goal', goal.goal_id, goal.version, 'goal.preemption_released', {}, meta(goal.owner_agent_id), database);
    }
    database.prepare('UPDATE goal_preemptions SET resumed_at = ? WHERE human_goal_id = ? AND autonomous_goal_id = ?')
      .run(new Date().toISOString(), humanGoalId, goal.goal_id);
  }
}

function releaseGoalPreemption(actorId: string, goalId: string, database = db): boolean {
  const { state, version } = requireGoal(goalId, database);
  if (state.status !== 'Queued' || !state.preemptedFromStatus) return false;
  appendEventInTransaction('Goal', goalId, version, 'goal.preemption_released', {
    status: state.preemptedFromStatus, phase: state.preemptedFromPhase,
  }, meta(actorId), database);
  const restored = getGoal(goalId, database)!;
  enqueueTransitionHeartbeat(goalId, database);
  const pending = database.prepare(
    "SELECT 1 FROM goal_heartbeats WHERE goal_id = ? AND status = 'pending' AND phase IN ('owner_scoping','round_1','round_2','owner_synthesis') LIMIT 1",
  ).get(goalId);
  if (!pending) {
    const phase = restored.status === 'Queued' ? 'owner_scoping'
      : restored.discussion_phase === 'awaiting_lease' ? 'owner_synthesis' : restored.discussion_phase;
    if (phase) database.prepare(
      `INSERT INTO goal_heartbeats
         (heartbeat_id, scope_id, goal_id, phase, agent_id, revision, trigger_ref, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(randomUUID(), goalId, goalId, phase, restored.owner_agent_id, restored.revision, `preemption:${version}`, new Date().toISOString(), new Date().toISOString());
  }
  return true;
}

function enqueueGoalHeartbeat(goal: GoalRow, phase: string, database: DatabaseSync, agentId = goal.owner_agent_id): void {
  const now = new Date().toISOString();
  const restored = database.prepare(
    `UPDATE goal_heartbeats SET status = 'pending', updated_at = ?
      WHERE heartbeat_id = (SELECT heartbeat_id FROM goal_heartbeats
        WHERE goal_id = ? AND phase = ? AND agent_id = ? AND revision = ? AND trigger_ref = 'phase' AND status = 'skipped'
        ORDER BY rowid DESC LIMIT 1)`,
  ).run(now, goal.goal_id, phase, agentId, goal.revision);
  if (restored.changes) return;
  database.prepare(
    `INSERT OR IGNORE INTO goal_heartbeats
       (heartbeat_id, scope_id, goal_id, phase, agent_id, revision, trigger_ref, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'phase', 'pending', ?, ?)`,
  ).run(randomUUID(), goal.goal_id, goal.goal_id, phase, agentId, goal.revision, now, now);
}

function enqueueTransitionHeartbeat(goalId: string, database: DatabaseSync): void {
  const goal = getGoal(goalId, database);
  if (!goal) return;
  if (goal.status === 'Queued') return enqueueGoalHeartbeat(goal, 'owner_scoping', database);
  if (goal.status === 'Discussing') {
    if (goal.discussion_phase === 'owner_scoping') return enqueueGoalHeartbeat(goal, 'owner_scoping', database);
    if (goal.discussion_phase === 'awaiting_lease' || goal.discussion_phase === 'owner_synthesis') {
      return enqueueGoalHeartbeat(goal, 'owner_synthesis', database);
    }
    if (goal.discussion_phase === 'round_1' || goal.discussion_phase === 'round_2') {
      const pending = database.prepare(
        'SELECT 1 FROM goal_heartbeats WHERE goal_id = ? AND phase = ? AND revision = ? AND status = ? LIMIT 1',
      ).get(goalId, goal.discussion_phase, goal.revision, 'pending');
      if (!pending) enqueueGoalHeartbeat(goal, goal.discussion_phase, database);
    }
    return;
  }
  if (goal.status === 'Verifying') return enqueueGoalHeartbeat(goal, 'verifying', database);
  if (goal.status === 'Executing' && !database.prepare(
    "SELECT 1 FROM tasks_read_model WHERE goal_id = ? AND status NOT IN ('Done', 'Archived') LIMIT 1",
  ).get(goalId)) enqueueGoalHeartbeat(goal, 'verifying', database);
}

export function createGoal(actorId: string, input: CreateGoalInput, database = db, repos: RepoRegistry = loadRepoRegistry()): string {
  const workspaceId = requiredText(input.workspaceId, 'workspaceId', 200);
  const projectId = requireActiveProject(workspaceId, input.projectId, database);
  const project = getProject(projectId, database)!;
  if (!project.target_repo) throw new CommandError('Project 尚未設定 target repo');
  if (!repos.has(project.target_repo)) throw new CommandError('target repo 未登記');
  const source = parseSource(input.source);
  const objective = requiredText(input.objective, 'objective', 2000);
  const successCriteria = requiredText(input.successCriteria, 'successCriteria', 5000);
  const dataScope = input.dataScope == null ? '' : requiredText(input.dataScope, 'dataScope', 5000);
  const ownerAgentId = requiredText(input.ownerAgentId, 'ownerAgentId', 200);
  requireCoordinatorOwnerAgent(ownerAgentId, workspaceId, database);
  const parentGoalId = optionalId(input.parentGoalId, 'parentGoalId');
  if (parentGoalId) {
    const parent = getGoal(parentGoalId, database);
    if (!parent || parent.workspace_id !== workspaceId || parent.project_id !== projectId) {
      throw new CommandError('parent Goal 必須屬於同一 Workspace 與 Project');
    }
  }
  if (source !== 'human') {
    const active = database.prepare(
      `SELECT 1 FROM goals_read_model
        WHERE workspace_id = ? AND source <> 'human' AND status NOT IN ('Done', 'Cancelled') LIMIT 1`,
    ).get(workspaceId);
    if (active) throw new ConflictError('Workspace 已有 active 自治 Goal');
  }

  const goalId = randomUUID();
  const create = () => {
    appendEventInTransaction('Goal', goalId, 0, 'goal.created', {
      workspaceId, projectId, parentGoalId, source, objective, successCriteria, dataScope, createdBy: actorId, ownerAgentId,
    }, meta(actorId), database);
    if (source === 'human') {
      const autonomous = database.prepare(
        `SELECT g.* FROM goals_read_model g JOIN projects_read_model p ON p.project_id = g.project_id
          WHERE g.source <> 'human' AND g.status NOT IN ('Done', 'Cancelled') AND p.target_repo = ?`,
      ).all(project.target_repo) as unknown as GoalRow[];
      for (const goal of autonomous) {
        if (goal.status === 'Blocked' || goal.status === 'Paused') continue;
        const leased = hasLease(goal.goal_id, database);
        if (leased && goal.pause_requested) continue;
        database.prepare(
          `INSERT OR IGNORE INTO goal_preemptions
             (human_goal_id, autonomous_goal_id, kind, created_at, resumed_at) VALUES (?, ?, ?, ?, NULL)`,
        ).run(goalId, goal.goal_id, leased ? 'pause' : 'queue', new Date().toISOString());
        if (leased) {
          if (!goal.pause_requested) appendEventInTransaction(
            'Goal', goal.goal_id, goal.version, 'goal.pause_requested', {}, meta(ownerAgentId), database,
          );
        } else {
          skipPendingGoalHeartbeats(goal.goal_id, database);
          appendEventInTransaction('Goal', goal.goal_id, goal.version, 'goal.preempted', {
            fromStatus: goal.status, fromPhase: goal.discussion_phase,
          }, meta(ownerAgentId), database);
        }
      }
    }
  };
  if (database.isTransaction) create();
  else withTransaction(database, create);
  return goalId;
}

export function startDiscussion(actorId: string, goalId: string, database = db): void {
  const { row, state, version } = requireGoal(goalId, database);
  if (state.status !== 'Queued') throw new CommandError(`goal 狀態 ${state.status} 不可開始討論`);
  requireCoordinatorOwnerAgent(row.owner_agent_id, row.workspace_id, database);
  appendEvent('Goal', goalId, version, 'goal.discussion_started', {}, meta(actorId), database);
}

export function setDiscussionPhase(actorId: string, goalId: string, phase: DiscussionPhase, database = db): void {
  const { state, version } = requireGoal(goalId, database);
  if (state.status !== 'Discussing' || !state.phase) throw new CommandError(`goal 狀態 ${state.status} 不可推進討論`);
  const allowed: Record<DiscussionPhase, DiscussionPhase[]> = {
    owner_scoping: ['round_1'],
    round_1: ['round_2', 'awaiting_lease'],
    round_2: ['awaiting_lease'],
    awaiting_lease: [],
    owner_synthesis: [],
  };
  if (!allowed[state.phase].includes(phase)) throw new CommandError(`討論 phase 不合法：${state.phase} → ${phase}`);
  appendEvent('Goal', goalId, version, 'goal.discussion_phase_changed', { phase }, meta(actorId), database);
}

export function acquireRepoLease(actorId: string, goalId: string, database = db): void {
  withTransaction(database, () => {
    const { row, state, version } = requireGoal(goalId, database);
    if (state.status !== 'Discussing' || state.phase !== 'awaiting_lease') {
      throw new CommandError('goal 必須在 awaiting_lease 才能取得 repo execution lease');
    }
    const targetRepo = getProject(row.project_id, database)?.target_repo;
    if (!targetRepo) throw new CommandError('Project 尚未設定 target repo');
    const occupied = database.prepare('SELECT goal_id FROM repo_leases WHERE target_repo = ?').get(targetRepo) as
      | { goal_id: string }
      | undefined;
    if (occupied && occupied.goal_id !== goalId) throw new ConflictError('repo execution lease 已被其他 Goal 持有');
    if (!occupied) {
      database.prepare('INSERT INTO repo_leases (target_repo, goal_id, acquired_at) VALUES (?, ?, ?)')
        .run(targetRepo, goalId, new Date().toISOString());
    }
    appendEventInTransaction('Goal', goalId, version, 'goal.lease_acquired', { targetRepo }, meta(actorId), database);
  });
}

export function startExecution(actorId: string, goalId: string, database = db): void {
  const { state, version } = requireGoal(goalId, database);
  if (state.status !== 'Discussing' || state.phase !== 'owner_synthesis' || !hasLease(goalId, database)) {
    throw new CommandError(`goal 狀態 ${state.status} 不可開始執行`);
  }
  appendEvent('Goal', goalId, version, 'goal.execution_started', {}, meta(actorId), database);
}

export function startVerification(actorId: string, goalId: string, database = db): void {
  const { state, version } = requireGoal(goalId, database);
  if (state.status !== 'Executing' || !hasLease(goalId, database)) {
    throw new CommandError(`goal 狀態 ${state.status} 不可開始驗證`);
  }
  const append = database.isTransaction ? appendEventInTransaction : appendEvent;
  append('Goal', goalId, version, 'goal.verification_started', {}, meta(actorId), database);
}

export function completeGoal(actorId: string, goalId: string, evidenceRefs: unknown, database = db): void {
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0 || evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
    throw new CommandError('Goal 完成必須提供 evidence refs');
  }
  withTransaction(database, () => {
    const { row, state, version } = requireGoal(goalId, database);
    if (state.status !== 'Verifying' || !hasLease(goalId, database)) {
      throw new CommandError(`goal 狀態 ${state.status} 不可完成`);
    }
    database.prepare('DELETE FROM repo_leases WHERE goal_id = ?').run(goalId);
    skipPendingGoalHeartbeats(goalId, database);
    appendEventInTransaction('Goal', goalId, version, 'goal.completed', { evidenceRefs }, meta(actorId), database);
    if (row.source === 'human') resumePreemptedGoals(goalId, database);
    const now = new Date().toISOString();
    database.prepare(
      `INSERT OR IGNORE INTO goal_heartbeats
         (heartbeat_id, scope_id, goal_id, phase, agent_id, revision, trigger_ref, status, created_at, updated_at)
       VALUES (?, ?, ?, 'followup', ?, ?, ?, 'pending', ?, ?)`,
    ).run(randomUUID(), goalId, goalId, getGoal(goalId, database)?.owner_agent_id ?? actorId, state.revision, `followup:${goalId}`, now, now);
  });
}

export function pauseGoal(actorId: string, goalId: string, safeCheckpoint: boolean, database = db): 'paused' | 'scheduled' {
  return withTransaction(database, () => {
    const { row, state, version } = requireGoal(goalId, database);
    requireActive(state);
    if (state.status === 'Paused' || state.status === 'Blocked') throw new CommandError(`goal 狀態 ${state.status} 不可暫停`);
    const runningRun = database.prepare("SELECT 1 FROM goal_runs WHERE goal_id = ? AND status = 'running' LIMIT 1").get(goalId);
    if (!safeCheckpoint || runningRun) {
      if (!state.pauseRequested) {
        appendEventInTransaction('Goal', goalId, version, 'goal.pause_requested', {}, meta(actorId), database);
      }
      return 'scheduled';
    }
    const leased = hasLease(goalId, database);
    if (leased) database.prepare('DELETE FROM repo_leases WHERE goal_id = ?').run(goalId);
    appendEventInTransaction('Goal', goalId, version, 'goal.paused', {
      fromStatus: state.status,
      fromPhase: state.phase,
    }, meta(actorId), database);
    return 'paused';
  });
}

export function applyPendingGoalPause(actorId: string, goalId: string, safeCheckpoint: boolean, database = db): boolean {
  const goal = getGoal(goalId, database);
  if (!goal?.pause_requested || !safeCheckpoint) return false;
  return pauseGoal(actorId, goalId, true, database) === 'paused';
}

export function isGoalSafeCheckpoint(goalId: string, database = db, coordinatorDatabase?: DatabaseSync): boolean {
  // 已封存 task 的 worktree（路徑以 task id 結尾）不會再合併，旗標永遠清不掉，不能擋暫停（2026-10-19 Goal 925ef0b0 實例）。
  if (database.prepare(
    `SELECT 1 FROM goal_worktrees w
      WHERE w.goal_id = ? AND (w.dirty = 1 OR w.unmerged = 1)
        AND NOT EXISTS (SELECT 1 FROM tasks_read_model t
          WHERE t.goal_id = w.goal_id AND t.status = 'Archived' AND w.worktree_path LIKE '%/' || t.task_id)
      LIMIT 1`,
  ).get(goalId)) return false;
  if (!coordinatorDatabase) return true;
  const taskIds = (database.prepare('SELECT task_id FROM tasks_read_model WHERE goal_id = ?').all(goalId) as unknown as Array<{ task_id: string }>)
    .map((row) => row.task_id);
  if (!taskIds.length) return true;
  const placeholders = taskIds.map(() => '?').join(',');
  return !coordinatorDatabase.prepare(
    `SELECT 1 FROM action_log
      WHERE task_id IN (${placeholders}) AND status = 'pending'
        AND (lower(kind) LIKE '%merge%' OR lower(kind) LIKE '%deploy%') LIMIT 1`,
  ).get(...taskIds);
}

export function resumeGoal(actorId: string, goalId: string, changeDescription: unknown = undefined, database = db): void {
  const resume = () => {
    const { state, version } = requireGoal(goalId, database);
    if (state.status !== 'Paused' && state.status !== 'Blocked') throw new CommandError(`goal 狀態 ${state.status} 不可恢復`);
    const blockedChange = state.status === 'Blocked' ? requiredText(changeDescription, '變更說明', 2000) : null;
    const fromStatus = state.status === 'Paused' ? state.pausedFromStatus : state.blockedFromStatus;
    const fromPhase = state.status === 'Paused' ? state.pausedFromPhase : state.blockedFromPhase;
    if (!fromStatus) throw new CommandError('goal 缺少恢復狀態');
    const heldLeaseState = fromStatus === 'Executing' || fromStatus === 'Verifying' || fromPhase === 'owner_synthesis';
    const status: GoalStatus = state.status === 'Blocked' ? fromStatus : heldLeaseState ? 'Discussing' : fromStatus;
    const phase: DiscussionPhase | null = state.status === 'Blocked'
      ? fromStatus === 'Discussing' ? 'owner_scoping' : fromPhase
      : heldLeaseState ? 'awaiting_lease' : fromPhase;
    const revision = state.status === 'Blocked' || heldLeaseState ? state.revision + 1 : state.revision;
    appendEventInTransaction('Goal', goalId, version, 'goal.resumed', {
      status, phase, revision, changeDescription: blockedChange,
    }, meta(actorId), database);
    enqueueTransitionHeartbeat(goalId, database);
  };
  if (database.isTransaction) resume();
  else withTransaction(database, resume);
}

export function blockGoal(actorId: string, goalId: string, reason: unknown, database = db): void {
  const block = () => {
    const { row, state, version } = requireGoal(goalId, database);
    requireActive(state);
    if (state.status === 'Queued') throw new CommandError('goal 狀態 Queued 不可標記 Blocked');
    if (state.status === 'Paused' || state.status === 'Blocked') throw new CommandError(`goal 狀態 ${state.status} 不可標記 Blocked`);
    const blockedReason = requiredText(reason, 'reason', 2000);
    appendEventInTransaction('Goal', goalId, version, 'goal.blocked', {
      reason: blockedReason, fromStatus: state.status, fromPhase: state.phase,
    }, meta(actorId), database);
    const task = database.prepare(
      "SELECT task_id FROM tasks_read_model WHERE goal_id = ? AND status <> 'Archived' ORDER BY rowid LIMIT 1",
    ).get(goalId) as { task_id: string } | undefined;
    notifyWorkspaceHumanAdmins(actorId, row.workspace_id, task?.task_id ?? '', `Goal Blocked：${blockedReason}`, database, goalId);
    if (row.source === 'human') resumePreemptedGoals(goalId, database);
  };
  if (database.isTransaction) block();
  else withTransaction(database, block);
}

export function cancelGoal(actorId: string, goalId: string, database = db): void {
  withTransaction(database, () => {
    const { row, state, version } = requireGoal(goalId, database);
    requireActive(state);
    const tasks = database.prepare(
      `SELECT task_id FROM tasks_read_model
        WHERE goal_id = ? AND status IN ('Todo', 'Doing', 'Review')`,
    ).all(goalId) as unknown as Array<{ task_id: string }>;
    const ownerAgentId = tasks.length ? getUserIdByEmail(MAIN_OWNER_EMAIL, database) : null;
    if (tasks.length && !ownerAgentId) throw new CommandError('Owner Agent 尚未建立');
    for (const task of tasks) {
      archiveTask(ownerAgentId!, task.task_id, database);
    }
    database.prepare('DELETE FROM repo_leases WHERE goal_id = ?').run(goalId);
    skipPendingGoalHeartbeats(goalId, database);
    appendEventInTransaction('Goal', goalId, version, 'goal.cancelled', {}, meta(actorId), database);
    if (row.source === 'human') resumePreemptedGoals(goalId, database);
  });
}

export function reviseGoal(actorId: string, goalId: string, successCriteria: unknown, database = db): void {
  const revise = () => {
    const { row, state, version } = requireGoal(goalId, database);
    requireActive(state);
    if (state.status === 'Blocked' || state.status === 'Paused') {
      throw new CommandError(`Goal 為 ${state.status}，請先恢復再修改`);
    }
    const criteria = requiredText(successCriteria, 'successCriteria', 5000);
    const holdsLease = hasLease(goalId, database);
    const restartDiscussion = !holdsLease && state.status === 'Discussing';
    appendEventInTransaction('Goal', goalId, version, 'goal.revised', {
      successCriteria: criteria, dataScope: row.data_scope, status: holdsLease ? 'Discussing' : state.status,
      phase: holdsLease ? 'owner_synthesis' : restartDiscussion ? 'owner_scoping' : state.phase, revision: state.revision + 1,
    }, meta(actorId), database);
    if (restartDiscussion) skipPendingGoalHeartbeats(goalId, database);
    if (holdsLease || restartDiscussion) enqueueTransitionHeartbeat(goalId, database);
  };
  if (database.isTransaction) revise();
  else withTransaction(database, revise);
}

export function reviseGoalDataScope(actorId: string, goalId: string, dataScope: unknown, database = db): void {
  const revise = () => {
    const { row, state, version } = requireGoal(goalId, database);
    requireActive(state);
    if (state.status === 'Blocked' || state.status === 'Paused') {
      throw new CommandError(`Goal 為 ${state.status}，請先恢復再修改`);
    }
    const scope = requiredText(dataScope, 'dataScope', 5000);
    const holdsLease = hasLease(goalId, database);
    const restartDiscussion = !holdsLease && state.status === 'Discussing';
    appendEventInTransaction('Goal', goalId, version, 'goal.revised', {
      successCriteria: row.success_criteria, dataScope: scope, status: holdsLease ? 'Discussing' : state.status,
      phase: holdsLease ? 'owner_synthesis' : restartDiscussion ? 'owner_scoping' : state.phase, revision: state.revision + 1,
    }, meta(actorId), database);
    if (restartDiscussion) skipPendingGoalHeartbeats(goalId, database);
    if (holdsLease || restartDiscussion) enqueueTransitionHeartbeat(goalId, database);
  };
  if (database.isTransaction) revise();
  else withTransaction(database, revise);
}

export function reconcileGoalDiscussion(actorId: string, goalId: string, database = db): void {
  const reconcile = () => {
    const { state, version } = requireGoal(goalId, database);
    if (state.status !== 'Discussing' || state.phase !== 'round_1') {
      throw new CommandError('只有 round_1 可進行 reconciliation');
    }
    appendEventInTransaction('Goal', goalId, version, 'goal.discussion_reconciled', {
      revision: state.revision + 1,
    }, meta(actorId), database);
    enqueueTransitionHeartbeat(goalId, database);
  };
  if (database.isTransaction) reconcile();
  else withTransaction(database, reconcile);
}

export function getGoal(goalId: string, database = db): GoalRow | null {
  return (database.prepare('SELECT * FROM goals_read_model WHERE goal_id = ?').get(goalId) as GoalRow | undefined) ?? null;
}

export function listGoals(workspaceId: string, database = db): GoalRow[] {
  return database.prepare('SELECT * FROM goals_read_model WHERE workspace_id = ? ORDER BY rowid')
    .all(workspaceId) as unknown as GoalRow[];
}

export function getGoalWorkspaceId(goalId: string, database = db): string | null {
  return getGoal(goalId, database)?.workspace_id ?? null;
}

export function registerGoalProjections(): void {
  registerProjection('goal.created', (event, database) => {
    const payload = event.payload as {
      workspaceId: string; projectId: string; parentGoalId: string | null; source: GoalSource;
      objective: string; successCriteria: string; dataScope: string; createdBy: string; ownerAgentId: string;
    };
    database.prepare(
      `INSERT INTO goals_read_model
         (goal_id, workspace_id, project_id, parent_goal_id, source, objective, success_criteria, data_scope,
          status, discussion_phase, revision, created_by, owner_agent_id, evidence_refs_json,
          version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Queued', NULL, 1, ?, ?, '[]', ?, ?, ?)`,
    ).run(
      event.aggregate_id, payload.workspaceId, payload.projectId, payload.parentGoalId, payload.source,
      payload.objective, payload.successCriteria, payload.dataScope ?? '', payload.createdBy, payload.ownerAgentId,
      event.aggregate_version, event.occurred_at, event.occurred_at,
    );
  });

  const update = (
    event: StoredEvent,
    database: DatabaseSync,
    fields: Record<string, unknown>,
  ) => {
    const names = Object.keys(fields);
    const assignments = names.map((name) => `${name} = ?`).join(', ');
    database.prepare(
      `UPDATE goals_read_model SET ${assignments}, version = ?, updated_at = ? WHERE goal_id = ?`,
    ).run(...names.map((name) => fields[name] as never), event.aggregate_version, event.occurred_at, event.aggregate_id);
  };

  registerProjection('goal.discussion_started', (event, database) => update(event, database, {
    status: 'Discussing', discussion_phase: 'owner_scoping',
  }));
  registerProjection('goal.discussion_phase_changed', (event, database) => update(event, database, {
    discussion_phase: (event.payload as { phase: DiscussionPhase }).phase,
  }));
  registerProjection('goal.lease_acquired', (event, database) => update(event, database, {
    status: 'Discussing', discussion_phase: 'owner_synthesis',
  }));
  registerProjection('goal.execution_started', (event, database) => update(event, database, {
    status: 'Executing', discussion_phase: null,
  }));
  registerProjection('goal.verification_started', (event, database) => update(event, database, {
    status: 'Verifying', discussion_phase: null,
  }));
  registerProjection('goal.completed', (event, database) => update(event, database, {
    status: 'Done', discussion_phase: null,
    pause_requested: 0,
    evidence_refs_json: JSON.stringify((event.payload as { evidenceRefs: string[] }).evidenceRefs),
  }));
  registerProjection('goal.paused', (event, database) => {
    const payload = event.payload as { fromStatus: GoalStatus; fromPhase: DiscussionPhase | null };
    update(event, database, {
      status: 'Paused', discussion_phase: null,
      paused_from_status: payload.fromStatus, paused_from_phase: payload.fromPhase, pause_requested: 0,
    });
  });
  registerProjection('goal.pause_requested', (event, database) => update(event, database, {
    pause_requested: 1,
  }));
  registerProjection('goal.preempted', (event, database) => update(event, database, {
    status: 'Queued', discussion_phase: null, pause_requested: 0,
  }));
  registerProjection('goal.preemption_released', (event, database) => update(event, database, {
    status: (event.payload as { status: GoalStatus }).status,
    discussion_phase: (event.payload as { phase: DiscussionPhase | null }).phase,
    pause_requested: 0,
  }));
  registerProjection('goal.resumed', (event, database) => {
    const payload = event.payload as { status: GoalStatus; phase: DiscussionPhase | null; revision: number };
    update(event, database, {
      status: payload.status, discussion_phase: payload.phase, revision: payload.revision,
      paused_from_status: null, paused_from_phase: null, blocked_from_status: null, blocked_from_phase: null,
      pause_requested: 0,
    });
  });
  registerProjection('goal.blocked', (event, database) => {
    const payload = event.payload as { fromStatus: GoalStatus; fromPhase: DiscussionPhase | null };
    update(event, database, {
      status: 'Blocked', discussion_phase: null,
      blocked_from_status: payload.fromStatus, blocked_from_phase: payload.fromPhase, pause_requested: 0,
    });
  });
  registerProjection('goal.cancelled', (event, database) => update(event, database, {
    status: 'Cancelled', discussion_phase: null, pause_requested: 0,
  }));
  registerProjection('goal.revised', (event, database) => {
    const payload = event.payload as {
      successCriteria: string; dataScope: string; status: GoalStatus; phase: DiscussionPhase | null; revision: number;
    };
    update(event, database, {
      success_criteria: payload.successCriteria, data_scope: payload.dataScope, status: payload.status,
      discussion_phase: payload.phase, revision: payload.revision,
    });
  });
  registerProjection('goal.discussion_reconciled', (event, database) => update(event, database, {
    status: 'Discussing', discussion_phase: 'owner_scoping',
    revision: (event.payload as { revision: number }).revision,
  }));
}
