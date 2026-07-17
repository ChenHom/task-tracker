# Sim 制度修正四項實作計畫（自動部署／ESCALATE 推播去重／派工前置同步／驗收分層）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 sim 中 ESCALATE 高頻卡點：live 部署漂移、升級訊息無人看見、worktree 落後派工前提、成員被搆不到的驗收卡死。

**Architecture:** 四項獨立小工程共用一個原則——把「機器可判定的事」從 ESCALATE 路徑移回自動化：systemd path unit 監看本地 master ref 觸發 build+restart；sweep 後掃 dev.db 新 ESCALATE 推 Discord（走 report.ts 既有的 openclaw CLI 路徑）；派工前 driver 先同步 worktree 與 master；prompt 明確劃分「成員=分支測試綠、owner=部署後 live 驗收」。

**Tech Stack:** bash + systemd user units、Node 24（node:sqlite、tsx）、既有 sim/run.test.ts 契約測試模式（source.includes + exported 函式直測）。

**背景（為何做）：** dev.db 777 則留言中 111 則（14%）是 [ESCALATE]。抽樣歸因：(1) fix 在分支但 localhost:3000 跑舊 dist、成員/owner 無權部署（~16 則，2026-07-17 案例躺 9 小時後 sim 以「不處理」結案，13 分鐘後人工部署才救回）；(2) worktree 與派工前提不同步——repo 不對、落後 master 50 commits（~30 則）；(3) 同一阻塞每小時重複留言無去重。ESCALATE 只被 buildSprintReport 計數（sim/run.ts:1456-1473），從不會主動到達人類。

---

## 事實依據（Explore 已查證，執行時可直接引用）

- 服務：`~/.config/systemd/user/task-tracker.service`，`WorkingDirectory=/home/hom/code/task-tracker`、`ExecStart=~/.nvm/versions/node/v24.3.0/bin/node dist/server.js`、`Restart=always`。repo 內原始碼版在 `deploy/task-tracker.service`。
- Sweep 觸發：`~/.local/bin/sim-sweep-cron.sh`（33 行）：`pgrep -f '\.bin/tsx sim/run\.ts'` 互斥（:19）→ health check（:24-28）→ `npm run sim -- --sweep ${ROLE}`（:30）。Timers：`sim-sweep-owner.timer`（每 :00/:30）、`sim-sweep-team.timer`（每 :15）。
- `.run.lock`：由 sim/run.ts `acquireRunLock()`（918-965）管理，cron script 不碰。
- Prompt 位置：member ESCALATE 規則 `sim/run.ts:1189`；member 完成定義 `doneDef` `sim/run.ts:1249-1251`（插入於 :1258）；owner sweep prompt `sim/run.ts:1919-1980`（整合驗證 step 5 在 :1978）；owner open/mid/close 的 ESCALATE 提及 :1337、:1360-1361、:1391。
- Worktree：`wt(m)=join(RUN.workDir, m.user)`、branch `sim/<user>`（:429-434）；`ensureSweepWorktree`（:1901-1911）只在 branch 無 unmerged 工作時才從 master 重建，**從不 merge master**。
- Discord 發送既成路徑：`/home/hom/.openclaw/workspace/owner-team-report/report.ts:138-155` 用 `execFileSync(OPENCLAW_BIN, ['message','send','--channel','discord','--target','channel:1515967128317071520', ...])`。repo 內無任何 webhook/ntfy script。
- 測試模式：`sim/run.test.ts:61` 讀 run.ts 原始碼做 `source.includes(...)` 契約斷言；函式直測僅 `notificationGatePrompt`（有 export）。`npm test` = `lint && typecheck && node --import tsx src/test.ts && node --import tsx sim/run.test.ts`（package.json）。
- 今日已實測：`npm test` 全套在 task-tracker.service 運行中跑過兩次皆綠、服務未受影響；但部署 gate 仍只用 build（見 Task 2 說明）。

---

