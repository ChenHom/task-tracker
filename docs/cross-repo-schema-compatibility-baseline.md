# 跨 repo 資料庫 Schema 相容部署盤點與受限驗證基線

> 查證日：2026-08-05。此文件是一次性唯讀盤點；`UNKNOWN` 表示未以證據補齊，不能推定為沒有風險。所有路徑均為可回查的原始碼或部署檔，未讀取或修改正式資料庫、憑證、服務或排程。

## 決策摘要

本輪只把「有難以重建資料，且已有資料回填／schema 相容程式可在隔離副本量測」的 `tw-day-trading` 納入後續 staging 候選。`task-tracker` 和 `ai-quota` 分別是單一實例的啟動式 SQLite schema 與可重建 JSON snapshot；兩者都記錄理由後排除，不為此導入共用 migration 平台或 expand-and-contract 雙寫。

正式／共享資料、服務與部署設定均未改動。本輪不把既有 unit test 視為 staging 量測，也不把沒有實測的 lock、rewrite 或維護窗填成已知值。

## 清冊

| Repo／服務 | 資料與可重建性 | Schema／migration runner | 部署重疊與責任 | 納入判定與證據 |
| --- | --- | --- | --- | --- |
| `task-tracker` (`/home/hom/code/task-tracker`) | `data/dev.db` 的 SQLite read model 與 event store；本盤點不量測資料量或最大表。服務是單一 user-level `task-tracker.service`，不見多實例 rollout 證據。 | `src/db.ts` 每次啟動以 `runMigrations(db)` 執行；`src/schema.ts` 主要為 `CREATE TABLE IF NOT EXISTS`，少量 `ALTER TABLE ... ADD COLUMN` 以既有欄位錯誤容忍。沒有 versioned migration 表或獨立 runner。 | `deploy/task-tracker.service`：`Restart=always`、working directory 為主 repo。部署／資料 owner、可接受維護窗、最大表、lock 與 rewrite 預估皆為 `UNKNOWN`。 | **排除（低風險）**：目前單一 SQLite 實例與 idempotent 啟動式建立不符合需要新舊 app 併行的門檻。若引入不可逆資料格式、長時間表重寫、複本部署或多 instance，必須重新納入。 |
| `ai-quota` (`/home/hom/services/ai-quota`) | 私有 state 是 `/home/hom/.local/state/ai-quota/quota.json`；是由 provider polling 重建的 snapshot，不是帳務或使用者主資料。 | `src/store.ts` 用 temporary file + `rename` 原子寫入，讀取端只接受 `schemaVersion === 1`，並驗證 providers、windows 與 status。它沒有資料庫或 migration runner。 | `deploy/ai-quota.service` 是 `Type=oneshot`；`deploy/ai-quota.timer` 每五分鐘執行。`task-tracker` 的 `src/quota.ts` 為已知 consumer，讀取同一路徑並在 state 不可讀時回傳 unavailable/stale。服務 owner、public snapshot 其他 consumer、維護窗皆為 `UNKNOWN`。 | **排除（可重建資料）**：檔案介面需要 consumer contract 管理，但不適用資料庫 expand-and-contract。本輪不切換 state path 或 snapshot。若 schemaVersion 變更，另開 ai-quota → task-tracker contract task，先完成雙版本 fixture、consumer 清冊與 rollback gate。 |
| `tw-day-trading` (`/home/hom/services/stock/tw-day-trading`) | `data/app.db` 的 SQLite 帳務／成交事實與 projection 不可視為可任意重建；`fills`、`position_lots`、`fifo_matches`、`realized_pnl` 與 high-watermark 直接受 `strategy_id` 影響。`README.md` 另明定研究資料寫入隔離的 `data/research.db`，不碰 `app.db`。 | `src/portfolio/db.py:init_db` 是 schema add-column runner；`scripts/migrate_multi_strategy.py` 對空白 `strategy_id` 分批更新，初始化 watermark，最後對每個 account reconcile。第二次執行應為零寫入。 | repo 文件可證實常駐 `trading-web.service` 與每日 cron 路徑，但本輪未查 live unit、crontab 或 production DB。資料／部署 owner、最大表、可接受維護窗、正式 lock/rewrite 時間與新舊版本是否併行都是 `UNKNOWN`。 | **納入候選**：有真實且可重跑的資料回填程式與對帳 readback；但尚沒有被授權的 production backfill 或 staging snapshot。本輪只以合成 legacy fixture 量測，不能外推到正式資料量或鎖影響。 |

## 選定的受限驗證：tw-day-trading multi-strategy 回填

### 要驗證的變更與相容邊界

候選是既有 `scripts/migrate_multi_strategy.py`：它只處理仍為空字串的 `strategy_id`，依來源保留 `MANUAL_IMPORT → MANUAL`，其餘 legacy data 使用指定的 legacy strategy；持倉／FIFO／已實現損益再由相關 fill 推導。對帳未通過時 CLI 以非零結束。

