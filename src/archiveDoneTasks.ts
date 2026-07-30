import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { archiveTask } from './task';
import { getUserIdByEmail } from './auth';
import { MAIN_OWNER_EMAIL, MAIN_WORKSPACE_ID } from './mainWorkspacePolicy';

const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Archives tasks that have continuously remained Done for at least seven days. */
export function archiveDoneTasks(database: DatabaseSync = db, now = new Date()): number {
  const cutoff = new Date(now.getTime() - ARCHIVE_AFTER_MS).toISOString();
  const taskIds = database
    .prepare(
      `SELECT t.task_id, t.workspace_id
         FROM tasks_read_model t
         JOIN workspaces_read_model w ON w.workspace_id = t.workspace_id
        WHERE t.status = 'Done' AND t.done_at IS NOT NULL AND t.done_at <= ? AND w.status = 'active'`,
    )
    .all(cutoff) as { task_id: string; workspace_id: string }[];

  for (const { task_id: taskId, workspace_id: workspaceId } of taskIds) {
    const actorId = workspaceId === MAIN_WORKSPACE_ID
      ? getUserIdByEmail(MAIN_OWNER_EMAIL, database)
      : 'task-archive-sweeper';
    if (actorId) archiveTask(actorId, taskId, database);
  }
  return taskIds.length;
}

if (require.main === module) {
  const archived = archiveDoneTasks();
  console.log(`Archived ${archived} task(s) that had been Done for at least seven days.`);
}
