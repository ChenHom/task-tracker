import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { CommandError, ConflictError } from './eventStore';

export type HeartbeatStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain';
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain';
export type RunAttempt = 'primary' | 'fallback';

export interface HeartbeatRow {
  heartbeat_id: string;
  scope_id: string;
  goal_id: string | null;
  phase: string;
  agent_id: string;
  revision: number;
  trigger_ref: string;
  status: HeartbeatStatus;
  created_at: string;
  updated_at: string;
}

export interface GoalRunRow {
  run_id: string;
  heartbeat_id: string;
  goal_id: string | null;
  task_id: string | null;
  agent_id: string;
  phase: string;
  adapter: string;
  model: string;
  attempt: RunAttempt;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimate_basis: string;
  estimate_confidence: string;
  quota_snapshot_json: string;
  actual_input_tokens: number | null;
  actual_output_tokens: number | null;
  actual_cost: number | null;
  status: RunStatus;
  outcome: string | null;
  error_category: string | null;
  evidence_ref: string | null;
  side_effect_state: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

function text(value: unknown, field: string, max = 1000): string {
  if (typeof value !== 'string' || !value.trim()) throw new CommandError(`${field} 不可為空`);
  const clean = value.trim();
  if (clean.length > max) throw new CommandError(`${field} 過長`);
  return clean;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new CommandError(`${field} 必須是非負整數`);
  return value as number;
}

export interface EnqueueHeartbeatInput {
  scopeId: unknown;
  goalId?: unknown;
  phase: unknown;
  agentId: unknown;
  revision: unknown;
  triggerRef: unknown;
}

export function enqueueHeartbeat(input: EnqueueHeartbeatInput, database = db): string {
  const scopeId = text(input.scopeId, 'scopeId', 200);
  const goalId = input.goalId == null ? null : text(input.goalId, 'goalId', 200);
  const phase = text(input.phase, 'phase', 100);
  const agentId = text(input.agentId, 'agentId', 200);
  const revision = nonNegativeInteger(input.revision, 'revision');
  const triggerRef = text(input.triggerRef, 'triggerRef', 300);
  const existing = database.prepare(
    `SELECT heartbeat_id FROM goal_heartbeats
      WHERE scope_id = ? AND phase = ? AND agent_id = ? AND revision = ? AND trigger_ref = ?`,
  ).get(scopeId, phase, agentId, revision, triggerRef) as { heartbeat_id: string } | undefined;
  if (existing) return existing.heartbeat_id;

  const heartbeatId = randomUUID();
  const now = new Date().toISOString();
  try {
    database.prepare(
      `INSERT INTO goal_heartbeats
         (heartbeat_id, scope_id, goal_id, phase, agent_id, revision, trigger_ref, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(heartbeatId, scopeId, goalId, phase, agentId, revision, triggerRef, now, now);
  } catch (error) {
    const raced = database.prepare(
      `SELECT heartbeat_id FROM goal_heartbeats
        WHERE scope_id = ? AND phase = ? AND agent_id = ? AND revision = ? AND trigger_ref = ?`,
    ).get(scopeId, phase, agentId, revision, triggerRef) as { heartbeat_id: string } | undefined;
    if (raced) return raced.heartbeat_id;
    throw error;
  }
  return heartbeatId;
}

export function listHeartbeats(scopeId: string, database = db): HeartbeatRow[] {
  return database.prepare('SELECT * FROM goal_heartbeats WHERE scope_id = ? ORDER BY rowid').all(scopeId) as unknown as HeartbeatRow[];
}

export interface PrepareRunInput {
  heartbeatId: unknown;
  goalId?: unknown;
  taskId?: unknown;
  agentId: unknown;
  phase: unknown;
  adapter: unknown;
  model: unknown;
  attempt: unknown;
  estimatedInputTokens: unknown;
  estimatedOutputTokens: unknown;
  estimateBasis: unknown;
  estimateConfidence: unknown;
  quotaSnapshotJson: unknown;
}

export function prepareRun(input: PrepareRunInput, database = db): string {
  const heartbeatId = text(input.heartbeatId, 'heartbeatId', 200);
  if (!database.prepare('SELECT 1 FROM goal_heartbeats WHERE heartbeat_id = ?').get(heartbeatId)) {
    throw new CommandError('heartbeat 不存在');
  }
  const attempt = input.attempt;
  if (attempt !== 'primary' && attempt !== 'fallback') throw new CommandError('Run attempt 不合法');
  const quotaSnapshotJson = text(input.quotaSnapshotJson, 'quotaSnapshotJson', 100_000);
  try { JSON.parse(quotaSnapshotJson); } catch { throw new CommandError('quotaSnapshotJson 不是合法 JSON'); }

  const runId = randomUUID();
  database.prepare(
    `INSERT INTO goal_runs
       (run_id, heartbeat_id, goal_id, task_id, agent_id, phase, adapter, model, attempt,
        estimated_input_tokens, estimated_output_tokens, estimate_basis, estimate_confidence,
        quota_snapshot_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    runId,
    heartbeatId,
    input.goalId == null ? null : text(input.goalId, 'goalId', 200),
    input.taskId == null ? null : text(input.taskId, 'taskId', 200),
    text(input.agentId, 'agentId', 200),
    text(input.phase, 'phase', 100),
    text(input.adapter, 'adapter', 30),
    text(input.model, 'model', 200),
    attempt,
    nonNegativeInteger(input.estimatedInputTokens, 'estimatedInputTokens'),
    nonNegativeInteger(input.estimatedOutputTokens, 'estimatedOutputTokens'),
    text(input.estimateBasis, 'estimateBasis', 300),
    text(input.estimateConfidence, 'estimateConfidence', 30),
    quotaSnapshotJson,
    new Date().toISOString(),
  );
  return runId;
}

export function getRun(runId: string, database = db): GoalRunRow | null {
  return (database.prepare('SELECT * FROM goal_runs WHERE run_id = ?').get(runId) as GoalRunRow | undefined) ?? null;
}

export function listGoalRuns(goalId: string, database = db): GoalRunRow[] {
  return database.prepare('SELECT * FROM goal_runs WHERE goal_id = ? ORDER BY rowid').all(goalId) as unknown as GoalRunRow[];
}

export function markRunRunning(runId: string, database = db): void {
  const now = new Date().toISOString();
  const info = database.prepare("UPDATE goal_runs SET status = 'running', started_at = ? WHERE run_id = ? AND status = 'pending'")
    .run(now, runId);
  if (info.changes === 0) throw new CommandError('run 不存在或狀態不可啟動');
  database.prepare("UPDATE goal_heartbeats SET status = 'running', updated_at = ? WHERE heartbeat_id = (SELECT heartbeat_id FROM goal_runs WHERE run_id = ?)")
    .run(now, runId);
}

export interface FinishRunInput {
  status: unknown;
  actualInputTokens: unknown;
  actualOutputTokens: unknown;
  actualCost: unknown;
  credibleBilling: unknown;
  outcome: unknown;
  errorCategory: unknown;
  evidenceRef: unknown;
  sideEffectState: unknown;
}

function optionalText(value: unknown, field: string): string | null {
  return value == null ? null : text(value, field, 2000);
}

function optionalTokens(value: unknown, field: string): number | null {
  return value == null ? null : nonNegativeInteger(value, field);
}

export function finishRun(runId: string, input: FinishRunInput, database = db): void {
  if (input.status !== 'succeeded' && input.status !== 'failed' && input.status !== 'uncertain') {
    throw new CommandError('Run status 不合法');
  }
  let actualCost: number | null = null;
  if (input.actualCost != null) {
    if (input.credibleBilling !== true) throw new CommandError('actual cost 只能來自可信 billing');
    if (typeof input.actualCost !== 'number' || !Number.isFinite(input.actualCost) || input.actualCost < 0) {
      throw new CommandError('actual cost 不合法');
    }
    actualCost = input.actualCost;
  }
  const now = new Date().toISOString();
  const info = database.prepare(
    `UPDATE goal_runs SET status = ?, actual_input_tokens = ?, actual_output_tokens = ?, actual_cost = ?,
       outcome = ?, error_category = ?, evidence_ref = ?, side_effect_state = ?, ended_at = ?
     WHERE run_id = ? AND status = 'running'`,
  ).run(
    input.status,
    optionalTokens(input.actualInputTokens, 'actualInputTokens'),
    optionalTokens(input.actualOutputTokens, 'actualOutputTokens'),
    actualCost,
    optionalText(input.outcome, 'outcome'),
    optionalText(input.errorCategory, 'errorCategory'),
    optionalText(input.evidenceRef, 'evidenceRef'),
    optionalText(input.sideEffectState, 'sideEffectState'),
    now,
    runId,
  );
  if (info.changes === 0) throw new CommandError('run 不存在或狀態不可完成');
  database.prepare('UPDATE goal_heartbeats SET status = ?, updated_at = ? WHERE heartbeat_id = (SELECT heartbeat_id FROM goal_runs WHERE run_id = ?)')
    .run(input.status, now, runId);
}

export interface ParticipationInput {
  goalId: unknown;
  revision: unknown;
  agentId: unknown;
  reason: unknown;
  assignment: unknown;
  selectedLoad: unknown;
}

export function addParticipation(input: ParticipationInput, database = db): string {
  const id = randomUUID();
  try {
    database.prepare(
      `INSERT INTO goal_participations
         (participation_id, goal_id, revision, agent_id, reason, assignment, selected_load, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, text(input.goalId, 'goalId', 200), nonNegativeInteger(input.revision, 'revision'),
      text(input.agentId, 'agentId', 200), text(input.reason, 'reason', 2000),
      text(input.assignment, 'assignment', 2000), nonNegativeInteger(input.selectedLoad, 'selectedLoad'),
      new Date().toISOString(),
    );
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ConflictError('Participation 已存在');
    throw error;
  }
  return id;
}

export function listParticipations(goalId: string, revision: number, database = db): Record<string, unknown>[] {
  return database.prepare('SELECT * FROM goal_participations WHERE goal_id = ? AND revision = ? ORDER BY rowid')
    .all(goalId, revision) as Record<string, unknown>[];
}

export interface ContributionInput {
  goalId: unknown;
  revision: unknown;
  round: unknown;
  agentId: unknown;
  stance: unknown;
  claim: unknown;
  reason: unknown;
  evidenceRefs: unknown;
}

export function addContribution(input: ContributionInput, database = db): string {
  if (input.round !== 'round_1' && input.round !== 'round_2') throw new CommandError('Contribution round 不合法');
  const allowedStances = input.round === 'round_1'
    ? ['analysis']
    : ['agree', 'concern', 'correction'];
  if (typeof input.stance !== 'string' || !allowedStances.includes(input.stance)) {
    throw new CommandError('Contribution stance 不合法');
  }
  const claim = text(input.claim, 'claim', 5000);
  const reason = text(input.reason, 'reason', 5000);
  if (/^(收到|了解|已閱讀|ok)$/iu.test(claim) || /^(收到|了解|已閱讀|ok)$/iu.test(reason)) {
    throw new CommandError('Contribution 必須包含實質內容');
  }
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
    throw new CommandError('evidenceRefs 不合法');
  }

  const id = randomUUID();
  try {
    database.prepare(
      `INSERT INTO goal_contributions
         (contribution_id, goal_id, revision, round, agent_id, stance, claim, reason, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, text(input.goalId, 'goalId', 200), nonNegativeInteger(input.revision, 'revision'),
      input.round, text(input.agentId, 'agentId', 200), input.stance, claim, reason,
      JSON.stringify(input.evidenceRefs), new Date().toISOString(),
    );
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ConflictError('Contribution 已存在');
    throw error;
  }
  return id;
}

export function listContributions(goalId: string, revision: number, database = db): Record<string, unknown>[] {
  return database.prepare('SELECT * FROM goal_contributions WHERE goal_id = ? AND revision = ? ORDER BY rowid')
    .all(goalId, revision) as Record<string, unknown>[];
}
