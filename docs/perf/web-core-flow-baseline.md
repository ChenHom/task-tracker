# task-tracker Web 核心流程效能 lab baseline（受限試點）

> 對應 task：`f896148d-f6cc-483d-8ed4-40fb22f61ec5`
>
> 執行人：小芸（user06）
>
> 首次量測：2026-08-05，Asia/Taipei；機器：本機開發環境，`localhost:3000`（loopback，無真實網路延遲）

## 結論

本次完成受限、lab-only 的 Web 效能 baseline，不是正式環境的 Web Vitals 或跨 repo SLO：

- **API round-trip**（登入→看板→task 詳情＋留言的完整 9 支 API）：已用固定 fixture、固定流程實測 5 次，取得 median／spread，可重跑指令與原始輸出見下方。
- **靜態資源盤點**（LCP/CLS 等瀏覽器渲染指標所需的資源基礎）：已盤點檔案數量、大小、快取與壓縮 header 現況。
- **瀏覽器渲染與 journey 指標**：原執行 session 的 Playwright MCP 權限阻塞由 Owner 於同日改用 repo 既有 `playwright-cli` 解除；Chrome 149、1365×768 下完整重跑 5 次，取得 LCP、CLS、Event Timing、Navigation／Resource Timing 與各流程分段時間。INP 僅記錄本次互動的 Event Timing 最大 duration，避免把少量 lab 操作冒充 field INP。
- **瀏覽器 smoke**：5 次均完成登入、進入 canonical workspace、顯示看板、開啟固定 task 並讀回 25 則留言；最終 URL 與 fixture 全部一致。
- 沒有安裝或外送任何 RUM／新依賴；產物只保存彙總 timing、資源 bytes／count 與 fixture 數量，不保存 task／留言內容，也沒有回寫資料。

## 固定條件（fixture）

| 項目 | 值 |
| --- | --- |
| 帳號 | `user06@test.local`（每次重新登入，不重用 session） |
| Workspace | `d9da9945-ce5f-400f-806e-1d75e95e313a`（canonical，41 tasks） |
| Fixture task | `6384b6f4-f92f-45a2-a5e1-133f04f76372`（Done，25 則留言，0 附件；已確認 5 次量測期間內容未變動） |
| 機器／網路 | 本機 loopback，同一台機器同時跑 server 與量測端，無外部網路變因 |
| Browser／viewport | Chrome `149.0.7827.114`、1365×768；`playwright-cli 0.1.14` 的獨立 `owner-perf` session |
| Browser run 隔離 | 每次清 cookies、開新 page、重新登入；不使用 persistent profile；第 4 次未收到 LCP entry，補跑一筆前景 page 後以該筆替換，保留完整 5 筆有效樣本 |
| Cache | 目前 server 對靜態資源不送 `Cache-Control`／`ETag`／`Last-Modified`（見下方盤點），故瀏覽器不會套用 heuristic cache；冷熱 cache 差異在現況下對此 app 不具意義，已記錄為現況而非改善項 |
| 併發 | 同一 workspace 為其他 agent 共用的協作看板，task 數量可能隨時間波動；量測當下用 `curl` 直接讀 API 回應大小佐證 5 次期間資料一致（見下表 size 欄全同） |

## 核心流程 API 序列（drift check 結果，非猜測）

依序讀 `public/js/app.js`、`public/js/views/login.js`、`public/js/sidebar.js`、`public/js/views/notifications.js`、`public/js/views/kanban.js`（`loadAllData()`）、`public/js/views/task-detail.js` 確認登入→看板→task 詳情實際觸發的 9 支 API（不是憑印象假設）：

1. `POST /api/auth/login`
2. `GET /api/auth/me`
3. `GET /api/workspaces`（`syncGlobalWorkspaces`）
4. `GET /api/notifications?page=1&pageSize=15`（sidebar 未讀 badge）
5. `GET /api/workspaces/:id/tasks`（看板主資料，與 6/7 平行發出）
6. `GET /api/workspaces/:id/projects`
7. `GET /api/workspaces/:id/members`
8. `GET /api/tasks/:id/comments`（開啟 task 詳情 modal）
9. `GET /api/tasks/:id/attachments`（開啟 task 詳情 modal，與 8 平行發出）

## 可重跑指令

每次重跑用全新 cookie jar（避免沿用 session），依序執行以下 9 支 `curl`（真實跑過 5 次，指令與輸出如下）：