## Task 1: /api/health 曝露 git rev（讓「live 落後」機器可判定）

**Files:**
- Modify: `src/server.ts`（health handler 附近）
- Test: `src/server.test.ts`

- [ ] **Step 1: 寫失敗測試** — 在 `src/server.test.ts` 既有 health 測試旁加：

```ts
// health 需回報部署中的 git rev，供部署 readback 與 owner live 驗收比對
const healthRes = await fetch(`${base}/api/health`);
const health = await healthRes.json();
assert.match(health.rev, /^[0-9a-f]{7,40}$/, 'health 必須帶 git rev');
```

（執行時先讀 server.test.ts 現有 health 斷言的實際寫法，比照其 fetch/base 變數命名。）

- [ ] **Step 2: 跑測試確認失敗** — `node --import tsx src/server.test.ts`，預期 assert rev undefined 失敗。

- [ ] **Step 3: 最小實作** — `src/server.ts` 啟動時讀一次 HEAD（不引入依賴）：

```ts
import { execFileSync } from 'node:child_process';
const GIT_REV = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname + '/..' }).toString().trim(); }
  catch { return 'unknown'; }
})();
```

health 回應改為 `{ status: 'ok', db: true, rev: GIT_REV }`（比照現有 health handler 實際結構修改）。注意 dist/ 執行時 `__dirname` 是 `dist/`，`cwd: join(__dirname,'..')` 即 repo 根，git 可用；`unknown` fallback 讓測試環境（無 .git 的暫存目錄）不炸——若測試環境拿到 `unknown`，Step 1 的 regex 改為 `/^([0-9a-f]{7,40}|unknown)$/` 並以整合驗證（Task 2 Step 6）覆蓋真實值。

- [ ] **Step 4: 跑測試綠** — `node --import tsx src/server.test.ts` PASS，再跑 `npx tsc --noEmit`。

- [ ] **Step 5: Commit** — `git add src/server.ts src/server.test.ts && git commit -m "feat: expose git rev in /api/health"`

## Task 2: master 自動部署（systemd path unit → build → restart → readback）

**Files:**
- Create: `deploy/sim-autodeploy.sh`
- Create: `deploy/sim-autodeploy.service`、`deploy/sim-autodeploy.path`
- Modify: `deploy/README.md`

**設計取捨（已定）：** gate 只做 `npm run build`（tsc 全量編譯）。完整 npm test 屬於合併階段的責任（owner sweep merge 時已跑、人工 push 前已跑）；部署階段重跑一是慢、二是 e2e 與 port 3000 正式服務有既知互踩風險（memory: fuser -k 3000/tcp）。監看**本地** `refs/heads/master`——owner sweep 的 merge 是本地操作，watch origin 會漏。

- [ ] **Step 1: 寫部署腳本** `deploy/sim-autodeploy.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO=/home/hom/code/task-tracker
STATE=/home/hom/.local/state/sim-autodeploy
LOG="$STATE/deploy.log"
mkdir -p "$STATE"
cd "$REPO"
HEAD=$(git rev-parse master)
DEPLOYED=$(cat "$STATE/deployed_rev" 2>/dev/null || echo none)
[ "$HEAD" = "$DEPLOYED" ] && exit 0
# ponytail: sweep 進行中就等（最多 30 分），避免重啟打斷 in-flight session
for _ in $(seq 60); do
  pgrep -f '\.bin/tsx sim/run\.ts' >/dev/null || break
  sleep 30
done
echo "[$(date -Is)] deploying $HEAD (was $DEPLOYED)" >>"$LOG"
if ! npm run build >>"$LOG" 2>&1; then
  echo "[$(date -Is)] BUILD FAILED, not restarting" >>"$LOG"
  "$REPO/sim/notify-human.sh" "⚠️ autodeploy build FAILED at $HEAD（服務仍跑舊版 $DEPLOYED）" || true
  exit 1
fi
systemctl --user restart task-tracker.service
sleep 3
REV=$(curl -sf --max-time 10 http://localhost:3000/api/health | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).rev))" || echo readback-failed)
if [ "$REV" = "$HEAD" ]; then
  echo "$HEAD" >"$STATE/deployed_rev"
  echo "[$(date -Is)] deployed OK rev=$REV" >>"$LOG"
else
  echo "[$(date -Is)] READBACK MISMATCH rev=$REV head=$HEAD" >>"$LOG"
  "$REPO/sim/notify-human.sh" "⚠️ autodeploy readback 不符：health rev=$REV, master=$HEAD" || true
  exit 1
fi
```

