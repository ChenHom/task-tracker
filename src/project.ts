import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { CommandError } from './eventStore';
import { loadRepoRegistry, type RepoRegistry } from './repoRegistry';
import { getWorkspaceStatus } from './workspace';

function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new CommandError('name 必須是字串');
  const trimmed = name.trim();
  if (!trimmed) throw new CommandError('name 不可為空');
  if (trimmed.length > 200) throw new CommandError('name 過長（上限 200 字）');
  return trimmed;
}

function validateDescription(description: unknown): string {
  if (description == null) return '';
  if (typeof description !== 'string') throw new CommandError('description 必須是字串');
  const trimmed = description.trim();
  if (trimmed.length > 2000) throw new CommandError('description 過長（上限 2000 字）');
  return trimmed;
}

function validateTargetRepo(targetRepo: unknown, repos?: RepoRegistry): string | null {
  if (targetRepo == null || targetRepo === '') return null;
  if (typeof targetRepo !== 'string') throw new CommandError('targetRepo 必須是字串或 null');
  const clean = targetRepo.trim();
  if (!(repos ?? loadRepoRegistry()).has(clean)) throw new CommandError('target repo 未登記');
  return clean;
}

export type ProjectStatus = 'active' | 'archived';

export interface ProjectInput {
  name?: unknown;
  description?: unknown;
  targetRepo?: unknown;
}

export interface ProjectRow {
  project_id: string;
  workspace_id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  target_repo: string | null;
  created_at: string;
  updated_at: string;
}

export function createProject(
  workspaceId: string,
  input: ProjectInput,
  database = db,
  repos?: RepoRegistry,
): string {
  const workspaceStatus = getWorkspaceStatus(workspaceId, database);
  if (workspaceStatus === null) throw new CommandError('workspace 不存在');
  if (workspaceStatus !== 'active') throw new CommandError(`workspace 目前為 ${workspaceStatus}，不可新增 project`);

  const name = validateName(input.name);
  const description = validateDescription(input.description);
  const targetRepo = validateTargetRepo(input.targetRepo, repos);
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO projects_read_model
       (project_id, workspace_id, name, description, status, target_repo, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(id, workspaceId, name, description, targetRepo, now, now);
  return id;
}

export function getProject(projectId: string, database = db): ProjectRow | null {
  return (database.prepare('SELECT * FROM projects_read_model WHERE project_id = ?').get(projectId) as ProjectRow | undefined) ?? null;
}

export function listProjects(workspaceId: string, database = db): ProjectRow[] {
  return database.prepare('SELECT * FROM projects_read_model WHERE workspace_id = ? ORDER BY rowid')
    .all(workspaceId) as unknown as ProjectRow[];
}

export function updateProject(
  projectId: string,
  patch: ProjectInput,
  database = db,
  repos?: RepoRegistry,
): void {
  const project = getProject(projectId, database);
  if (!project) throw new CommandError('project 不存在');
  if (project.status !== 'active') throw new CommandError('project 已封存');

  const keys = ['name', 'description', 'targetRepo'].filter((key) => key in patch);
  if (keys.length === 0) throw new CommandError('不支援的 project PATCH 欄位');
  if (keys.length !== 1) throw new CommandError('PATCH 一次只能改一個欄位');
  const now = new Date().toISOString();
  switch (keys[0]) {
    case 'name':
      database.prepare('UPDATE projects_read_model SET name = ?, updated_at = ? WHERE project_id = ?')
        .run(validateName(patch.name), now, projectId);
      return;
    case 'description':
      database.prepare('UPDATE projects_read_model SET description = ?, updated_at = ? WHERE project_id = ?')
        .run(validateDescription(patch.description), now, projectId);
      return;
    case 'targetRepo':
      if (database.prepare(
        `SELECT 1 FROM goals_read_model
          WHERE project_id = ? AND status NOT IN ('Done', 'Cancelled') LIMIT 1`,
      ).get(projectId)) {
        throw new CommandError('Project 有 active Goal，不可修改 target repo');
      }
      database.prepare('UPDATE projects_read_model SET target_repo = ?, updated_at = ? WHERE project_id = ?')
        .run(validateTargetRepo(patch.targetRepo, repos), now, projectId);
  }
}

export function requireActiveProject(
  workspaceId: string,
  projectId: unknown,
  database: DatabaseSync = db,
): string {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new CommandError('projectId 必須是字串');
  const project = getProject(projectId.trim(), database);
  if (!project) throw new CommandError('project 不存在');
  if (project.workspace_id !== workspaceId) throw new CommandError('project 必須屬於同一 workspace');
  if (project.status !== 'active') throw new CommandError('project 已封存');
  return project.project_id;
}

export function archiveProject(projectId: string, database = db): void {
  const project = getProject(projectId, database);
  if (!project) throw new CommandError('project 不存在');
  if (project.status === 'archived') throw new CommandError('project 已封存');
  const unfinished = database.prepare(
    `SELECT 1 FROM tasks_read_model
      WHERE project_id = ? AND status IN ('Todo', 'Doing', 'Review') LIMIT 1`,
  ).get(projectId);
  if (unfinished) throw new CommandError('project 仍有未完成 task，不可封存');
  const activeGoal = database.prepare(
    `SELECT 1 FROM goals_read_model
      WHERE project_id = ? AND status NOT IN ('Done', 'Cancelled') LIMIT 1`,
  ).get(projectId);
  if (activeGoal) throw new CommandError('project 仍有 active Goal，不可封存');
  const unsafeWorktree = database.prepare(
    `SELECT 1 FROM goal_worktrees w JOIN goals_read_model g ON g.goal_id = w.goal_id
      WHERE g.project_id = ? AND (w.dirty = 1 OR w.unmerged = 1) LIMIT 1`,
  ).get(projectId);
  if (unsafeWorktree) throw new CommandError('project 仍有 dirty 或未合併 worktree，不可封存');
  database.prepare("UPDATE projects_read_model SET status = 'archived', updated_at = ? WHERE project_id = ?")
    .run(new Date().toISOString(), projectId);
}

export function registerGoalWorktree(goalId: string, targetRepo: string, worktreePath: string, database = db): void {
  const goal = database.prepare(
    `SELECT g.goal_id FROM goals_read_model g JOIN projects_read_model p ON p.project_id = g.project_id
      WHERE g.goal_id = ? AND p.target_repo = ?`,
  ).get(goalId, targetRepo);
  if (!goal || !worktreePath.trim()) throw new CommandError('Goal worktree 關聯不合法');
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO goal_worktrees (worktree_path, goal_id, target_repo, dirty, unmerged, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?)
     ON CONFLICT(worktree_path) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(worktreePath, goalId, targetRepo, now, now);
}

// 遷移相容 API；新 UI 不呼叫 hard delete。
export function deleteProject(projectId: string, database = db): void {
  database.prepare('UPDATE tasks_read_model SET project_id = NULL WHERE project_id = ?').run(projectId);
  const info = database.prepare('DELETE FROM projects_read_model WHERE project_id = ?').run(projectId);
  if (info.changes === 0) throw new CommandError('project 不存在');
}

export function getProjectWorkspaceId(projectId: string, database = db): string | null {
  return getProject(projectId, database)?.workspace_id ?? null;
}

// 舊 caller 的窄相容層；新程式使用 updateProject。
export function renameProject(projectId: string, name: unknown, database = db): void {
  updateProject(projectId, { name }, database);
}
