import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { db as appDb } from '../src/db';
import { getAgent, listWorkspaceAgents } from '../src/agent';
import { CommandError } from '../src/eventStore';
import { getGoal, registerGoalProjections, startDiscussion, blockGoal } from '../src/goal';
import { listDeliveryEvidence } from '../src/deliveryEvidence';
import {
  advanceGoalDiscussion, createFollowupGoal, materializeGoalTasks, selectGoalParticipants,
  storeGoalSynthesis, verifyGoalDelivery, type DiscussionOutput, type ParticipantSelection, type SynthesisOutput,
} from '../src/goalOrchestrator';
import { enqueueHeartbeat, finishRun, getRun, listContributions, listParticipations, markRunRunning, prepareRun } from '../src/goalRun';
import { getProject } from '../src/project';
import { getQuotaSnapshot } from '../src/quota';
import { registerTaskProjections } from '../src/task';
import { buildGoalDiscussionPacket, readGoalRepoSources, runGoalDiscussion } from './goalDiscussion';
import { runSafeDiscussionSession, SAFE_DISCUSSION_ROUTE } from './run';

type JsonObject = Record<string, unknown>;

export interface GoalCoordinatorDeps {
  database?: DatabaseSync;
  quotaSnapshot: () => Promise<string>;
  invokeJson: (input: { phase: string; prompt: string; sourceTexts: string[] }) => Promise<JsonObject>;
}

function parseJsonOutput(output: string): JsonObject {
  const clean = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(clean) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommandError('Owner 輸出不是 JSON object');
  return value as JsonObject;
}

function repoSources(targetRepo: string) {
  const paths = ['AGENTS.md', 'docs/tasks/current.md', 'package.json'].filter((path) => existsSync(join(targetRepo, path)));
  return readGoalRepoSources(targetRepo, paths);
}

async function ownerJsonRun(input: {
  goalId: string; phase: string; prompt: string; sourceTexts: string[]; triggerRef?: string;
}, deps: GoalCoordinatorDeps, database: DatabaseSync): Promise<JsonObject> {
  const goal = getGoal(input.goalId, database);
  if (!goal) throw new CommandError('goal 不存在');
  const heartbeatId = enqueueHeartbeat({
    scopeId: goal.goal_id, goalId: goal.goal_id, phase: input.phase, agentId: goal.owner_agent_id,
    revision: goal.revision, triggerRef: input.triggerRef ?? 'phase',
  }, database);
  const prior = database.prepare("SELECT run_id FROM goal_runs WHERE heartbeat_id = ? AND attempt = 'primary'").get(heartbeatId) as { run_id: string } | undefined;
  if (prior) {
    const run = getRun(prior.run_id, database)!;
    const stored = database.prepare('SELECT output_json FROM goal_stage_outputs WHERE heartbeat_id = ?').get(heartbeatId) as { output_json: string } | undefined;
    if (stored) {
      if (run.status === 'running') finishRun(prior.run_id, {
        status: 'succeeded', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
        outcome: 'reconciled_stored_output', errorCategory: null, evidenceRef: `${input.phase}:structured`, sideEffectState: 'none',
      }, database);
      return JSON.parse(stored.output_json) as JsonObject;
    }
    if (run.status === 'running') {
      const expired = run.started_at && Date.now() - Date.parse(run.started_at) >= 15 * 60 * 1000;
      if (!expired) throw new CommandError(`${input.phase} 已在執行`);
      finishRun(prior.run_id, {
        status: 'uncertain', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
        outcome: null, errorCategory: 'crash_recovery', evidenceRef: null, sideEffectState: 'unknown',
      }, database);
      throw new CommandError(`${input.phase} 前次執行逾時且副作用不確定`);
    }
    if (run.status !== 'pending') throw new CommandError(`${input.phase} 已有終態 Run`);
  }
  const estimate = Math.ceil(input.prompt.length / 4);
  const runId = prior?.run_id ?? prepareRun({
    heartbeatId, goalId: goal.goal_id, agentId: goal.owner_agent_id, phase: input.phase,
    adapter: 'claude', model: SAFE_DISCUSSION_ROUTE.model, attempt: 'primary',
    estimatedInputTokens: estimate, estimatedOutputTokens: 800,
    estimateBasis: 'bounded_context_chars', estimateConfidence: 'medium', quotaSnapshotJson: await deps.quotaSnapshot(),
  }, database);
  const claimed = getRun(runId, database)!;
  if (claimed.status !== 'pending') throw new CommandError(`${input.phase} 已由其他 worker claim`);
  try {
    markRunRunning(runId, database);
  } catch (error) {
    if (getRun(runId, database)?.status === 'running') throw new CommandError(`${input.phase} 已由其他 worker claim`);
    throw error;
  }
  try {
    const output = await deps.invokeJson({ phase: input.phase, prompt: input.prompt, sourceTexts: input.sourceTexts });
    database.prepare('INSERT INTO goal_stage_outputs (heartbeat_id, output_json, created_at) VALUES (?, ?, ?)')
      .run(heartbeatId, JSON.stringify(output), new Date().toISOString());
    finishRun(runId, {
      status: 'succeeded', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
      outcome: 'valid_structured_output', errorCategory: null, evidenceRef: `${input.phase}:structured`, sideEffectState: 'none',
    }, database);
    return output;
  } catch (error) {
    finishRun(runId, {
      status: 'failed', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
      outcome: null, errorCategory: 'discussion', evidenceRef: null, sideEffectState: 'none',
    }, database);
    throw error;
  }
}