（`sim/notify-human.sh` 在 Task 3 Step 1 建立；本 task 先建檔案再接上，執行順序上 Task 3 Step 1 可先做。）

- [ ] **Step 2: 寫 systemd units** — `deploy/sim-autodeploy.path`：

```ini
[Unit]
Description=Watch task-tracker master ref for autodeploy
[Path]
PathModified=/home/hom/code/task-tracker/.git/refs/heads/master
Unit=sim-autodeploy.service
[Install]
WantedBy=default.target
```

`deploy/sim-autodeploy.service`：

```ini
[Unit]
Description=Task Tracker autodeploy (build + restart on master change)
[Service]
Type=oneshot
ExecStart=/home/hom/code/task-tracker/deploy/sim-autodeploy.sh
Environment=PATH=/home/hom/.nvm/versions/node/v24.3.0/bin:/usr/local/bin:/usr/bin:/bin
```

注意：git 在 pack-refs 後 `refs/heads/master` loose file 可能暫時不存在，PathModified 會失效；因此 path unit 加一條 `PathModified=/home/hom/code/task-tracker/.git/packed-refs` 同時監看兩處。

- [ ] **Step 3: 安裝並啟用**：

```bash
chmod +x deploy/sim-autodeploy.sh
install -D -m644 deploy/sim-autodeploy.{path,service} -t ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sim-autodeploy.path
```

- [ ] **Step 4: 初始化 state**（避免首次觸發時把「已是最新」誤判為要部署）：`mkdir -p ~/.local/state/sim-autodeploy && git -C /home/hom/code/task-tracker rev-parse master > ~/.local/state/sim-autodeploy/deployed_rev`

- [ ] **Step 5: 端到端驗證（真跑）** — 做一個空 commit 觸發：`git commit --allow-empty -m "chore: autodeploy smoke"`，然後 60 秒內確認三件事：`journalctl --user -u sim-autodeploy.service -n 20` 顯示執行；`cat ~/.local/state/sim-autodeploy/deploy.log` 有 deployed OK；`curl -s localhost:3000/api/health` 的 rev == `git rev-parse master`。驗完 `git reset --hard HEAD~1` 清掉空 commit（會再觸發一次部署，屬預期，rev 回到前一版同樣驗證 readback）。

- [ ] **Step 6: 更新 deploy/README.md**（加 autodeploy 一節：安裝、停用 `systemctl --user disable --now sim-autodeploy.path`、log 位置）並 commit：`git add deploy/ && git commit -m "feat(deploy): autodeploy master via systemd path unit"`

## Task 3: ESCALATE 推播（sweep 後掃新留言 → Discord）

**Files:**
- Create: `sim/notify-human.sh`（薄包裝，單一出口）
- Create: `sim/escalateNotify.ts`（掃描邏輯，可注入測試）
- Create: `sim/escalateNotify.test.ts`
- Modify: `~/.local/bin/sim-sweep-cron.sh`（repo 外，人工步驟）
- Modify: `package.json`（test script 加一段）

- [ ] **Step 1: 寫 `sim/notify-human.sh`**（所有「通知人類」走這裡，之後換管道只改此檔）：

