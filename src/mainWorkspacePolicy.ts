export const MAIN_WORKSPACE_ID = '11a82028-fc50-466a-a723-e002032cd9a6';
export const MAIN_WORKSPACE_NAME = '主協作工作區';
export const MAIN_OWNER_EMAIL = 'user01@test.local';
export const MAIN_DISCUSSION_PREFIX = '[討論]';
export const MAIN_POLICY_TITLE = '[規則] 主工作區協作與交接';
export const MAIN_POLICY_DESCRIPTION = [
  '此處供目前七位成員提出工作問題、改善方向與優化想法；只討論，不直接實作。',
  '所有成員都可建立 Todo 討論與留言；user01 先留下 OWNER想法，再通知 user02-06 與 user09。',
  '回覆期限為連續 2 至 7 天、以半天為單位，通知送出後開始且不可調整；預設使用 2 天。',
  '所有 Commenter 都應留言；系統不追蹤回覆或缺席，也不因未回覆阻擋收尾。',
  '結論需由 OWNER 與建立者雙方確認；OWNER 自建時由任一 Commenter 確認。',
  '截止後由 user01 將 Todo 直接完成為 Done；未達共識則記錄分歧後完成，不實作。',
  '需要實作時在對應工作區另建 TASK，原討論只記錄工作區與 TASK 名稱，不提供連結。',
].join('\n');
