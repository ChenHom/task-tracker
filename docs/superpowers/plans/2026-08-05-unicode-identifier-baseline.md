# Unicode Identifier Baseline Implementation Plan

> **For agentic workers:** This plan is executed inline in the assigned worktree. The driver will commit the verified files after the session; this worker must not run git commands.

**Goal:** 建立 task-tracker 內部 identifier/display 欄位的 Unicode 邊界基線與可重跑的 in-memory fixture，確認目前不會把顯示名稱誤當作 UUID/RBAC 權限鍵。

**Architecture:** 不改 runtime 的正規化、collation、IDNA 或 confusable 政策；新增一個只供測試的 in-memory audit fixture，直接呼叫既有 command/query 與 SQLite metadata，讓現況可重跑。新增一份分類文件記錄欄位的原始值、canonical 比對鍵、顯示值、資料庫行為、Unicode edge cases 與安全 readback allowlist。

**Tech Stack:** TypeScript、Node `node:sqlite`、Node `url.domainToASCII`、SQLite in-memory database、既有 event-sourced workspace/member/task 與 CRUD attachment。

---

### Task 1: Add the failing Unicode baseline fixture

**Files:**
- Create: `src/unicodeIdentifier.test.ts`
- Modify: `src/test.ts:5-30`

- [ ] **Step 1: Write the fixture assertions first**

  Build an in-memory `DatabaseSync(':memory:')`, run `runMigrations`, register the existing workspace/member projections, and assert these exact boundaries:

  - NFC and NFD values remain distinct in `users.email`, `users.name`, workspace `name`, and attachment `original_name`; `String.prototype.normalize('NFC')` is reported only as an observation, not applied by the app.
  - Latin/Cyrillic confusable values remain distinct under the default SQLite comparison and are not auto-blocked.
  - Bidi and zero-width-joiner characters survive display-value readback; UUID-generated `stored_name` is not exposed by `listAttachments` or `readAttachment`.
  - A Unicode domain remains stored as the app's lowercased raw email while `domainToASCII` provides the separately reported IDNA/Punycode form.
  - `PRAGMA collation_list`, `PRAGMA table_info(users)`, and equality probes record SQLite's actual default behavior; ASCII case handling from `createUser` is distinguished from SQLite `NOCASE`.
  - Two users with the same display name but different UUIDs can hold separate memberships; `getMemberRole` and task/attachment workspace context continue to resolve by UUID.
  - Returned workspace/member/attachment rows contain only the established safe fields, preserving Unicode display values.

  The test prints a compact JSON evidence block containing Node/ICU/Unicode/CLDR versions, SQLite version, collation names, canonicalization results, and field classifications so the run is reproducible.

- [ ] **Step 2: Run the new test and confirm the failure is meaningful**

  Run: `npx tsx src/unicodeIdentifier.test.ts`

  Expected: FAIL before the fixture exists, with the missing test-file/module error; after correcting only test syntax or fixture setup errors, the first behavioral failure must identify a missing baseline assertion rather than a production change.

- [ ] **Step 3: Add the new test to the aggregate test entrypoint**

  Add `import './unicodeIdentifier.test';` beside the other `src` tests in `src/test.ts`, without changing test ordering outside the new import.

### Task 2: Make the fixture green without changing runtime policy

**Files:**
- Modify: `src/unicodeIdentifier.test.ts`

- [ ] **Step 1: Use only existing commands and read APIs**

  Keep all production behavior unchanged. Use a temporary in-memory database for rows and the existing attachment API's cleanup path for any transient file. Do not update historical rows, add schema normalization, reject confusables, or make display names unique.

- [ ] **Step 2: Run focused verification**

  Run: `npx tsx src/unicodeIdentifier.test.ts`

  Expected: `unicodeIdentifier.test.ts OK` plus the JSON evidence block; no files or historical database rows remain changed after the run.

### Task 3: Document the baseline and its limits

**Files:**
- Create: `docs/security/unicode-identifier-baseline.md`

- [ ] **Step 1: Record the verified field classification**

  Document each in-scope field (`users.email`, `users.name`, `attachments.original_name`, `attachments.stored_name`, `workspaces_read_model.name`, `workspace_id`, `workspace_members_read_model.user_id`, `tasks_read_model.workspace_id`) as display value, canonical comparison key, or UUID/RBAC key. State the exact current transformations: trim, ASCII-compatible JS lowercasing for email, basename/control-character stripping for attachment display names, and no app-level NFC/NFD, Unicode casefold, IDNA, confusable, bidi, or joiner policy.

- [ ] **Step 2: Include reproducible commands and captured runtime observations**

  Include `npx tsx src/unicodeIdentifier.test.ts`, `npx tsc --noEmit`, and the test's captured Node/ICU/Unicode/CLDR/SQLite/collation evidence. Explain that the fixture is in-memory and does not backfill existing data.

- [ ] **Step 3: Run final checks for the task**

  Run:

  ```bash
  npx tsc --noEmit
  npx tsx src/unicodeIdentifier.test.ts
  ```

  Expected: both commands exit 0; the final task comment includes the actual outputs and the changed file list. Do not run `npm run sim`, a live sweep, or a git commit.
