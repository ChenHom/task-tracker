import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { getAgent, listWorkspaceAgents } from './agent';
import { appendEventInTransaction, CommandError, ConflictError } from './eventStore';
import { buildMetadata as meta } from './requestContext';
import {
  acquireRepoLease, blockGoal, getGoal, reconcileGoalDiscussion, setDiscussionPhase,
  completeGoal, reviseGoal, startVerification,
} from './goal';
import { requireActiveProject } from './project';
import { listDeliveryEvidence } from './deliveryEvidence';
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
    enqueueHeartbeat({ scopeId: goalId, goalId, phase: 'round_1', agentId: item.agentId, revision: goal.revision, triggerRef: 'phase' }, database);
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
): Promise<'terminal' | 'waiting'> {
  const agentId = String(participation.agent_id);
  const existingContribution = listContributions(goalId, revision, database).some((row) => row.round === round && row.agent_id === agentId);
  const heartbeatId = enqueueHeartbeat({ scopeId: goalId, goalId, phase: round, agentId, revision, triggerRef: 'phase' }, database);
  const previous = database.prepare('SELECT run_id FROM goal_runs WHERE heartbeat_id = ? AND attempt = ?').get(heartbeatId, 'primary') as { run_id: string } | undefined;
  if (previous) {
    const run = getRun(previous.run_id, database)!;
    if (existingContribution) {
      if (run.status === 'running') finishRun(previous.run_id, {
        status: 'succeeded', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
        outcome: 'reconciled_existing_contribution', errorCategory: null, evidenceRef: 'contribution:existing', sideEffectState: 'none',
      }, database);
      return 'terminal';
    }
    if (run.status === 'running') {
      const expired = run.started_at && Date.now() - Date.parse(run.started_at) >= 15 * 60 * 1000;
      if (!expired) return 'waiting';
      finishRun(previous.run_id, {
        status: 'uncertain', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
        outcome: null, errorCategory: 'crash_recovery', evidenceRef: null, sideEffectState: 'unknown',
      }, database);
      return 'terminal';
    }
    if (run.status !== 'pending') return 'terminal';
  }
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
  const claimed = getRun(runId, database)!;
  if (claimed.status === 'running') return 'waiting';
  if (claimed.status !== 'pending') return 'terminal';
  try {
    markRunRunning(runId, database);
  } catch (error) {
    if (getRun(runId, database)?.status === 'running') return 'waiting';
    throw error;
  }
  try {
    const output = await deps.invoke({ goalId, revision, round, agentId, assignment: String(participation.assignment), peerContributions: peers });
    const contributionId = addContribution({ goalId, revision, round, agentId, ...output }, database);
    finishRun(runId, {
      status: 'succeeded', actualInputTokens: output.actualInputTokens ?? null,
      actualOutputTokens: output.actualOutputTokens ?? null, actualCost: null, credibleBilling: false,
      outcome: 'valid_contribution', errorCategory: null, evidenceRef: `contribution:${contributionId}`, sideEffectState: 'none',
    }, database);
    return 'terminal';
  } catch (error) {
    finishRun(runId, {
      status: 'failed', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
      outcome: null, errorCategory: 'discussion', evidenceRef: null, sideEffectState: 'none',
    }, database);
    return 'terminal';
  }
}

export async function advanceGoalDiscussion(goalId: string, deps: GoalDiscussionDeps): Promise<'round_2' | 'awaiting_lease' | 'reconciled' | 'blocked' | 'waiting'> {
  const database = deps.database ?? db;
  const goal = getGoal(goalId, database);
  if (!goal || goal.status !== 'Discussing' || (goal.discussion_phase !== 'round_1' && goal.discussion_phase !== 'round_2')) {
    throw new CommandError('Goal 不在可推進的討論階段');
  }
  const round = goal.discussion_phase;
  const participation = listParticipations(goalId, goal.revision, database);
  const roundOne = listContributions(goalId, goal.revision, database).filter((row) => row.round === 'round_1');
  const outcomes = [];
  for (const selected of participation) outcomes.push(await runContribution(goalId, goal.revision, round, selected, round === 'round_2' ? roundOne : [], deps, database));
  if (outcomes.includes('waiting')) return 'waiting';
  const all = listContributions(goalId, goal.revision, database);
  const valid = all.filter((row) => row.round === round);
  recordRound(goalId, goal.revision, round, 'completed', null, database);
  if (round === 'round_2') {
    setDiscussionPhase(goal.owner_agent_id, goalId, 'awaiting_lease', database);
    enqueueHeartbeat({ scopeId: goalId, goalId, phase: 'owner_synthesis', agentId: goal.owner_agent_id, revision: goal.revision, triggerRef: 'phase' }, database);
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
    enqueueHeartbeat({ scopeId: goalId, goalId, phase: 'owner_synthesis', agentId: goal.owner_agent_id, revision: goal.revision, triggerRef: 'phase' }, database);
    return 'awaiting_lease';
  }
  setDiscussionPhase(goal.owner_agent_id, goalId, 'round_2', database);
  for (const selected of participation) enqueueHeartbeat({ scopeId: goalId, goalId, phase: 'round_2', agentId: String(selected.agent_id), revision: goal.revision, triggerRef: 'phase' }, database);
  return 'round_2';
}

