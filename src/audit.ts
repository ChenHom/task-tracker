import { db } from './db';
import { loadEvents, type StoredEvent } from './eventStore';

// 不做 activity_logs：event_store 本身就是 audit log，直接查它就得到「誰、何時、改了什麼」。

// 推導某 aggregate 歸屬的 workspace，供 audit 授權（跨 workspace 窺看要擋）。null = aggregate 不存在。
export function getAggregateWorkspace(aggregateId: string, database = db): string | null {
  const first = database
    .prepare('SELECT aggregate_type, payload_json FROM event_store WHERE aggregate_id = ? ORDER BY aggregate_version LIMIT 1')
    .get(aggregateId) as { aggregate_type: string; payload_json: string } | undefined;
  if (!first) return null;
  switch (first.aggregate_type) {
    case 'Workspace':
      return aggregateId; // workspace aggregate 的 id 就是 workspace_id
    case 'Member':
      return aggregateId.split(':')[0]; // aggregate_id = workspace_id:user_id
    case 'Task':
      return ((JSON.parse(first.payload_json) as { workspaceId?: string }).workspaceId) ?? null;
    default:
      return null;
  }
}

// 完整事件流（payload / metadata 已 parse）：metadata 帶 actor_id / ip / user_agent / request_id。
export function getAuditTrail(aggregateId: string, database = db): StoredEvent[] {
  return loadEvents(aggregateId, database);
}
