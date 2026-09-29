# 跨 Repo 知識研究與自動出版設計

日期：2026-09-29  
狀態：已核准，待實作計畫  
涵蓋 repo：`task-tracker`、`RSSHub`、`harness`、`knowledge-mirror`、`knowledge-showcase`

## 1. 目的

建立一條可驗證的知識出版流程，將公開討論串與持續更新的 RSS 來源整理成書籍知識庫：

- 每本達到收錄門檻的書有一個索引與不限篇數的深入筆記。
- 重要主張以原始來源優先查證，並保留支持、反證、限制與不確定性。
- 每本書獨立研究、驗證與發布；單本失敗不阻擋其他書。
- 通過驗證後自動產生 `docs/`、同步公開 showcase，並以線上 readback 才判定完成。
- Task Tracker 保存工作狀態；Harness 保存執行證據；`knowledge-mirror/notes/` 保存 canonical 知識。

第一個真實來源是公開 ChatGPT 分享串：

`https://chatgpt.com/share/6abb3cc5-afc8-83ee-b169-f7ded2cb4081`

該頁已驗證為免登入 HTTP 200，頁面內嵌公開對話資料。結構化 share API 回 403，因此第一版需從公開 HTML 的內嵌資料擷取，不依賴受保護 API。

## 2. 核心決策

1. 採 Task 驅動的知識出版管線，不建立新的通用 queue 平台。
2. RSSHub 只負責持續來源發現，不直接寫知識庫或觸發發布。
3. 一次性的 ChatGPT 分享網址直接進 Intake Adapter，不硬做成 RSSHub route。
4. 一本書對應一個 Task Tracker Task 與一個 Harness Work；不限篇數以 Harness plan milestone 管理。
5. Research Runner、Harness、Publisher 分權：研究者不能寫 repo，寫作者不能上網，Publisher 不使用 LLM。
6. `knowledge-mirror/notes/` 是唯一手寫 canonical source；`docs/` 一律生成。
7. canonical repo 永遠先於 showcase 發布；跨 repo 發布不是原子交易，使用 release ID 與 reconciliation 收斂。
8. 自動發布採單書隔離；總索引只列已成功發布的書，失敗項目留在待研究清單。

## 3. 系統責任

### 3.1 RSSHub

- 監看 allowlist 中會持續更新的作者、出版社、正式訪談、勘誤、研究及高品質評論來源。
- 提供 item GUID、來源 URL、標題、時間與摘要給 Intake Adapter。
- 不建立正式知識筆記、不直接修改 Task 狀態、不持有 Git credential。
- 相同書籍的新 item 應連回既有 `[BOOK]` Task，不重複建立書籍。

### 3.2 Task Tracker

- 以固定 Project `知識庫補充` 保存來源 Task 與書籍 Task。
- 保存來源 URL、內容指紋、候選書、排除理由、Harness Work ID、驗證 evidence、release ID、commit 與公開網址。
- 使用既有 `Todo -> Doing -> Review -> Done`，不新增另一套狀態機。
- 使用既有 `::shortId` 關聯來源 Task 與書籍 Task，不在第一版新增 parent/child schema。
- 只有公開頁與兩個 Git repo 都完成 readback，書籍 Task 才能進 Done。

### 3.3 Research Runner

- 只提供 WebSearch/WebFetch 類能力，不提供 shell、repo、Git credential 或本機檔案存取。
- 只允許公開 HTTP/HTTPS；阻擋 loopback、私人網段、link-local、credential URL 與重新導向到受限目標。
- 對下載大小、回應類型、總來源數、單來源時間與整體預算設上限。
- 將網頁轉為消毒後的 source bundle；網頁文字一律視為不可信資料，不視為指令。

### 3.4 Harness

- 每本書建立隔離 Work，凍結 repository contract 與驗證規則。
- 維持 network deny，只讀取 Research Runner 產生的 source bundle。
- 修改範圍限於該書的 `notes/books/<book-slug>/`、書籍總索引，以及必要的 builder/test 檔。
- 執行內容、結構、來源、版權、build、manifest、diff 與連結驗證。
- 分開呈現 agent claim 與 Harness evidence；必要條件有 fail/unknown 時不得發布。

### 3.5 Deterministic Publisher

- 不使用 LLM；只接受 Harness 已通過的 release manifest。
- 持有範圍受限的 knowledge-mirror 與 knowledge-showcase 發布權限。
- 驗證 repo identity、origin、clean baseline、expected base revision、allowlisted diff 及 publication lock。
- 依序完成 canonical commit/push、showcase sync/commit/push、公開 HTTP readback。
- 對 timeout 或結果不明使用 `UNKNOWN`，先 reconcile remote ref、commit 與公開內容，禁止盲目重送。

