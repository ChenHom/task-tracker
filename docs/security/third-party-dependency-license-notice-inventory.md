# 跨 repo 第三方依賴授權與 NOTICE 唯讀試點

更新日期：2026-08-05

這是一份第一輪、範圍受限的唯讀盤點。目的只在把 `task-tracker` 與 `game1`
的實際 build / deploy 入口、lockfile、runtime artifact、LICENSE / NOTICE
證據與重新評估門檻寫成同一份可回查清冊；不是法律意見，也不是正式合規結論。

## 範圍

- 納入：會被實際部署或交付給使用者／維運者的 artifact、其 lockfile、
  systemd / nginx 入口，與 repo-local `LICENSE` / `NOTICE` 證據。
- 排除：純個人 prompt、離線測試、一次性實驗、未發布草稿、只存在於開發期的工具鏈副作用。
- 查證日：2026-08-05。只讀 repo 檔案、lockfile、build 產物與 deploy unit；
  未碰正式環境或線上流量。

## 結論與邊界

- 兩個 repo 目前都沒有可見的 runtime third-party dependency surface。
- `task-tracker` 的 `package-lock.json` root 只有 4 個 `devDependencies`，
  runtime deps 為 0；`game1` 的 `package-lock.json` root 只有 1 個 `devDependency`，
  runtime deps 為 0。
- `task-tracker` 的 live entry `dist/server.js` 只 import `node:*` builtins 與本地模組；
  `game1` 的 live entry `server.js` 只 import `node:*` builtins，
  `dist/main.js` 只 import `./core.js`。
- 兩個 repo 都沒有 repo-local `LICENSE` 或 `NOTICE` 檔案可回查。
- 目前能確認的授權證據只落在 build / tooling 這一層；它們是 dev-only，不是 deployed runtime artifact。
- `game1` 的 nginx installer script 有一個可驗證缺口：它引用的
  `/home/hom/code/game/game1/deploy/game-pinball-default-location.conf`
  不在這個 checkout 內，因此 route snippet 只能標 `UNKNOWN`。

## 盤點清冊

| Repo | Build / deploy entry | Runtime artifact readback | lockfile readback | LICENSE / NOTICE readback | current interpretation |
| --- | --- | --- | --- | --- | --- |
| `task-tracker` | `npm run build` -> `tsc`; live unit `deploy/task-tracker.service` runs `node dist/server.js`; deploy notes are in [`deploy/README.md`](../../deploy/README.md) | `dist/server.js` imports only `node:http`, `node:fs/promises`, `node:path`, `node:crypto`, `node:child_process` and local modules; `npm run build` emits a `dist/` tree from source | root runtime deps `0`; dev deps `4`: `@types/node` `24.13.2` `MIT`, `eslint` `8.57.1` `MIT`, `tsx` `4.22.4` `MIT`, `typescript` `5.9.3` `Apache-2.0` | no repo-local `LICENSE` or `NOTICE` file found | current shipped runtime is internal JS + Node builtins only; build toolchain is dev-only |
| `game1` | `npm run build` -> `tsc -p tsconfig.json`; live unit `deploy/pinball-bounce.service` runs `node /home/hom/code/game/game1/server.js`; route installer `deploy/install-game-pinball-nginx-route.sh` exposes `/game/pinball/` | `server.js` imports only `node:http`, `node:fs/promises`, `node:path`, `node:url`; `dist/core.js` has no external imports; `dist/main.js` imports only `./core.js` | root runtime deps `0`; dev deps `1`: `typescript` `5.9.3` `Apache-2.0` | no repo-local `LICENSE` or `NOTICE` file found | current shipped runtime is Node builtins + local modules only; nginx snippet path is `UNKNOWN` in this checkout |

## 授權證據

### task-tracker

- `package-lock.json` 只有 dev toolchain 的授權標籤：
  `@types/node` `MIT`、`eslint` `MIT`、`tsx` `MIT`、`typescript` `Apache-2.0`。
- 這些套件只出現在 build / test chain，不進 `dist/server.js` 的 runtime import graph。
- 因為 shipped artifact 沒有第三方 runtime package，現階段沒有看到需要為 runtime artifact 另外補 `NOTICE` 的證據。

### game1

- `package-lock.json` 只有一個 dev toolchain 套件：`typescript` `5.9.3`，授權為 `Apache-2.0`。
- `server.js` 與 `dist/*.js` 的 import graph 只落在 Node builtins 與本地模組，沒有第三方 runtime package。
- 因為 shipped artifact 沒有第三方 runtime package，現階段沒有看到需要為 runtime artifact 另外補 `NOTICE` 的證據。

## 受限驗證

### task-tracker

- `npm run build`
- `node` script 讀 `package-lock.json`，確認 root runtime deps 為 0、dev deps 為 4
- `rg -n "from |require\\(" dist/server.js`
- `rg --files . | rg '(^|/)(LICENSE|NOTICE)(\\.|$)'`

### game1

- 只做 read-only 讀檔：`package.json`、`package-lock.json`、`server.js`、`dist/core.js`、
  `dist/main.js`、`deploy/pinball-bounce.service`、`deploy/install-game-pinball-nginx-route.sh`
- `node` script 讀 `/home/hom/code/game/game1/package-lock.json`，確認 root runtime deps 為 0、dev deps 為 1
- `rg -n "from |require\\(" /home/hom/code/game/game1/server.js`
- `rg -n "from |require\\(" /home/hom/code/game/game1/dist/core.js`
- `rg -n "from |require\\(" /home/hom/code/game/game1/dist/main.js`
- `rg --files /home/hom/code/game/game1 | rg '(^|/)(LICENSE|NOTICE)(\\.|$)'`

## 未解項目與重評觸發

- 如果未來任何 repo 開始把第三方 runtime package ship 進 artifact
  （bundled JS、container image、installer、vendor dir），需要重做 license / NOTICE review。
- 如果 build toolchain 被包進分發品，也需要重查其 license obligations。
- 如果新增 repo-local `LICENSE` / `NOTICE` 或引入 copied upstream code snippets，需要重跑清冊。
- `game1` 的 nginx route snippet 文件目前在此 checkout 內缺失，這是本輪唯一明確的 `UNKNOWN` 點。

## 查回路徑

- [`deploy/task-tracker.service`](../../deploy/task-tracker.service)
- [`deploy/README.md`](../../deploy/README.md)
- [`package.json`](../../package.json)
- [`package-lock.json`](../../package-lock.json)
- `dist/server.js`
- `/home/hom/code/game/game1/deploy/pinball-bounce.service`
- `/home/hom/code/game/game1/deploy/install-game-pinball-nginx-route.sh`
- `/home/hom/code/game/game1/package.json`
- `/home/hom/code/game/game1/package-lock.json`
- `/home/hom/code/game/game1/server.js`
- `/home/hom/code/game/game1/dist/core.js`
- `/home/hom/code/game/game1/dist/main.js`
- `/home/hom/code/game/game1/docs/gameplay/pinball-bounce-v1.md`

## 驗證環境聲明

- `task-tracker` 的 build 只在目前 worktree 執行一次，生成的 `dist/` 仍受 `.gitignore` 忽略。
- `game1` 只做 read-only inspection，沒有對該 repo 寫入任何檔案。
- 沒有修改正式服務、nginx、systemd、DB、cookie、token 或外部服務。