```bash
#!/usr/bin/env bash
# 用法: notify-human.sh "訊息"。走 report.ts 同款 openclaw 路徑；失敗不中斷呼叫方。
set -u
BIN="${OPENCLAW_BIN:-openclaw}"
exec "$BIN" message send --channel discord --target channel:1515967128317071520 --message "$1"
```

執行時先 `command -v openclaw` 確認在 PATH；若不在，讀 `/home/hom/.openclaw/workspace/owner-team-report/report.ts:21` 取得 OPENCLAW_BIN 實際路徑填入預設值。

- [ ] **Step 2: 寫失敗測試** `sim/escalateNotify.test.ts`（比照 run.test.ts 的 mkdtempSync + 注入模式）：

```ts
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { scanNewEscalates } from './escalateNotify';

const dir = mkdtempSync(join(tmpdir(), 'esc-notify-'));
const db = new DatabaseSync(join(dir, 'dev.db'));
db.exec(`CREATE TABLE comments (comment_id TEXT, task_id TEXT, user_id TEXT, content TEXT, created_at TEXT);
CREATE TABLE tasks_read_model (task_id TEXT, title TEXT, workspace_id TEXT, status TEXT, priority TEXT, description TEXT, assignee_id TEXT, project_id TEXT, due_at TEXT, version INT, updated_at TEXT);`);
db.prepare("INSERT INTO tasks_read_model (task_id, title) VALUES ('t1', '[BUG] guard 卡住')").run();
db.prepare("INSERT INTO comments VALUES ('c1','t1','u3','[ESCALATE] 部署漂移','2026-07-17T10:00:00Z')").run();
db.prepare("INSERT INTO comments VALUES ('c2','t1','u3','一般留言','2026-07-17T10:01:00Z')").run();

const statePath = join(dir, 'state.json');
// 第一次掃描：撈到 1 則、狀態前進
const sent: string[] = [];
let n = scanNewEscalates(join(dir, 'dev.db'), statePath, (msg) => sent.push(msg));
assert.strictEqual(n, 1);
assert.ok(sent[0].includes('[BUG] guard 卡住') && sent[0].includes('部署漂移'), '訊息含 task 標題與內容');
// 第二次掃描：無新 ESCALATE → 不發送（去重核心）
n = scanNewEscalates(join(dir, 'dev.db'), statePath, (msg) => sent.push(msg));
assert.strictEqual(n, 0);
assert.strictEqual(sent.length, 1);
console.log('escalateNotify.test.ts OK');
```

（執行時 CREATE TABLE 欄位以 `src/schema.ts` 實際 migration 為準，最小欄位即可。）

- [ ] **Step 3: 跑測試確認失敗** — `node --import tsx sim/escalateNotify.test.ts`，預期 import 失敗（模組不存在）。

- [ ] **Step 4: 實作 `sim/escalateNotify.ts`**：

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

interface EscRow { rowid: number; content: string; created_at: string; title: string | null }

export function scanNewEscalates(dbPath: string, statePath: string, send: (msg: string) => void): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let last = 0;
  try { last = JSON.parse(readFileSync(statePath, 'utf8')).lastRowid ?? 0; } catch { /* 首次執行 */ }
  const rows = db.prepare(`SELECT c.rowid AS rowid, c.content, c.created_at, t.title
    FROM comments c LEFT JOIN tasks_read_model t ON t.task_id = c.task_id
    WHERE c.rowid > ? AND c.content LIKE '%[ESCALATE]%' ORDER BY c.rowid`).all(last) as unknown as EscRow[];
  for (const r of rows) {
    send(`🚨 [ESCALATE] ${r.title ?? '(unknown task)'}｜${r.created_at}\n${r.content.slice(0, 300)}`);
  }
  const maxRowid = db.prepare('SELECT COALESCE(MAX(rowid),0) AS m FROM comments').get() as { m: number };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ lastRowid: maxRowid.m }));
  return rows.length;
}

