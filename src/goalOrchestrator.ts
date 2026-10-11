import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { getAgent, listWorkspaceAgents } from './agent';
import { CommandError, ConflictError } from './eventStore';
import {
  acquireRepoLease, blockGoal, getGoal, reconcileGoalDiscussion, setDiscussionPhase,
} from './goal';
import {
  addContribution, addParticipation, enqueueHeartbeat, finishRun, getRun,
  listContributions, listParticipations, markRunRunning, prepareRun,
} from './goalRun';

export interface ParticipantSelection {
  agentId: string; reason: string; assignment: string; selectedLoad: number;
}
export interface DiscussionOutput {
  stance: 'analysis' | 'agree' | 'concern' | 'correction';
  claim: string; reason: string; evidenceRefs: string[];
  actualInputTokens?: number | null; actualOutputTokens?: number | null;
}
export interface SynthesisOutput {
  summary: string;
  taskPlans: Array<{ title: string; description: string; assigneeId: string; dependsOn?: string[]; acceptanceCriteria: string; rollbackCondition: string }>;
  evidenceRefs: string[];
}
export interface GoalDiscussionDeps {
  database?: DatabaseSync;
  quotaSnapshot: () => string;
  invoke: (input: { goalId: string; revision: number; round: 'round_1' | 'round_2'; agentId: string; assignment: string; peerContributions: Record<string, unknown>[] }) => Promise<DiscussionOutput>;
  estimate?: (input: { assignment: string; peerCount: number }) => { inputTokens: number; outputTokens: number };
}

function clean(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CommandError(`${field} 不可為空`);
  return value.trim();
}

export function selectGoalParticipants(
  ownerAgentId: string, goalId: string, selections: readonly ParticipantSelection[], database = db,
): void {
  const goal = getGoal(goalId, database);
  if (!goal) throw new CommandError('goal 不存在');
  if (goal.owner_agent_id !== ownerAgentId || goal.status !== 'Discussing' || goal.discussion_phase !== 'owner_scoping') {
    throw new CommandError('Goal 目前不可選人');
  }
  if (selections.length < 1 || selections.length > 5) throw new CommandError('參與者必須為 1–5 位');
  const eligible = new Set(listWorkspaceAgents(goal.workspace_id, database)
    .filter((agent) => agent.role === 'member' && agent.status === 'active')
    .map((agent) => agent.agent_id));
  if (new Set(selections.map((item) => item.agentId)).size !== selections.length) throw new CommandError('參與者不可重複');
  for (const item of selections) {
    if (!eligible.has(item.agentId)) throw new CommandError('Agent 不符合 Workspace／狀態資格');
    addParticipation({
      goalId, revision: goal.revision, agentId: item.agentId,
      reason: clean(item.reason, 'reason'), assignment: clean(item.assignment, 'assignment'),
      selectedLoad: item.selectedLoad,
    }, database);
  }
  setDiscussionPhase(ownerAgentId, goalId, 'round_1', database);
}

