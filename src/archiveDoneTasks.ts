import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { archiveTask, registerTaskProjections } from './task';
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

  let archived = 0;
  for (const { task_id: taskId, workspace_id: workspaceId } of taskIds) {
    const actorId = workspaceId === MAIN_WORKSPACE_ID
      ? getUserIdByEmail(MAIN_OWNER_EMAIL, database)
      : 'task-archive-sweeper';
    if (!actorId) {
      console.error(`archive ${taskId} 略過：主工作區找不到 ${MAIN_OWNER_EMAIL}`);
      continue;
    }
    try {
      archiveTask(actorId, taskId, database);
      archived++;
    } catch (err) {
      // 單筆失敗不該讓整輪掃描中斷；留下可讀紀錄讓 Owner 依相同條件人工補跑
      console.error(`archive ${taskId} 失敗：${(err as Error).message}`);
    }
  }
  return archived; // 實際歸檔數，不是候選數
}

if (require.main === module) {
  // 必須註冊 projection：appendEvent 只會跑「已註冊」的 projection，少了這行事件會寫進
  // event_store 但 tasks_read_model 完全不動——看板照舊顯示 Done，下一次掃描又撈到同一批，
  // 對已在 event store 標記 archived 的 aggregate 再 append 就整個 crash。
  registerTaskProjections();
  const archived = archiveDoneTasks();
  console.log(`Archived ${archived} task(s) that had been Done for at least seven days.`);
}
