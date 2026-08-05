# 跨 repo 依賴更新唯讀盤點與低風險提案驗證基線

> 查證日：2026-08-06。本文件是一次性唯讀盤點與隔離 pilot 紀錄；不代表已升級正式依賴、啟用 automerge 或完成法律／資安結論。

## 決策摘要

本輪先核對 `task-tracker`、已可查證的 `job-risk-radar`，以及派工要求中的
`line-stock-bot`。前兩者都有可回查的 manifest、lockfile 與依賴／驗證證據；
`line-stock-bot` 的 canonical path 仍未提供，不能把「查不到」當成沒有依賴或
更新工具。

已在隔離副本以 `job-risk-radar` 的 `vitest` patch 更新做 pilot：只改
`^4.1.6` → `^4.1.10` 及 lockfile，`npm ci`、`npm run verify` 均成功；移除
lockfile 的負面測試按預期以 `EUSAGE` 失敗，回到 baseline 後可重新 `npm ci`。
正式 repo、正式依賴、CI、registry 設定與 automerge 均未改動。

## 範圍與限制

- 納入：實際仍在維護、具有 package manifest／lockfile、CI 或可重跑驗證的 repo。
- 盤點：owner、package manager、manifest／lockfile、runtime／dev dependency、
  CI 觸發、更新工具、registry、相容測試、更新與回退 readback。
- pilot 限制：只允許 patch／minor；不涉及 runtime、security 或 auth；不直接升級
  正式 repo；不啟用 automerge。
- 未觀測到的工具、PR、queue 或 owner 一律標 `UNKNOWN`，不推論為零。
- 沒有修改正式服務、systemd、資料庫、credentials 或外部 repo。

## 盤點清冊

| Repo | 可回查證據 | 更新工具／CI | 目前依賴觀測 | 判定 |
| --- | --- | --- | --- | --- |
| `task-tracker` (`/home/hom/code/task-tracker/sim-work/user05`) | `package.json`、`package-lock.json`；`npm`；root `dependencies` 為 0，只有 4 個 `devDependencies` | 未找到 `.github/workflows`、Dependabot、Renovate 或 matching dependency PR；本 repo 的可重跑門檻是 `npm run lint`、`npx tsc --noEmit` 及既有測試 | `npm outdated --json`：`@types/node` 24.13.2 → 24.13.3、`tsx` 4.22.4 → 4.23.8；TypeScript 5.9.3、ESLint 8.57.1 無 wanted 更新；`npm audit --omit=dev` 為 0 vulnerabilities | 可作盤點樣本；不進行正式升級，因 task 本輪只建立基線 |
| `job-risk-radar` (`/home/hom/services/job-risk-radar`) | `package.json`、`package-lock.json`、`.github/workflows/ci.yml`；`npm`；root `dependencies` 為 0，只有 4 個 `devDependencies` | CI 在 `master` push／PR 觸發 Node 22、`npm ci`、`npm run verify`；未找到 Dependabot、Renovate 或 matching dependency PR；registry 由 lockfile 的 npm registry URL 可回查 | `npm outdated --json`：`@types/node` 24.12.4 → 24.13.3、`tsx` 4.21.0 → 4.23.8、`vitest` 4.1.6 → 4.1.10；TypeScript 5.9.3 無 wanted 更新；`npm audit --omit=dev` 為 0 vulnerabilities | 適合做低風險 patch pilot；不得因此直接合併或啟用自動合併 |
| `line-stock-bot` | 既有 task 留言已記錄：`/home/hom/services/line-stock-bot` 不存在，並在 `/home/hom/code`、`/home/hom/services` 以名稱查找仍無 canonical repo | UNKNOWN；沒有 path 就不能查 manifest、lockfile、CI、registry、更新工具或 PR | UNKNOWN；不能推論為沒有更新 | 阻塞三 repo baseline 閉合；需 owner 提供 canonical path 或另開跨 repo 範圍 |

### 已知責任與缺口

- 各 repo 的 dependency／CI owner 未從可查證檔案指定，責任人為 `UNKNOWN`；在
  任何正式提案前由 Owner 指定 review、merge 與 rollback 決策者。