// CLI 進入點：node --import tsx sim/escalateNotify.ts <dbPath>
if (process.argv[1]?.endsWith('escalateNotify.ts')) {
  const dbPath = process.argv[2] ?? '/home/hom/code/task-tracker/data/dev.db';
  const state = `${process.env.HOME}/.local/state/sim-escalate/state.json`;
  const n = scanNewEscalates(dbPath, state, (msg) => {
    try { execFileSync(`${dirname(process.argv[1])}/notify-human.sh`, [msg], { stdio: 'ignore' }); }
    catch (e) { console.error('notify failed:', (e as Error).message); }
  });
  console.log(`escalate-notify: ${n} new`);
}
```

state 前進到「全表 MAX(rowid)」而非最後一則 ESCALATE 的 rowid——語意是「掃過這個時點之前的所有留言」，兩者皆可，MAX 較不易在無新 ESCALATE 時重複掃舊區間。

- [ ] **Step 5: 跑測試綠** — `node --import tsx sim/escalateNotify.test.ts` → `escalateNotify.test.ts OK`；`npx tsc -p sim/tsconfig.json` 乾淨。

- [ ] **Step 6: 接上 cron** — 編輯 `~/.local/bin/sim-sweep-cron.sh`，在 `npm run sim -- --sweep ${ROLE}` 那行（:30）之後加：

```bash
node --import tsx sim/escalateNotify.ts >>"$LOG_FILE" 2>&1 || true
```

（變數名以該檔實際 log 變數為準；`|| true` 保證通知失敗不影響 sweep 結果碼。）

- [ ] **Step 7: 把測試納入 npm test** — package.json test script 改為：`... && node --import tsx sim/run.test.ts && node --import tsx sim/escalateNotify.test.ts`

- [ ] **Step 8: 真跑驗證** — `node --import tsx sim/escalateNotify.ts`（對真 dev.db）：首次會把歷史 111 則視為已處理嗎？——不會，首次 state 不存在 last=0 會全掃。**先手動初始化 state 避免灌爆 Discord**：`mkdir -p ~/.local/state/sim-escalate && node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/home/hom/code/task-tracker/data/dev.db',{readOnly:true});const m=db.prepare('SELECT MAX(rowid) m FROM comments').get().m;require('fs').writeFileSync(process.env.HOME+'/.local/state/sim-escalate/state.json',JSON.stringify({lastRowid:m}))"`，再跑 CLI 確認輸出 `escalate-notify: 0 new`。最後發一則測試訊息驗證管道：`sim/notify-human.sh "🔧 escalate-notify 管道測試"`，在 Discord 看到即通過。

- [ ] **Step 9: Commit** — `git add sim/notify-human.sh sim/escalateNotify.ts sim/escalateNotify.test.ts package.json && git commit -m "feat(sim): push new ESCALATE comments to Discord after sweeps"`

## Task 4: ESCALATE 留言去重（prompt 規則 + 契約測試）

**Files:**
- Modify: `sim/run.ts:1189`（member API_RULES）、`sim/run.ts:1977`（owner sweep prompt）
- Test: `sim/run.test.ts`

- [ ] **Step 1: 寫失敗契約測試** — `sim/run.test.ts`（放在 :94-95 的 `[CROSS-REPO]` 斷言旁）：

```ts
assert.ok(
  (source.match(/同一 task 已有你留過且狀況未變的 \[ESCALATE\]，不要重複留言/g)?.length ?? 0) >= 2,
  'member 與 owner prompt 都必須含 ESCALATE 去重規則',
);
```

- [ ] **Step 2: 跑測試確認失敗** — `node --import tsx sim/run.test.ts`。

- [ ] **Step 3: 改 prompt** — `sim/run.ts:1189` 該條規則句尾加：`同一 task 已有你留過且狀況未變的 [ESCALATE]，不要重複留言；維持靜默直到阻塞內容改變或解除。` owner sweep prompt（:1977 的 ESCALATE 條目）加同一句。

