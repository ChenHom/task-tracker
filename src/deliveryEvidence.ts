import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { CommandError } from './eventStore';
import { enqueueHeartbeat } from './goalRun';

export type DeliveryEvidenceKind = 'task.execution_started' | 'commit.recorded' | 'task.blocked'
  | 'ci.checked' | 'merge.integrated' | 'deployment.verified' | 'deployment_not_required';

export interface DeliveryEvidenceRow {
  task_id: string;
  kind: DeliveryEvidenceKind;
  ref: string;
  detail: string;
  created_at: string;
}

export function recordDeliveryEvidence(taskId: string, input: { kind: unknown; ref: unknown; detail?: unknown }, database = db): void {
  if (!database.prepare('SELECT 1 FROM tasks_read_model WHERE task_id = ?').get(taskId)) throw new CommandError('task 不存在');
  if (!['task.execution_started', 'commit.recorded', 'task.blocked', 'ci.checked', 'merge.integrated', 'deployment.verified', 'deployment_not_required'].includes(String(input.kind))) {
    throw new CommandError('delivery evidence kind 不合法');
  }
  const kind = input.kind as DeliveryEvidenceKind;
  if (typeof input.ref !== 'string' || !input.ref.trim()) throw new CommandError('delivery evidence ref 不可為空');
  const ref = input.ref.trim();
  const detail = input.detail == null ? '' : String(input.detail).trim();
  database.exec('BEGIN IMMEDIATE');
  try {
    const inserted = database.prepare(
      `INSERT INTO task_delivery_evidence (task_id, kind, ref, detail, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, kind, ref) DO NOTHING`,
    ).run(taskId, kind, ref, detail, new Date().toISOString());
    if (kind === 'task.blocked' && inserted.changes > 0) {
      const goal = database.prepare(
        `SELECT g.goal_id, g.owner_agent_id, g.revision
           FROM tasks_read_model t JOIN goals_read_model g ON g.goal_id = t.goal_id
          WHERE t.task_id = ?`,
      ).get(taskId) as { goal_id: string; owner_agent_id: string; revision: number } | undefined;
      if (goal) enqueueHeartbeat({
        scopeId: goal.goal_id, goalId: goal.goal_id, phase: 'task_blocked', agentId: goal.owner_agent_id,
        revision: goal.revision, triggerRef: `evidence:${taskId}:${ref}`,
      }, database);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function listDeliveryEvidence(taskId: string, database = db): DeliveryEvidenceRow[] {
  return database.prepare('SELECT * FROM task_delivery_evidence WHERE task_id = ? ORDER BY rowid').all(taskId) as unknown as DeliveryEvidenceRow[];
}