export function storeGoalSynthesis(goalId: string, output: SynthesisOutput, database = db): void {
  const goal = getGoal(goalId, database);
  if (goal && getGoalSynthesis(goalId, goal.revision, database)) return;
  if (!goal || goal.status !== 'Discussing' || (goal.discussion_phase !== 'awaiting_lease' && goal.discussion_phase !== 'owner_synthesis')) throw new CommandError('Goal 尚未等待 lease');
  if (goal.discussion_phase === 'awaiting_lease') acquireRepoLease(goal.owner_agent_id, goalId, database);
  else if (!database.prepare('SELECT 1 FROM repo_leases WHERE goal_id = ?').get(goalId)) throw new CommandError('Goal 未持有 repo lease');
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

export function materializeGoalTasks(ownerAgentId: string, goalId: string, database = db): string[] {
  const goal = getGoal(goalId, database);
  const existingTasks = database.prepare('SELECT task_id FROM tasks_read_model WHERE goal_id = ? ORDER BY rowid').all(goalId) as unknown as Array<{ task_id: string }>;
  if (goal?.status === 'Executing' && existingTasks.length) return existingTasks.map((task) => task.task_id);
  if (!goal || goal.owner_agent_id !== ownerAgentId || goal.status !== 'Discussing' || goal.discussion_phase !== 'owner_synthesis') {
    throw new CommandError('Goal 尚未完成 synthesis');
  }
  const synthesis = getGoalSynthesis(goalId, goal.revision, database);
  if (!synthesis) throw new CommandError('Goal synthesis 不存在');
  if (!database.prepare('SELECT 1 FROM repo_leases WHERE goal_id = ?').get(goalId)) throw new CommandError('Goal 未持有 repo lease');
  const plans = JSON.parse(String(synthesis.task_plans_json)) as SynthesisOutput['taskPlans'];
  if (!Array.isArray(plans) || plans.length === 0) throw new CommandError('synthesis 必須包含 Task');
  const ids: string[] = [];
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const plan of plans) {
      const title = clean(plan.title, 'Task title');
      const description = clean(plan.description, 'Task description');
      const assigneeId = clean(plan.assigneeId, 'Task assignee');
      if (title.length > 200 || description.length > 5000) throw new CommandError('Task 內容過長');
      if (!database.prepare('SELECT 1 FROM workspace_members_read_model WHERE workspace_id = ? AND user_id = ?').get(goal.workspace_id, assigneeId)) {
        throw new CommandError('Task assignee 必須是 Workspace member');
      }
      const taskId = randomUUID();
      appendEventInTransaction('Task', taskId, 0, 'task.created', {
        workspaceId: goal.workspace_id, projectId: goal.project_id, goalId,
        title, description: `${description}\n\n驗收：${clean(plan.acceptanceCriteria, 'acceptanceCriteria')}\nRollback：${clean(plan.rollbackCondition, 'rollbackCondition')}`,
        status: 'Todo', priority: 'Medium', assigneeId, dueAt: null,
      }, meta(ownerAgentId), database);
      ids.push(taskId);
    }
    appendEventInTransaction('Goal', goalId, goal.version, 'goal.execution_started', {}, meta(ownerAgentId), database);
    database.exec('COMMIT');
    return ids;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function verifyGoalDelivery(ownerAgentId: string, goalId: string, input: {
  passed: boolean; evidenceRefs: string[]; deployment: 'verified' | 'not_required' | 'missing';
}, database = db): 'done' | 'retry' | 'blocked' {
  let goal = getGoal(goalId, database);
  if (!goal) throw new CommandError('goal 不存在');
  if (goal.status === 'Executing') startVerification(ownerAgentId, goalId, database);
  goal = getGoal(goalId, database)!;
  if (goal.status !== 'Verifying') throw new CommandError('Goal 不在 Verifying');
  const tasks = database.prepare('SELECT task_id, status FROM tasks_read_model WHERE goal_id = ?').all(goalId) as unknown as Array<{ task_id: string; status: string }>;
  if (tasks.length === 0 || tasks.some((task) => task.status !== 'Done')) throw new CommandError('Goal 仍有未完成 Task');
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) throw new CommandError('Goal 驗收缺少 evidence');
  const deliveryRefs: string[] = [];
  for (const task of tasks) {
    const evidence = listDeliveryEvidence(task.task_id, database);
    const kinds = new Set(evidence.map((item) => item.kind));
    if (!kinds.has('ci.checked') || !kinds.has('merge.integrated')
      || (!kinds.has('deployment.verified') && !kinds.has('deployment_not_required'))) {
      throw new CommandError(`Task ${task.task_id} 缺少 CI、merge 或 deployment 權威證據`);
    }
    deliveryRefs.push(...evidence.map((item) => `${item.kind}:${item.ref}`));
  }
  const evidenceRefs = [...new Set([...input.evidenceRefs, ...deliveryRefs])];
  database.prepare(
    `INSERT INTO goal_verifications (goal_id, revision, passed, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(goal_id, revision) DO NOTHING`,
  ).run(goalId, goal.revision, input.passed ? 1 : 0, JSON.stringify(evidenceRefs), new Date().toISOString());
  if (input.passed) {
    completeGoal(ownerAgentId, goalId, evidenceRefs, database);
    return 'done';
  }
  const failures = (database.prepare('SELECT COUNT(*) AS count FROM goal_verifications WHERE goal_id = ? AND passed = 0').get(goalId) as { count: number }).count;
  if (failures >= 2) {
    blockGoal(ownerAgentId, goalId, '第二次驗收仍失敗', database);
    return 'blocked';
  }
  reviseGoal(ownerAgentId, goalId, goal.success_criteria, database);
  return 'retry';
}

