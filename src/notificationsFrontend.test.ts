import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// 針對 public/js/views/notifications.js 的獨立 vm 沙盒（刻意不與 frontendViews.test.ts
// 共用同一個 vm context：該檔用同名 top-level function 當 stub，混在一起載入會被
// notifications.js 的同名 real function 蓋掉，反而讓既有測試的 mock 失效）。
class MockElement {
  [key: string]: any;
  tag: string;
  style: any = {};
  childNodes: MockElement[] = [];
  onclick: Function | null = null;
  textContent = '';
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

  get innerHTML() {
    return this._innerHTML || '';
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    this.childNodes = [];
    if (val.includes('id="notif-list"')) {
      this.appendChild(new MockElement('ul').setAttribute2('id', 'notif-list'));
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

async function main(): Promise<void> {
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

  const NotificationsView = sandbox.globalThis.NotificationsView;
  const refreshNotificationBadge = sandbox.globalThis.refreshNotificationBadge;
  const stopNotificationPolling = sandbox.globalThis.stopNotificationPolling;
  const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

  try {
    // ── 0. 0 筆未讀：兩處 badge 都應隱藏 ──
    apiMock = async () => ([
      { notification_id: 'n0', source_task_id: 't0', source_comment_id: 'c0', snippet: '已讀通知', created_at: '2026-01-01T00:00:00.000Z', read_at: '2026-01-01T00:00:00.000Z' }
    ]);
    await refreshNotificationBadge();
    assert.strictEqual(sidebarBadge.style.display, 'none', '0 筆未讀時 sidebar badge 應隱藏');
    assert.strictEqual(toggleBadge.style.display, 'none', '0 筆未讀時漢堡 badge 應隱藏');

    // ── 1. 未讀數同步反映在桌機／手機兩個 badge 節點，數字一致 ──
    apiMock = async () => ([
      { notification_id: 'n1', source_task_id: 't1', source_comment_id: 'c1', snippet: '@我 看一下', created_at: '2026-01-01T00:00:00.000Z', read_at: null },
      { notification_id: 'n2', source_task_id: 't2', source_comment_id: 'c2', snippet: '已讀通知', created_at: '2026-01-01T00:00:00.000Z', read_at: '2026-01-02T00:00:00.000Z' }
    ]);
    await refreshNotificationBadge();
    assert.strictEqual(sidebarBadge.textContent, '1');
    assert.strictEqual(toggleBadge.textContent, '1');
    assert.strictEqual(sidebarBadge.style.display, 'inline-flex');
    assert.strictEqual(toggleBadge.style.display, 'inline-flex');

    // ── 1b. 多筆未讀：兩處 badge 數字要一致且等於未讀筆數 ──
    apiMock = async () => ([
      { notification_id: 'm1', source_task_id: 't1', source_comment_id: 'c1', snippet: '@我 1', created_at: '2026-01-01T00:00:00.000Z', read_at: null },
      { notification_id: 'm2', source_task_id: 't2', source_comment_id: 'c2', snippet: '@我 2', created_at: '2026-01-01T00:00:00.000Z', read_at: null },
      { notification_id: 'm3', source_task_id: 't3', source_comment_id: 'c3', snippet: '@我 3', created_at: '2026-01-01T00:00:00.000Z', read_at: null }
    ]);
    await refreshNotificationBadge();
    assert.strictEqual(sidebarBadge.textContent, '3', '多筆未讀時 sidebar badge 數字應等於未讀筆數');
    assert.strictEqual(toggleBadge.textContent, '3', '多筆未讀時漢堡 badge 數字應與 sidebar 一致');

    // ── 2. 掛載通知頁：未讀卡片有「標示已讀」按鈕，點擊後本地立即歸零、背景重抓校正 ──
    apiMock = async () => ([
      { notification_id: 'n1', source_task_id: 't1', source_comment_id: 'c1', snippet: '@我 看一下', created_at: '2026-01-01T00:00:00.000Z', read_at: null },
      { notification_id: 'n2', source_task_id: 't2', source_comment_id: 'c2', snippet: '已讀通知', created_at: '2026-01-01T00:00:00.000Z', read_at: '2026-01-02T00:00:00.000Z' }
    ]);
    await NotificationsView.render(container);
    await refreshNotificationBadge(); // render() 內已呼叫過一次，這裡等同「頁籤切回前景」再拉一次
    const card1 = findById(root, 'notif-card-n1');
    assert.ok(card1, '未讀通知應渲染出卡片');
    const markReadBtn = findAllByClass(card1!, 'notif-mark-read-btn')[0];
    assert.ok(markReadBtn, '未讀卡片應有標示已讀按鈕');

    let readPostCalled = false;
    apiMock = async (path: string, opts: any) => {
      if (path === '/api/notifications/n1/read' && opts?.method === 'POST') {
        readPostCalled = true;
        return { ok: true };
      }
      return [
        { notification_id: 'n1', source_task_id: 't1', source_comment_id: 'c1', snippet: '@我 看一下', created_at: '2026-01-01T00:00:00.000Z', read_at: '2026-01-03T00:00:00.000Z' },
        { notification_id: 'n2', source_task_id: 't2', source_comment_id: 'c2', snippet: '已讀通知', created_at: '2026-01-01T00:00:00.000Z', read_at: '2026-01-02T00:00:00.000Z' }
      ];
    };
    // 按鈕的 onclick 是 block-body arrow（不回傳 promise），markRead 是 fire-and-forget，
    // 所以先斷言同步保證會發生的樂觀更新，再 flush microtask 佇列確認背景 POST 有打出去。
    markReadBtn.onclick!({ stopPropagation: () => {} });
    assert.strictEqual(sidebarBadge.style.display, 'none', '標示已讀後未讀數應立即歸零（本地樂觀更新）');
    await flushPromises();
    assert.strictEqual(readPostCalled, true, '應呼叫 POST /api/notifications/n1/read');

    // ── 3. 點擊通知本體，來源可存取：成功導向並帶上 comment 定位參數 ──
    stopNotificationPolling();
    apiMock = async () => ([
      { notification_id: 'n3', source_task_id: 't3', source_comment_id: 'c3', snippet: '@我 再看一次', created_at: '2026-01-04T00:00:00.000Z', read_at: null }
    ]);
    await refreshNotificationBadge();
    await NotificationsView.render(container);
    stopNotificationPolling();
    const card3 = findById(root, 'notif-card-n3');
    const body3 = findAllByClass(card3!, 'notif-body')[0];

    apiMock = async (path: string) => {
      if (path === '/api/tasks/t3') return { task_id: 't3', workspace_id: 'ws-1' };
      if (path === '/api/notifications/n3/read') return { ok: true };
      return [];
    };
    navigatedHash = null;
    await body3.onclick!();
    assert.strictEqual(navigatedHash, '#/task/t3?comment=c3', '應導向來源 task 並定位留言');
    assert.strictEqual(state.workspaceId, 'ws-1', '應切到通知來源所屬工作區');

    // ── 4. 點擊通知本體，來源 403：保留卡片、顯示友善原因，不導頁 ──
    apiMock = async () => ([
      { notification_id: 'n4', source_task_id: 't4', source_comment_id: 'c4', snippet: '@我 沒權限', created_at: '2026-01-05T00:00:00.000Z', read_at: null }
    ]);
    await refreshNotificationBadge();
    await NotificationsView.render(container);
    stopNotificationPolling();
    const card4 = findById(root, 'notif-card-n4');
    const body4 = findAllByClass(card4!, 'notif-body')[0];

    apiMock = async (path: string) => {
      if (path === '/api/tasks/t4') throw new Error('權限不足');
      return [];
    };
    navigatedHash = null;
    await body4.onclick!();
    assert.strictEqual(navigatedHash, null, '403 時不應導頁');
    assert.ok(findById(root, 'notif-card-n4'), '403 時應保留通知卡片');
    const err4 = findAllByClass(card4!, 'notif-error')[0];
    assert.strictEqual(err4.textContent, '你目前沒有查看此來源的權限');
    assert.ok(findAllByClass(card4!, 'notif-mark-read-btn')[0], '403 時仍保留手動標示已讀，避免 badge 卡死');

    // ── 5. 404 來源已不存在的友善訊息 ──
    apiMock = async (path: string) => {
      if (path === '/api/tasks/t4') throw new Error('task 不存在');
      return [];
    };
    navigatedHash = null;
    await body4.onclick!();
    const err4b = findAllByClass(card4!, 'notif-error')[0];
    assert.strictEqual(err4b.textContent, '來源已不存在');

    console.log('notificationsFrontend.test.ts OK');
  } finally {
    stopNotificationPolling();
  }
}

main().catch(err => {
  console.error('notificationsFrontend.test.ts FAILED:', err);
  process.exit(1);
});