- [ ] **Step 4: 跑測試綠** — `node --import tsx sim/run.test.ts` OK，`npx tsc -p sim/tsconfig.json` 乾淨。

- [ ] **Step 5: Commit** — `git add sim/run.ts sim/run.test.ts && git commit -m "feat(sim): dedup repeated ESCALATE comments via prompt rule"`

## Task 5: 派工前置同步（sweep 前 worktree merge master）

**Files:**
- Modify: `sim/run.ts`（`ensureSweepWorktree` :1901-1911 附近，新增 `syncWorktreeWithMaster` 並 export）
- Test: `sim/run.test.ts`（真 git 暫存 repo 測試，比照 mkdtempSync 模式）

- [ ] **Step 1: 寫失敗測試** — `sim/run.test.ts` 末段（真 git 場景）：

```ts
import { syncWorktreeWithMaster } from './run';
{
  const repo = mkdtempSync(join(tmpdir(), 'sync-wt-'));
  const g = (args: string[], cwd = repo) => execFileSync('git', args, { cwd }).toString().trim();
  g(['init', '-b', 'master']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(repo, 'a.txt'), '1\n'); g(['add', '.']); g(['commit', '-m', 'c1']);
  g(['worktree', 'add', join(repo, 'wt'), '-b', 'sim/u', 'master']);
  writeFileSync(join(repo, 'a.txt'), '2\n'); g(['add', '.']); g(['commit', '-m', 'c2']); // master 前進，branch 落後
  const r = syncWorktreeWithMaster(join(repo, 'wt'));
  assert.strictEqual(r, 'merged', '落後且無衝突 → 自動 merge master');
  assert.strictEqual(g(['rev-parse', 'sim/u']), g(['rev-parse', 'master']), '同步後與 master 齊');
  // dirty worktree → 跳過不動
  writeFileSync(join(repo, 'wt', 'a.txt'), 'dirty\n');
  assert.strictEqual(syncWorktreeWithMaster(join(repo, 'wt')), 'skipped-dirty');
}
```

（`execFileSync`/`writeFileSync` import 若 run.test.ts 尚未引入則補。）

- [ ] **Step 2: 跑測試確認失敗** — export 不存在。

- [ ] **Step 3: 實作** — `sim/run.ts`，放在 `ensureSweepWorktree` 旁：

```ts
export function syncWorktreeWithMaster(dir: string): 'merged' | 'up-to-date' | 'skipped-dirty' | 'conflict-aborted' {
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir }).toString().trim();
  if (g(['status', '--porcelain']) !== '') return 'skipped-dirty'; // 不動在製品（memory: dirty FAIL 死鎖）
  const behind = Number(g(['rev-list', '--count', 'HEAD..master']));
  if (behind === 0) return 'up-to-date';
  try { g(['merge', 'master', '--no-edit']); return 'merged'; }
  catch { try { g(['merge', '--abort']); } catch { /* 沒有進行中的 merge */ } return 'conflict-aborted'; }
}
```

呼叫點：sweep 的 member session 啟動前（`ensureSweepWorktree` 成功後）呼叫並 `console.log` 結果；`conflict-aborted` 時在該成員 prompt 前置區加一句「你的分支與 master 有衝突，本輪先處理 merge（依既有 merge conflict 流程）」——衝突訊息注入點比照 sweep 現有把 owner 意見塞進 prompt 的作法（執行時找 sweep 組 member prompt 的位置）。

- [ ] **Step 4: 跑測試綠** — `node --import tsx sim/run.test.ts` OK；`npx tsc -p sim/tsconfig.json` 乾淨。

- [ ] **Step 5: Commit** — `git add sim/run.ts sim/run.test.ts && git commit -m "feat(sim): sync member worktree with master before sweep dispatch"`

## Task 6: 驗收分層（prompt 修訂 + 契約測試）

**Files:**
- Modify: `sim/run.ts:1249-1251`（doneDef）、`sim/run.ts:1978`（owner sweep step 5）
- Test: `sim/run.test.ts`

