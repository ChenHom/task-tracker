import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// 1. Setup Browser Mock Environment
class MockElement {
  [key: string]: any;
  tag: string;
  id: string;
  className: string;
  style: any = {};
  childNodes: MockElement[] = [];
  onclick: Function | null = null;
  onchange: Function | null = null;
  onsubmit: Function | null = null;
  textContent: string = '';
  value: string = '';
  eventListeners: { [event: string]: Function[] } = {};
  disabled: boolean = false;
  selected: boolean = false;
  checked: boolean = false;

  get options() {
    return this.childNodes;
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    this.childNodes = [];
    
    // Parse form controls if any inside innerHTML
    if (val.includes('id="login-form"')) {
      const email = new MockElement('input', { id: 'login-email', type: 'email' });
      const password = new MockElement('input', { id: 'login-password', type: 'password' });
      const error = new MockElement('p', { id: 'login-error', class: 'error' });
      const form = new MockElement('form', { id: 'login-form' });
      form.appendChild(email);
      form.appendChild(password);
      this.appendChild(form);
      this.appendChild(error);
    }
    if (val.includes('id="forgot-form"')) {
      const email = new MockElement('input', { id: 'forgot-email', type: 'email' });
      const msg = new MockElement('p', { id: 'forgot-message', class: 'message' });
      const form = new MockElement('form', { id: 'forgot-form' });
      form.appendChild(email);
      this.appendChild(form);
      this.appendChild(msg);
    }
    if (val.includes('id="search-form"')) {
      const q = new MockElement('input', { id: 'search-input', type: 'text' });
      const error = new MockElement('p', { id: 'search-error', class: 'error' });
      const results = new MockElement('div', { id: 'search-results' });
      const form = new MockElement('form', { id: 'search-form' });
      form.appendChild(q);
      this.appendChild(form);
      this.appendChild(error);
      this.appendChild(results);
    }
    if (val.includes('id="audit-form"')) {
      const aggInput = new MockElement('input', { id: 'audit-aggregate-input', type: 'text' });
      const error = new MockElement('p', { id: 'audit-error', class: 'error' });
      const list = new MockElement('ul', { id: 'audit-list' });
      const form = new MockElement('form', { id: 'audit-form' });
      form.appendChild(aggInput);
      this.appendChild(form);
      this.appendChild(error);
      this.appendChild(list);
    }
  }

  classList = {
    classes: [] as string[],
    add: (cls: string) => {
      if (!this.classList.classes.includes(cls)) this.classList.classes.push(cls);
      this.className = this.classList.classes.join(' ');
    },
    remove: (cls: string) => {
      const idx = this.classList.classes.indexOf(cls);
      if (idx !== -1) this.classList.classes.splice(idx, 1);
      this.className = this.classList.classes.join(' ');
    },
    contains: (cls: string) => {
      return this.classList.classes.includes(cls);
    }
  };

  constructor(tag: string, attrs: any = {}) {
    this.tag = tag;
    this.id = attrs.id || '';
    this.className = attrs.class || '';
    for (const [key, value] of Object.entries(attrs)) {
      if (key !== 'class') this[key] = value;
    }
    if (this.className) {
      this.classList.classes = this.className.split(' ');
    }
    if (attrs.value !== undefined) {
      this.value = attrs.value;
    }
  }

  appendChild(child: MockElement) {
    this.childNodes.push(child);
  }

  hasChildNodes() {
    return this.childNodes.length > 0;
  }

  addEventListener(event: string, callback: Function) {
    this.eventListeners[event] = this.eventListeners[event] || [];
    this.eventListeners[event].push(callback);
  }

  removeEventListener(event: string, callback: Function) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
    }
  }

  dispatchEvent(event: { type: string } | Event) {
    const type = event.type;
    if (this.eventListeners[type]) {
      for (const listener of this.eventListeners[type]) {
        listener(event);
      }
    }
  }

  setAttribute(k: string, v: any) {
    this[k] = v;
    if (k === 'class') {
      this.className = String(v);
      this.classList.classes = this.className.split(' ');
    }
  }

  getAttribute(k: string) {
    return this[k];
  }
}