```bash
curl -s -o /dev/null -w '01_login total=%{time_total}s size=%{size_download}B http=%{http_code}\n' \
  -c /tmp/jar.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"user06@test.local","password":"test1234"}'
curl -s -o /dev/null -w '02_me total=%{time_total}s size=%{size_download}B http=%{http_code}\n' \
  -b /tmp/jar.txt http://localhost:3000/api/auth/me
curl -s -o /dev/null -w '03_workspaces total=%{time_total}s size=%{size_download}B http=%{http_code}\n' \
  -b /tmp/jar.txt http://localhost:3000/api/workspaces
curl -s -o /dev/null -w '04_notifications total=%{time_total}s size=%{size_download}B http=%{http_code}\n' \
  -b /tmp/jar.txt 'http://localhost:3000/api/notifications?page=1&pageSize=15'
curl -s -o /dev/null -w '05_board_tasks total=%{time_total}s size=%{size_download}B http=%{http_code}\n' \
  -b /tmp/jar.txt http://localhost:3000/api/workspaces/d9da9945-ce5f-400f-806e-1d75e95e313a/tasks
curl -s -o /dev/null -w '06_projects total=%{time_total}s size=%{size_download}B http=%{http_code}\n' \
  -b /tmp/jar.txt http://localhost:3000/api/workspaces/d9da9945-ce5f-400f-806e-1d75e95e313a/projects
curl -s -o /dev/null -w '07_members total=%{time_total}s size=%{size_download}B http=%{http_code}\n' \
  -b /tmp/jar.txt http://localhost:3000/api/workspaces/d9da9945-ce5f-400f-806e-1d75e95e313a/members
curl -s -o /dev/null -w '08_comments total=%{time_total}s size=%{size_download}B http=%{http_code}\n' \
  -b /tmp/jar.txt http://localhost:3000/api/tasks/6384b6f4-f92f-45a2-a5e1-133f04f76372/comments
curl -s -o /dev/null -w '09_attachments total=%{time_total}s size=%{size_download}B http=%{http_code}\n' \
  -b /tmp/jar.txt http://localhost:3000/api/tasks/6384b6f4-f92f-45a2-a5e1-133f04f76372/attachments
```

## 實測結果（5 次，單位 ms，loopback）

| API | Run1 | Run2 | Run3 | Run4 | Run5 | median | spread(max-min) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 01 login (POST) | 28.7 | 28.4 | 35.8 | 31.0 | 29.0 | 29.0 | 7.4 |
| 02 auth/me | 0.39 | 0.38 | 0.31 | 0.29 | 0.30 | 0.31 | 0.10 |
| 03 workspaces | 0.39 | 0.35 | 0.30 | 0.33 | 0.40 | 0.35 | 0.10 |
| 04 notifications | 0.93 | 0.71 | 0.80 | 0.74 | 0.60 | 0.74 | 0.33 |
| 05 board tasks | 3.12 | 2.63 | 4.09 | 3.90 | 2.80 | 3.12 | 1.46 |
| 06 projects | 0.47 | 0.33 | 0.47 | 0.57 | 0.38 | 0.47 | 0.24 |
| 07 members | 0.44 | 0.39 | 0.70 | 0.63 | 0.49 | 0.49 | 0.31 |
| 08 comments | 1.46 | 1.44 | 1.69 | 1.67 | 1.52 | 1.52 | 0.26 |
| 09 attachments | 0.95 | 0.78 | 0.60 | 0.61 | 0.59 | 0.61 | 0.37 |
| **總和（單次完整流程）** | 36.9 | 35.4 | 44.8 | 39.8 | 36.1 | **36.9** | **9.4** |

回應大小（`size_download`）5 次完全相同，確認 fixture 期間資料未被其他 agent 變動：`login=11B`、`me=89B`、`workspaces=395B`、`notifications=7603B`、`board_tasks=73618B`、`projects=167B`、`members=1050B`、`comments=24462B`、`attachments=2B`。

## 瀏覽器核心 journey 實測（5 次，單位 ms）

每次均由登入頁執行真實表單輸入／submit，點擊 canonical workspace 卡片，再開啟固定 task 詳情。`max event duration` 來自 Event Timing（每次 6 筆具 interactionId 的 event），是本 lab 的互動延遲觀測值，不等同正式 field INP。

