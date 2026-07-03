import { db } from './db';

// LIKE 掃 task / comment / project，範圍限單一 workspace（權限邊界在 server：requirePermission Viewer）。
// 使用者輸入的 % _ \ 會被當 LIKE 萬用字元，必須 escape（信任邊界 + 正確性）。
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export interface SearchResult {
  tasks: { task_id: string; title: string; status: string }[];
  projects: { project_id: string; name: string }[];
  comments: { comment_id: string; task_id: string; content: string }[];
}

export function searchWorkspace(workspaceId: string, query: unknown, database = db): SearchResult {
  const q = (typeof query === 'string' ? query : '').trim().slice(0, 200);
  if (!q) return { tasks: [], projects: [], comments: [] }; // 空查詢不掃全表

  const like = `%${escapeLike(q)}%`;
  const tasks = database
    .prepare(
      `SELECT task_id, title, status FROM tasks_read_model
        WHERE workspace_id = ? AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
        ORDER BY rowid`,
    )
    .all(workspaceId, like, like) as unknown as SearchResult['tasks'];

  const projects = database
    .prepare(
      `SELECT project_id, name FROM projects_read_model
        WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY rowid`,
    )
    .all(workspaceId, like) as unknown as SearchResult['projects'];

  const comments = database
    .prepare(
      `SELECT c.comment_id, c.task_id, c.content FROM comments c
         JOIN tasks_read_model t ON t.task_id = c.task_id
        WHERE t.workspace_id = ? AND c.content LIKE ? ESCAPE '\\' ORDER BY c.rowid`,
    )
    .all(workspaceId, like) as unknown as SearchResult['comments'];

  return { tasks, projects, comments };
}
