import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// 針對 public/js/views/notifications.js 的獨立 vm 沙盒（刻意不與 frontendViews.test.ts
// 共用同一個 vm context：該檔用同名 top-level function 當 stub，混在一起載入會被
// notifications.js 的同名 real function 蓋掉，反而讓既有測試的 mock 失效）。
// document.activeElement 的替身：renderPaginationNav() 用它判斷焦點原本在不在 nav 內
let mockActiveElement: MockElement | null = null;

class MockElement {
  [key: string]: any;
  tag: string;
  style: any = {};
  childNodes: MockElement[] = [];
  onclick: Function | null = null;
  classList = {
    classes: [] as string[],
    contains: (c: string) => this.classList.classes.includes(c)
  };

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(k: string, v: any) {
    this[k] = v;
    if (k === 'class') this.classList.classes = String(v).split(' ').filter(Boolean);
  }

  appendChild(child: MockElement) {
    this.childNodes.push(child);
  }

  // renderPaginationNav() 重繪後要把焦點補回 nav，需要 contains()／focus()／children
  get children(): MockElement[] {
    return this.childNodes;
  }

  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.childNodes.some((child) => child.contains(node));
  }

  focus(): void {
    mockActiveElement = this;
  }

  // 真實 DOM 的 .textContent = '' 會清空所有子節點；renderList() 依賴這個語意
  // 在重繪前清空舊卡片，mock 也要照做，否則換頁測試會看到新舊卡片疊在一起。
  get textContent() {
    return this._textContent || '';
  }

  set textContent(val: string) {
    this._textContent = val;
    this.childNodes = [];
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    this.childNodes = [];
    if (val.includes('id="notif-list"')) {
      this.appendChild(new MockElement('ul').setAttribute2('id', 'notif-list'));
    }
    if (val.includes('id="notif-pagination"')) {
      this.appendChild(new MockElement('nav').setAttribute2('id', 'notif-pagination'));
    }
    if (val.includes('id="notif-page-size"')) {
      this.appendChild(new MockElement('select').setAttribute2('id', 'notif-page-size'));
    }
    if (val.includes('id="notif-filter"')) {
      this.appendChild(new MockElement('select').setAttribute2('id', 'notif-filter'));
    }
  }
}
// 小工具：setAttribute 回傳 this 方便鏈式建立節點
(MockElement.prototype as any).setAttribute2 = function (k: string, v: any) {
  this.setAttribute(k, v);
  return this;
};

function findById(root: MockElement, id: string): MockElement | null {
  if (root.id === id) return root;
  for (const c of root.childNodes) {
    const found = findById(c, id);
    if (found) return found;
  }
  return null;
}

function findAllByClass(root: MockElement, cls: string, out: MockElement[] = []): MockElement[] {
  if (root.classList.contains(cls)) out.push(root);
  for (const c of root.childNodes) findAllByClass(c, cls, out);
  return out;
}

// GET /api/notifications?page=N&pageSize=M 的 opt-in 分頁回應包裝。
function page(items: any[], overrides: any = {}) {
  return {
    items,
    page: 1,
    pageSize: 15,
    totalCount: items.length,
    totalPages: 1,
    unreadTotal: items.filter(n => n.read_at === null).length,
    ...overrides
  };
}

/**
 * 建立一份獨立的 vm 環境載入 notifications.js，可指定初始螢幕寬度與已保存的
 * 每頁筆數偏好，用來測試「首次載入預設值」與「偏好優先」等只會在模組載入當下
 * 決定一次的邏輯。
 */