| 指標 | Run1 | Run2 | Run3 | Run4 | Run5 | median | spread(max-min) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Navigation DOMContentLoaded | 42 | 36 | 36 | 42 | 24 | 36 | 18 |
| Navigation loadEvent | 43 | 37 | 38 | 42 | 24 | 38 | 19 |
| Login → workspace visible | 112 | 93 | 110 | 86 | 90 | 93 | 26 |
| Workspace → board visible | 301 | 327 | 342 | 326 | 337 | 327 | 41 |
| Board → task detail visible | 94 | 96 | 92 | 107 | 94 | 94 | 15 |
| **完整 journey** | **508** | **517** | **544** | **519** | **520** | **519** | **36** |
| LCP | 72 | 60 | 64 | 68 | 60 | 64 | 12 |
| CLS | 0.0001 | 0.0001 | 0.0001 | 0.0001 | 0.0001 | 0.0001 | 0 |
| Max Event Timing duration | 72 | 48 | 48 | 40 | 40 | 48 | 32 |

Resource Timing 五次皆為 45 entries、`390,416 B` transfer size、`377,766 B` encoded body size。這包含初始靜態資源與 journey 中的 API 請求，不能與下節單純以 repo 檔案大小計算的靜態資源總量互換。

## 靜態資源盤點

App 是純 ES module SPA，無 code-splitting（`app.js` 靜態 import `routes.js`，`routes.js` 再靜態 import 全部 9 個 view 模組），因此首次載入一律抓齊全部 JS/CSS，與使用者實際進入哪個畫面無關：

| 類別 | 檔案數 | 總大小（未壓縮） |
| --- | ---: | ---: |
| HTML | 1 | 2,749 B |
| JS（`app.js` + `js/*.js` + `js/views/*.js`） | 20 | 178,451 B |
| CSS | 7 | 40,919 B |
| **合計** | **28** | **194,050 B（約 190 KB）** |

`curl -I` 確認 `app.js` 回應無 `Content-Encoding`、無 `Cache-Control`、無 `ETag`／`Last-Modified`（`src/server.ts` 靜態檔 handler 只設 `Content-Type` 與 `x-content-type-options`）：目前每次載入都是未壓縮全量傳輸，瀏覽器也無法套用 heuristic cache。

## 回歸預算建議（僅涵蓋本次實際量測到的項目）

| 指標 | Baseline（median） | 建議預算 | 依據 |
| --- | --- | --- | --- |
| 單次完整流程 API 總時間（loopback） | 36.9 ms | > 80 ms 視為異常需追查 | 5 次 spread 僅 9.4ms，波動小；抓 baseline 的 ~2 倍留緩衝，非正式 SLO |
| `GET /api/workspaces/:id/tasks` 單支 | 3.1 ms | > 15 ms 視為異常 | 目前隨 workspace task 數量線性成長（見下方候選發現），數字會隨資料量改變，此預算只適用本 fixture 規模（41 tasks） |
| 靜態資源總大小 | 194,050 B / 28 檔 | 增量 > 15%（約 +29 KB）需在 PR 說明 | 目前無任何壓縮／快取，任何新增檔案都是 100% 落在使用者身上，先用相對增量把關，不設絕對硬門檻 |
| 瀏覽器完整 journey | 519 ms | > 700 ms 視為異常需重跑確認 | 5 次 spread 36ms；只適用相同 Chrome、viewport、fixture 與 loopback 條件 |
| Lab LCP | 64 ms | > 150 ms 視為異常需重跑確認 | 本機小型 SPA 的 5 次 spread 12ms；不是 field LCP 或正式 SLO |
| Lab CLS | 0.0001 | > 0.01 視為異常需人工檢查 | 現況近零；門檻只用來抓明顯 layout shift，不宣稱 WCAG 或 Core Web Vitals conformance |
| Max Event Timing duration | 48 ms | > 100 ms 視為異常需重跑確認 | 每次只有 6 筆互動 event；作為 lab INP 線索，不當成 field INP |

以上預算皆為觀測性門檻：單次超過先在相同條件重跑，不直接作硬 gate。

## 原環境阻塞與解除紀錄

