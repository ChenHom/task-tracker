import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { getAgent, listAgents, listWorkspaceAgents } from './agent';
import { appendEventInTransaction, CommandError, ConflictError } from './eventStore';
import { buildMetadata as meta } from './requestContext';
import {
  acquireRepoLease, blockGoal, createGoal, getGoal, reconcileGoalDiscussion, setDiscussionPhase,
  completeGoal, reviseGoal, startVerification,
} from './goal';
import { getProject, requireActiveProject } from './project';
import { loadRepoRegistry, type RepoRegistry } from './repoRegistry';
import { listDeliveryEvidence, type DeliveryEvidenceKind } from './deliveryEvidence';
import { SAFE_DISCUSSION_ROUTE } from './safeDiscussionRoute';
import { archiveTask } from './task';
import {
  addContribution, addParticipation, enqueueHeartbeat, finishRun, getRun,
  listContributions, listParticipations, markRunRunning, prepareRun,
} from './goalRun';

export interface ParticipantSelection {
  agentId: string; reason: string; assignment: string; selectedLoad: number;
}

export interface EligibleGoalParticipant { agent: ReturnType<typeof listWorkspaceAgents>[number]; selectedLoad: number }
export interface DiscussionOutput {
  stance: 'analysis' | 'agree' | 'concern' | 'correction';
  claim: string; reason: string; evidenceRefs: string[];
  actualInputTokens?: number | null; actualOutputTokens?: number | null;
  tokenTotal?: number | null;
  sourceRefs?: string[];
}
export interface SynthesisOutput {
  summary: string;
  decisionRationale: string;
  changeScope: string;
  uncertainties: string[];
  taskPlans: Array<{ title: string; description: string; assigneeId: string; dependsOn: string[]; deploymentNotRequired: boolean; acceptanceCriteria: string; rollbackCondition: string }>;
  archiveTaskIds?: string[];
  evidenceRefs: string[];
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
export interface GoalDiscussionDeps {
  database?: DatabaseSync;
  quotaSnapshot: () => string | Promise<string>;
  invoke: (input: { goalId: string; revision: number; round: 'round_1' | 'round_2'; agentId: string; assignment: string; peerContributions: Record<string, unknown>[] }) => Promise<DiscussionOutput>;
  estimate?: (input: { assignment: string; peerCount: number }) => { inputTokens: number; outputTokens: number };
}

function clean(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CommandError(`${field} 不可為空`);
  return value.trim();
}

export class InvalidGoalSynthesisError extends CommandError {}

// 前綴不可改（測試與 Blocked reason 都比對它）；後綴只放欄位名與型別要求，不放模型輸出內容
const INVALID_SYNTHESIS = 'Owner synthesis 格式不合法';

function synthesisText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidGoalSynthesisError(`${field} 不可為空`);
  return value.trim();
}