### 3.6 Knowledge repositories

- `knowledge-mirror/notes/`：canonical 知識。
- `knowledge-mirror/docs/`：由 `scripts/build_pages.py` 生成。
- `knowledge-showcase`：`docs/` 的公開衍生副本，不含獨立內容來源。

## 4. 整體資料流

```text
ChatGPT 分享網址                 RSSHub allowlist item
       |                                 |
       +--------- Intake Adapter --------+
                         |
              canonicalize + dedupe
                         |
          Task Tracker [SOURCE] Task
                         |
           候選書辨識與收錄門檻
                         |
           每本合格書一個 [BOOK] Task
                         |
                 Research Runner
                         |
               sanitized source bundle
                         |
                   Harness Work
       claim ledger -> notes -> verification evidence
                         |
               required criteria PASS
                         |
              Deterministic Publisher
       canonical push -> showcase push -> live readback
                         |
            Task Tracker Review -> Done
```

## 5. Task Tracker 資料表示

### 5.1 Project

固定 Project 名稱：`知識庫補充`。

### 5.2 來源 Task

標題格式：

```text
[SOURCE] <來源標題>
```

描述至少包含：

- canonical URL
- source kind：`chatgpt-share` 或 `rsshub-item`
- fetched at
- content SHA-256
- RSS GUID（若適用）
- 候選書清單
- 已建立的 `::書籍Task`
- 排除書籍與理由

去重鍵：

- ChatGPT Share：canonical URL + content SHA-256
- RSSHub：feed identity + item GUID；GUID 缺失時使用 canonical URL + normalized publication time

同 URL 同內容不得重複開工；同 URL 內容改變則建立新的來源版本紀錄並連回原來源 Task。

### 5.3 書籍 Task

標題格式：

```text
[BOOK] <書名> — <作者>
```

一本書只使用一個 Task。描述或留言保存：

- 書籍識別與版本
- 來源 Task short ID
- Harness Work ID
- source bundle digest
- claim ledger digest
- validation summary
- release ID
- knowledge-mirror commit
- showcase commit
- 公開網址與 readback 結果

狀態語意：

| 狀態 | 語意 |
| --- | --- |
| Todo | 候選書，尚未通過收錄門檻 |
| Doing | 研究、來源整理或筆記產生中 |
| Review | 內容驗證或發布進行中；包含發布結果 UNKNOWN |
| Done | canonical、showcase 與公開頁全部 readback 成功 |
| Archived | 已明確停止追蹤的候選，不代表研究或發布失敗 |

HTTP 自動化仍須遵守一次只 PATCH 一個欄位。

## 6. Knowledge Mirror 內容結構

`scripts/build_pages.py` 目前只接受 `ai`、`backend`、`finance`、`infrastructure`、`mobile`。本功能新增第六個公開 domain：`books`。

```text
notes/books/
├── index.md
└── <book-slug>/
    ├── index.md
    ├── 01-core-thesis.md
    ├── 02-key-concept-<slug>.md
    ├── 03-evidence-and-criticism.md
    ├── 04-practical-application.md
    └── ...
```

篇數不限；檔名使用穩定的小寫 ASCII slug。新增或拆分筆記時必須更新該書索引與跨書總索引。

### 6.1 跨書總索引

`notes/books/index.md` 固定包含：

1. 已完成研究
2. 主題關聯
3. 推薦閱讀路徑
4. 待研究書籍
5. 證據不足或未收錄項目

### 6.2 每本書索引

`notes/books/<book-slug>/index.md` 固定包含：

1. 書籍識別：書名、作者、版本、出版資訊
2. 為何收錄
3. 核心主張地圖
4. 各篇知識筆記導航
5. 原始來源與來源層級
6. 爭議、限制與未解問題
7. 原討論來源
8. 最後查證日期

### 6.3 深入知識筆記

每篇筆記固定包含：

1. 核心命題
2. 為什麼重要
3. 書中的論證
4. 原始資料與延伸研究
5. 支持證據
6. 反證、限制與爭議
7. 可實際應用的方法
8. 不適用情境
9. 與其他書或既有知識的關係
10. 來源清單與查證日期

筆記以重新組織、比較與分析為主。只保留說明觀點所需的短引文，不重製章節、長段落、付費內容或可替代原書的連續摘要。

