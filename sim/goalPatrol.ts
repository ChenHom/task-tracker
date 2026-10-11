import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { getAgent } from '../src/agent';
import { db as appDb } from '../src/db';
import { enqueueHeartbeat } from '../src/goalRun';
import { finishRun, getRun, markRunRunning, prepareRun } from '../src/goalRun';
import { createGoal, registerGoalProjections, startDiscussion } from '../src/goal';
import { listProjects } from '../src/project';
import { listTasks, registerTaskProjections } from '../src/task';
import { getQuotaSnapshot } from '../src/quota';
import { runSafeDiscussionSession, SAFE_DISCUSSION_ROUTE } from './run';

export function patrolSlot(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = Number(value('hour')) < 12 ? '00' : '12';
  return `${value('year')}-${value('month')}-${value('day')}T${hour}:00+08:00`;
}

export function evidenceFingerprint(values: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...values].sort())).digest('hex');
}

export function runGoalPatrol(input: {
  workspaceId: string; evidenceFingerprint: string; now: Date; database?: DatabaseSync; keepEligiblePending?: boolean;
}): { status: 'eligible' | 'skipped'; reason?: string; heartbeatId: string } {
  const database = input.database ?? appDb;
  const owner = database.prepare("SELECT agent_id FROM agents WHERE role = 'owner' LIMIT 1").get() as { agent_id: string } | undefined;
  if (!owner || !getAgent(owner.agent_id, database)) throw new Error('Owner Agent 不存在');
  const revision = 0;
  const triggerRef = `patrol:${patrolSlot(input.now)}`;
  const prior = database.prepare('SELECT fingerprint FROM goal_patrol_evidence WHERE workspace_id = ?').get(input.workspaceId) as { fingerprint: string } | undefined;
  let reason: string | undefined;
  if (database.prepare("SELECT 1 FROM goal_heartbeats WHERE scope_id = ? AND phase = 'discovery' AND status IN ('pending','running') LIMIT 1").get(input.workspaceId)) reason = 'discovery_running';
  else if (database.prepare("SELECT 1 FROM goals_read_model WHERE workspace_id = ? AND source <> 'human' AND status NOT IN ('Done','Cancelled') LIMIT 1").get(input.workspaceId)) reason = 'active_autonomous_goal';
  else if (database.prepare("SELECT 1 FROM goals_read_model WHERE workspace_id = ? AND source = 'human' AND status = 'Executing' LIMIT 1").get(input.workspaceId)) reason = 'human_goal_executing';
  else if (prior?.fingerprint === input.evidenceFingerprint) reason = 'evidence_unchanged';
  const heartbeatId = enqueueHeartbeat({ scopeId: input.workspaceId, phase: 'discovery', agentId: owner.agent_id, revision, triggerRef }, database);
  if (!reason || reason === 'evidence_unchanged') {
    database.prepare(
      `INSERT INTO goal_patrol_evidence (workspace_id, fingerprint, checked_at) VALUES (?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET fingerprint = excluded.fingerprint, checked_at = excluded.checked_at`,
    ).run(input.workspaceId, input.evidenceFingerprint, input.now.toISOString());
  }
  // 第一版 CLI 是明確 dry-run，沒有 model consumer；不可留下永久 pending 假裝 discovery 正在執行。
  if (reason || !input.keepEligiblePending) {
    database.prepare("UPDATE goal_heartbeats SET status = 'succeeded', updated_at = ? WHERE heartbeat_id = ?").run(input.now.toISOString(), heartbeatId);
  }
  return reason ? { status: 'skipped', reason, heartbeatId } : { status: 'eligible', heartbeatId };
}

export function workspaceEvidence(workspaceId: string, database = appDb): string {
  const projects = listProjects(workspaceId, database);
  const repoHeads = projects.filter((project) => project.status === 'active' && project.target_repo).map((project) => {
    try { return `${project.project_id}:${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project.target_repo!, encoding: 'utf8' }).trim()}`; }
    catch { return `${project.project_id}:unavailable`; }
  });
  const taskRows = listTasks(workspaceId, database).map((task) => `${task.task_id}:${task.status}:${task.updated_at ?? ''}`);
  const commentState = database.prepare(
    `SELECT COUNT(*) AS count, COALESCE(MAX(c.rowid), 0) AS max_rowid FROM comments c
      JOIN tasks_read_model t ON t.task_id = c.task_id WHERE t.workspace_id = ?`,
  ).get(workspaceId) as { count: number; max_rowid: number };
  const attachmentState = database.prepare(
    `SELECT COUNT(*) AS count, COALESCE(MAX(a.rowid), 0) AS max_rowid FROM attachments a
      JOIN tasks_read_model t ON t.task_id = a.task_id WHERE t.workspace_id = ?`,
  ).get(workspaceId) as { count: number; max_rowid: number };
  return evidenceFingerprint([...repoHeads, ...taskRows, `comments:${commentState.count}:${commentState.max_rowid}`, `attachments:${attachmentState.count}:${attachmentState.max_rowid}`]);
}

