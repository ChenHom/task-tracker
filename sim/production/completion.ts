// 正式環境 sim 協調器的完成通知（任務 7）：單一 task 的 SYSTEM 完成留言、user09
// notification readback、Review -> Done 轉移。Discord 彙整通知的 batch／重試邏輯
// **不在這裡**——那是多 task、tick 級的關注點，屬於 coordinator.ts（見該檔任務 7
// 步驟 4 的段落），這裡只處理「一個 task 的完成」這一件事。
//
// 核心原則（呼應 agent.ts／api.ts 已建立的房規）：從不盲目信任自己上一輪「宣稱」
// 做過什麼——留言是否已經貼過、notification 是否已經存在、task 是否已經 Done，
// 一律用真正的 readback 重新確認，不靠本機記憶或樂觀假設。completion_outbox 這一列
// 的存在本身只負責一件事：保證「決定要完成這個 task」到「真的貼出留言」之間，就算
// process 在這中間 crash，也能從持久化狀態安全地重新驅動——它不是、也不需要是
// 「留言有沒有貼成功」這件事的權威來源，那件事永遠向 task-tracker 本身 readback。
import type { DatabaseSync } from 'node:sqlite';
import { UncertainMutationError } from './api';
import type { CommentSnapshot, NotificationSnapshot, TaskSnapshot } from './policy';
import { enqueueCompletion, markCompletionDone } from './state';

// ---------------------------------------------------------------------------
// 步驟 3：completion comment 契約（逐字照抄計畫給定的模板，不得偏離欄位順序或文字）。
// ---------------------------------------------------------------------------

export interface CompletionCommentInput {
  taskTitle: string;
  taskId: string;
  /** 功能／修改：owner-approved 摘要。 */
  summary: string;
  /** 驗證：focused tests + integration + live acceptance 的描述。 */
  verification: string;
  /** Commit：accepted head／merge sha。 */
  commitSha: string;
  /** 部署版本：health rev。 */
  deployRev: string;
  completionId: string;
}

export function buildCompletionComment(input: CompletionCommentInput): string {
  return [
    '【SYSTEM完成】 @user09',
    `TASK：${input.taskTitle}（${input.taskId}）`,
    `功能／修改：${input.summary}`,
    `驗證：${input.verification}`,
    `Commit：${input.commitSha}`,
    `部署版本：${input.deployRev}`,
    `執行識別：${input.completionId}`,
  ].join('\n');
}

/** `completion_id = task_id + ':' + accepted_head_sha`（計畫步驟 3 逐字定義）。 */
export function completionId(taskId: string, acceptedHeadSha: string): string {
  return `${taskId}:${acceptedHeadSha}`;
}

/** 留言的去重 action key：直接沿用 completion_id 衍生出一個穩定字串。 */
export function completionActionKey(id: string): string {
  return `completion_comment:${id}`;
}

/**
 * readback 比對用的唯一標記：模板最後一行「執行識別：<completion id>」本身就是
 * 每個 completion 獨一無二的字串（completion_id 已含 task_id + head_sha），拿它
 * 找留言，不需要伺服器另外支援用 X-Action-Key 讀回。
 */
function commentMarker(id: string): string {
  return `執行識別：${id}`;
}

// ---------------------------------------------------------------------------
// 步驟 3：postCompletionAndTransitionToDone 需要的注入介面。
// 結構上刻意是 api.ts TaskTrackerClient 的子集（用 Pick 也可以，這裡直接手寫
// 介面，讓測試可以注入任意假物件，也可以直接塞一個真正的 TaskTrackerClient 實例
// ——兩者在結構上相容）。
// ---------------------------------------------------------------------------

export interface CompletionOwnerClient {
  listComments(taskId: string): Promise<CommentSnapshot[]>;
  postCommentOnce(taskId: string, content: string, actionKey: string): Promise<string>;
  getTask(taskId: string): Promise<TaskSnapshot>;
  patchTaskField(taskId: string, field: 'status' | 'assignee', value: unknown): Promise<TaskSnapshot>;
}

export interface CompletionNotifierClient {
  listNotifications(): Promise<NotificationSnapshot[]>;
}

export interface PostCompletionInput {
  db: DatabaseSync;
  /** 已登入、有權限貼留言／PATCH task 的 client（正式環境是 user01）。 */
  ownerClient: CompletionOwnerClient;
  /** 已以 user09 身分登入的 client——只用來讀 notifications，不做任何 mutation。 */
  user09Client: CompletionNotifierClient;
  /** user09 的 canonical user ID：notification.recipientId 必須恰好等於這個值。 */
  user09Id: string;
  taskId: string;
  taskTitle: string;
  acceptedHeadSha: string;
  summary: string;
  verification: string;
  deployRev: string;
  now?: Date;
}

