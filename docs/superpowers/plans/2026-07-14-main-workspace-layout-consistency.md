# Main Workspace Layout Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓主工作區在所有 viewport 保留四條看板河道，並讓自己的留言操作按鈕不再在手機版互相擠壓。

**Architecture:** 保留既有的主工作區 domain 狀態限制，只調整 kanban DOM 結構與 CSS grid，使 Doing/Review 成為無操作的空白河道。留言操作維持原 API 與事件處理，只改 DOM 按鈕文字及 `.comment-actions` 的垂直排版。

**Tech Stack:** Native ESM JavaScript、CSS Grid/Flexbox、Node `assert` 前端 source/DOM harness。

---

### Task 1: 主工作區四河道與留言操作版面

**Files:**
- Modify: `src/frontend.test.ts:505-506,748-760`
- Modify: `public/js/views/kanban.js:82-112`
- Modify: `public/js/views/task-detail.js:544-628`
- Modify: `public/css/kanban.css:65-86`
- Modify: `public/css/task-detail.css:80-91,514-523`

- [ ] **Step 1: 寫入會失敗的前端測試**

在 `src/frontend.test.ts` 將既有自己的留言刪除按鈕 assertion 改為 `刪除`，先在既有 source 載入區加入：

```ts
const taskDetailCssSource = readFileSync(join(__dirname, '../public/css/task-detail.css'), 'utf8');
```

再在主工作區 source assertion 後加入：

```ts
assert.doesNotMatch(kanbanSource, /isMainWorkspace \? '' : `\s*<div class="kanban-column col-doing">/);
assert.match(kanbanSource, /<div class="kanban-column col-doing">[\s\S]*?<div class="kanban-column col-review">/);
assert.doesNotMatch(kanbanSource, /main-discussion-board/);
assert.match(taskDetailCssSource, /\.comment-actions\s*\{[\s\S]*flex-direction:\s*column/);
assert.match(taskDetailCssSource, /@media \(max-width: 768px\)[\s\S]*\.comment-actions\s*\{[\s\S]*flex-direction:\s*column/);
```

這些 assertions 確認主工作區不再條件式略過 Doing/Review，並以欄向排列修正所有 viewport 的留言操作。

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --import tsx src/frontend.test.ts`

Expected: FAIL，指出刪除按鈕仍為 `刪除留言`，且主工作區仍有 `main-discussion-board`／條件式省略河道。

- [ ] **Step 3: 實作最小前端修改**

在 `public/js/views/kanban.js` 移除 `isMainWorkspace ? '' :` 對 Doing/Review 欄位的條件式包裝，讓兩欄永遠渲染；兩欄既有新增插槽保留，但因主工作區原本的 `canCreateTask` 判斷只允許 Todo，不會產生新增按鈕。移除 board class 中的 `main-discussion-board`。

在 `public/css/kanban.css` 刪除：

```css
.kanban-board.main-discussion-board {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.kanban-board.main-discussion-board.show-archived-col {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
```

使主工作區使用 `.kanban-board` 的四欄與 `@media (max-width: 1024px)` 的單欄 RWD。

在 `public/js/views/task-detail.js` 將：

```js
const deleteBtn = el('button', { type: 'button', class: 'btn-danger' }, '刪除留言');
```

改為：

```js
const deleteBtn = el('button', { type: 'button', class: 'btn-danger' }, '刪除');
```

在 `public/css/task-detail.css` 的 base 與 `@media (max-width: 768px)` `.comment-actions` 均加入 `flex-direction: column; align-items: stretch;`。按鈕保留窄螢幕的 `width: 100%` 與 `height: 36px`，讓編輯/儲存先出現在上方、刪除在下方。

- [ ] **Step 4: 執行 focused 測試確認通過**

Run: `node --import tsx src/frontend.test.ts`

Expected: `frontend.test.ts OK`。

- [ ] **Step 5: 檢查前端 lint 與瀏覽器畫面**

Run: `npm run lint`

Expected: exit code `0`。

以 feature preview 開啟主工作區，在桌面與 768px 以下 viewport 驗證 `Todo`、`Doing`、`Review`、`Done` 均存在；確認 OWNER 仍只有 `→ Done`；開啟自己留言的 task detail，確認編輯位於刪除上方且文字為 `刪除`。

- [ ] **Step 6: 提交實作**

```bash
git add src/frontend.test.ts public/js/views/kanban.js public/js/views/task-detail.js public/css/kanban.css public/css/task-detail.css
git commit -m "fix: align main workspace board and comment actions"
```
