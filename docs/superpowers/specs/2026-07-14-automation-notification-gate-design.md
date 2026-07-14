# 自動化成員通知前置閘門設計

## 目標

所有自動化 owner 與 member session 在處理一般看板工作前，必須先讀取並處理登入當下的未讀通知。主工作區通知必須留下實際留言，避免「已讀」被誤當成已查看或已回覆。

## 範圍

- 本期只修改 `sim/run.ts` 的 API 驅動流程與 prompt；不新增前端通知入口、badge、WebSocket 或 browser automation。
- 適用於 owner sweep、team sweep 與一般 run 中由 runner 啟動的 owner/member session。
- 通知資料沿用 `GET /api/notifications`、`POST /api/notifications/:id/read` 與既有 task/comment API；不新增後端 schema 或 route。

## 前置流程

1. 每個 actor 以既有 `login()` 取得 cookie 後，立即取得自己的未讀通知快照。
2. 快照為空才可執行原本的看板巡檢、認領或 owner 收斂流程。
3. 快照中的每筆通知都要讀取 `source_task_id` 對應 TASK 與 `source_comment_id` 對應留言；來源資料會放進該 actor 的通知專用 prompt。
4. 主工作區來源必須由 actor 在該 TASK 留下一則新的留言。沒有補充時使用「已閱讀，目前無補充。」；有問題或建議時留下具體內容。
5. runner 在標記主工作區通知已讀前，重新讀取該 TASK 留言，確認存在由目前 actor 建立、且晚於前置快照的新留言。
6. 一般工作區通知由 prompt 依內容處理；來源成功讀取後才能標記已讀，並不強制每一筆都新增留言。
7. 每筆成功處理的通知呼叫 `POST /api/notifications/:id/read`。前置快照仍有任何未讀時，本 actor 本輪不執行一般工作。

## 無法開啟的來源

- TASK、留言或 workspace 已刪除，或 actor 對來源回 `403`／`404`：runner 輸出包含 notification id、來源 task id 與 HTTP status 的 unavailable 記錄，接著標記該通知已讀，避免永久阻塞。
- 網路錯誤、`5xx`、無法解析資料或未能驗證主工作區留言：不標記已讀，actor 本輪停止於前置流程；下次啟動重新嘗試。

## 一致性與迴圈界線

- 閘門只承諾清空 actor 登入當下取得的未讀快照；其他 actor 在處理期間新建立的通知，留給下一次登入前置流程。
- 通知處理留言不得包含 `@自己`。runner 與 prompt 都不應為了辨識、引用或確認而提及目前 actor 自己的 handle；後端既有的自我通知略過規則只能作為保護，不能取代這項輸出限制。
- 一個 actor 的通知前置失敗不應讓其他 actor 已完成的通知回復未讀；每個 actor 以自己的 cookie 與快照獨立處理。

## 驗證

- runner 單元測試覆蓋：無未讀直接通過、主工作區通知有新留言後才標已讀、主工作區缺少留言時不進一般工作、一般通知成功標已讀、403/404 記錄後標已讀、5xx 保留未讀、既有未讀快照逐筆處理。
- prompt 測試確認 member 與 owner 都收到通知前置規則，且主工作區要求留言後才標已讀。
- 不執行 live sweep；只跑 `sim/run.test.ts`、完整 `npm test` 與 TypeScript build。
