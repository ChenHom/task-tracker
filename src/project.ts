import { randomUUID } from 'node:crypto';
import { db } from './db';
import { CommandError } from './eventStore';
import { getWorkspaceStatus } from './workspace';

// Project 不走 Event Sourcing（DESIGN 指定）：這裡就是傳統 CRUD，直接讀寫 projects_read_model。
// 沒有 event_store / appendEvent / projection / 樂觀鎖 version。權限仍沿用 requirePermission（在 server 層）。

function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new CommandError('name 必須是字串');
  const trimmed = name.trim();
  if (!trimmed) throw new CommandError('name 不可為空');
  if (trimmed.length > 200) throw new CommandError('name 過長（上限 200 字）');
  return trimmed;
}

export interface ProjectRow {
  project_id: string;
  workspace_id: string;
  name: string;
}

export function createProject(workspaceId: string, name: unknown, database = db): string {
  // 一致 task：不讓 project 落進 archived/deleted/不存在的 workspace。
  const status = getWorkspaceStatus(workspaceId, database);
  if (status === null) throw new CommandError('workspace 不存在');
  if (status !== 'active') throw new CommandError(`workspace 目前為 ${status}，不可新增 project`);

  const clean = validateName(name);
  const id = randomUUID();
  database.prepare('INSERT INTO projects_read_model (project_id, workspace_id, name) VALUES (?, ?, ?)').run(id, workspaceId, clean);
  return id;
}

export function listProjects(workspaceId: string, database = db): ProjectRow[] {
  return database
    .prepare('SELECT project_id, workspace_id, name FROM projects_read_model WHERE workspace_id = ? ORDER BY rowid')
    .all(workspaceId) as unknown as ProjectRow[];
}

export function renameProject(projectId: string, name: unknown, database = db): void {
  const clean = validateName(name);
  const info = database.prepare('UPDATE projects_read_model SET name = ? WHERE project_id = ?').run(clean, projectId);
  if (info.changes === 0) throw new CommandError('project 不存在');
}

export function deleteProject(projectId: string, database = db): void {
  database.prepare('UPDATE tasks_read_model SET project_id = NULL WHERE project_id = ?').run(projectId);
  const info = database.prepare('DELETE FROM projects_read_model WHERE project_id = ?').run(projectId);
  if (info.changes === 0) throw new CommandError('project 不存在');
}

// PATCH / DELETE 用：查資源歸屬的 workspace 以做權限檢查。null = project 不存在。
export function getProjectWorkspaceId(projectId: string, database = db): string | null {
  const row = database.prepare('SELECT workspace_id FROM projects_read_model WHERE project_id = ?').get(projectId) as
    | { workspace_id: string }
    | undefined;
  return row?.workspace_id ?? null;
}