- `task-tracker` 沒有可觀測的 bot queue、cooldown、schedule 或依賴 PR 歷史；這只
  表示目前 repo 內沒有相關設定，不表示外部平台沒有工作。
- `job-risk-radar` 有成功 CI 證據：Verify run `25992771020`（2026-05-17，
  workflow：`.github/workflows/ci.yml`）；沒有可查證的 dependency PR／人工 merge
  證據，因此不把 CI 成功當成更新已合併。
- `line-stock-bot` 的缺口已先以 `[CROSS-REPO]` 留言告知；本輪不重跑同一查找，
  維持靜默直到 canonical path 或環境狀態改變。

## 受限 pilot：job-risk-radar 的 vitest patch

### 變更與相容邊界

- 隔離根目錄：`/tmp/job-risk-dependency-pilot-6Lv8g3`。
- source：`/home/hom/services/job-risk-radar`；正式 repo 未寫入。
- 唯一提案差異：`vitest` `^4.1.6` → `^4.1.10`，同步更新 lockfile 的 root
  specifier 與解析版本 `4.1.6` → `4.1.10`。
- 不改 Node engine、runtime dependency、CI workflow、registry 或 script。
- 回退以保存的 baseline `package.json`／`package-lock.json` 還原；不以
  `npm audit fix` 或自動升級擴大範圍。

### Readback

| 階段 | 證據 | 實際結果 |
| --- | --- | --- |
| baseline install | `baseline.log` | baseline 解析到 `vitest 4.1.6`，`npm ci` 成功 |
| proposal install | `proposal-ci.log` | `npm ci` 成功，安裝 54 packages |
| compatibility | `proposal-verify.log` | `npm run verify` 成功；38 test files、127 tests 全部通過，typecheck 與 build 也通過 |
| negative path | `broken.log` | 移除 lockfile 後 `npm ci` 以 `EUSAGE`／status 1 失敗；fail-closed |
| rollback | `rollback.log` | 回到 baseline 依賴後可重新 `npm ci`；未修改正式 repo |

pilot 的成功只證明這個隔離 patch 在當時的 Node/npm 與測試集合可重跑，不代表
正式部署的容量、registry、CI runner 或其他 consumer 已驗證。任何 verify 失敗、
lockfile drift、相容測試失敗或 rollback snapshot 不可讀，都必須停止，不得進入
人工 merge。

## Pilot 進入門檻

1. canonical repo/path、owner、manifest、lockfile、workflow 與 registry 均可回查。
2. default branch 有近期成功 CI，且 PR 觸發與驗證命令可重跑。
3. 只做 patch／minor；不得同時改 runtime、security、auth、資料格式或部署設定。
4. 隔離副本保留 baseline 與 proposal；`npm ci`、typecheck、test、build 及相容
   readback 全部成功。
5. 失敗須 fail-closed，回退以保存的 baseline 為準；最後由人工 review／merge，
   禁止 automerge。

## 重評觸發與下一步

- `line-stock-bot` 提供 canonical repo 後，補同一份清冊的 manifest、lockfile、CI、
  registry 與最近成功 check；若仍不存在，保留 UNKNOWN 與查找證據，不建立假 repo。
- 任一 repo 新增 runtime dependency、Dependabot／Renovate、container／vendor
  產物或安全／auth 相關更新時，重新判斷 pilot 是否仍屬低風險。
- 只有 Owner 指定責任人、review／rollback gate 並確認 baseline 證據後，才可另開
  正式提案；本 task 不升級依賴、不啟用 automerge。

## 可重跑查證命令

```bash
# task-tracker（目前 worktree）
npm outdated --json
npm audit --omit=dev --json
npx tsc --noEmit

# job-risk-radar（唯讀查詢）
cd /home/hom/services/job-risk-radar
npm outdated --json
npm audit --omit=dev --json
sed -n '1,220p' .github/workflows/ci.yml

# 隔離 pilot readback
for f in /tmp/job-risk-dependency-pilot-6Lv8g3/{baseline.log,proposal-ci.log,proposal-verify.log,broken.log,rollback.log}; do
  sed -n '1,180p' "$f"
done
```

以上命令與 pilot 均未對正式 repo 或服務產生寫入副作用。