export function createFollowupGoal(ownerAgentId: string, parentGoalId: string, input: {
  objective: string; successCriteria: string; reason: string; evidenceRefs: string[];
}, database = db): string {
  const parent = getGoal(parentGoalId, database);
  if (!parent || parent.status !== 'Done') throw new CommandError('只有 Done Goal 可建立 follow-up');
  const successCriteria = clean(input.successCriteria, 'successCriteria');
  if (successCriteria === parent.success_criteria) throw new CommandError('follow-up 必須使用不同成功條件');
  clean(input.reason, 'reason');
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) throw new CommandError('follow-up 必須有增量證據');
  const fingerprint = createHash('sha256').update(JSON.stringify([...input.evidenceRefs].sort())).digest('hex');
  const objective = clean(input.objective, 'objective');
  requireActiveProject(parent.workspace_id, parent.project_id, database);
  database.exec('BEGIN IMMEDIATE');
  try {
    const existing = database.prepare(
      'SELECT child_goal_id FROM goal_followups WHERE parent_goal_id = ? AND success_criteria = ? AND evidence_fingerprint = ?',
    ).get(parentGoalId, successCriteria, fingerprint) as { child_goal_id: string } | undefined;
    if (existing) {
      database.exec('COMMIT');
      return existing.child_goal_id;
    }
    const childGoalId = randomUUID();
    appendEventInTransaction('Goal', childGoalId, 0, 'goal.created', {
      workspaceId: parent.workspace_id,
      projectId: parent.project_id,
      parentGoalId,
      source: 'followup',
      objective,
      successCriteria,
      createdBy: ownerAgentId,
      ownerAgentId,
    }, meta(ownerAgentId), database);
    database.prepare(
      `INSERT INTO goal_followups (parent_goal_id, success_criteria, evidence_fingerprint, child_goal_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(parentGoalId, successCriteria, fingerprint, childGoalId, new Date().toISOString());
    database.exec('COMMIT');
    return childGoalId;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
