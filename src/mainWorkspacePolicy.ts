export const MAIN_WORKSPACE_ID = '11a82028-fc50-466a-a723-e002032cd9a6';
export const MAIN_WORKSPACE_NAME = '主協作工作區';
export const MAIN_OWNER_EMAIL = 'user01@test.local';
export const MAIN_DISCUSSION_PREFIX = '[討論]';
export const MAIN_POLICY_TITLE = '[規則] 主工作區協作與交接';
export const MAIN_POLICY_DESCRIPTION = [
  '此處只建立討論，不直接實作。',
  '所有人都可新增 Todo 討論與留言。',
  '只有 user01 可以改變狀態；開始討論時系統會自動指派 user01。',
  '決議後先判斷 target repo，使用 canonical／對應工作區建立實作 task、回寫完整連結，再完成原討論。',
].join('\n');
