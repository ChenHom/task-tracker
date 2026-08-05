# task-tracker 關鍵資料備份還原演練（受限試點）

> 對應 task：`4a5fefb1-198b-4775-893e-92284041b543`
>
> 執行人：大熊（user05）
>
> 首次演練：2026-08-05，Asia/Taipei

## 結論

本次是「受限試點部分通過」，不能判定正式備份還原已就緒，也不應把這次結果當成 RPO/RTO 保證。

- 從部署中的 SQLite DB 建立隔離快照，連同附件實體檔複製到全新的 `/tmp` restore 目錄。
- 還原 DB 通過 `PRAGMA integrity_check`、`PRAGMA foreign_key_check`，資料筆數與附件 metadata／實體檔對上。
- 使用還原資料在非 3000 port 啟動 task-tracker，隔離 `/api/health` 回 HTTP 200、`status=ok`、`db=true`。
- 未找到 task-tracker 的既有排程備份、保留政策、異地副本或還原 job；RPO/RTO、金鑰／環境設定還原也尚未驗證。
- `TASK_TRACKER_DATA_DIR` 目前只切換 DB；`src/attachment.ts` 仍固定使用程式相對的 `data/attachments`，因此不能宣稱以單一資料目錄即可完整搬移 DB 與附件。

本次沒有修改正式 service、systemd unit，也沒有以演練方式回寫正式 DB；看板上的本 task 狀態變更依派工流程執行，演練副本只寫入 `/tmp`，且沒有驗收 live `localhost:3000` 服務。

## 現況盤點

| 類別 | 實際位置／來源 | 已確認狀態 |
| --- | --- | --- |
| SQLite DB | `/home/hom/code/task-tracker/data/dev.db` | 4,665,344 bytes；SQLite 3.50.1；`journal_mode=delete`；未見 `dev.db-wal` |
| 附件 metadata | DB 的 `attachments` table | 1 筆 |
| 附件實體 | `/home/hom/code/task-tracker/data/attachments/` | 1 個檔案，28 bytes |
| DB 路徑設定 | `src/db.ts:6-9` | `TASK_TRACKER_DATA_DIR` 可改 DB 目錄；未設定時為 repo `data/` |
| 附件路徑設定 | `src/attachment.ts:8-11` | 固定為 `join(__dirname, '../data/attachments')`，不跟隨 `TASK_TRACKER_DATA_DIR` |
| 部署服務 | `deploy/task-tracker.service:5-11` | user-level systemd；`WorkingDirectory=/home/hom/code/task-tracker`；執行 `dist/server.js` |
| 外部設定依賴 | `deploy/task-tracker.service:9` | `AI_QUOTA_STATE_PATH=/home/hom/.local/state/ai-quota/quota.json`；本次未備份或驗證該外部 state |

DB 盤點結果如下：

```text
users=30
workspaces=23
tasks=182
comments=1476
attachments=1
event_store=2036
foreign_keys=1
```

repo、`/home/hom/.local/state`、`/home/hom/backups`、`/var/backups` 的唯讀盤點未找到 task-tracker 備份鏈路。找到的 `/home/hom/backups/sqlite/2026-06-25/` 只有其他服務的 SQLite 檔案，沒有 `task-tracker` DB。

## 受限演練步驟

演練使用新的 `/tmp/task-tracker-restore-drill.XXXXXX` 目錄；來源 DB 不停機、不以裸 `cp` 當一致性快照。SQLite 沒有 `sqlite3` CLI，因此使用 Node 內建 `node:sqlite` 的唯讀連線執行 `VACUUM INTO`，再另外複製附件目錄。

```bash
DRILL_DIR="$(mktemp -d /tmp/task-tracker-restore-drill.XXXXXX)"
mkdir -p "$DRILL_DIR/vacuum/data/attachments" "$DRILL_DIR/restore/data/attachments"

node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync("/home/hom/code/task-tracker/data/dev.db",{readOnly:true}); const q=String.fromCharCode(39); const p=process.argv[1].replaceAll(q,q+q); db.exec("VACUUM INTO " + q + p + q); db.close(); console.log("vacuum-into-ok");' "$DRILL_DIR/vacuum/dev.db"
cp -a /home/hom/code/task-tracker/data/attachments/. "$DRILL_DIR/vacuum/data/attachments/"

cp -p "$DRILL_DIR/vacuum/dev.db" "$DRILL_DIR/restore/data/dev.db"
cp -a "$DRILL_DIR/vacuum/data/attachments/." "$DRILL_DIR/restore/data/attachments/"
```

