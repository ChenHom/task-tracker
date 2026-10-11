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
  status: GoalStatus;
  discussion_phase: DiscussionPhase | null;
  revision: number;
  created_by: string;
  owner_agent_id: string;
  paused_from_status: GoalStatus | null;
  paused_from_phase: DiscussionPhase | null;
  blocked_from_status: GoalStatus | null;
  blocked_from_phase: DiscussionPhase | null;
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
  blockedFromStatus: GoalStatus | null;
  blockedFromPhase: DiscussionPhase | null;
}

const INITIAL: GoalState = {
  exists: false,
  status: 'Queued',
  phase: null,
  revision: 0,
  pausedFromStatus: null,
  pausedFromPhase: null,
  blockedFromStatus: null,
  blockedFromPhase: null,
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
      return { ...state, status: 'Done', phase: null };
    case 'goal.paused':
      return {
        ...state,
        status: 'Paused',
        phase: null,
        pausedFromStatus: payload.fromStatus as GoalStatus,
        pausedFromPhase: (payload.fromPhase as DiscussionPhase | null) ?? null,
      };
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
      };
    case 'goal.cancelled':
      return { ...state, status: 'Cancelled', phase: null };
    case 'goal.revised':
      return {
        ...state,
        status: payload.status as GoalStatus,
        phase: (payload.phase as DiscussionPhase | null) ?? null,
        revision: Number(payload.revision),
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

export function createGoal(actorId: string, input: CreateGoalInput, database = db): string {
  const workspaceId = requiredText(input.workspaceId, 'workspaceId', 200);
  const projectId = requireActiveProject(workspaceId, input.projectId, database);
  const project = getProject(projectId, database)!;
  if (!project.target_repo) throw new CommandError('Project 尚未設定 target repo');
  const source = parseSource(input.source);
  const objective = requiredText(input.objective, 'objective', 2000);
  const successCriteria = requiredText(input.successCriteria, 'successCriteria', 5000);
  const ownerAgentId = requiredText(input.ownerAgentId, 'ownerAgentId', 200);
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
  appendEvent('Goal', goalId, 0, 'goal.created', {
    workspaceId,
    projectId,
    parentGoalId,
    source,
    objective,
    successCriteria,
    createdBy: actorId,
    ownerAgentId,
  }, meta(actorId), database);
  return goalId;
}

export function startDiscussion(actorId: string, goalId: string, database = db): void {
  const { state, version } = requireGoal(goalId, database);
  if (state.status !== 'Queued') throw new CommandError(`goal 狀態 ${state.status} 不可開始討論`);
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
  appendEvent('Goal', goalId, version, 'goal.verification_started', {}, meta(actorId), database);
}

export function completeGoal(actorId: string, goalId: string, evidenceRefs: unknown, database = db): void {
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0 || evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
    throw new CommandError('Goal 完成必須提供 evidence refs');
  }
  withTransaction(database, () => {
    const { state, version } = requireGoal(goalId, database);
    if (state.status !== 'Verifying' || !hasLease(goalId, database)) {
      throw new CommandError(`goal 狀態 ${state.status} 不可完成`);
    }
    database.prepare('DELETE FROM repo_leases WHERE goal_id = ?').run(goalId);
    appendEventInTransaction('Goal', goalId, version, 'goal.completed', { evidenceRefs }, meta(actorId), database);
  });
}

export function pauseGoal(actorId: string, goalId: string, safeCheckpoint: boolean, database = db): void {
  withTransaction(database, () => {
    const { state, version } = requireGoal(goalId, database);
    requireActive(state);
    if (state.status === 'Paused' || state.status === 'Blocked') throw new CommandError(`goal 狀態 ${state.status} 不可暫停`);
    const leased = hasLease(goalId, database);
    if (leased && !safeCheckpoint) throw new CommandError('repo 尚未到安全 checkpoint');
    if (leased) database.prepare('DELETE FROM repo_leases WHERE goal_id = ?').run(goalId);
    appendEventInTransaction('Goal', goalId, version, 'goal.paused', {
      fromStatus: state.status,
      fromPhase: state.phase,
    }, meta(actorId), database);
  });
}