- [ ] **Step 1: 寫失敗契約測試**：

```ts
assert.ok(
  source.includes('不要對 localhost:3000 做 live 驗收'),
  'member 完成定義必須排除 live 驗收',
);
assert.ok(
  source.includes('等待自動部署完成（health rev 與 master 一致）再做 live 驗收'),
  'owner sweep 必須在部署後才做 live 驗收',
);
```

- [ ] **Step 2: 跑測試確認失敗**。

- [ ] **Step 3: 改 prompt** —
  - `doneDef`（:1251）句尾加：`不要對 localhost:3000 做 live 驗收；live 行為以部署後的 owner 巡檢為準，live 與你分支不一致不是你的阻塞，不要為此 [ESCALATE]。`
  - owner sweep step 5（:1978）句尾加：`merge 後 master 會自動部署；需要 live 驗收時，等待自動部署完成（health rev 與 master 一致）再做 live 驗收，可用 GET /api/health 的 rev 欄位確認；rev 長時間不一致才留一次 [ESCALATE]。`

- [ ] **Step 4: 跑測試綠** — `node --import tsx sim/run.test.ts` OK。

- [ ] **Step 5: Commit** — `git add sim/run.ts sim/run.test.ts && git commit -m "feat(sim): layer acceptance — branch-green for members, post-deploy live smoke for owner"`

## Task 7: 文件與收尾

**Files:**
- Modify: `docs/operations.md`（autodeploy、escalate-notify 操作說明）
- Modify: `docs/tasks/current.md`（記錄本四項）

- [ ] **Step 1:** `docs/operations.md` 加「自動部署」「ESCALATE 推播」兩節：unit 名稱、log/state 路徑、停用指令、初始化 state 的指令（從 Task 2 Step 4 與 Task 3 Step 8 複製）。
- [ ] **Step 2:** `docs/tasks/current.md` 加一節記錄四項修正與日期（2026-07-XX 依實際執行日）。
- [ ] **Step 3:** 全套驗證 — `npm test` 全綠。
- [ ] **Step 4: Commit** — `git add docs/ && git commit -m "docs: record sim process fixes (autodeploy, escalate push, dispatch sync, acceptance layering)"`

---

## 端到端驗證（全部完成後）

1. **自動部署**：push 或本地 merge 一個 commit 到 master → 60 秒內 `curl -s localhost:3000/api/health` 的 rev 追上 `git rev-parse master`（Task 2 Step 5 已驗，此處為最終 readback）。
2. **推播**：等下一個整點 sweep（:00/:15/:30）後看 `~/.local/state/sim-escalate/state.json` 有前進、cron log 出現 `escalate-notify: N new`；若期間真有新 ESCALATE，Discord 收到訊息。
3. **去重／分層／同步**：下一輪 sweep 的 prompt artifact（sim-logs/sweep-*/prompts/）含新規則字句；member worktree 在派工 log 中出現 `merged`/`up-to-date`。
4. **一週後回歸指標**：`SELECT count(*) FROM comments WHERE content LIKE '%[ESCALATE]%' AND created_at > <部署日>` 對比部署前一週的 7 則/日均值——預期降至 ~2 則/日以下。

## 風險備忘

- run.ts 改動會與現存 sim 分支（user03/user06 尚有領先 commit）在未來合併時輕微衝突——與本次手解 run.ts 衝突同級，可接受。
- autodeploy 在 build 失敗時**不重啟**、通知人類，服務維持舊版運行（fail-safe）。
- escalate-notify 讀 DB 是 readOnly，與正式服務無鎖衝突（SQLite WAL 讀不阻塞寫）。
- 執行本計畫時 sim sweep 每 15 分鐘會觸發：改 run.ts 期間若 sweep 啟動會 pgrep 互斥不衝突，但 commit 前留意 worktree dirty 掃檔問題（memory）——每個 task 完成立即 commit。