## 7. 書籍候選與收錄門檻

候選書必須同時符合：

1. 可確認書名、作者與版本，避免同名誤判。
2. 來源不是順帶提及，至少包含一個可研究的主張、方法或問題。
3. 至少找到一個 primary source：作者、出版社、官方書介、合法試閱或作者正式訪談。
4. 重要事實至少有第二來源交叉確認。
5. 能形成實質知識，不只是書籍簡介。
6. 不需要依賴盜版全文才能完成研究。

未通過者不建立正式書籍目錄，只進總索引待研究區，並保存明確排除理由。日後資料補足可重新評估。

## 8. 原始來源優先研究

來源層級：

1. `primary`：作者、出版社、官方書介、合法試閱、作者正式訪談。
2. `research`：書中引用的原始論文、官方統計、標準或基礎資料。
3. `secondary`：高品質書評、專業評論或可信媒體，用於補充與反方觀點。

每本書的 Harness Work 使用 claim ledger：

```text
claim_id
claim
source_url
source_level
relation: support | contradict | context
verification_status
note_paths
```

研究順序：

1. 確認書籍版本、作者與出版資料。
2. 從來源討論萃取核心命題，但不將討論內容視為已確認事實。
3. 找作者、出版社等 primary source。
4. 追查原始研究、案例與數據。
5. 找反證、批評、後續研究與適用限制。
6. 依概念邊界拆分不限篇數的筆記。
7. 建立書內、跨書及既有 knowledge-mirror 連結。
8. 檢查每個重要主張的來源覆蓋。

來源不足時只能標示為「作者主張」、「待查證」或「目前沒有獨立證據」，不得改寫成確認事實。

## 9. 驗證契約

一本書發布前必須全部通過：

1. 書名、作者、版本及來源識別完成。
2. 至少一個 primary source，重要事實有交叉來源。
3. claim ledger 沒有未標示的 unsupported claim。
4. 長篇引用、疑似原文重製、敏感資訊與 credential 掃描通過。
5. 固定章節、H1、檔名、內部連結與跨書連結正確。
6. 修改只落在該書目錄、總索引、必要 builder/test 與對應生成檔。
7. `python3 scripts/build_pages.py` 成功。
8. `docs/manifest.json` 包含預期筆記。
9. knowledge-mirror diff 沒有非預期變更。
10. showcase 隔離同步與連結驗證成功。

外部來源因反爬或暫時故障無法 readback 時為 `UNKNOWN`，只阻擋引用該來源的書，不影響其他書。

## 10. 發布協定

### 10.1 Release manifest

Publisher 只接受由 Harness evidence 生成且內容 digest 相符的 manifest：

- release ID
- book task ID
- source bundle digest
- claim ledger digest
- expected knowledge-mirror base revision
- allowlisted source paths
- required checks and results
- intended public paths

### 10.2 發布順序

```text
Harness PASS
  -> acquire publication lock
  -> verify both repo identities and clean baselines
  -> rebuild knowledge-mirror docs
  -> verify canonical diff allowlist
  -> commit and push knowledge-mirror
  -> run showcase dry-run/sync
  -> verify showcase diff allowlist
  -> commit and push knowledge-showcase
  -> HTTP/readback public pages
  -> update Task Tracker to Done
```

Publisher 必須序列化，避免多本書同時修改總索引及 manifest。

### 10.3 Showcase script hardening

現有 `scripts/build_showcase.py` 會刪除 showcase 中除 `.git` 與 README 以外的項目再複製 `docs/`。自動化前必須增加：

- `--dry-run`
- expected repo/origin 驗證
- clean baseline gate
- copy manifest
- diff allowlist
- publication lock
- release ID
- push 後 readback

任何 unrelated dirty state、unexpected deletion 或 origin mismatch 都須 fail closed。

### 10.4 部分發布與 UNKNOWN

- canonical push 失敗：不執行 showcase；Task 留在 Review。
- canonical push 成功、showcase 失敗：保存 canonical commit，reconcile 後只補 derived showcase。
- push timeout：先查 remote ref、commit SHA 與內容 digest，不直接重送。
- showcase push 成功、HTTP readback 暫時失敗：Task 留在 Review，重試 readback，不建立重複 commit。
- Done 後才發現公開內容錯誤：建立明確修正 release；不改寫或刪除歷史 evidence。

## 11. 失敗隔離與重試

