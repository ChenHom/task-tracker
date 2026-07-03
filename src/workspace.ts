import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { appendEvent, loadEvents, registerProjection, CommandError, type StoredEvent } from './eventStore';
import { buildMetadata as meta } from './requestContext';
import { seedOwner } from './member';

export type WorkspaceStatus = 'active' | 'archived' | 'deleted';

// ── Aggregate：把事件流 reduce 成現狀 ──────────────────────────────
interface WorkspaceState {
  exists: boolean;
  status: WorkspaceStatus;
  name: string;
}
const INITIAL: WorkspaceState = { exists: false, status: 'active', name: '' };

function reduce(state: WorkspaceState, e: StoredEvent): WorkspaceState {
  const p = e.payload as { name?: string };
  switch (e.event_type) {
    case 'workspace.created':
      return { exists: true, status: 'active', name: p.name ?? '' };
    case 'workspace.renamed':
      return { ...state, name: p.name ?? state.name };
    case 'workspace.archived':
      return { ...state, status: 'archived' };
    case 'workspace.deleted':
      return { ...state, status: 'deleted' };
    default:
      return state;
  }
}

function load(id: string, database: DatabaseSync): { state: WorkspaceState; version: number } {
  const events = loadEvents(id, database);
  const state = events.reduce(reduce, INITIAL);
  const version = events.length ? events[events.length - 1].aggregate_version : 0;
  return { state, version };
}

// ── 輸入驗證（信任邊界，OWASP：每個 command 都驗）──────────────────
function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new CommandError('name 必須是字串');
  const trimmed = name.trim();
  if (!trimmed) throw new CommandError('name 不可為空');
  if (trimmed.length > 200) throw new CommandError('name 過長（上限 200 字）');
  return trimmed;
}

// ── Command handlers：load events → 驗證狀態機 → append ─────────────
export function createWorkspace(actorId: string, name: unknown, database = db): string {
  const clean = validateName(name);
  const id = randomUUID();
  appendEvent('Workspace', id, 0, 'workspace.created', { name: clean }, meta(actorId), database);
  seedOwner(id, actorId, database); // 建立者自動成為 Owner，之後才有權限可查
  return id;
}

export function renameWorkspace(actorId: string, id: string, name: unknown, database = db): void {
  const clean = validateName(name);
  const { state, version } = load(id, database);
  if (!state.exists) throw new CommandError('workspace 不存在');
  if (state.status !== 'active') throw new CommandError(`workspace 目前為 ${state.status}，不可改名`);
  appendEvent('Workspace', id, version, 'workspace.renamed', { name: clean }, meta(actorId), database);
}

export function archiveWorkspace(actorId: string, id: string, database = db): void {
  const { state, version } = load(id, database);
  if (!state.exists) throw new CommandError('workspace 不存在');
  if (state.status !== 'active') throw new CommandError(`workspace 目前為 ${state.status}，不可封存`);
  appendEvent('Workspace', id, version, 'workspace.archived', {}, meta(actorId), database);
}

export function deleteWorkspace(actorId: string, id: string, database = db): void {
  const { state, version } = load(id, database);
  if (!state.exists) throw new CommandError('workspace 不存在');
  if (state.status === 'deleted') throw new CommandError('workspace 已刪除');
  appendEvent('Workspace', id, version, 'workspace.deleted', {}, meta(actorId), database);
}

// ── Projection → workspaces_read_model ─────────────────────────────
// 顯式註冊（非 import 副作用），server 啟動與各測試各自呼叫一次，配合 resetProjections。
export function registerWorkspaceProjections(): void {
  registerProjection('workspace.created', (e, database) => {
    const p = e.payload as { name: string };
    database
      .prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
      .run(e.aggregate_id, p.name, 'active', e.occurred_at);
  });
  registerProjection('workspace.renamed', (e, database) => {
    const p = e.payload as { name: string };
    database.prepare('UPDATE workspaces_read_model SET name = ? WHERE workspace_id = ?').run(p.name, e.aggregate_id);
  });
  registerProjection('workspace.archived', (e, database) => {
    database.prepare('UPDATE workspaces_read_model SET status = ? WHERE workspace_id = ?').run('archived', e.aggregate_id);
  });
  registerProjection('workspace.deleted', (e, database) => {
    database.prepare('UPDATE workspaces_read_model SET status = ? WHERE workspace_id = ?').run('deleted', e.aggregate_id);
  });
}

// ── Query：只列出「我有 membership」的 workspace（已刪除的不列出）──
export interface WorkspaceRow {
  workspace_id: string;
  name: string;
  status: WorkspaceStatus;
  created_at: string;
}
// 資源歸屬檢查用：查 workspace 現況狀態。null = 不存在。
export function getWorkspaceStatus(workspaceId: string, database = db): WorkspaceStatus | null {
  const row = database.prepare('SELECT status FROM workspaces_read_model WHERE workspace_id = ?').get(workspaceId) as
    | { status: WorkspaceStatus }
    | undefined;
  return row?.status ?? null;
}

export function listWorkspaces(userId: string, database = db): WorkspaceRow[] {
  return database
    .prepare(
      `SELECT w.workspace_id, w.name, w.status, w.created_at
         FROM workspaces_read_model w
         JOIN workspace_members_read_model m ON m.workspace_id = w.workspace_id
        WHERE m.user_id = ? AND w.status != 'deleted'
        ORDER BY w.created_at`,
    )
    .all(userId) as unknown as WorkspaceRow[];
}