function selections(value: JsonObject, candidates: Set<string>): ParticipantSelection[] {
  if (!Array.isArray(value.selections)) throw new CommandError('Owner scoping 缺少 selections');
  return value.selections.map((item) => {
    const row = item as JsonObject;
    if (!candidates.has(String(row.agentId))) throw new CommandError('Owner 選擇了不合格 Agent');
    return { agentId: String(row.agentId), reason: String(row.reason ?? ''), assignment: String(row.assignment ?? ''), selectedLoad: Number(row.selectedLoad ?? 0) };
  });
}

function synthesis(value: JsonObject): SynthesisOutput {
  if (!Array.isArray(value.taskPlans) || !Array.isArray(value.evidenceRefs)) throw new CommandError('Owner synthesis 格式不合法');
  return { summary: String(value.summary ?? ''), taskPlans: value.taskPlans as SynthesisOutput['taskPlans'], evidenceRefs: value.evidenceRefs.map(String) };
}

export async function runGoalCoordinatorOnce(goalId: string, deps: GoalCoordinatorDeps): Promise<string> {
  const database = deps.database ?? appDb;
  let goal = getGoal(goalId, database);
  if (!goal) throw new CommandError('goal 不存在');
  const project = getProject(goal.project_id, database);
  if (!project?.target_repo) throw new CommandError('Goal Project 沒有 target repo');
  const sources = repoSources(project.target_repo);

  if (goal.status === 'Queued') {
    startDiscussion(goal.owner_agent_id, goalId, database);
    goal = getGoal(goalId, database)!;
  }

  if (goal.status === 'Discussing' && goal.discussion_phase === 'owner_scoping') {
    const candidates = listWorkspaceAgents(goal.workspace_id, database).filter((agent) => agent.role === 'member' && agent.status === 'active');
    const candidateIds = new Set(candidates.map((agent) => agent.agent_id));
    const loads = new Map(candidates.map((agent) => [agent.agent_id, (database.prepare("SELECT COUNT(*) AS n FROM goal_runs WHERE agent_id = ? AND status IN ('pending','running')").get(agent.agent_id) as { n: number }).n]));
    const output = await ownerJsonRun({
      goalId, phase: 'owner_scoping', sourceTexts: sources.map((source) => source.content),
      prompt: `為 Goal 選擇 1-5 位 Agent，不可選 Owner。只回 JSON {"selections":[{"agentId":"...","reason":"...","assignment":"...","selectedLoad":0}]}\nGoal:${goal.objective}\n成功條件:${goal.success_criteria}\n候選:${JSON.stringify(candidates.map((agent) => ({ id: agent.agent_id, skill: JSON.parse(agent.skill_profile_json), load: loads.get(agent.agent_id) })))}`,
    }, deps, database);
    selectGoalParticipants(goal.owner_agent_id, goalId, selections(output, candidateIds), database);
    return 'round_1';
  }

  if (goal.status === 'Discussing' && (goal.discussion_phase === 'round_1' || goal.discussion_phase === 'round_2')) {
    const quota = await deps.quotaSnapshot();
    return advanceGoalDiscussion(goalId, {
      database, quotaSnapshot: () => quota,
      invoke: async ({ round, assignment, peerContributions }) => {
        const packet = buildGoalDiscussionPacket({
          objective: goal!.objective, successCriteria: goal!.success_criteria,
          assignment: peerContributions.length ? `${assignment}\n需交叉審查:${JSON.stringify(peerContributions)}` : assignment,
          round, sources,
        });
        return runGoalDiscussion({ route: SAFE_DISCUSSION_ROUTE, packet }, async (invocation) => {
          const value = await deps.invokeJson({ phase: round, prompt: invocation.prompt, sourceTexts: sources.map((source) => source.content) });
          return value as unknown as DiscussionOutput;
        });
      },
    });
  }

  if (goal.status === 'Discussing' && goal.discussion_phase === 'awaiting_lease') {
    const contributions = listContributions(goalId, goal.revision, database);
    const output = await ownerJsonRun({
      goalId, phase: 'owner_synthesis', sourceTexts: sources.map((source) => source.content),
      prompt: `收斂 Goal 並直接產生實作 Task。只回 JSON {"summary":"...","taskPlans":[{"title":"...","description":"...","assigneeId":"...","acceptanceCriteria":"...","rollbackCondition":"..."}],"evidenceRefs":["..."]}\nGoal:${goal.objective}\n成功條件:${goal.success_criteria}\n參與:${JSON.stringify(listParticipations(goalId, goal.revision, database))}\n貢獻:${JSON.stringify(contributions)}`,
    }, deps, database);
    storeGoalSynthesis(goalId, synthesis(output), database);
    materializeGoalTasks(goal.owner_agent_id, goalId, database);
    return 'Executing';
  }

  if (goal.status === 'Executing' || goal.status === 'Verifying') {
    const tasks = database.prepare('SELECT task_id, status FROM tasks_read_model WHERE goal_id = ?').all(goalId) as unknown as Array<{ task_id: string; status: string }>;
    if (!tasks.length || tasks.some((task) => task.status !== 'Done')) return 'waiting_tasks';
    const evidence = tasks.flatMap((task) => listDeliveryEvidence(task.task_id, database));
    const output = await ownerJsonRun({
      goalId, phase: 'verifying', sourceTexts: sources.map((source) => source.content),
      prompt: `根據成功條件與權威交付證據驗收。只回 JSON {"passed":true,"evidenceRefs":["..."]}\n成功條件:${goal.success_criteria}\n交付證據:${JSON.stringify(evidence)}`,
    }, deps, database);
    const evidenceRefs = Array.isArray(output.evidenceRefs) ? output.evidenceRefs.map(String) : [];
    return verifyGoalDelivery(goal.owner_agent_id, goalId, { passed: output.passed === true, evidenceRefs, deployment: 'verified' }, database);
  }

  if (goal.status === 'Done') {
    const heartbeat = database.prepare("SELECT heartbeat_id, status FROM goal_heartbeats WHERE goal_id = ? AND phase = 'followup' ORDER BY rowid DESC LIMIT 1").get(goalId) as { heartbeat_id: string; status: string } | undefined;
    if (!heartbeat || heartbeat.status !== 'pending') return 'Done';
    const output = await ownerJsonRun({
      goalId, phase: 'followup', triggerRef: `followup:${goalId}`, sourceTexts: sources.map((source) => source.content),
      prompt: `評估 Goal 完成後是否需要 child Goal。只回 JSON：{"action":"end"}或{"action":"create","objective":"...","successCriteria":"...","reason":"...","evidenceRefs":["..."]}\nGoal:${goal.objective}\n完成證據:${goal.evidence_refs_json}`,
    }, deps, database);
    if (output.action === 'create') createFollowupGoal(goal.owner_agent_id, goalId, {
      objective: String(output.objective ?? ''), successCriteria: String(output.successCriteria ?? ''), reason: String(output.reason ?? ''),
      evidenceRefs: Array.isArray(output.evidenceRefs) ? output.evidenceRefs.map(String) : [],
    }, database);
    return output.action === 'create' ? 'followup_created' : 'followup_ended';
  }

  return goal.status;
}