export function resumeGoal(actorId: string, goalId: string, database = db): void {
  const { state, version } = requireGoal(goalId, database);
  if (state.status !== 'Paused' && state.status !== 'Blocked') throw new CommandError(`goal 狀態 ${state.status} 不可恢復`);
  const fromStatus = state.status === 'Paused' ? state.pausedFromStatus : state.blockedFromStatus;
  const fromPhase = state.status === 'Paused' ? state.pausedFromPhase : state.blockedFromPhase;
  if (!fromStatus) throw new CommandError('goal 缺少恢復狀態');
  const heldLeaseState = fromStatus === 'Executing' || fromStatus === 'Verifying' || fromPhase === 'owner_synthesis';
  const status: GoalStatus = heldLeaseState ? 'Discussing' : fromStatus;
  const phase: DiscussionPhase | null = heldLeaseState ? 'awaiting_lease' : fromPhase;
  const revision = state.status === 'Blocked' || heldLeaseState ? state.revision + 1 : state.revision;
  appendEvent('Goal', goalId, version, 'goal.resumed', {
    status,
    phase,
    revision,
  }, meta(actorId), database);
}

export function blockGoal(actorId: string, goalId: string, reason: unknown, database = db): void {
  const { state, version } = requireGoal(goalId, database);
  requireActive(state);
  if (state.status === 'Paused' || state.status === 'Blocked') throw new CommandError(`goal 狀態 ${state.status} 不可標記 Blocked`);
  appendEvent('Goal', goalId, version, 'goal.blocked', {
    reason: requiredText(reason, 'reason', 2000),
    fromStatus: state.status,
    fromPhase: state.phase,
  }, meta(actorId), database);
}

export function cancelGoal(actorId: string, goalId: string, database = db): void {
  withTransaction(database, () => {
    const { state, version } = requireGoal(goalId, database);
    requireActive(state);
    database.prepare('DELETE FROM repo_leases WHERE goal_id = ?').run(goalId);
    appendEventInTransaction('Goal', goalId, version, 'goal.cancelled', {}, meta(actorId), database);
  });
}

export function reviseGoal(actorId: string, goalId: string, successCriteria: unknown, database = db): void {
  const { state, version } = requireGoal(goalId, database);
  requireActive(state);
  const criteria = requiredText(successCriteria, 'successCriteria', 5000);
  const holdsLease = hasLease(goalId, database);
  appendEvent('Goal', goalId, version, 'goal.revised', {
    successCriteria: criteria,
    status: holdsLease ? 'Discussing' : state.status,
    phase: holdsLease ? 'owner_synthesis' : state.phase,
    revision: state.revision + 1,
  }, meta(actorId), database);
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
      objective: string; successCriteria: string; createdBy: string; ownerAgentId: string;
    };
    database.prepare(
      `INSERT INTO goals_read_model
         (goal_id, workspace_id, project_id, parent_goal_id, source, objective, success_criteria,
          status, discussion_phase, revision, created_by, owner_agent_id, evidence_refs_json,
          version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Queued', NULL, 1, ?, ?, '[]', ?, ?, ?)`,
    ).run(
      event.aggregate_id, payload.workspaceId, payload.projectId, payload.parentGoalId, payload.source,
      payload.objective, payload.successCriteria, payload.createdBy, payload.ownerAgentId,
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
    evidence_refs_json: JSON.stringify((event.payload as { evidenceRefs: string[] }).evidenceRefs),
  }));
  registerProjection('goal.paused', (event, database) => {
    const payload = event.payload as { fromStatus: GoalStatus; fromPhase: DiscussionPhase | null };
    update(event, database, {
      status: 'Paused', discussion_phase: null,
      paused_from_status: payload.fromStatus, paused_from_phase: payload.fromPhase,
    });
  });
  registerProjection('goal.resumed', (event, database) => {
    const payload = event.payload as { status: GoalStatus; phase: DiscussionPhase | null; revision: number };
    update(event, database, {
      status: payload.status, discussion_phase: payload.phase, revision: payload.revision,
      paused_from_status: null, paused_from_phase: null, blocked_from_status: null, blocked_from_phase: null,
    });
  });
  registerProjection('goal.blocked', (event, database) => {
    const payload = event.payload as { fromStatus: GoalStatus; fromPhase: DiscussionPhase | null };
    update(event, database, {
      status: 'Blocked', discussion_phase: null,
      blocked_from_status: payload.fromStatus, blocked_from_phase: payload.fromPhase,
    });
  });
  registerProjection('goal.cancelled', (event, database) => update(event, database, {
    status: 'Cancelled', discussion_phase: null,
  }));
  registerProjection('goal.revised', (event, database) => {
    const payload = event.payload as {
      successCriteria: string; status: GoalStatus; phase: DiscussionPhase | null; revision: number;
    };
    update(event, database, {
      success_criteria: payload.successCriteria, status: payload.status,
      discussion_phase: payload.phase, revision: payload.revision,
    });
  });
}