// Global registry of DOM mock nodes
const containerChildren: MockElement[] = [];

function findElementInContainer(tagOrId: string): MockElement | null {
  const findRec = (node: MockElement): MockElement | null => {
    if (node.id === tagOrId || node.tag === tagOrId) return node;
    for (const child of node.childNodes) {
      const found = findRec(child);
      if (found) return found;
    }
    return null;
  };
  for (const root of containerChildren) {
    const found = findRec(root);
    if (found) return found;
  }
  return null;
}

function findElement(el: MockElement, predicate: (element: MockElement) => boolean): MockElement | null {
  if (predicate(el)) return el;
  for (const child of el.childNodes) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}


const mockDocument: any = {
  body: new MockElement('body'),
  createElement: (tag: string) => new MockElement(tag),
  getElementById: (id: string) => {
    return findElementInContainer(id);
  },
  addEventListener: () => {},
  removeEventListener: () => {}
};

// Global state / callbacks stubs
const state = {
  workspaceId: null as string | null,
  workspaceName: null as string | null,
  globalWorkspaces: [] as any[],
  userEmail: null as string | null,
  userName: null as string | null,
  clear: () => {
    state.workspaceId = null;
    state.workspaceName = null;
    state.userEmail = null;
    state.userName = null;
  }
};

let navigatedHash: string | null = null;
function navigate(hash: string) {
  navigatedHash = hash;
}

let syncWorkspacesCalled = false;
let syncedGlobalWorkspaces: any[] = [];
async function syncGlobalWorkspaces() {
  syncWorkspacesCalled = true;
  state.globalWorkspaces = syncedGlobalWorkspaces;
}

function requireWorkspace(container: any) {
  if (!state.workspaceId) {
    container.innerHTML = '<h2>尚未選擇工作區</h2>';
    return false;
  }
  return true;
}

function el(tag: string, attrs?: any, text?: string) {
  const node = new MockElement(tag, attrs);
  if (text !== undefined && text !== null) {
    node.textContent = text;
  }
  return node;
}

function showError(id: string, err: any) {
  const val = err instanceof Error ? err.message : String(err);
  const target = mockDocument.getElementById(id);
  if (target) {
    target.textContent = val;
    target.style.display = 'block';
  } else {
    // fallback
  }
}

let apiMock: ((path: string, options?: any) => Promise<any>) | null = null;

let openTaskDetailModalCalls: Array<{ taskId: string; opts: any }> = [];
function openTaskDetailModal(taskId: string, opts: any) {
  openTaskDetailModalCalls.push({ taskId, opts });
}

let refreshNotificationBadgeCalls = 0;
async function refreshNotificationBadge() {
  refreshNotificationBadgeCalls++;
}

const ROLE_RANK: { [key: string]: number } = { Viewer: 0, Commenter: 1, Member: 2, Admin: 3, Owner: 4 };
const hasRole = (role: string, minimum: string) => ROLE_RANK[role] >= ROLE_RANK[minimum];
const MAIN_WORKSPACE_ID = '11a82028-fc50-466a-a723-e002032cd9a6';
const MAIN_OWNER_EMAIL = 'user01@test.local';
const MAIN_POLICY_TITLE = '[規則] 主工作區協作與交接';
const MAIN_DISCUSSION_DESCRIPTION_TEMPLATE = '問題／優化想法：\n目前情況或影響：\n希望改善的結果：';

const sessionStorageStore: { [key: string]: string } = {};
const sessionStorage = {
  getItem: (k: string) => (k in sessionStorageStore ? sessionStorageStore[k] : null),
  setItem: (k: string, v: string) => { sessionStorageStore[k] = String(v); }
};

const sandbox = {
  document: mockDocument,
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { hash: '#/login' }
  },
  api: async (path: string, options?: any) => {
    if (apiMock) return apiMock(path, options);
    throw new Error('api mock not configured');
  },
  state,
  navigate,
  syncGlobalWorkspaces,
  requireWorkspace,
  el,
  showError,
  openTaskDetailModal,
  refreshNotificationBadge,
  hasRole,
  MAIN_WORKSPACE_ID,
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_TITLE,
  MAIN_DISCUSSION_DESCRIPTION_TEMPLATE,
  sessionStorage,
  AbortController,
  globalThis: {} as any
};