- 每本書有自己的 Task、Harness Work、source bundle、claim ledger 與 release ID。
- 研究或驗證失敗留在 Doing；發布失敗或 UNKNOWN 留在 Review。
- 一本書失敗不阻擋其他已通過書籍。
- 總索引的已完成區只能由成功 release 生成；失敗書保留在待研究區。
- retry 必須沿用同一 Work/release identity 或明確 fork；不得靜默建立重複工作。
- 自動重試只適用確定未產生副作用的讀取、build 與驗證。Git push 等外部副作用須先 reconcile。

## 12. 測試策略

### 12.1 Unit tests

- URL canonicalization
- ChatGPT share ID parsing
- RSS GUID fallback
- content digest 與去重
- 私人位址／credential URL 阻擋
- 書籍識別正規化
- 收錄門檻
- source level 分類
- claim coverage
- release state 與 UNKNOWN reconciliation

### 12.2 Fixtures

- 使用小型合成 ChatGPT share fixture，不提交完整第三方對話。
- 提供同 URL 同內容、同 URL 更新、同名不同作者、只有順帶提書、來源不足等案例。
- 提供 prompt injection、惡意重新導向、過大回應與不可達來源案例。

### 12.3 Integration tests

- 暫存 Task Tracker／Harness adapter state。
- 暫存 knowledge-mirror 與 showcase Git repo。
- notes -> docs -> manifest -> showcase 全流程。
- dirty baseline、origin mismatch、unexpected diff、partial push 與 readback failure。
- 多書研究可平行、Publisher 必須序列化。

### 12.4 End-to-end rollout

1. 使用指定分享串擷取候選書。
2. 選一本文獻最完整的書完成 dry-run，不 push。
3. 人工核對第一次 dry-run 的筆記、來源、diff 與 Task evidence。
4. 啟用單本書自動發布。
5. 驗證 canonical commit、showcase commit、公開網址與 Task Done。
6. 擴充同來源多書。
7. 最後才接 RSSHub allowlist。

這個首次 dry-run 核對是 rollout gate，不改變正式穩定流程「通過自動驗證後自動發布」的目標。

## 13. 分期範圍

### Phase 1：單本書垂直切片

- ChatGPT share Intake Adapter
- 候選書識別與收錄門檻
- Research Runner source bundle
- 單本書 Harness Work、claim ledger 與筆記模板
- `books` domain 與 builder validation
- Publisher dry-run、正式發布與 Task evidence 回寫

### Phase 2：同來源多本書

- 每本書獨立 Work
- 平行研究、序列發布
- 自動維護跨書總索引
- 單書失敗隔離
- 重跑與內容更新冪等性

### Phase 3：RSSHub 持續來源

- feed allowlist
- item intake 與頻率限制
- 每日候選上限
- 既有書增量研究
- 新書收錄門檻
- RSS source health 與失敗 telemetry

## 14. 成功標準

- 能從指定分享串穩定產生候選書清單。
- 至少一本文獻充足的書完成公開發布。
- 每個重要主張都有來源或明確不確定性標示。
- 沒有未授權長篇原文、credential 或私人資料進入 Git。
- `notes/`、生成 `docs/`、showcase 與公開頁一致。
- 相同輸入重跑不建立重複 Task、筆記或 commit。
- 任一步驟失敗都不會誤把 Task 標為 Done。
- canonical 成功而 showcase 失敗時可安全續作。
- 單書失敗不影響其他書發布。

## 15. 非目標

- 不重建或公開整本書內容。
- 不讓 RSSHub item 直接觸發公開發布。
- 不讓 LLM 持有 Git push credential。
- 不新增通用 message queue 或第二套工作狀態機。
- 不改 Task Tracker 的正常狀態機。
- 不把 `docs/` 當手寫來源。
- 第一階段不處理私人或需登入的 ChatGPT 對話。
- 不啟動既有 live AI sim 車隊執行此流程。
- 不將 Harness 的 network deny 放寬成一般網頁瀏覽能力。

## 16. 操作與稽核

- Intake、Research、Harness 與 Publisher 皆使用相同 correlation ID／book task ID。
- 日誌不得保存 cookie、credential、完整 private prompt 或未消毒網頁內容。
- Task 留言只放摘要與 artifact pointer，不貼完整 source bundle。
- Harness trace 是執行證據；Git commit 是內容證據；公開 readback 是發布證據，三者不可互相取代。
- 自動化所需 token／Git credential 必須只注入 Publisher，且限目標 repo 與必要操作。
- 保留每次 release 的 input digest、checks、commit 與 readback，才能判斷重試、續作或修正 release。
