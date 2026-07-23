// 正式環境 sim 協調器的卡關轉移／Owner 介入狀態機。
//
// 目前範圍刻意窄：只處理「連續多次 member attempt 都沒有可驗證進展時，該不該
// enqueue Owner intervention、該不該轉入 human_blocked」這一件事（計畫任務 5
// 步驟 5）。整合／部署／完成通知／真正的 tick loop 是之後任務（6／7／8）的責任，
// 屆時會繼續擴充這個檔案，這裡不預先蓋範圍。
//
// 純函式、零 I/O：不 import node:sqlite、node:http 或 git.ts。no-progress 計數、
// Owner intervention 門檻與 human_blocked 判斷全部委派給 policy.ts 既有的
// recordMemberAttempt／shouldResumeHumanBlocked——這裡不重寫那套邏輯，只負責把
// agent.ts 的 MemberSessionResult 轉換成 policy.ts 要的 evidenceChanged bool，
// 並在真的轉入 human_blocked 的那一刻，產生一則唯一、可去重的 @user09 留言內容。
import type { TaskRun } from './types';
import { recordMemberAttempt, shouldResumeHumanBlocked, taskEvidenceFingerprint, type TaskEvidence } from './policy';
import type { MemberSessionResult } from './agent';

export interface HumanBlockedNotice {
  /**
   * action_log 的去重 key：同一次卡關轉移永遠得到同一把 key（純函式於
   * taskId + noProgressCount），重複呼叫（例如 driver 重跑同一個 tick、或
   * action_log 因為並發被重送）必須撞到相同 key 而不是造出第二則留言。
   */
  actionKey: string;
  content: string;
}

export interface MemberAttemptTransition {
  run: TaskRun;
  /** 這次呼叫是否剛好讓 ownerIntervened 從 false 變成 true——該去 enqueue 一次 Owner intervention。 */
  ownerInterventionRequested: boolean;
  /** 非 null 代表這次呼叫剛好讓 phase 轉成 human_blocked——內容即唯一、去重用的 @user09 留言。 */
  humanBlockedNotice: HumanBlockedNotice | null;
}

const HUMAN_BLOCKED_ACTION_KIND = 'human_blocked_notice';

/** human_blocked 通知的 action key：taskId + noProgressCount，同一次卡關轉移永遠得到同一把 key。 */
export function humanBlockedActionKey(taskId: string, noProgressCount: number): string {
  return `${HUMAN_BLOCKED_ACTION_KIND}:${taskId}:${noProgressCount}`;
}

function buildHumanBlockedNotice(run: TaskRun, session: MemberSessionResult): HumanBlockedNotice {
  const blockerText = session.output.blocker ?? '（member session 未回報明確 blocker）';
  const actionKey = humanBlockedActionKey(run.taskId, run.noProgressCount);
  const content =
    `@user09 這個 task 已卡關，需要人工介入。\n` +
    `連續 ${run.noProgressCount} 次 member attempt 都沒有可驗證的進展（已含一次 Owner 介入後的最後嘗試）。\n` +
    `最近一次回報的 blocker：${blockerText}\n` +
    `task status／assignee 保持不變；在你留言或出現尚未記錄的人工 task 變更之前，不會再排入任何 AI action。\n` +
    `action_key: ${actionKey}`;
  return { actionKey, content };
}

/**
 * 把一次 member session 的獨立驗證結果（agent.ts 的 MemberSessionResult）套進
 * policy.ts 既有的 no-progress／Owner intervention／human_blocked 狀態機，並在
 * 剛好轉入 human_blocked 的那一刻，把「目前板面證據」的 fingerprint 寫回 TaskRun、
 * 產生唯一的 @user09 留言內容。
 *
 * `evidenceChanged` 的定義選擇 `session.outcome === 'progressed'`，而不是「這次
 * blocker 文字跟上次是否不同」：只有跨過 agent.ts 定義的完整成功門檻（已驗證 commit
 * + verification PASS + driver 摘要留言 + Doing -> Review readback）才代表這個
 * task 的板面狀態真的往前走了。一個「這次 blocker 文字換了、但仍然沒有任何可驗證
 * 副作用」的 session 依然是卡住的，不應該重置 noProgressCount——否則 AI 只要每次
 * 講不同的藉口就能無限期避開 Owner 介入與 human_blocked 升級，違背這整個 subsystem
 * 要防的「假裝有進展」反模式。
 *
 * `currentEvidence` 代表呼叫端（未來真正呼叫 API 的那一層；這裡永遠是呼叫端自行
 * 組好或測試注入的快照）目前讀到的板面證據（留言／狀態／期限）。只有在這次呼叫
 * 剛好轉入 human_blocked 時才會用到它，寫進 evidenceFingerprint 當作「卡關當下」的
 * 基準，讓之後的 shouldResumeFromHumanBlocked 只在真的出現新證據（新留言、期限
 * 事件，或未記錄的人工 task mutation）時才判定可恢復——不會因為卡關前後板面完全沒變
 * 就立刻誤判「可以恢復」。
 */
export function recordMemberSessionAttempt(
  run: TaskRun,
  session: MemberSessionResult,
  currentEvidence: TaskEvidence,
): MemberAttemptTransition {
  const evidenceChanged = session.outcome === 'progressed';
  const wasIntervened = run.ownerIntervened;
  const wasBlocked = run.phase === 'human_blocked';

  let updatedRun = recordMemberAttempt(run, evidenceChanged);

  const ownerInterventionRequested = !wasIntervened && updatedRun.ownerIntervened;

  let humanBlockedNotice: HumanBlockedNotice | null = null;
  if (!wasBlocked && updatedRun.phase === 'human_blocked') {
    updatedRun = { ...updatedRun, evidenceFingerprint: taskEvidenceFingerprint(currentEvidence) };
    humanBlockedNotice = buildHumanBlockedNotice(updatedRun, session);
  }

  return { run: updatedRun, ownerInterventionRequested, humanBlockedNotice };
}

/**
 * human_blocked 是否應該恢復——直接委派給 policy.ts 既有的比對邏輯，這裡不重寫
 * 任何 fingerprint 比對規則。存在的理由只是把「coordinator 該問 policy.ts 什麼問題」
 * 講清楚、可以獨立於 recordMemberSessionAttempt 被呼叫與測試。
 */
export function shouldResumeFromHumanBlocked(run: TaskRun, currentEvidence: TaskEvidence): boolean {
  return shouldResumeHumanBlocked(run, currentEvidence);
}
