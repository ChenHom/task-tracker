import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { CommandError } from './eventStore';

export type DeliveryEvidenceKind = 'ci.checked' | 'merge.integrated' | 'deployment.verified' | 'deployment_not_required';

export interface DeliveryEvidenceRow {
  task_id: string;
  kind: DeliveryEvidenceKind;
  ref: string;
  detail: string;
  created_at: string;
}

export function recordDeliveryEvidence(taskId: string, input: { kind: unknown; ref: unknown; detail?: unknown }, database = db): void {
  if (!database.prepare('SELECT 1 FROM tasks_read_model WHERE task_id = ?').get(taskId)) throw new CommandError('task 不存在');
  if (!['ci.checked', 'merge.integrated', 'deployment.verified', 'deployment_not_required'].includes(String(input.kind))) {
    throw new CommandError('delivery evidence kind 不合法');
  }
  const kind = input.kind as DeliveryEvidenceKind;
  if (typeof input.ref !== 'string' || !input.ref.trim()) throw new CommandError('delivery evidence ref 不可為空');
  const detail = input.detail == null ? '' : String(input.detail).trim();
  database.prepare(
    `INSERT INTO task_delivery_evidence (task_id, kind, ref, detail, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, kind, ref) DO NOTHING`,
  ).run(taskId, kind, input.ref.trim(), detail, new Date().toISOString());
}

export function listDeliveryEvidence(taskId: string, database = db): DeliveryEvidenceRow[] {
  return database.prepare('SELECT * FROM task_delivery_evidence WHERE task_id = ? ORDER BY rowid').all(taskId) as unknown as DeliveryEvidenceRow[];
}