程式 rollback 的邊界不是把已回填的值改回空字串：新 schema／新資料格式可被新版程式讀取，回退舊程式前必須先在隔離 snapshot 證明它能讀取非空 `strategy_id`。因此正式回退採 **roll-forward 優先**：停止寫入、保存 snapshot 與 migration report、修正新的 reader／reconcile，再重跑冪等 migration；不得在沒有資料分類證據下以 bulk UPDATE 抹除 strategy attribution。

### 隔離量測證據

| 項目 | 實際結果 |
| --- | --- |
| 資料規模與隔離方式 | `tests/unit/test_migration_script.py` 以 pytest 的 `tmp_path/legacy.db` 建立一個合成 account：兩筆 fills、兩筆 position lots、1 筆 market bar；不使用 `data/app.db`。 |
| 執行命令 | `PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -o cache_dir=/tmp/tw-day-trading-pytest-cache-20260805 tests/unit/test_migration_script.py`（cwd：`/home/hom/services/stock/tw-day-trading`）。 |
| 起訖與結果 | 2026-08-05 23:18:40 +08:00 起訖（命令不足一秒）；pytest 顯示 `1 passed in 0.06s`（整個命令 wall time 0.5s）。沒有對正式 DB 或服務寫入。 |
| 首次套用／驗證查詢 | fixture 斷言 strategy fill 是 `trend_pullback`、手動 fill 是 `MANUAL`、對應 lots 已回填、strategy watermark 為 1200000、`MANUAL` 不建立 watermark，且所有 account reconcile 為 `RECONCILE_OK`。 |
| 重跑／停止條件 | fixture 第二次呼叫 `migrate()` 時 fills、lots、watermarks 都為零寫入，reconcile 仍為 `RECONCILE_OK`。任何 reconcile 非 OK、未能歸屬的 anomaly、意外非零第二次寫入、或 staging lock 超過核定窗口，都必須停止，不得接觸正式 DB。 |
| lock／rewrite 觀測 | **尚未量測**。fixture 的 0.06s 不代表 production lock、journal growth、table rewrite 或 I/O。 |

## 未授權前不得執行的 staging／正式步驟

在取得資料 owner 和維運 owner 的明確授權前，不得執行 `python3 -m scripts.migrate_multi_strategy --db data/app.db`。下一次受限 staging 驗證至少需要：

1. 以遮蔽／隔離的 app.db snapshot 取得表列數、檔案大小與最大表；記錄 snapshot 時間、hash 與存放責任人。
2. 在同類 SQLite journal / filesystem 設定量測 `init_db` 與 migrate 的開始、結束、鎖等候、journal/WAL 成長與 I/O；設定核定的維護窗與中止門檻後才可開始。
3. 執行前後對 `strategy_id = ''` 的四個事實／projection 表做 count readback，保存 migration report、anomaly list 與每個 account 的 reconcile 結果；確認舊／新 reader 的相容矩陣。
4. 回退 gate 採停止寫入與 roll-forward：若 reader 或 reconcile 失敗，保留 snapshot、停止後續 rollout，修正新版相容性後重跑冪等 migration。只有資料 owner 核准且有還原演練證據時，才可從備份還原。

## 缺口、責任與重新評估

| 缺口 | 責任人 | 最小下一步／重評觸發 |
| --- | --- | --- |
| 三個 repo 的服務、資料與維護窗 owner 未由可查證來源指定。 | `UNKNOWN`；由各 repo 維運 owner 指派。 | 在任何 staging snapshot 或 production migration 前，在對應 repo 的 task 指定資料 owner、執行者、監看者與 rollback 決策者。 |
| tw-day-trading 正式資料量、最大表、lock/rewrite 與備份還原時間沒有隔離量測。 | `UNKNOWN`；tw-day-trading 資料 owner。 | 出現下一個需改現有帳務表的 schema 變更時，先建立遮蔽 snapshot，完成上述四項 readback。 |
| ai-quota 的現存與未知 consumers 未做完整清冊。 | `UNKNOWN`；ai-quota 維運 owner。 | `schemaVersion` 或 required field 要變更時，先做 consumer discovery、v1/v2 fixture 與 rollback test；沒有 evidence 不得視為零 consumer。 |
| task-tracker 未來若改為多 instance、加入長回填或不可逆資料格式，目前排除判定會失效。 | `UNKNOWN`；task-tracker 維運 owner。 | 任何 rollout / migration design 出現上述條件時，重開本盤點並量測 SQLite lock、備份與新舊 reader 相容性。 |

## 本輪限制

- 未改動任何跨 repo 原始碼、正式 DB、quota snapshot、systemd unit、cron 或 credentials。
- 未對 localhost 或正式服務做驗收；這份文件只記錄原始碼與隔離 fixture 的證據。
- 未建立新的 migration framework、雙寫或跨 repo 抽象層。