export function validateGoalSynthesis(output: unknown, workspaceId: string, database = db, goalId?: string): SynthesisOutput {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new InvalidGoalSynthesisError(`${INVALID_SYNTHESIS}：根層必須是 JSON object`);
  const value = output as Record<string, unknown>;
  if (!Array.isArray(value.taskPlans)) throw new InvalidGoalSynthesisError(`${INVALID_SYNTHESIS}：taskPlans 必須是陣列`);
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
    throw new InvalidGoalSynthesisError(`${INVALID_SYNTHESIS}：evidenceRefs 必須是非空字串陣列`);
  }
  if (!Array.isArray(value.uncertainties) || value.uncertainties.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new InvalidGoalSynthesisError(`${INVALID_SYNTHESIS}：uncertainties 必須是非空字串陣列`);
  }
  const archiveTaskIds = value.archiveTaskIds == null ? [] : value.archiveTaskIds;
  if (!Array.isArray(archiveTaskIds) || archiveTaskIds.some((id) => typeof id !== 'string' || !id.trim())
    || new Set(archiveTaskIds).size !== archiveTaskIds.length) {
    throw new InvalidGoalSynthesisError('archiveTaskIds 格式不合法');
  }
  if (archiveTaskIds.length && (!goalId || archiveTaskIds.some((taskId) => !database.prepare(
    "SELECT 1 FROM tasks_read_model WHERE task_id = ? AND goal_id = ? AND status IN ('Todo', 'Doing', 'Review')",
  ).get(taskId, goalId)))) throw new InvalidGoalSynthesisError('archiveTaskIds 只能包含本 Goal 的未完成 Task');
  const retainedTask = goalId && database.prepare(
    `SELECT 1 FROM tasks_read_model WHERE goal_id = ? AND status <> 'Archived'
      AND task_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`,
  ).get(goalId, JSON.stringify(archiveTaskIds));
  if (value.taskPlans.length === 0 && !retainedTask) throw new InvalidGoalSynthesisError('synthesis 必須包含 Task');
  const earlierTitles: string[] = [];
  const taskPlans = value.taskPlans.map((item, index) => {
    const at = `taskPlans[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new InvalidGoalSynthesisError(`${INVALID_SYNTHESIS}：${at} 必須是 object`);
    const plan = item as Record<string, unknown>;
    for (const field of ['title', 'description', 'assigneeId', 'acceptanceCriteria', 'rollbackCondition']) {
      if (typeof plan[field] !== 'string') throw new InvalidGoalSynthesisError(`${INVALID_SYNTHESIS}：${at}.${field} 必須是字串`);
    }
    const title = synthesisText(plan.title, 'Task title');
    const description = synthesisText(plan.description, 'Task description');
    const assigneeId = synthesisText(plan.assigneeId, 'Task assignee');
    if (title.length > 200 || description.length > 5000) throw new InvalidGoalSynthesisError('Task 內容過長');
    if (!database.prepare('SELECT 1 FROM workspace_members_read_model WHERE workspace_id = ? AND user_id = ?').get(workspaceId, assigneeId)) {
      throw new InvalidGoalSynthesisError('Task assignee 必須是 Workspace member');
    }
    // Owner 只規劃與提供方向，不實作 task（Agent 的 agent_id 就是 user_id）
    if (database.prepare(
      `SELECT 1 FROM agents WHERE role = 'owner' AND (user_id = ? OR agent_id = ?)
       UNION ALL SELECT 1 FROM goals_read_model g JOIN agents a ON a.agent_id = g.owner_agent_id
        WHERE g.goal_id = ? AND (a.user_id = ? OR a.agent_id = ?)`,
    ).get(assigneeId, assigneeId, goalId ?? '', assigneeId, assigneeId)) {
      throw new InvalidGoalSynthesisError(`${INVALID_SYNTHESIS}：${at}.assigneeId 不得是 Owner`);
    }
    if (!Array.isArray(plan.dependsOn)
      || plan.dependsOn.some((dependency) => typeof dependency !== 'string' || !dependency.trim())) {
      throw new InvalidGoalSynthesisError(`${INVALID_SYNTHESIS}：${at}.dependsOn 必須是非空字串陣列`);
    }
    const dependsOn = (plan.dependsOn as string[]).map((dependency) => dependency.trim());
    // 只能依賴排在前面的 plan（title 完全相等），排程才有順序可依、也不會循環
    if (dependsOn.some((dependency) => !earlierTitles.includes(dependency))) {
      throw new InvalidGoalSynthesisError(`${INVALID_SYNTHESIS}：${at}.dependsOn 必須完全等於排在前面的 taskPlan title`);
    }
    earlierTitles.push(title);
    if (typeof plan.deploymentNotRequired !== 'boolean') {
      throw new InvalidGoalSynthesisError(`${INVALID_SYNTHESIS}：${at}.deploymentNotRequired 必須是 boolean`);
    }
    return {
      title,
      description,
      assigneeId,
      dependsOn,
      deploymentNotRequired: plan.deploymentNotRequired,
      acceptanceCriteria: synthesisText(plan.acceptanceCriteria, 'acceptanceCriteria'),
      rollbackCondition: synthesisText(plan.rollbackCondition, 'rollbackCondition'),
    };
  });
  return {
    summary: synthesisText(value.summary, 'summary'),
    decisionRationale: synthesisText(value.decisionRationale, 'decisionRationale'),
    changeScope: synthesisText(value.changeScope, 'changeScope'),
    uncertainties: (value.uncertainties as string[]).map((item) => item.trim()),
    taskPlans,
    archiveTaskIds: archiveTaskIds.map((id) => id.trim()),
    evidenceRefs: (value.evidenceRefs as string[]).map((ref) => ref.trim()),
  };
}

export function selectGoalParticipants(
  ownerAgentId: string, goalId: string, selections: readonly ParticipantSelection[], database = db, repos: RepoRegistry = loadRepoRegistry(),
): 'selected' | 'blocked' {
  const goal = getGoal(goalId, database);
  if (!goal) throw new CommandError('goal 不存在');
  if (goal.owner_agent_id !== ownerAgentId || goal.status !== 'Discussing') {
    throw new CommandError('Goal 目前不可選人');
  }
  if (selections.length < 1 || selections.length > 5) throw new CommandError('參與者必須為 1–5 位');
  const candidates = eligibleGoalParticipants(goalId, database, false, repos);
  const eligible = new Map(candidates.map((candidate) => [candidate.agent.agent_id, candidate.selectedLoad]));
  if (new Set(selections.map((item) => item.agentId)).size !== selections.length) throw new CommandError('參與者不可重複');
  const normalized = selections.map((item) => {
    if (!eligible.has(item.agentId)) {
      const agent = getAgent(item.agentId, database);
      const targetRepo = (database.prepare('SELECT target_repo FROM projects_read_model WHERE project_id = ?').get(goal.project_id) as { target_repo: string | null }).target_repo;
      if (agent && !JSON.parse(agent.repo_access_json || '[]').some((repo: string) => repo === '*' || repo === targetRepo)) {
        throw new CommandError('Agent 缺少 repo 權限');
      }
      if (agent && repos.get(targetRepo ?? '')?.claudeOnly === true && agent.primary_adapter !== 'claude') {
        throw new CommandError('repo 只允許 claude confined 成員');
      }
      const load = agentWorkload(item.agentId, agent?.user_id ?? item.agentId, goalId, database);
      if (load > 0) throw new CommandError('Agent 已有不可並行工作');
      throw new CommandError('Agent skill_profile 完全不符或不符合 Workspace／狀態資格');
    }
    return { ...item, selectedLoad: eligible.get(item.agentId)!, reason: clean(item.reason, 'reason'), assignment: clean(item.assignment, 'assignment') };
  });
  if (isGoalReconciliationRevision(goalId, goal.revision, database)) {
    const previous = listParticipations(goalId, goal.revision - 1, database)
      .map((row) => ({ agentId: String(row.agent_id), assignment: String(row.assignment) })).sort((a, b) => a.agentId.localeCompare(b.agentId));
    const current = normalized.map((row) => ({ agentId: row.agentId, assignment: row.assignment })).sort((a, b) => a.agentId.localeCompare(b.agentId));
    if (previous.length && JSON.stringify(previous) === JSON.stringify(current)) {
      blockGoal(ownerAgentId, goalId, 'reconciliation 未改變人選或分析面向', database);
      return 'blocked';
    }
  }
  const existing = listParticipations(goalId, goal.revision, database);
  if (existing.length) {
    const comparable = (rows: Array<Record<string, unknown>>) => rows.map((row) => ({
      agentId: String(row.agentId ?? row.agent_id), reason: String(row.reason), assignment: String(row.assignment),
      selectedLoad: Number(row.selectedLoad ?? row.selected_load),
    })).sort((a, b) => a.agentId.localeCompare(b.agentId));
    if (goal.discussion_phase === 'round_1'
      && JSON.stringify(comparable(existing)) === JSON.stringify(comparable(normalized))) return 'selected';
    throw new ConflictError('Participation 已存在');
  }
  if (goal.discussion_phase !== 'owner_scoping') throw new CommandError('Goal 目前不可選人');
  withTransaction(database, () => {
    for (const item of normalized) {
      addParticipation({ goalId, revision: goal.revision, ...item }, database);
      enqueueHeartbeat({ scopeId: goalId, goalId, phase: 'round_1', agentId: item.agentId, revision: goal.revision, triggerRef: 'phase' }, database);
    }
    appendEventInTransaction('Goal', goalId, goal.version, 'goal.discussion_phase_changed', { phase: 'round_1' }, meta(ownerAgentId), database);
  });
  return 'selected';
}

export function isGoalReconciliationRevision(goalId: string, revision: number, database = db): boolean {
  return Boolean(database.prepare('SELECT 1 FROM goal_reconciliations WHERE goal_id = ? AND revision = ?').get(goalId, revision));
}

function agentWorkload(agentId: string, userId: string, excludingGoalId: string, database: DatabaseSync): number {
  const participations = (database.prepare(
    `SELECT COUNT(*) AS n FROM goal_participations p JOIN goals_read_model g ON g.goal_id = p.goal_id
      WHERE p.agent_id = ? AND p.goal_id <> ? AND g.status = 'Discussing'
        AND g.discussion_phase IN ('owner_scoping','round_1','round_2') AND p.revision = g.revision`,
  ).get(agentId, excludingGoalId) as { n: number }).n;
  const tasks = (database.prepare(
    "SELECT COUNT(*) AS n FROM tasks_read_model WHERE assignee_id = ? AND status IN ('Doing','Review')",
  ).get(userId) as { n: number }).n;
  return participations + tasks;
}

export function eligibleGoalParticipants(goalId: string, database = db, includeBusy = false, repos: RepoRegistry = loadRepoRegistry()): EligibleGoalParticipant[] {
  const goal = getGoal(goalId, database);
  if (!goal) throw new CommandError('goal 不存在');
  const project = requireActiveProject(goal.workspace_id, goal.project_id, database);
  const targetRepo = database.prepare('SELECT target_repo FROM projects_read_model WHERE project_id = ?').get(project) as { target_repo: string | null };
  const registered = targetRepo.target_repo ? repos.get(targetRepo.target_repo) : undefined;
  const agents = listWorkspaceAgents(goal.workspace_id, database).filter((agent) => agent.role === 'member' && agent.status === 'active');
  const knownSkills = new Set(listAgents(database).flatMap((agent) => {
    const profile = JSON.parse(agent.skill_profile_json) as { skills?: unknown };
    return Array.isArray(profile.skills) ? profile.skills.filter((skill): skill is string => typeof skill === 'string').map((skill) => skill.toLowerCase()) : [];
  }));
  // data_scope 多半是禁止事項（「不得使用…API」），不能拿來推導必要 skill。
  const goalText = `${goal.objective} ${goal.success_criteria}`.toLowerCase();
  const goalTokens = new Set(goalText.match(/[a-z][a-z0-9-]*/g) ?? []);
  const requiredSkills = [...knownSkills].filter((skill) => goalTokens.has(skill));
  return agents.flatMap((agent) => {
    const access = JSON.parse(agent.repo_access_json || '[]') as string[];
    if (!targetRepo.target_repo || !access.some((repo) => repo === '*' || repo === targetRepo.target_repo)) return [];
    // 含憑證的 repo 只派 claude confined：primary 不是 claude（codex、agy）的 Agent 不進候選，Owner 就選不到。
    if (registered?.claudeOnly === true && agent.primary_adapter !== 'claude') return [];
    const profile = JSON.parse(agent.skill_profile_json) as { skills?: unknown };
    const skills = Array.isArray(profile.skills) ? profile.skills.filter((skill): skill is string => typeof skill === 'string').map((skill) => skill.toLowerCase()) : [];
    if (requiredSkills.length && !requiredSkills.some((skill) => skills.includes(skill))) return [];
    const selectedLoad = agentWorkload(agent.agent_id, agent.user_id, goalId, database);
    return includeBusy || selectedLoad === 0 ? [{ agent, selectedLoad }] : [];
  });
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
    adapter: SAFE_DISCUSSION_ROUTE.runner, model: SAFE_DISCUSSION_ROUTE.model, attempt: 'primary',
    estimatedInputTokens: estimate.inputTokens, estimatedOutputTokens: estimate.outputTokens,
    estimateBasis: 'bounded_context_chars', estimateConfidence: 'medium', quotaSnapshotJson: await deps.quotaSnapshot(),
    sourceRefsJson: '[]',
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
    database.prepare('UPDATE goal_runs SET source_refs_json = ? WHERE run_id = ?')
      .run(JSON.stringify(output.sourceRefs ?? []), runId);
    const contributionId = addContribution({ goalId, revision, round, agentId, ...output }, database);
    finishRun(runId, {
      status: 'succeeded', actualInputTokens: output.actualInputTokens ?? null,
      actualOutputTokens: output.actualOutputTokens ?? null, tokenTotal: output.tokenTotal ?? null,
      actualCost: null, credibleBilling: false,
      outcome: 'valid_contribution', errorCategory: null, evidenceRef: `contribution:${contributionId}`, sideEffectState: 'none',
    }, database);
    return 'terminal';
  } catch (error) {
    finishRun(runId, {
      status: 'failed', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
      // 只記自家 CommandError 訊息（如「stance 不合法」），不記模型輸出內容
      outcome: error instanceof CommandError ? error.message.slice(0, 200) : (error as Error)?.name ?? 'error',
      errorCategory: 'discussion', evidenceRef: null, sideEffectState: 'none',
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
  const calls = participation.map((selected) => () => runContribution(
    goalId, goal.revision, round, selected, round === 'round_2' ? roundOne : [], deps, database,
  ));
  const outcomes = round === 'round_1' ? await Promise.all(calls.map((call) => call())) : [];
  if (round === 'round_2') for (const call of calls) outcomes.push(await call());
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
    const prior = database.prepare('SELECT 1 FROM goal_reconciliations WHERE goal_id = ? AND revision = ?').get(goalId, goal.revision);
    if (prior) {
      blockGoal(goal.owner_agent_id, goalId, 'Round 1 reconciliation 後仍無有效 Contribution', database);
      return 'blocked';
    }
    database.prepare('INSERT INTO goal_reconciliations (goal_id, revision, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(goalId, goal.revision + 1, 'no_valid_contribution', new Date().toISOString());
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
  const validated = validateGoalSynthesis(output, goal.workspace_id, database, goalId);
  if (goal.discussion_phase === 'awaiting_lease') acquireRepoLease(goal.owner_agent_id, goalId, database);
  else if (!database.prepare('SELECT 1 FROM repo_leases WHERE goal_id = ?').get(goalId)) throw new CommandError('Goal 未持有 repo lease');
  try {
    database.prepare(
      `INSERT INTO goal_syntheses
         (goal_id, revision, summary, task_plans_json, evidence_json, decision_rationale, change_scope, uncertainties_json, archive_task_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(goalId, goal.revision, validated.summary, JSON.stringify(validated.taskPlans), JSON.stringify(validated.evidenceRefs),
      validated.decisionRationale, validated.changeScope, JSON.stringify(validated.uncertainties), JSON.stringify(validated.archiveTaskIds), new Date().toISOString());
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
  const ids: string[] = [];
  return withTransaction(database, () => {
    const validated = validateGoalSynthesis({
      summary: synthesis.summary,
      decisionRationale: synthesis.decision_rationale,
      changeScope: synthesis.change_scope,
      uncertainties: JSON.parse(String(synthesis.uncertainties_json)),
      taskPlans: JSON.parse(String(synthesis.task_plans_json)),
      archiveTaskIds: JSON.parse(String(synthesis.archive_task_ids_json)),
      evidenceRefs: JSON.parse(String(synthesis.evidence_json)),
    }, goal.workspace_id, database, goalId);
    for (const taskId of validated.archiveTaskIds ?? []) archiveTask(ownerAgentId, taskId, database);
    const taskIdByTitle = new Map<string, string>();
    for (const plan of validated.taskPlans) {
      const taskId = randomUUID();
      appendEventInTransaction('Task', taskId, 0, 'task.created', {
        workspaceId: goal.workspace_id, projectId: goal.project_id, goalId,
        title: plan.title, description: `${plan.description}\n\nDepends on: ${plan.dependsOn.join(', ') || 'none'}\n驗收：${plan.acceptanceCriteria}\nRollback：${plan.rollbackCondition}`,
        status: 'Todo', priority: 'Medium', assigneeId: plan.assigneeId, dueAt: null,
        deploymentNotRequired: plan.deploymentNotRequired,
        dependsOnTaskIds: plan.dependsOn.map((title) => taskIdByTitle.get(title)),
      }, meta(ownerAgentId), database);
      taskIdByTitle.set(plan.title, taskId);
      ids.push(taskId);
    }
    appendEventInTransaction('Goal', goalId, goal.version, 'goal.execution_started', {}, meta(ownerAgentId), database);
    return ids;
  });
}

export function validateGoalDeliveryEvidence(goalId: string, database = db, repos: RepoRegistry = loadRepoRegistry()): string[] {
  const goal = getGoal(goalId, database);
  if (!goal) throw new CommandError('goal 不存在');
  const project = getProject(goal.project_id, database);
  if (!project) throw new CommandError('project 不存在');
  const repoDeploymentNotRequired = project.target_repo
    ? repos.get(project.target_repo)?.deployment === 'not_required'
    : false;
  const tasks = database.prepare("SELECT task_id, deployment_not_required FROM tasks_read_model WHERE goal_id = ? AND status <> 'Archived'")
    .all(goalId) as unknown as Array<{ task_id: string; deployment_not_required: number }>;
  const refs: string[] = [];
  for (const task of tasks) {
    const evidence = listDeliveryEvidence(task.task_id, database);
    const kinds = new Set(evidence.map((item) => item.kind));
    const latestCi = evidence.filter((item) => item.kind === 'ci.checked').at(-1);
    if (!latestCi?.detail.startsWith('passed')) kinds.delete('ci.checked');
    const deploymentKind = task.deployment_not_required === 1 || repoDeploymentNotRequired
      ? 'deployment_not_required'
      : 'deployment.verified';
    const required: DeliveryEvidenceKind[] = ['ci.checked', 'merge.integrated', deploymentKind];
    const missing = required.filter((kind) => !kinds.has(kind));
    if (missing.length) throw new CommandError(`Task ${task.task_id} 缺少 ${missing.join('、')} 權威證據`);
    refs.push(...evidence.map((item) => `${item.kind}:${item.ref}`));
  }
  return refs;
}

export function verifyGoalDelivery(ownerAgentId: string, goalId: string, input: {
  passed: boolean; evidenceRefs: string[]; deployment: 'verified' | 'not_required' | 'missing';
}, database = db, repos: RepoRegistry = loadRepoRegistry()): 'done' | 'retry' | 'blocked' {
  let goal = getGoal(goalId, database);
  if (!goal) throw new CommandError('goal 不存在');
  if (goal.status === 'Executing') startVerification(ownerAgentId, goalId, database);
  goal = getGoal(goalId, database)!;
  if (goal.status !== 'Verifying') throw new CommandError('Goal 不在 Verifying');
  const tasks = database.prepare("SELECT task_id, status, deployment_not_required FROM tasks_read_model WHERE goal_id = ? AND status <> 'Archived'").all(goalId) as unknown as Array<{ task_id: string; status: string; deployment_not_required: number }>;
  if (tasks.some((task) => task.status !== 'Done')) throw new CommandError('Goal 仍有未完成 Task');
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) throw new CommandError('Goal 驗收缺少 evidence');
  const deliveryRefs = validateGoalDeliveryEvidence(goalId, database, repos);
  const evidenceRefs = [...new Set([...input.evidenceRefs, ...deliveryRefs])];
  database.prepare(
    `INSERT INTO goal_verifications (goal_id, revision, passed, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(goal_id, revision) DO NOTHING`,
  ).run(goalId, goal.revision, input.passed ? 1 : 0, JSON.stringify(evidenceRefs), new Date().toISOString());
  if (input.passed) {
    completeGoal(ownerAgentId, goalId, evidenceRefs, database);
    return 'done';
  }
  const reset = database.prepare(
    `SELECT CAST(json_extract(resumed.payload_json, '$.revision') AS INTEGER) AS revision
       FROM event_store resumed
       JOIN event_store blocked
         ON blocked.aggregate_id = resumed.aggregate_id
        AND blocked.aggregate_version = resumed.aggregate_version - 1
        AND blocked.event_type = 'goal.blocked'
      WHERE resumed.aggregate_id = ? AND resumed.event_type = 'goal.resumed'
      ORDER BY resumed.aggregate_version DESC LIMIT 1`,
  ).get(goalId) as { revision: number } | undefined;
  const failures = (database.prepare(
    'SELECT COUNT(*) AS count FROM goal_verifications WHERE goal_id = ? AND passed = 0 AND revision >= ?',
  ).get(goalId, reset?.revision ?? 0) as { count: number }).count;
  if (failures >= 2) {
    blockGoal(ownerAgentId, goalId, '第二次驗收仍失敗', database);
    return 'blocked';
  }
  reviseGoal(ownerAgentId, goalId, goal.success_criteria, database);
  const revised = getGoal(goalId, database)!;
  enqueueHeartbeat({
    scopeId: goalId, goalId, phase: 'owner_synthesis', agentId: revised.owner_agent_id,
    revision: revised.revision, triggerRef: 'phase',
  }, database);
  return 'retry';
}

export function createFollowupGoal(ownerAgentId: string, parentGoalId: string, input: {
  objective: string; successCriteria: string; reason: string; evidenceRefs: string[];
}, database = db, repos: RepoRegistry = loadRepoRegistry()): string {
  const parent = getGoal(parentGoalId, database);
  if (!parent || parent.status !== 'Done') throw new CommandError('只有 Done Goal 可建立 follow-up');
  const successCriteria = clean(input.successCriteria, 'successCriteria');
  if (successCriteria === parent.success_criteria) throw new CommandError('follow-up 必須使用不同成功條件');
  clean(input.reason, 'reason');
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) throw new CommandError('follow-up 必須有增量證據');
  const fingerprint = createHash('sha256').update(JSON.stringify([...input.evidenceRefs].sort())).digest('hex');
  const objective = clean(input.objective, 'objective');
  requireActiveProject(parent.workspace_id, parent.project_id, database);
  return withTransaction(database, () => {
    const existing = database.prepare(
      `SELECT f.child_goal_id FROM goal_followups f
         JOIN goals_read_model p ON p.goal_id = f.parent_goal_id
        WHERE p.workspace_id = ? AND p.project_id = ?
          AND f.success_criteria = ? AND f.evidence_fingerprint = ?`,
    ).get(parent.workspace_id, parent.project_id, successCriteria, fingerprint) as { child_goal_id: string } | undefined;
    if (existing) throw new ConflictError('follow-up 指紋重複');
    const childGoalId = createGoal(ownerAgentId, {
      workspaceId: parent.workspace_id, projectId: parent.project_id, parentGoalId,
      // data_scope 放的是硬性限制（例如不得用券商正式 API），follow-up 沒有自己的欄位，必須沿用父 Goal
      source: 'followup', objective, successCriteria, dataScope: parent.data_scope || undefined, ownerAgentId,
    }, database, repos);
    database.prepare(
      `INSERT INTO goal_followups (parent_goal_id, success_criteria, evidence_fingerprint, child_goal_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(parentGoalId, successCriteria, fingerprint, childGoalId, new Date().toISOString());
    return childGoalId;
  });
}

export function saveFollowupCandidate(ownerAgentId: string, parentGoalId: string, input: {
  objective: string; successCriteria: string; reason: string; evidenceRefs: string[];
}, database = db): 'saved' {
  const parent = getGoal(parentGoalId, database);
  if (!parent || parent.status !== 'Done') throw new CommandError('只有 Done Goal 可保存 follow-up 候選');
  const objective = clean(input.objective, 'objective');
  const successCriteria = clean(input.successCriteria, 'successCriteria');
  const reason = clean(input.reason, 'reason');
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) throw new CommandError('follow-up 必須有增量證據');
  const evidenceRefs = input.evidenceRefs.map((ref) => clean(ref, 'evidenceRef'));
  const fingerprint = createHash('sha256').update(JSON.stringify([...evidenceRefs].sort())).digest('hex');
  database.prepare(
    `INSERT OR IGNORE INTO goal_followup_candidates
       (candidate_id, parent_goal_id, workspace_id, project_id, objective, success_criteria, reason,
        evidence_json, evidence_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), parentGoalId, parent.workspace_id, parent.project_id, objective, successCriteria, reason,
    JSON.stringify(evidenceRefs), fingerprint, new Date().toISOString());
  return 'saved';
}