async function invokeLiveJson(input: { phase: string; prompt: string; sourceTexts: string[] }): Promise<JsonObject> {
  const result = await runSafeDiscussionSession({ route: SAFE_DISCUSSION_ROUTE, prompt: input.prompt, sourceTexts: input.sourceTexts, label: `goal-${input.phase}` });
  if (result.errored || result.timedOut || !result.output) throw new Error(`safe discussion ${input.phase} failed`);
  return parseJsonOutput(result.output);
}

if (require.main === module) {
  const goalArg = process.argv.indexOf('--goal');
  const pending = process.argv.includes('--pending');
  const pendingRow = pending ? appDb.prepare(
    `SELECT h.goal_id FROM goal_heartbeats h JOIN goals_read_model g ON g.goal_id = h.goal_id
      WHERE h.status = 'pending' AND g.status NOT IN ('Cancelled', 'Blocked')
      ORDER BY h.rowid LIMIT 1`,
  ).get() as { goal_id: string } | undefined : undefined;
  const goalId = goalArg >= 0 ? process.argv[goalArg + 1] : pendingRow?.goal_id;
  if (!goalId || goalId.startsWith('--')) {
    if (pending) console.log(JSON.stringify({ pending: false, live: process.argv.includes('--live') }));
    else throw new Error('--goal <goalId> 或 --pending 必填');
    process.exit(0);
  }
  const goal = getGoal(goalId);
  if (!process.argv.includes('--live')) {
    console.log(JSON.stringify({ goalId, status: goal?.status ?? 'missing', phase: goal?.discussion_phase ?? null, live: false }));
  } else {
    registerGoalProjections();
    registerTaskProjections();
    runGoalCoordinatorOnce(goalId, {
      quotaSnapshot: async () => JSON.stringify(await getQuotaSnapshot()),
      invokeJson: invokeLiveJson,
    }).then((status) => console.log(JSON.stringify({ goalId, status }))).catch((error) => {
      const current = getGoal(goalId);
      if (current && !['Done', 'Cancelled', 'Blocked'].includes(current.status)) blockGoal(current.owner_agent_id, goalId, (error as Error).message);
      console.error((error as Error).message);
      process.exitCode = 1;
    });
  }
}