小芸原 session 的 Playwright MCP 瀏覽器工具（`browser_navigate`、`browser_resize`、`browser_close`）三次獨立呼叫皆回「需要人工核可，但此 session 無法核可」，非 code 問題。Owner 於 2026-08-05 改用已授權的 `playwright-cli` 獨立 Chrome session，依下方腳本語意完成 5 筆有效量測與 readback，因此本阻塞已解除；原 [ESCALATE] 保留作環境差異紀錄。

下方腳本保留為可重跑方法，不需要重新設計：

```js
// 在瀏覽器 DevTools console 貼上，或透過 Playwright/Puppeteer evaluate() 執行
// 需在導覽到 http://localhost:3000/ 之後、或頁面載入完成後皆可（用 buffered:true 補抓早期 entry）
async function measureCoreFlow() {
  window.__lcp = []; window.__cls = 0; window.__events = [];
  new PerformanceObserver(l => l.getEntries().forEach(e => window.__lcp.push({startTime: e.startTime, size: e.size})))
    .observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver(l => l.getEntries().forEach(e => { if (!e.hadRecentInput) window.__cls += e.value; }))
    .observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver(l => l.getEntries().forEach(e => window.__events.push({ name: e.name, duration: e.duration })))
    .observe({ type: 'event', buffered: true, durationThreshold: 16 });

  function wait(fn, timeout = 8000, interval = 40) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      (function poll() {
        let v; try { v = fn(); } catch { v = false; }
        if (v) return resolve(v);
        if (performance.now() - t0 > timeout) return reject(new Error('timeout'));
        setTimeout(poll, interval);
      })();
    });
  }

  await wait(() => document.getElementById('login-form'));
  performance.mark('t0_start');
  const emailEl = document.getElementById('login-email');
  const passEl = document.getElementById('login-password');
  emailEl.value = 'user06@test.local'; emailEl.dispatchEvent(new Event('input', { bubbles: true }));
  passEl.value = 'test1234'; passEl.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('login-form').requestSubmit();

  await wait(() => location.hash === '#/workspaces' && document.querySelectorAll('.workspace-card').length > 0);
  performance.mark('t1_workspaces_visible');

  const card = document.querySelector('[data-short-id="::d9da9945"]');
  const r = card.getBoundingClientRect();
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));

  await wait(() => location.hash === '#/tasks' && document.getElementById('kanban-board-el') && document.querySelectorAll('.task-card').length > 0);
  performance.mark('t2_board_visible');

  location.hash = '#/task/6384b6f4-f92f-45a2-a5e1-133f04f76372';
  await wait(() => document.querySelectorAll('#task-detail-modal .comment-item').length >= 20);
  performance.mark('t3_taskdetail_visible');

  performance.measure('login_to_workspaces', 't0_start', 't1_workspaces_visible');
  performance.measure('workspaces_to_board', 't1_workspaces_visible', 't2_board_visible');
  performance.measure('board_to_taskdetail', 't2_board_visible', 't3_taskdetail_visible');
  performance.measure('total_flow', 't0_start', 't3_taskdetail_visible');

  await new Promise(r2 => setTimeout(r2, 300));
  const nav = performance.getEntriesByType('navigation')[0] || {};
  return {
    navigation: { domContentLoaded: nav.domContentLoadedEventEnd, loadEvent: nav.loadEventEnd },
    measures: performance.getEntriesByType('measure').map(m => ({ name: m.name, duration: Math.round(m.duration) })),
    lcp: window.__lcp.at(-1)?.startTime ?? null,
    cls: window.__cls,
    maxEventDuration: window.__events.length ? Math.max(...window.__events.map(e => e.duration)) : 0
  };
}
measureCoreFlow().then(console.log);
```

重跑 5 次方式：每次先整頁重新載入（`location.reload()` 或關閉分頁重開），避免 SPA 內殘留的 `performance` timeline 干擾下一輪。

## 候選後續發現（不在本題實作，僅記錄）

- `GET /api/workspaces/:id/tasks` 回傳全部 task 的完整 description（本 fixture 41 筆已 73.6 KB），沒有分頁或欄位裁切；task 數量隨團隊使用持續成長，此端點大小會線性放大，值得未來開一張「看板列表 API 分頁/欄位精簡」的 task。
- 靜態資源完全無 `Cache-Control`／`ETag`／壓縮，28 個檔案、194 KB 每次登入都全量重傳；值得未來評估加 gzip/br 壓縮與快取 header（純後端 server 設定改動，風險低、報酬高）。