export async function runLiveDiscovery(workspaceId: string, heartbeatId: string, database = appDb, deps = {
  quotaSnapshot: async () => JSON.stringify(await getQuotaSnapshot()),
  invoke: async (prompt: string) => {
    const session = await runSafeDiscussionSession({ route: SAFE_DISCUSSION_ROUTE, prompt, sourceTexts: [prompt], label: 'goal-discovery' });
    if (session.errored || session.timedOut || !session.output) throw new Error('Goal discovery safe session failed');
    return session.output;
  },
}): Promise<string> {
  const owner = database.prepare("SELECT agent_id FROM agents WHERE role = 'owner' LIMIT 1").get() as { agent_id: string };
  const projects = listProjects(workspaceId, database).filter((project) => project.status === 'active' && project.target_repo);
  if (!projects.length) {
    database.prepare("UPDATE goal_heartbeats SET status = 'succeeded', updated_at = ? WHERE heartbeat_id = ?").run(new Date().toISOString(), heartbeatId);
    return 'no_registered_project';
  }
  const prompt = `你是 Goal discovery Owner。根據現有 Project 與 Task 證據，只回 JSON {"action":"none"}或{"action":"create","projectId":"...","objective":"...","successCriteria":"..."}。不得建立 Workspace。\nProjects:${JSON.stringify(projects)}\nTasks:${JSON.stringify(listTasks(workspaceId, database))}`;
  const prior = database.prepare("SELECT run_id FROM goal_runs WHERE heartbeat_id = ? AND attempt = 'primary'").get(heartbeatId) as { run_id: string } | undefined;
  const stored = database.prepare('SELECT output_json FROM goal_stage_outputs WHERE heartbeat_id = ?').get(heartbeatId) as { output_json: string } | undefined;
  if (prior && !stored) {
    const run = getRun(prior.run_id, database)!;
    if (run.status === 'running') {
      const expired = run.started_at && Date.now() - Date.parse(run.started_at) >= 15 * 60 * 1000;
      if (!expired) throw new Error('Discovery 已由其他 worker 執行');
      finishRun(prior.run_id, {
        status: 'uncertain', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
        outcome: null, errorCategory: 'crash_recovery', evidenceRef: null, sideEffectState: 'unknown',
      }, database);
      throw new Error('Discovery 前次執行逾時且副作用不確定');
    }
    if (run.status !== 'pending') throw new Error('Discovery 已有終態 Run');
  }
  const runId = prepareRun({
    heartbeatId, agentId: owner.agent_id, phase: 'discovery', adapter: 'claude', model: SAFE_DISCUSSION_ROUTE.model,
    attempt: 'primary', estimatedInputTokens: Math.ceil(prompt.length / 4), estimatedOutputTokens: 500,
    estimateBasis: 'bounded_context_chars', estimateConfidence: 'medium', quotaSnapshotJson: await deps.quotaSnapshot(),
  }, database);
  if (!stored) {
    try {
      markRunRunning(runId, database);
    } catch (error) {
      if (getRun(runId, database)?.status === 'running') throw new Error('Discovery 已由其他 worker claim');
      throw error;
    }
  }
  try {
    const output = stored
      ? JSON.parse(stored.output_json) as Record<string, unknown>
      : JSON.parse((await deps.invoke(prompt)).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as Record<string, unknown>;
    if (!stored) database.prepare('INSERT INTO goal_stage_outputs (heartbeat_id, output_json, created_at) VALUES (?, ?, ?)')
      .run(heartbeatId, JSON.stringify(output), new Date().toISOString());
    let outcome = 'no_goal';
    if (output.action === 'create') {
      const project = projects.find((candidate) => candidate.project_id === output.projectId);
      if (!project) throw new Error('Discovery 選擇了不合格 Project');
      const objective = String(output.objective ?? '').trim();
      const successCriteria = String(output.successCriteria ?? '').trim();
      const existing = database.prepare(
        `SELECT goal_id FROM goals_read_model WHERE workspace_id = ? AND project_id = ? AND source = 'owner_discovery'
           AND objective = ? AND success_criteria = ? AND status NOT IN ('Done','Cancelled') LIMIT 1`,
      ).get(workspaceId, project.project_id, objective, successCriteria) as { goal_id: string } | undefined;
      const goalId = existing?.goal_id ?? createGoal(owner.agent_id, {
        workspaceId, projectId: project.project_id, source: 'owner_discovery', objective,
        successCriteria, ownerAgentId: owner.agent_id,
      }, database);
      if (!existing) startDiscussion(owner.agent_id, goalId, database);
      const goal = database.prepare('SELECT revision FROM goals_read_model WHERE goal_id = ?').get(goalId) as { revision: number };
      enqueueHeartbeat({ scopeId: goalId, goalId, phase: 'owner_scoping', agentId: owner.agent_id, revision: goal.revision, triggerRef: 'start' }, database);
      outcome = `goal:${goalId}`;
    }
    if (getRun(runId, database)?.status === 'running') finishRun(runId, { status: 'succeeded', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false, outcome, errorCategory: null, evidenceRef: outcome, sideEffectState: 'none' }, database);
    return outcome;
  } catch (error) {
    if (getRun(runId, database)?.status === 'running') finishRun(runId, { status: 'failed', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false, outcome: null, errorCategory: 'discovery', evidenceRef: null, sideEffectState: 'none' }, database);
    throw error;
  }
}

if (require.main === module) {
  if (!process.argv.includes('--once')) {
    console.log('goal patrol 預設 dry-run；使用 --once 只記錄機械巡檢 heartbeat，不啟動模型。');
  } else {
    const workspaceId = process.env.GOAL_PATROL_WORKSPACE_ID;
    if (!workspaceId) throw new Error('GOAL_PATROL_WORKSPACE_ID 必填');
    const live = process.argv.includes('--live');
    if (live) { registerGoalProjections(); registerTaskProjections(); }
    const result = runGoalPatrol({ workspaceId, evidenceFingerprint: workspaceEvidence(workspaceId), now: new Date(), keepEligiblePending: live });
    if (live && result.status === 'eligible') runLiveDiscovery(workspaceId, result.heartbeatId).then((outcome) => console.log({ ...result, outcome })).catch((error) => { console.error(error); process.exitCode = 1; });
    else console.log(result);
  }
}
