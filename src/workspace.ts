import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { appendEvent, loadEvents, registerProjection, type StoredEvent } from './eventStore';

// 業務規則違反（狀態機不允許的轉換、輸入驗證失敗）。對應 HTTP 400。
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

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

// ponytail: Phase 3 metadata 先記 actor_id；Phase 7 audit 再補 ip / user_agent / request_id。
function meta(actorId: string) {
  return { actor_id: actorId };
}

// ── Command handlers：load events → 驗證狀態機 → append ─────────────
export function createWorkspace(actorId: string, name: unknown, database = db): string {
  const clean = validateName(name);
  const id = randomUUID();
  appendEvent('Workspace', id, 0, 'workspace.created', { name: clean }, meta(actorId), database);
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

// ── Query：只讀 read model（已刪除的不列出）──────────────────────
export interface WorkspaceRow {
  workspace_id: string;
  name: string;
  status: WorkspaceStatus;
  created_at: string;
}
export function listWorkspaces(database = db): WorkspaceRow[] {
  return database
    .prepare("SELECT workspace_id, name, status, created_at FROM workspaces_read_model WHERE status != 'deleted' ORDER BY created_at")
    .all() as unknown as WorkspaceRow[];
}
