// 正式環境 cutover 的固定 migration set：五個真實、永久看板 task 的唯一權威定義
// （加上兩個永遠排除的 task）。
//
// 這是這些字面值唯一的來源。`sim/production/policy.ts`（任務 3）與
// `sim/production/migrate.ts`（任務 9）都必須從這裡 import，不得各自維護一份
// byte-for-byte 相同的副本——那種雙份定義只會在未來某次編輯漏改其中一邊時悄悄分岔，
// 而這些 ID 是真實、永久的看板資料，不是測試用假資料，分岔的代價是操作到錯誤的
// 正式環境 task。
//
// 為什麼抽成獨立檔案，而不是讓 migrate.ts 直接 import policy.ts 的既有定義（或反過來）：
// migrate.ts 同時需要 policy.ts 的其他 export（TaskSnapshot、isExcludedTask、
// validatePrerequisiteEvidence……）與 CUTOVER_TASKS 本身。若 CUTOVER_TASKS 留在
// policy.ts，migrate.ts -> policy.ts 是單向依賴、本來就不會循環；但把它放在policy.ts
// 會讓「migrate.ts 是這組 migration set 的權威定義處」這個計畫明文要求的角色變成名不
// 副實（只是把 policy.ts 的值原封不動 re-export）。抽到這個零依賴的中立模組，兩邊都
// 是單向 import，語意上也更準確：這是純資料，不屬於 policy.ts 的 scheduling 邏輯，
// 也不屬於 migrate.ts 的 reconciliation 邏輯。
export const CUTOVER_TASKS = {
  mainDiscussion: '10e65231-a4b2-4bdb-aab4-9f3c5fb0e916',
  mainPolicy: '27ec8d7e-8605-468c-9f2c-13a80bef2a5a',
  legacyCanonicalDiscussion: '8be538bc-ffc6-4122-9757-026a54ba813f',
  activeReview: {
    taskId: '938aa035-5f96-4908-b28b-876fa4735061',
    assigneeEmail: 'user06@test.local',
    classification: 'bug',
  },
  queuedReview: {
    taskId: '6384b6f4-f92f-45a2-a5e1-133f04f76372',
    assigneeEmail: null,
    afterTaskId: '938aa035-5f96-4908-b28b-876fa4735061',
  },
  completedPrerequisite: {
    taskId: '00123ef0-81cb-410e-aed1-d6d1fb925ed6',
    implementedByPlanTask: 1,
    implementerEmail: 'user03@test.local',
    taskBranch: 'sim/task/00123ef0-81cb-410e-aed1-d6d1fb925ed6',
    requiredStatus: 'Done',
  },
  deferredAssignment: {
    taskId: '027c0052-46d5-4da7-90fa-dd8efb2219fc',
    assigneeEmail: 'user05@test.local',
    classification: 'approved',
    afterTaskId: '938aa035-5f96-4908-b28b-876fa4735061',
  },
} as const;

// 雙重規則排除用的 canonical title（ID 為主、title 為輔的 defense-in-depth）。
export const MAIN_POLICY_TITLE = '[規則] 主工作區協作與交接';
export const LEGACY_CANONICAL_DISCUSSION_TITLE = '[討論] 方向與下一步';