export type CompletionResult =
  | {
      kind: 'done';
      completionId: string;
      taskId: string;
      commentId: string;
      notificationId: string;
      task: TaskSnapshot;
    }
  | {
      kind: 'patch_failed';
      completionId: string;
      taskId: string;
      commentId: string;
      notificationId: string;
      reason: string;
    };

/**
 * 依計畫步驟 3 的固定順序執行單一 task 的完成流程：
 *
 *   (a) 持久化 completion_outbox row（在任何留言 POST 之前）
 *   -> (b) 留言（readback 優先，不確定時再 readback 一次，不盲目重送）
 *   -> (c) user09 notification readback（不標記已讀）
 *   -> (d) Review -> Done PATCH（同樣先 readback 現況，避免對已經 Done 的 task 重複 PATCH）
 *
 * 每一步都是可安全重試的：整個函式可以在任何一步之後的 crash／失敗發生後被重新
 * 呼叫，(a)(b)(c) 永遠先用 readback 確認「是不是已經做過」，不會因為重呼叫而
 * 重複留言或重複送出 mutation。只有 (d) PATCH 失敗（`patch_failed`）時，呼叫端
 * 才需要之後再呼叫一次這個函式重試——那次重試會直接從 (a)(b)(c) 的 readback
 * 短路過去，只真正重試 PATCH，不會回頭重貼留言。
 */
export async function postCompletionAndTransitionToDone(input: PostCompletionInput): Promise<CompletionResult> {
  const now = input.now ?? new Date();
  const id = completionId(input.taskId, input.acceptedHeadSha);

  // (a) 必須先於任何留言 POST 嘗試持久化——enqueueCompletion 本身是冪等的
  // （INSERT OR IGNORE），重複呼叫不會重置既有 row。
  enqueueCompletion(input.db, { completionId: id, taskId: input.taskId }, now);

  // (b) 留言：readback 優先。
  const marker = commentMarker(id);
  const content = buildCompletionComment({
    taskTitle: input.taskTitle,
    taskId: input.taskId,
    summary: input.summary,
    verification: input.verification,
    commitSha: input.acceptedHeadSha,
    deployRev: input.deployRev,
    completionId: id,
  });
  const actionKey = completionActionKey(id);

  let commentId: string;
  const existingComments = await input.ownerClient.listComments(input.taskId);
  const existingMatch = existingComments.find((c) => c.content.includes(marker));
  if (existingMatch) {
    commentId = existingMatch.commentId;
  } else {
    try {
      commentId = await input.ownerClient.postCommentOnce(input.taskId, content, actionKey);
    } catch (err) {
      if (!(err instanceof UncertainMutationError)) throw err;
      // 結果不確定：不盲目重送，改用 readback 找有沒有符合 marker 的留言已經落地。
      const retryComments = await input.ownerClient.listComments(input.taskId);
      const retryMatch = retryComments.find((c) => c.content.includes(marker));
      if (!retryMatch) throw err; // 真的不確定且 readback 也找不到——把原始錯誤丟出去，交由呼叫端決定何時重試。
      commentId = retryMatch.commentId;
    }
  }

  // (c) user09 notification readback——只讀不標記已讀（這裡的介面根本沒有標記已讀的方法）。
  const notifications = await input.user09Client.listNotifications();
  const notification = notifications.find(
    (n) => n.sourceCommentId === commentId && n.recipientId === input.user09Id,
  );
  if (!notification) {
    throw new Error(
      `postCompletionAndTransitionToDone: no notification found for user09 (${input.user09Id}) referencing comment ${commentId} on task ${input.taskId}`,
    );
  }

  // (d) Review -> Done：先 readback 現況，已經是 Done 就不重複 PATCH（例如上一輪
  // 呼叫其實成功了，只是回傳結果不確定，呼叫端因此又重試了一次整個函式）。
  const finish = (task: TaskSnapshot): CompletionResult => {
    markCompletionDone(input.db, id, now);
    return { kind: 'done', completionId: id, taskId: input.taskId, commentId, notificationId: notification.notificationId, task };
  };
  const patchFailed = (reason: string): CompletionResult => ({
    kind: 'patch_failed',
    completionId: id,
    taskId: input.taskId,
    commentId,
    notificationId: notification.notificationId,
    reason,
  });

  const currentTask = await input.ownerClient.getTask(input.taskId);
  if (currentTask.status === 'Done') {
    return finish(currentTask);
  }

  try {
    const patched = await input.ownerClient.patchTaskField(input.taskId, 'status', 'Done');
    return finish(patched);
  } catch (err) {
    if (err instanceof UncertainMutationError) {
      const readback = await input.ownerClient.getTask(input.taskId);
      if (readback.status === 'Done') return finish(readback);
      return patchFailed(
        `PATCH status Review->Done uncertain and readback still shows ${readback.status}: ${(err as Error).message}`,
      );
    }
    return patchFailed((err as Error).message);
  }
}
