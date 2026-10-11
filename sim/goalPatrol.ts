import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { getAgent } from '../src/agent';
import { db as appDb } from '../src/db';
import { enqueueHeartbeat } from '../src/goalRun';

export function patrolSlot(now: Date): string {
  const hour = now.getUTCHours() < 12 ? '00' : '12';
  return `${now.toISOString().slice(0, 10)}T${hour}:00Z`;
}

export function evidenceFingerprint(values: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...values].sort())).digest('hex');
}

export function runGoalPatrol(input: {
  workspaceId: string; evidenceFingerprint: string; now: Date; database?: DatabaseSync;
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
  database.prepare(
    `INSERT INTO goal_patrol_evidence (workspace_id, fingerprint, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET fingerprint = excluded.fingerprint, checked_at = excluded.checked_at`,
  ).run(input.workspaceId, input.evidenceFingerprint, input.now.toISOString());
  if (reason) database.prepare("UPDATE goal_heartbeats SET status = 'succeeded', updated_at = ? WHERE heartbeat_id = ?").run(input.now.toISOString(), heartbeatId);
  return reason ? { status: 'skipped', reason, heartbeatId } : { status: 'eligible', heartbeatId };
}

if (require.main === module) {
  if (!process.argv.includes('--once')) {
    console.log('goal patrol 預設 dry-run；使用 --once 只記錄機械巡檢 heartbeat，不啟動模型。');
  } else {
    const workspaceId = process.env.GOAL_PATROL_WORKSPACE_ID;
    if (!workspaceId) throw new Error('GOAL_PATROL_WORKSPACE_ID 必填');
    console.log(runGoalPatrol({ workspaceId, evidenceFingerprint: evidenceFingerprint([]), now: new Date() }));
  }
}