最後將還原內容複製到另一個空白 `boot/data` 目錄，確認 app 的 DB 啟動初始化，再以 `PORT=33105` 啟動隔離服務；完成後以 Ctrl-C 停止該隔離 process。

## 本次實測證據

### 快照與還原完整性

快照時間約為 2026-08-05 14:19（Asia/Taipei）。`VACUUM INTO` 會重寫／壓縮 SQLite 檔案，所以原始 DB 與快照的 bytes hash 不同是預期現象；判定依資料 readback 與還原 hash，不依檔案 bytes 相等。

```text
vacuum DB sha256  = aecd2daa0e74e3fb8e95e17a62f8de61ed974131c147b9092b8b0a75f767b866
restore DB sha256 = aecd2daa0e74e3fb8e95e17a62f8de61ed974131c147b9092b8b0a75f767b866

vacuum attachment sha256  = 67d7f3dcf6178b8b988dc8410101bbf02a270731187e6cee68b47c0396c46a95
restore attachment sha256 = 67d7f3dcf6178b8b988dc8410101bbf02a270731187e6cee68b47c0396c46a95
```

還原 DB readback：

```text
PRAGMA integrity_check = ok
PRAGMA foreign_key_check = []
users=30, workspaces=23, tasks=182, comments=1476,
attachments=1, events=2036
attachmentFiles=1
missingAttachments=[]
```

### 隔離服務啟動

```bash
TASK_TRACKER_DATA_DIR="$DRILL_DIR/boot/data" PORT=33105 node --import tsx src/server.ts
curl -sS -i http://127.0.0.1:33105/api/health
```

實際 readback：

```text
HTTP/1.1 200 OK
{"status":"ok","db":true,"rev":"43c55ae2644d7c8886e21fbbcb390e4329734eb0"}
```

`src/db.ts` 在同一個隔離 `TASK_TRACKER_DATA_DIR` 也能完成 startup，讀出 `tasks=182`。這證明 DB 快照可供本 repo 的 app 啟動；`rev` 是本次 worktree 的程式版本，不是正式部署版本 readback。

### 已重現的附件路徑缺口

以 `TASK_TRACKER_DATA_DIR="$DRILL_DIR/boot/data"` 載入 `src/attachment.ts` 時，實際輸出仍是：

```text
attachment-dir=/home/hom/code/task-tracker/sim-work/user05/data/attachments
```

這與還原資料的 `$DRILL_DIR/boot/data/attachments` 不同。現況若要做完整隔離服務還原，必須同時依賴程式相對的附件目錄；單獨設定 DB data directory 會讓附件讀寫落到另一個位置。

## 缺口與最小補強建議

1. **先補一致的資料根目錄 seam**：讓附件實體路徑與 DB 共用同一個資料根目錄，並補一個只驗證自訂 data directory 的 attachment regression；不要先引入備份平台或新 schema。
2. **再建立單一 task-tracker backup job**：同一輪產生 SQLite 一致快照、附件副本、時間／版本／檔案清單與 sha256 manifest；job 必須明確記錄失敗，不把單純「檔案存在」當成功。
3. **定義並量測保留與 RPO/RTO**：先由 owner 決定保存週期與目標，再在隔離空白目錄實際恢復 DB、附件、必要設定／金鑰，量測備份時間點、還原耗時與 app health／登入／讀寫 readback。
4. **補定期演練與回退界線**：演練只能寫隔離目錄；正式 service、user unit 與正式 DB 不在本 task 內直接停機或回寫。完成上述補強前，結論維持「不得上線」。

## Owner 驗收摘要

| 驗收項目 | 結果 |
| --- | --- |
| 可由紀錄重現隔離 DB／附件快照與還原 | 通過 |
| 還原 DB integrity／FK／資料筆數 | 通過 |
| 還原附件 metadata／實體檔 | 通過（本次資料 1 筆） |
| 隔離 app health 啟動 | 通過，HTTP 200、`db=true` |
| 正式備份 job／保留／異地副本 | 未驗證，現況不存在 |
| RPO／RTO | 未量測 |
| 必要設定／金鑰可還原 | 未驗證 |
| 以單一 data directory 完整還原 DB＋附件 | 未通過，附件路徑 seam 尚未一致 |

最終判定：**受限試點部分通過；不得視為正式備份還原完成。**
