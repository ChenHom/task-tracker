# Changelog

本檔記錄跨版本仍值得查閱的 notable change；現行行為與操作契約仍以既有 `docs/`、`README.md` 與 `design.md` 為準。

版本區塊採 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 分類。每一筆條目都必須附上看板 task UUID 與合併 commit 的 short hash，讓變更可從 task 與 Git 互相回查。GitHub Release 只從對應版本區塊產生，不另建工程日誌。

## [Unreleased]

尚未發布的 notable change 放在這裡；發布時移入版本區塊並保留 task／commit 識別。

## 條目格式

只使用與變更相符的分類；以下是格式範例，不是待發布內容：

### Added

- <新增功能摘要>（Task: `<task-uuid>`；Commit: `<short-sha>`）

### Changed

- <既有行為或公開契約變更摘要>（Task: `<task-uuid>`；Commit: `<short-sha>`）

### Fixed

- <錯誤修正摘要>（Task: `<task-uuid>`；Commit: `<short-sha>`）

### Security

- <安全修正摘要；若需要使用者或維運者採取行動，請明確寫出>（Task: `<task-uuid>`；Commit: `<short-sha>`）

### Breaking changes

- **BREAKING:** <不相容變更、影響範圍與遷移方式>（Task: `<task-uuid>`；Commit: `<short-sha>`）

純重構、測試、typo／不改契約的文件補充，以及不影響外部行為的依賴升級，不需新增條目；純內部安全加固若不需要使用者或維運者採取行動，也可省略。