vm.createContext(sandbox);

// Loader helper
function loadViewModule(filename: string, exportName: string) {
  const path = join(__dirname, '../public/js/views', filename);
  let code = readFileSync(path, 'utf8');
  
  // Strip imports
  code = code.replace(/import\s+[\s\S]*?\s+from\s+['"].*?['"];?/g, '');
  
  // Convert all exports to normal declarations
  code = code.replace(/\bexport\s+/g, '');
  
  code += `\nglobalThis.${exportName} = typeof ${exportName} !== "undefined" ? ${exportName} : undefined;\n`;
  
  vm.runInContext(code, sandbox);
}

// Load views
loadViewModule('login.js', 'LoginView');
loadViewModule('forgot-password.js', 'ForgotPasswordView');
loadViewModule('search.js', 'SearchView');
loadViewModule('audit.js', 'AuditView');
loadViewModule('kanban.js', 'KanbanView');

const LoginView = sandbox.globalThis.LoginView;
const ForgotPasswordView = sandbox.globalThis.ForgotPasswordView;
const SearchView = sandbox.globalThis.SearchView;
const AuditView = sandbox.globalThis.AuditView;
const KanbanView = sandbox.globalThis.KanbanView;

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

// Reset helpers
function resetViewsMocks() {
  containerChildren.length = 0;
  state.workspaceId = null;
  state.workspaceName = null;
  state.globalWorkspaces = [];
  state.userEmail = null;
  state.userName = null;
  openTaskDetailModalCalls = [];
  refreshNotificationBadgeCalls = 0;
  navigatedHash = null;
  syncWorkspacesCalled = false;
  syncedGlobalWorkspaces = [];
  apiMock = null;
}

async function runTests() {
  console.log('Running frontendViews.test.ts...');

  const toPlain = (obj: any) => obj === null || obj === undefined ? obj : JSON.parse(JSON.stringify(obj));

  // ==========================================
  // [views/login.js] Tests
  // ==========================================
  
  // Login success
  {
    resetViewsMocks();
    const container = new MockElement('div');
    containerChildren.push(container);
    
    await LoginView.render(container);
    
    const form = findElementInContainer('login-form');
    const emailInput = findElementInContainer('login-email');
    const passwordInput = findElementInContainer('login-password');
    assert.ok(form && emailInput && passwordInput);

    emailInput.value = 'user@test.local';
    passwordInput.value = 'test1234';

    let loginUrl = '';
    let meUrl = '';
    apiMock = async (url: string) => {
      if (url === '/api/auth/login') {
        loginUrl = url;
        return { success: true };
      }
      if (url === '/api/auth/me') {
        meUrl = url;
        return { name: 'User 09' };
      }
      return null;
    };

    const submitHandlers = form.eventListeners['submit'];
    assert.ok(submitHandlers && submitHandlers.length > 0);

    const preventDefaultCalled = { val: false };
    const mockEvent = {
      preventDefault: () => { preventDefaultCalled.val = true; }
    };

    await submitHandlers[0](mockEvent);

    assert.strictEqual(preventDefaultCalled.val, true);
    assert.strictEqual(loginUrl, '/api/auth/login');
    assert.strictEqual(meUrl, '/api/auth/me');
    assert.strictEqual(state.userEmail, 'user@test.local');
    assert.strictEqual(state.userName, 'User 09');
    assert.strictEqual(syncWorkspacesCalled, true);
    assert.strictEqual(navigatedHash, '#/workspaces');
    assert.strictEqual(refreshNotificationBadgeCalls, 1, '登入成功應重抓一次通知未讀數');
  }

  // Login failure
  {
    resetViewsMocks();
    const container = new MockElement('div');
    containerChildren.push(container);
    await LoginView.render(container);

    const form = findElementInContainer('login-form');
    const errorEl = findElementInContainer('login-error');
    assert.ok(form && errorEl);

    apiMock = async () => {
      throw new Error('帳號或密碼錯誤');
    };

    const submitHandlers = form.eventListeners['submit'];
    await submitHandlers[0]({ preventDefault: () => {} });

    assert.strictEqual(errorEl.textContent, '帳號或密碼錯誤');
    assert.strictEqual(errorEl.style.display, 'block');
  }

  // ==========================================
  // [views/forgot-password.js] Tests
  // ==========================================
  
  // Forgot password success
  {
    resetViewsMocks();
    const container = new MockElement('div');
    containerChildren.push(container);
    await ForgotPasswordView.render(container);

    const form = findElementInContainer('forgot-form');
    const emailInput = findElementInContainer('forgot-email');
    const msgEl = findElementInContainer('forgot-message');
    assert.ok(form && emailInput && msgEl);

    emailInput.value = 'forgot@test.local';

    let requestedPath = '';
    let requestedBody: any = null;
    apiMock = async (url: string, init?: any) => {
      requestedPath = url;
      requestedBody = init?.body;
      return { message: '重設連結已寄出！' };
    };

    const submitHandlers = form.eventListeners['submit'];
    await submitHandlers[0]({ preventDefault: () => {} });

    assert.strictEqual(requestedPath, '/api/auth/forgot-password');
    assert.deepStrictEqual(toPlain(requestedBody), { email: 'forgot@test.local' });
    assert.strictEqual(msgEl.textContent, '重設連結已寄出！');
    assert.strictEqual(msgEl.style.display, 'block');
  }

  // Forgot password fail
  {
    resetViewsMocks();
    const container = new MockElement('div');
    containerChildren.push(container);
    await ForgotPasswordView.render(container);

    const form = findElementInContainer('forgot-form');
    const msgEl = findElementInContainer('forgot-message');
    assert.ok(form && msgEl);

    apiMock = async () => {
      throw new Error('查無此電子郵件');
    };

    const submitHandlers = form.eventListeners['submit'];
    await submitHandlers[0]({ preventDefault: () => {} });

    assert.strictEqual(msgEl.textContent, '查無此電子郵件');
    assert.strictEqual(msgEl.style.display, 'block');
  }

  // ==========================================
  // [views/search.js] Tests
  // ==========================================
  
  // Search workspace check negative
  {
    resetViewsMocks();
    state.workspaceId = null;
    const container = new MockElement('div');
    containerChildren.push(container);
    await SearchView.render(container);
    assert.ok(container.innerHTML.includes('尚未選擇工作區'));
  }

  // Search success (renders tasks, projects, comments)
  {
    resetViewsMocks();
    state.workspaceId = 'ws-search-1';
    const container = new MockElement('div');
    containerChildren.push(container);
    await SearchView.render(container);

    const form = findElementInContainer('search-form');
    const qInput = findElementInContainer('search-input');
    const resultsContainer = findElementInContainer('search-results');
    assert.ok(form && qInput && resultsContainer);

    qInput.value = 'query-val';

    let requestedUrl = '';
    apiMock = async (url: string) => {
      requestedUrl = url;
      return {
        tasks: [{ task_id: 'task-1', title: 'Find Task', status: 'Doing' }],
        projects: [{ project_id: 'proj-1', name: 'Search Project' }],
        comments: [{ task_id: 'task-2', content: 'Search Comment Content matches' }]
      };
    };

    const submitHandlers = form.eventListeners['submit'];
    await submitHandlers[0]({ preventDefault: () => {} });

    assert.strictEqual(requestedUrl, '/api/search?workspace=ws-search-1&q=query-val');
    
    // Result render assertions
    const resultsHTML = resultsContainer.childNodes;
    assert.strictEqual(resultsHTML.length, 3, 'should render 3 result groups');

    // Tasks Group
    const taskGroup = resultsHTML[0];
    assert.ok(taskGroup.childNodes.some(n => n.textContent.includes('任務搜尋結果 (1)')));
    
    // Projects Group
    const projGroup = resultsHTML[1];
    assert.ok(projGroup.childNodes.some(n => n.textContent.includes('專案搜尋結果 (1)')));
    assert.ok(projGroup.childNodes.some(n => n.childNodes && n.childNodes.some(item => item.textContent === 'Search Project')));

    // Comments Group
    const commGroup = resultsHTML[2];
    assert.ok(commGroup.childNodes.some(n => n.textContent.includes('留言搜尋結果 (1)')));
  }

  // Search abort controller integration (concurrency)
  {
    resetViewsMocks();
    state.workspaceId = 'ws-search-1';
    const container = new MockElement('div');
    containerChildren.push(container);
    await SearchView.render(container);

    const form = findElementInContainer('search-form');
    const qInput = findElementInContainer('search-input');
    assert.ok(form && qInput);

    qInput.value = 'key';

    const signals: AbortSignal[] = [];
    apiMock = async (url: string, init?: any) => {
      if (init?.signal) {
        signals.push(init.signal);
      }
      return { tasks: [], projects: [], comments: [] };
    };

    const submitHandlers = form.eventListeners['submit'];
    
    // Trigger first search
    const p1 = submitHandlers[0]({ preventDefault: () => {} });
    // Trigger second search immediately
    const p2 = submitHandlers[0]({ preventDefault: () => {} });

    await Promise.all([p1, p2]);

    assert.strictEqual(signals.length, 2);
    assert.strictEqual(signals[0].aborted, true, 'first signal should be aborted');
    assert.strictEqual(signals[1].aborted, false, 'second signal should not be aborted');
  }

  // ==========================================
  // [views/audit.js] Tests
  // ==========================================
  
  // Audit search and translate translations
  {
    resetViewsMocks();
    const container = new MockElement('div');
    containerChildren.push(container);
    await AuditView.render(container);

    const form = findElementInContainer('audit-form');
    const aggInput = findElementInContainer('audit-aggregate-input');
    const listEl = findElementInContainer('audit-list');
    assert.ok(form && aggInput && listEl);

    aggInput.value = 'ws-uuid-1';

    let requestedUrl = '';
    apiMock = async (url: string) => {
      requestedUrl = url;
      return [
        {
          event_type: 'workspace.created',
          occurred_at: '2026-07-16T12:00:00.000Z',
          payload: { name: 'WS Design' },
          metadata: { actor_id: 'user-1', ip: '127.0.0.1' }
        },
        {
          event_type: 'member.invited',
          occurred_at: '2026-07-16T12:05:00.000Z',
          payload: { role: 'Admin' },
          metadata: { actor_id: 'user-1', ip: '127.0.0.1' }
        },
        {
          event_type: 'task.status_changed',
          occurred_at: '2026-07-16T12:10:00.000Z',
          payload: { status: 'Done' },
          metadata: { actor_id: 'user-2', ip: '127.0.0.2' }
        }
      ];
    };

    const submitHandlers = form.eventListeners['submit'];
    await submitHandlers[0]({ preventDefault: () => {} });

    assert.strictEqual(requestedUrl, '/api/audit?aggregate_id=ws-uuid-1');
    
    // Cards checks
    const cards = listEl.childNodes;
    assert.strictEqual(cards.length, 3);

    // Event 1: workspace.created
    const card1 = cards[0];
    assert.ok(findElement(card1, n => n.textContent === 'workspace.created'));
    assert.ok(findElement(card1, n => n.textContent === '建立了工作區 "WS Design"'));
    assert.ok(findElement(card1, n => n.textContent.includes('操作者: user-1 | IP: 127.0.0.1')));

    // Event 2: member.invited
    const card2 = cards[1];
    assert.ok(findElement(card2, n => n.textContent === '邀請了使用者加入，指派角色為 Admin'));

    // Event 3: task.status_changed
    const card3 = cards[2];
    assert.ok(findElement(card3, n => n.textContent === '將任務看板狀態移至 "Done"'));

    // Detail Expand/Collapse Check
    const detailsBtn = card1.childNodes.find(n => n.tag === 'button' && n.className === 'audit-details-btn');
    const preBlock = card1.childNodes.find(n => n.tag === 'pre' && n.className === 'audit-card-payload');
    assert.ok(detailsBtn && preBlock);
    
    assert.strictEqual(preBlock.classList.contains('show'), false);
    assert.strictEqual(detailsBtn.textContent, '顯示原始資料');

    // Click details
    detailsBtn.onclick!();
    assert.strictEqual(preBlock.classList.contains('show'), true);
    assert.strictEqual(detailsBtn.textContent, '隱藏原始資料');

    // Click collapse
    detailsBtn.onclick!();
    assert.strictEqual(preBlock.classList.contains('show'), false);
    assert.strictEqual(detailsBtn.textContent, '顯示原始資料');
  }

  // Audit empty log
  {
    resetViewsMocks();
    const container = new MockElement('div');
    containerChildren.push(container);
    await AuditView.render(container);

    const form = findElementInContainer('audit-form');
    const listEl = findElementInContainer('audit-list');
    assert.ok(form && listEl);

    apiMock = async () => [];

    const submitHandlers = form.eventListeners['submit'];
    await submitHandlers[0]({ preventDefault: () => {} });

    assert.strictEqual(listEl.childNodes.length, 1);
    assert.ok(listEl.childNodes[0].classList.contains('audit-empty-text'));
    assert.strictEqual(listEl.childNodes[0].textContent, '（無相關事件日誌）');
  }

  // ==========================================
  // [views/kanban.js] Tests — #/task/:id deep link cold start
  // ==========================================

  const boardApiMock = (workspaceId: string) => async (path: string) => {
    if (path === `/api/workspaces/${workspaceId}/tasks`) return [];
    if (path === `/api/workspaces/${workspaceId}/projects`) return [];
    if (path === `/api/workspaces/${workspaceId}/members`) return [];
    throw new Error('unexpected path: ' + path);
  };

  // Cold start deep link success: workspaceId=null resolved from cached globalWorkspaces
  {
    resetViewsMocks();
    state.workspaceId = null;
    state.globalWorkspaces = [{ workspace_id: 'ws-1', name: 'Workspace One' }];
    const container = new MockElement('div');
    containerChildren.push(container);

    const board = boardApiMock('ws-1');
    apiMock = async (path: string, options?: any) => {
      if (path === '/api/tasks/task-123') return { task_id: 'task-123', workspace_id: 'ws-1', title: 'Some Task' };
      return board(path);
    };

    await KanbanView.render(container, ['task-123'], new URLSearchParams());
    await flushPromises();

    assert.strictEqual(state.workspaceId, 'ws-1');
    assert.strictEqual(state.workspaceName, 'Workspace One');
    assert.strictEqual(syncWorkspacesCalled, false, '快取已有該工作區，不應重新 sync');
    assert.strictEqual(openTaskDetailModalCalls.length, 1);
    assert.strictEqual(openTaskDetailModalCalls[0].taskId, 'task-123');
    assert.ok(!container.innerHTML.includes('尚未選擇工作區'));
    assert.ok(!container.innerHTML.includes('無法開啟此任務'));
  }

  // Cold start deep link success: workspace missing from cache, resolved after re-sync
  {
    resetViewsMocks();
    state.workspaceId = null;
    state.globalWorkspaces = [];
    assert.deepStrictEqual(state.globalWorkspaces, [], '重新同步前快取應為空');
    syncedGlobalWorkspaces = [{ workspace_id: 'ws-2', name: 'Workspace Two' }];
    const container = new MockElement('div');
    containerChildren.push(container);

    const board = boardApiMock('ws-2');
    apiMock = async (path: string) => {
      if (path === '/api/tasks/task-9') return { task_id: 'task-9', workspace_id: 'ws-2', title: 'Task 9' };
      return board(path);
    };

    await KanbanView.render(container, ['task-9'], new URLSearchParams());
    await flushPromises();

    assert.strictEqual(syncWorkspacesCalled, true, '快取沒有該工作區時應觸發重新 sync');
    assert.deepStrictEqual(state.globalWorkspaces, [{ workspace_id: 'ws-2', name: 'Workspace Two' }]);
    assert.strictEqual(state.workspaceId, 'ws-2');
    assert.strictEqual(state.workspaceName, 'Workspace Two');
    assert.strictEqual(openTaskDetailModalCalls.length, 1);
    assert.strictEqual(openTaskDetailModalCalls[0].taskId, 'task-9');
  }

  // Cold start deep link failure: workspace still missing after re-sync
  {
    resetViewsMocks();
    state.workspaceId = null;
    state.globalWorkspaces = [];
    const container = new MockElement('div');
    containerChildren.push(container);

    apiMock = async (path: string) => {
      if (path === '/api/tasks/task-10') return { task_id: 'task-10', workspace_id: 'ws-2', title: 'Task 10' };
      throw new Error('unexpected path: ' + path);
    };

    await KanbanView.render(container, ['task-10'], new URLSearchParams());

    assert.strictEqual(syncWorkspacesCalled, true, '快取沒有該工作區時應觸發重新 sync');
    assert.strictEqual(state.workspaceId, null, '重新 sync 仍找不到工作區時不應變更 state');
    assert.deepStrictEqual(state.globalWorkspaces, [], '重新 sync 失敗後快取應保持空白');
    assert.ok(findElement(container, n => n.textContent === '找不到此任務所屬的工作區，或您無權限存取'));
  }

  // Cold start deep link: single-task API 404
  {
    resetViewsMocks();
    state.workspaceId = null;
    const container = new MockElement('div');
    containerChildren.push(container);

    apiMock = async () => { throw new Error('task 不存在'); };

    await KanbanView.render(container, ['missing-task'], new URLSearchParams());

    assert.strictEqual(state.workspaceId, null);
    assert.ok(findElement(container, n => n.textContent === '無法開啟此任務'));
    assert.ok(findElement(container, n => n.textContent === 'task 不存在'));
  }

  // Cold start deep link: single-task API 403
  {
    resetViewsMocks();
    state.workspaceId = null;
    const container = new MockElement('div');
    containerChildren.push(container);

    apiMock = async () => { throw new Error('權限不足'); };

    await KanbanView.render(container, ['forbidden-task'], new URLSearchParams());

    assert.strictEqual(state.workspaceId, null);
    assert.ok(findElement(container, n => n.textContent === '無法開啟此任務'));
    assert.ok(findElement(container, n => n.textContent === '權限不足'));
  }

  // Regression: workspace already selected + opening a task — deep-link fetch must be skipped
  {
    resetViewsMocks();
    state.workspaceId = 'ws-1';
    state.workspaceName = 'Workspace One';
    const container = new MockElement('div');
    containerChildren.push(container);

    let singleTaskFetched = false;
    const board = boardApiMock('ws-1');
    apiMock = async (path: string) => {
      if (path === '/api/tasks/task-123') { singleTaskFetched = true; return { task_id: 'task-123', workspace_id: 'ws-1' }; }
      return board(path);
    };

    await KanbanView.render(container, ['task-123'], new URLSearchParams());
    await flushPromises();

    assert.strictEqual(singleTaskFetched, false, 'workspace 已選定時不應重新打單筆 task API');
    assert.strictEqual(openTaskDetailModalCalls.length, 1);
    assert.strictEqual(openTaskDetailModalCalls[0].taskId, 'task-123');
  }

  // Regression: existing #/tasks listing (no task id) unaffected
  {
    resetViewsMocks();
    state.workspaceId = 'ws-1';
    state.workspaceName = 'Workspace One';
    const container = new MockElement('div');
    containerChildren.push(container);

    let singleTaskFetched = false;
    const board = boardApiMock('ws-1');
    apiMock = async (path: string) => {
      if (path.startsWith('/api/tasks/')) { singleTaskFetched = true; return board(path); }
      return board(path);
    };

    await KanbanView.render(container, [], new URLSearchParams());
    await flushPromises();

    assert.strictEqual(singleTaskFetched, false);
    assert.strictEqual(openTaskDetailModalCalls.length, 0);
    assert.ok(container.innerHTML.includes('kanban-board'));
    assert.ok(!container.innerHTML.includes('尚未選擇工作區'));
  }

  console.log('frontendViews.test.ts OK');
}

runTests().catch(err => {
  console.error('frontendViews.test.ts FAILED:', err);
  process.exit(1);
});
