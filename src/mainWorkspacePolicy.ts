export const MAIN_WORKSPACE_ID = '11a82028-fc50-466a-a723-e002032cd9a6';
export const MAIN_WORKSPACE_NAME = '主協作工作區';
export const MAIN_OWNER_EMAIL = 'user01@test.local';
export const MAIN_DISCUSSION_PREFIX = '[討論]';
export const MAIN_POLICY_TITLE = '[規則] 主工作區協作與交接';
export const MAIN_POLICY_DESCRIPTION = [
  '此處供目前七位成員提出工作問題、改善方向與優化想法；只討論，不直接實作。',
  '所有成員都可建立 Todo 討論與留言；user01 先留下 OWNER想法，再通知 user02-06 與 user09。',
  '回覆期限由【全員回覆：N天】指定為 2 至 7 天、以半天遞增；預設 2 天，通知送出後開始且不可調整、不可提前結案。',
  '所有 Commenter 都應留言；系統不追蹤回覆或缺席，也不因未回覆阻擋收尾。',
  '截止後由 user01 依「【結論】」「【結論：不實作】」或「【未達共識】」將 Todo 直接完成為 Done，不需要任何確認留言。',
  '需要實作時在對應工作區另建 TASK，原討論只記錄工作區與 TASK 名稱，不提供連結。',
].join('\n');