function createEnv(opts: { innerWidth?: number; storedPageSize?: string } = {}) {
  const root = new MockElement('div');
  const sidebarBadge = new MockElement('span');
  sidebarBadge.setAttribute('id', 'notif-badge-sidebar');
  sidebarBadge.setAttribute('class', 'notif-badge');
  const toggleBadge = new MockElement('span');
  toggleBadge.setAttribute('id', 'notif-badge-toggle');
  toggleBadge.setAttribute('class', 'notif-badge');
  const container = new MockElement('div');
  root.appendChild(sidebarBadge);
  root.appendChild(toggleBadge);
  root.appendChild(container);

  const mockDocument = {
    get activeElement() { return mockActiveElement; },
    getElementById: (id: string) => findById(root, id),
    querySelectorAll: (selector: string) => findAllByClass(root, selector.replace(/^\./, '')),
    querySelector: (selector: string) => {
      const m = selector.match(/^#([^\s]+)\s+\.(.+)$/);
      if (!m) return null;
      const scope = findById(root, m[1]);
      if (!scope) return null;
      return findAllByClass(scope, m[2])[0] || null;
    }
  };

  function el(tag: string, attrs: any = {}, text?: string) {
    const node = new MockElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'onclick') node.onclick = v as Function;
      else if (k === 'style') continue; // 初始 inline style 字串不影響測試斷言的 .style.display 物件
      else node.setAttribute(k, v);
    }
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  const formatTime = (iso: string) => iso;

  let navigatedHash: string | null = null;
  const navigate = (hash: string) => { navigatedHash = hash; };

  const state: any = {
    userEmail: 'me@test.local',
    workspaceId: null,
    workspaceName: null,
    globalWorkspaces: [{ workspace_id: 'ws-1', name: 'WS 1' }]
  };

  let syncCalled = 0;
  const syncGlobalWorkspaces = async () => { syncCalled++; };

  let apiMock: (path: string, opts?: any) => Promise<any> = async () => { throw new Error('api mock not configured'); };
  const apiCalls: Array<{ path: string; method: string }> = [];
  const api = async (path: string, opts: any = {}) => {
    apiCalls.push({ path, method: opts.method || 'GET' });
    return apiMock(path, opts);
  };

  const localStorageData: Record<string, string> = {};
  if (opts.storedPageSize !== undefined) localStorageData['notif-page-size'] = opts.storedPageSize;
  const localStorage = {
    getItem: (k: string) => (k in localStorageData ? localStorageData[k] : null),
    setItem: (k: string, v: string) => { localStorageData[k] = String(v); },
    removeItem: (k: string) => { delete localStorageData[k]; }
  };

  const window = { innerWidth: opts.innerWidth ?? 1024 };

  const sandbox: any = {
    document: mockDocument,
    api,
    state,
    el,
    formatTime,
    navigate,
    syncGlobalWorkspaces,
    setInterval,
    clearInterval,
    localStorage,
    window,
    globalThis: {}
  };
  vm.createContext(sandbox);

  let code = readFileSync(join(__dirname, '../public/js/views/notifications.js'), 'utf8');
  code = code.replace(/import\s+[\s\S]*?\s+from\s+['"].*?['"];?/g, '');
  code = code.replace(/\bexport\s+/g, '');
  code += `
globalThis.NotificationsView = typeof NotificationsView !== "undefined" ? NotificationsView : undefined;
globalThis.refreshNotificationBadge = typeof refreshNotificationBadge !== "undefined" ? refreshNotificationBadge : undefined;
globalThis.stopNotificationPolling = typeof stopNotificationPolling !== "undefined" ? stopNotificationPolling : undefined;
`;
  vm.runInContext(code, sandbox);

  return {
    root,
    sidebarBadge,
    toggleBadge,
    container,
    state,
    localStorageData,
    apiCalls,
    setApiMock: (fn: typeof apiMock) => { apiMock = fn; },
    getNavigatedHash: () => navigatedHash,
    NotificationsView: sandbox.globalThis.NotificationsView,
    refreshNotificationBadge: sandbox.globalThis.refreshNotificationBadge,
    stopNotificationPolling: sandbox.globalThis.stopNotificationPolling
  };
}

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

async function main(): Promise<void> {
  // 主流程沿用既有預設情境：桌面寬度、無已保存偏好 → 預設每頁 15 筆。
  const env = createEnv({ innerWidth: 1024 });
  const { root, sidebarBadge, toggleBadge, container, NotificationsView, refreshNotificationBadge, stopNotificationPolling } = env;

  try {
    // ── 0. 0 筆未讀：兩處 badge 都應隱藏 ──
    env.setApiMock(async () => page([
      { notification_id: 'n0', source_task_id: 't0', source_comment_id: 'c0', snippet: '已讀通知', created_at: '2026-01-01T00:00:00.000Z', read_at: '2026-01-01T00:00:00.000Z' }
    ]));
    await refreshNotificationBadge();
    assert.strictEqual(sidebarBadge.style.display, 'none', '0 筆未讀時 sidebar badge 應隱藏');
    assert.strictEqual(toggleBadge.style.display, 'none', '0 筆未讀時漢堡 badge 應隱藏');
    assert.ok(env.apiCalls[env.apiCalls.length - 1].path.includes('pageSize=15'), '桌面且無偏好時應預設每頁 15 筆');

    // ── 1. 未讀數同步反映在桌機／手機兩個 badge 節點，數字一致 ──
    env.setApiMock(async () => page([
      { notification_id: 'n1', source_task_id: 't1', source_comment_id: 'c1', snippet: '@我 看一下', created_at: '2026-01-01T00:00:00.000Z', read_at: null },
      { notification_id: 'n2', source_task_id: 't2', source_comment_id: 'c2', snippet: '已讀通知', created_at: '2026-01-01T00:00:00.000Z', read_at: '2026-01-02T00:00:00.000Z' }
    ]));
    await refreshNotificationBadge();
    assert.strictEqual(sidebarBadge.textContent, '1');
    assert.strictEqual(toggleBadge.textContent, '1');
    assert.strictEqual(sidebarBadge.style.display, 'inline-flex');
    assert.strictEqual(toggleBadge.style.display, 'inline-flex');

    // ── 1b. 多筆未讀：兩處 badge 數字要一致且等於「全體未讀」（unreadTotal，不受單頁筆數限制）──
    env.setApiMock(async () => page([
      { notification_id: 'm1', source_task_id: 't1', source_comment_id: 'c1', snippet: '@我 1', created_at: '2026-01-01T00:00:00.000Z', read_at: null },
      { notification_id: 'm2', source_task_id: 't2', source_comment_id: 'c2', snippet: '@我 2', created_at: '2026-01-01T00:00:00.000Z', read_at: null },
      { notification_id: 'm3', source_task_id: 't3', source_comment_id: 'c3', snippet: '@我 3', created_at: '2026-01-01T00:00:00.000Z', read_at: null }
    ], { unreadTotal: 20, totalCount: 20, totalPages: 2 }));
    await refreshNotificationBadge();
    assert.strictEqual(sidebarBadge.textContent, '20', 'badge 應顯示全體未讀 unreadTotal，不是單頁筆數');
    assert.strictEqual(toggleBadge.textContent, '20', '多筆未讀時漢堡 badge 數字應與 sidebar 一致');

    // ── 2. 掛載通知頁：未讀卡片有「標示已讀」按鈕，點擊後本地立即歸零、背景重抓校正 ──
    env.setApiMock(async () => page([
      { notification_id: 'n1', source_task_id: 't1', source_comment_id: 'c1', snippet: '@我 看一下', created_at: '2026-01-01T00:00:00.000Z', read_at: null },
      { notification_id: 'n2', source_task_id: 't2', source_comment_id: 'c2', snippet: '已讀通知', created_at: '2026-01-01T00:00:00.000Z', read_at: '2026-01-02T00:00:00.000Z' }
    ], { unreadTotal: 1 }));
    await NotificationsView.render(container);
    await refreshNotificationBadge(); // render() 內已呼叫過一次，這裡等同「頁籤切回前景」再拉一次
    const card1 = findById(root, 'notif-card-n1');
    assert.ok(card1, '未讀通知應渲染出卡片');
    const markReadBtn = findAllByClass(card1!, 'notif-mark-read-btn')[0];
    assert.ok(markReadBtn, '未讀卡片應有標示已讀按鈕');

    let readPostCalled = false;
    env.setApiMock(async (path: string, opts: any) => {
      if (path === '/api/notifications/n1/read' && opts?.method === 'POST') {
        readPostCalled = true;
        return { ok: true };
      }
      return page([
        { notification_id: 'n1', source_task_id: 't1', source_comment_id: 'c1', snippet: '@我 看一下', created_at: '2026-01-01T00:00:00.000Z', read_at: '2026-01-03T00:00:00.000Z' },
        { notification_id: 'n2', source_task_id: 't2', source_comment_id: 'c2', snippet: '已讀通知', created_at: '2026-01-01T00:00:00.000Z', read_at: '2026-01-02T00:00:00.000Z' }
      ], { unreadTotal: 0 });
    });
    // 按鈕的 onclick 是 block-body arrow（不回傳 promise），markRead 是 fire-and-forget，
    // 所以先斷言同步保證會發生的樂觀更新，再 flush microtask 佇列確認背景 POST 有打出去。
    markReadBtn.onclick!({ stopPropagation: () => {} });
    assert.strictEqual(sidebarBadge.style.display, 'none', '標示已讀後未讀數應立即歸零（本地樂觀更新）');
    await flushPromises();
    assert.strictEqual(readPostCalled, true, '應呼叫 POST /api/notifications/n1/read');

    // ── 3. 點擊通知本體，來源可存取：成功導向並帶上 comment 定位參數 ──
    stopNotificationPolling();
    env.setApiMock(async () => page([
      { notification_id: 'n3', source_task_id: 't3', source_comment_id: 'c3', snippet: '@我 再看一次', created_at: '2026-01-04T00:00:00.000Z', read_at: null }
    ], { unreadTotal: 1 }));
    await refreshNotificationBadge();
    await NotificationsView.render(container);
    stopNotificationPolling();
    const card3 = findById(root, 'notif-card-n3');
    const body3 = findAllByClass(card3!, 'notif-body')[0];

    env.setApiMock(async (path: string) => {
      if (path === '/api/tasks/t3') return { task_id: 't3', workspace_id: 'ws-1' };
      if (path === '/api/notifications/n3/read') return { ok: true };
      return page([]);
    });
    await body3.onclick!();
    assert.strictEqual(env.getNavigatedHash(), '#/task/t3?comment=c3', '應導向來源 task 並定位留言');
    assert.strictEqual(env.state.workspaceId, 'ws-1', '應切到通知來源所屬工作區');

    // ── 4. 點擊通知本體，來源 403：保留卡片、顯示友善原因，不導頁 ──
    env.setApiMock(async () => page([
      { notification_id: 'n4', source_task_id: 't4', source_comment_id: 'c4', snippet: '@我 沒權限', created_at: '2026-01-05T00:00:00.000Z', read_at: null }
    ], { unreadTotal: 1 }));
    await refreshNotificationBadge();
    await NotificationsView.render(container);
    stopNotificationPolling();
    const card4 = findById(root, 'notif-card-n4');
    const body4 = findAllByClass(card4!, 'notif-body')[0];

    env.setApiMock(async (path: string) => {
      if (path === '/api/tasks/t4') throw new Error('權限不足');
      return page([]);
    });
    await body4.onclick!();
    assert.ok(findById(root, 'notif-card-n4'), '403 時應保留通知卡片');
    const err4 = findAllByClass(card4!, 'notif-error')[0];
    assert.strictEqual(err4.textContent, '你目前沒有查看此來源的權限');
    assert.ok(findAllByClass(card4!, 'notif-mark-read-btn')[0], '403 時仍保留手動標示已讀，避免 badge 卡死');

    // ── 5. 404 來源已不存在的友善訊息 ──
    env.setApiMock(async (path: string) => {
      if (path === '/api/tasks/t4') throw new Error('task 不存在');
      return page([]);
    });
    await body4.onclick!();
    const err4b = findAllByClass(card4!, 'notif-error')[0];
    assert.strictEqual(err4b.textContent, '來源已不存在');

    // ── 6. 分頁 nav：2 頁時渲染上一頁／頁碼／下一頁，目前頁禁用且標示 aria-current，
    //      邊界頁 prev/next 對應禁用，點頁碼／下一頁會換頁並重繪清單 ──
    stopNotificationPolling();
    const requestedPages: string[] = [];
    const p1 = page([
      { notification_id: 'pg1', source_task_id: 't1', source_comment_id: 'c1', snippet: 'page1', created_at: '2026-03-02T00:00:00.000Z', read_at: null }
    ], { totalCount: 16, totalPages: 2, unreadTotal: 2, page: 1 });
    const p2 = page([
      { notification_id: 'pg2', source_task_id: 't2', source_comment_id: 'c2', snippet: 'page2', created_at: '2026-03-01T00:00:00.000Z', read_at: null }
    ], { totalCount: 16, totalPages: 2, unreadTotal: 2, page: 2 });
    env.setApiMock(async (path: string) => {
      const m = path.match(/page=(\d+)/);
      requestedPages.push(m ? m[1] : '?');
      return m && m[1] === '2' ? p2 : p1;
    });
    await NotificationsView.render(container);
    stopNotificationPolling();

    const navBox = findById(root, 'notif-pagination');
    assert.ok(navBox, '應渲染分頁 nav 容器');
    const navButtons = navBox!.childNodes;
    assert.strictEqual(navButtons.length, 4, '2 頁時應有上一頁／頁1／頁2／下一頁共 4 顆按鈕');
    assert.strictEqual(navButtons[0].disabled, true, '第 1 頁時上一頁應禁用');
    assert.strictEqual(navButtons[1].disabled, true, '目前頁按鈕本身應禁用（不可再點自己）');
    assert.strictEqual(navButtons[1]['aria-current'], 'page', '目前頁應標示 aria-current 供輔助工具辨識');
    assert.strictEqual(navButtons[2].disabled, undefined, '非目前頁不應禁用');
    assert.strictEqual(navButtons[3].disabled, undefined, '尚有下一頁時不應禁用');

    requestedPages.length = 0;
    navButtons[3].onclick!();
    await flushPromises();
    assert.ok(requestedPages.includes('2'), '點下一頁應向後端要求 page=2');
    assert.ok(findById(root, 'notif-card-pg2'), '換頁後應渲染第 2 頁的卡片');
    assert.strictEqual(findById(root, 'notif-card-pg1'), null, '換頁後第 1 頁卡片應被清除，不與第 2 頁混疊');

    const navBox2 = findById(root, 'notif-pagination');
    const navButtons2 = navBox2!.childNodes;
    assert.strictEqual(navButtons2[3].disabled, true, '最後一頁時下一頁應禁用');
    assert.strictEqual(navButtons2[0].disabled, undefined, '非第 1 頁時上一頁不應禁用');

    // 換頁會整個重繪 nav，目前頁按鈕又是 disabled 的；焦點若不補回，鍵盤使用者每翻一頁
    // 都得從頭 tab 回來。重繪後焦點必須仍留在 nav 內。
    mockActiveElement = navButtons2[0]; // 焦點停在「上一頁」
    navButtons2[0].onclick!();
    await flushPromises();
    const navBox3 = findById(root, 'notif-pagination');
    assert.ok(navBox3!.contains(mockActiveElement), '換頁重繪後焦點必須留在分頁 nav 內');
    assert.strictEqual(mockActiveElement!.disabled, undefined, '補回的焦點不可落在 disabled 按鈕上');

    // 焦點本來不在 nav（例如剛用滑鼠點卡片）就不該被搶走
    mockActiveElement = null;
    const navButtons3 = navBox3!.childNodes;
    navButtons3[3].onclick!();
    await flushPromises();
    assert.strictEqual(mockActiveElement, null, '焦點原本不在 nav 內時，重繪不得主動搶焦點');

    // ── 7. 每頁筆數選單：桌面情境掛載時選單值應等於目前生效的 15 ──
    const sizeSelectDesktop = findById(root, 'notif-page-size');
    assert.ok(sizeSelectDesktop, '應渲染每頁筆數選單');
    assert.strictEqual(sizeSelectDesktop!.value, '15', '桌面無偏好時選單應顯示目前生效的 15');

    // ── 8. 切換每頁筆數：保存偏好、以目前頁碼重新查詢；頁碼因筆數改變而越界時，
    //      沿用既有「退回第 1 頁重試」邏輯校正，不得停在空白頁 ──
    stopNotificationPolling();
    // 模擬真實後端：固定 25 筆總數，依 page/pageSize 算 totalPages，越界回錯誤（同 notification.ts 語意）
    const TOTAL = 25;
    function simulateBackend() {
      return async (path: string) => {
        const m = path.match(/page=(\d+)&pageSize=(\d+)/);
        if (!m) throw new Error('bad request');
        const p = Number(m[1]);
        const sz = Number(m[2]);
        const totalPages = Math.max(1, Math.ceil(TOTAL / sz));
        if (p > totalPages) throw new Error('page 超出範圍');
        return page([
          { notification_id: `n-p${p}-s${sz}`, source_task_id: 't1', source_comment_id: 'c1', snippet: `p${p}s${sz}`, created_at: '2026-04-01T00:00:00.000Z', read_at: null }
        ], { totalCount: TOTAL, totalPages, pageSize: sz, page: p, unreadTotal: 1 });
      };
    }
    env.setApiMock(simulateBackend());
    await NotificationsView.render(container); // loadPage(1)，此時 pageSize 仍為 15（totalPages=2）
    const sizeSelectAfterMount = findById(root, 'notif-page-size')!;

    // 切到 10 筆／頁（totalPages 變 3），再點兩次下一頁到第 3 頁
    sizeSelectAfterMount.value = '10';
    sizeSelectAfterMount.onchange!();
    await flushPromises();
    assert.strictEqual(env.localStorageData['notif-page-size'], '10', '切換筆數應寫入 localStorage 偏好');
    let nav = findById(root, 'notif-pagination')!;
    nav.childNodes[nav.childNodes.length - 1].onclick!(); // → page 2
    await flushPromises();
    nav = findById(root, 'notif-pagination')!;
    nav.childNodes[nav.childNodes.length - 1].onclick!(); // → page 3
    await flushPromises();
    assert.ok(findById(root, 'notif-card-n-p3-s10'), '應已停在每頁 10 筆的第 3 頁');

    // 切回 15 筆／頁：25 筆只剩 2 頁，第 3 頁越界，應退回第 1 頁重試
    env.apiCalls.length = 0;
    sizeSelectAfterMount.value = '15';
    sizeSelectAfterMount.onchange!();
    await flushPromises();
    assert.ok(env.apiCalls.some(c => c.path.includes('page=3') && c.path.includes('pageSize=15')), '應先以目前頁碼（3）＋新筆數（15）重新查詢');
    assert.ok(env.apiCalls.some(c => c.path.includes('page=1') && c.path.includes('pageSize=15')), '越界時應退回第 1 頁重試，不得停在空白頁');
    assert.ok(findById(root, 'notif-card-n-p1-s15'), '越界校正後應顯示第 1 頁資料');
    assert.strictEqual(env.localStorageData['notif-page-size'], '15', '再次切換應更新已保存偏好');

    console.log('notificationsFrontend.test.ts OK');
  } finally {
    stopNotificationPolling();
  }
}

/** 首次載入且無已保存偏好：手機寬度應預設每頁 10 筆。 */
async function testMobileDefault(): Promise<void> {
  const env = createEnv({ innerWidth: 375 });
  env.setApiMock(async () => page([]));
  await env.refreshNotificationBadge();
  assert.ok(env.apiCalls[0].path.includes('pageSize=10'), '手機寬度且無偏好時應預設每頁 10 筆');
  env.stopNotificationPolling();
  console.log('testMobileDefault OK');
}

/** 已保存偏好優先於螢幕寬度預設值。 */
async function testSavedPreferenceWins(): Promise<void> {
  const env = createEnv({ innerWidth: 1024, storedPageSize: '10' });
  env.setApiMock(async () => page([]));
  await env.refreshNotificationBadge();
  assert.ok(env.apiCalls[0].path.includes('pageSize=10'), '已保存偏好應優先於桌面預設 15');
  env.stopNotificationPolling();
  console.log('testSavedPreferenceWins OK');
}

/** 通知頁應把全部／未讀／已讀篩選交給後端，並在切換後保留目前頁面的正常空狀態。 */
async function testNotificationFilters(): Promise<void> {
  const env = createEnv({ innerWidth: 1024 });
  const requestedFilters: string[] = [];
  env.setApiMock(async (path: string) => {
    const match = path.match(/(?:^|&)filter=([^&]+)/);
    requestedFilters.push(match ? match[1] : 'missing');
    return page([]);
  });
  await env.NotificationsView.render(env.container);

  const filterSelect = findById(env.root, 'notif-filter');
  assert.ok(filterSelect, '通知頁應提供全部／未讀／已讀篩選選單');
  assert.strictEqual(filterSelect!.value, 'all', '初始篩選應為全部');

  filterSelect!.value = 'unread';
  filterSelect!.onchange!();
  await flushPromises();
  filterSelect!.value = 'read';
  filterSelect!.onchange!();
  await flushPromises();
  assert.deepStrictEqual(requestedFilters.slice(-3), ['all', 'unread', 'read'], '篩選切換應以 query 交給後端');
  assert.ok(findById(env.root, 'notif-list')!.childNodes[0].textContent.includes('目前沒有通知'), '空結果應顯示空狀態');
  env.stopNotificationPolling();
  console.log('testNotificationFilters OK');
}

main()
  .then(testMobileDefault)
  .then(testSavedPreferenceWins)
  .then(testNotificationFilters)
  .catch(err => {
    console.error('notificationsFrontend.test.ts FAILED:', err);
    process.exit(1);
  });
