export const MAIN_WORKSPACE_ID = '11a82028-fc50-466a-a723-e002032cd9a6';
export const MAIN_WORKSPACE_NAME = '主協作工作區';
export const MAIN_OWNER_EMAIL = 'user01@test.local';
export const MAIN_DISCUSSION_PREFIX = '[討論]';
export const MAIN_POLICY_TITLE = '[規則] 主工作區協作與交接';

// 主工作區討論協議的唯一真相來源。validator（mainDiscussion.ts）與 sim owner prompt
// （sim/run.ts）都必須從這裡衍生字串，不得各自硬寫：兩邊曾各留一份副本，2026-07-23
// 改 validator 沒改 prompt、2026-07-29 改 prompt 沒改 validator，全員回覆流程各斷一次。
export const THOUGHT_MARKER = '【OWNER想法】';
export const CONCLUSION_MARKER = '【結論】';
export const NO_IMPLEMENTATION_MARKER = '【結論：不實作】';
export const NO_CONSENSUS_MARKER = '【未達共識】';
export const HANDOFF_MARKER = '【實作任務】';

export const REQUIRED_THOUGHT_FIELDS = [
  '現況／問題',
  '預期價值',
  '風險與反對理由',
  '現行可替代方案',
  '初步判斷',
  '希望成員確認的問題',
] as const;

// 給 prompt 模板用的欄位提示。型別綁在 REQUIRED_THOUGHT_FIELDS 上，欄名改了這裡沒改就編譯失敗。
export const THOUGHT_FIELD_HINTS: Record<(typeof REQUIRED_THOUGHT_FIELDS)[number], string> = {
  '現況／問題': '目前情況與待解問題',
  '預期價值': '要解決的價值',
  '風險與反對理由': '風險、反對理由與代價',
  '現行可替代方案': '不實作時的替代作法',
  '初步判斷': 'OWNER 的暫定判斷',
  '希望成員確認的問題': '希望 Commenter 回覆的問題',
};

export const NO_CONSENSUS_FIELDS = [
  '尚未解決的分歧',
  '缺少的確認或資訊',
  '下次重新思考前的建議',
] as const;

export const LONGER_WINDOW_REASON_FIELD = '較長期限理由';

export const REPLY_WINDOW_MIN_DAYS = 2;
export const REPLY_WINDOW_MAX_DAYS = 7;
export const REPLY_WINDOW_DEFAULT_DAYS = REPLY_WINDOW_MIN_DAYS;
export const LEGACY_FIXED_REPLY_WINDOW_MARKER = '【全員回覆：24小時】';

// 這兩個 builder 同時供 prompt 產生字串與 validator 組正則使用：validator 傳入 capture
// group 當「值」，就得到與 builder 保證同構的樣式。字面部分（【】｜：）都不是正則
// metacharacter，可以直接內嵌。
export const replyWindowMarker = (days: number | string): string => `【全員回覆：${days}天】`;
export const handoffLine = (workspaceName: string, taskName: string): string =>
  `${HANDOFF_MARKER}工作區：${workspaceName}｜TASK：${taskName}`;

export const MAIN_POLICY_DESCRIPTION = [
  '此處供目前七位成員提出工作問題、改善方向與優化想法；只討論，不直接實作。',
  '所有成員都可建立 Todo 討論與留言；user01 先留下 OWNER想法，再通知 user02-06 與 user09。',
  `回覆期限由${replyWindowMarker('N')}指定為 ${REPLY_WINDOW_MIN_DAYS} 至 ${REPLY_WINDOW_MAX_DAYS} 天、以半天遞增；預設 ${REPLY_WINDOW_DEFAULT_DAYS} 天，通知送出後開始且不可調整、不可提前結案。`,
  '所有 Commenter 都應留言；系統不追蹤回覆或缺席，也不因未回覆阻擋收尾。',
  `截止後由 user01 依「${CONCLUSION_MARKER}」「${NO_IMPLEMENTATION_MARKER}」或「${NO_CONSENSUS_MARKER}」將 Todo 直接完成為 Done，不需要任何確認留言。`,
  '需要實作時在對應工作區另建 TASK，原討論只記錄工作區與 TASK 名稱，不提供連結。',
].join('\n');