function recordRound(goalId: string, revision: number, round: string, status: string, reason: string | null, database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO goal_rounds (goal_id, revision, round, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(goal_id, revision, round) DO NOTHING`,
  ).run(goalId, revision, round, status, reason, new Date().toISOString());
}

async function runContribution(
  goalId: string, revision: number, round: 'round_1' | 'round_2', participation: Record<string, unknown>,
  peers: Record<string, unknown>[], deps: GoalDiscussionDeps, database: DatabaseSync,
): Promise<void> {
  const agentId = String(participation.agent_id);
  if (listContributions(goalId, revision, database).some((row) => row.round === round && row.agent_id === agentId)) return;
  const heartbeatId = enqueueHeartbeat({ scopeId: goalId, goalId, phase: round, agentId, revision, triggerRef: 'phase' }, database);
  const previous = database.prepare('SELECT run_id FROM goal_runs WHERE heartbeat_id = ? AND attempt = ?').get(heartbeatId, 'primary') as { run_id: string } | undefined;
  if (previous && getRun(previous.run_id, database)?.status !== 'pending') return;
  const agent = getAgent(agentId, database);
  if (!agent) throw new CommandError('agent 不存在');
  const estimate = deps.estimate?.({ assignment: String(participation.assignment), peerCount: peers.length })
    ?? { inputTokens: Math.ceil((String(participation.assignment).length + JSON.stringify(peers).length) / 4), outputTokens: 500 };
  const runId = previous?.run_id ?? prepareRun({
    heartbeatId, goalId, taskId: null, agentId, phase: round,
    adapter: 'claude', model: 'claude-sonnet-5-5', attempt: 'primary',
    estimatedInputTokens: estimate.inputTokens, estimatedOutputTokens: estimate.outputTokens,
    estimateBasis: 'bounded_context_chars', estimateConfidence: 'medium', quotaSnapshotJson: deps.quotaSnapshot(),
  }, database);
  markRunRunning(runId, database);
  try {
    const output = await deps.invoke({ goalId, revision, round, agentId, assignment: String(participation.assignment), peerContributions: peers });
    const contributionId = addContribution({ goalId, revision, round, agentId, ...output }, database);
    finishRun(runId, {
      status: 'succeeded', actualInputTokens: output.actualInputTokens ?? null,
      actualOutputTokens: output.actualOutputTokens ?? null, actualCost: null, credibleBilling: false,
      outcome: 'valid_contribution', errorCategory: null, evidenceRef: `contribution:${contributionId}`, sideEffectState: 'none',
    }, database);
  } catch (error) {
    finishRun(runId, {
      status: 'failed', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
      outcome: null, errorCategory: 'discussion', evidenceRef: null, sideEffectState: 'none',
    }, database);
  }
}

export async function advanceGoalDiscussion(goalId: string, deps: GoalDiscussionDeps): Promise<'round_2' | 'awaiting_lease' | 'reconciled' | 'blocked'> {
  const database = deps.database ?? db;
  const goal = getGoal(goalId, database);
  if (!goal || goal.status !== 'Discussing' || (goal.discussion_phase !== 'round_1' && goal.discussion_phase !== 'round_2')) {
    throw new CommandError('Goal 不在可推進的討論階段');
  }
  const round = goal.discussion_phase;
  const participation = listParticipations(goalId, goal.revision, database);
  const roundOne = listContributions(goalId, goal.revision, database).filter((row) => row.round === 'round_1');
  for (const selected of participation) await runContribution(goalId, goal.revision, round, selected, round === 'round_2' ? roundOne : [], deps, database);
  const all = listContributions(goalId, goal.revision, database);
  const valid = all.filter((row) => row.round === round);
  recordRound(goalId, goal.revision, round, 'completed', null, database);
  if (round === 'round_2') {
    setDiscussionPhase(goal.owner_agent_id, goalId, 'awaiting_lease', database);
    return 'awaiting_lease';
  }
  if (valid.length === 0) {
    const prior = database.prepare('SELECT 1 FROM goal_reconciliations WHERE goal_id = ?').get(goalId);
    if (prior) {
      blockGoal(goal.owner_agent_id, goalId, 'Round 1 reconciliation 後仍無有效 Contribution', database);
      return 'blocked';
    }
    database.prepare('INSERT INTO goal_reconciliations (goal_id, revision, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(goalId, goal.revision, 'no_valid_contribution', new Date().toISOString());
    reconcileGoalDiscussion(goal.owner_agent_id, goalId, database);
    return 'reconciled';
  }
  if (valid.length < 2) {
    recordRound(goalId, goal.revision, 'round_2', 'skipped', 'insufficient_peers', database);
    setDiscussionPhase(goal.owner_agent_id, goalId, 'awaiting_lease', database);
    return 'awaiting_lease';
  }
  setDiscussionPhase(goal.owner_agent_id, goalId, 'round_2', database);
  return 'round_2';
}

export function storeGoalSynthesis(goalId: string, output: SynthesisOutput, database = db): void {
  const goal = getGoal(goalId, database);
  if (!goal || goal.status !== 'Discussing' || goal.discussion_phase !== 'awaiting_lease') throw new CommandError('Goal 尚未等待 lease');
  acquireRepoLease(goal.owner_agent_id, goalId, database);
  try {
    database.prepare(
      `INSERT INTO goal_syntheses (goal_id, revision, summary, task_plans_json, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(goalId, goal.revision, clean(output.summary, 'summary'), JSON.stringify(output.taskPlans), JSON.stringify(output.evidenceRefs), new Date().toISOString());
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ConflictError('Goal synthesis 已存在');
    throw error;
  }
}

export function getGoalSynthesis(goalId: string, revision: number, database = db): Record<string, unknown> | null {
  return (database.prepare('SELECT * FROM goal_syntheses WHERE goal_id = ? AND revision = ?').get(goalId, revision) as Record<string, unknown> | undefined) ?? null;
}
