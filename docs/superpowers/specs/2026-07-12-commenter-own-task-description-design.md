# Commenter 修改自建 Task 描述設計

**日期：** 2026-07-12

**狀態：** 實作完成，待部署驗收

## 範圍

- Commenter 在任何 workspace 都可修改自己建立 task 的 `description`。
- Commenter 仍不可修改標題、狀態、優先級、指派、期限、project、附件或封存狀態，也不可修改他人 task。
- Member、Admin、Owner 維持既有 task 修改權限；Viewer 維持唯讀。
- 主協作工作區仍固定為 user01 Owner、其他使用者 Commenter。其他 workspace 不做全域角色同步，預設成員仍是 Member，Owner 可另行調整。
- Archived task、deleted task 與非 active workspace 維持不可修改。

## 實作

- 重用 `task.created` event metadata 的 `actor_id` 作為建立者，不新增 schema 或 migration。
- task query 回傳建立者 ID，供 API 與前端判斷；建立者資料只對既有 workspace 成員可見。
- `PATCH /api/tasks/:id` 只有 body 恰好為 `{ description }` 時允許 Commenter 進入 command；其他欄位仍要求 Member。
- domain command 再驗證目前角色與 task 建立者，避免只靠 HTTP 或 UI 保護。
- task detail 對自建 task 的 Commenter 顯示唯讀標題、可編輯描述與儲存按鈕；其他 task 維持完整唯讀。

## 錯誤處理

- Commenter 修改他人 task 描述：HTTP 400 domain error；其他 task 欄位仍在權限層回 HTTP 403。
- 缺少或無法辨識 `task.created` 建立者的歷史 task：視為非本人建立，不放寬權限。
- PATCH 維持一次只能修改一個欄位，避免以混合 payload 繞過權限。

## 驗收

- domain test：Commenter 可修改自建 task 描述；不可修改他人描述；Member 仍可修改任意 task 描述。
- HTTP test：Commenter 的自建描述 PATCH 成功，標題／狀態與他人描述被拒絕。
- frontend test：自建 task 只有描述可編輯；他人 task 無儲存控制；Member UI 不變。
- `npm test`、`npm run build`、`git diff --check` 全數通過。

## 實作驗證

- Domain 與 HTTP 層已驗證 Commenter 只能 PATCH 自建 task 的 `{ description }`，其他欄位與他人 task 維持拒絕。
- Frontend fixture 已驗證自建 task 顯示唯讀標題、description textarea 與儲存按鈕，儲存時只發送 `{ description }`；他人 task 無儲存控制。
- Focused frontend test、`npm test`、`npm run build` 與 `git diff --check` 已在本分支通過。
