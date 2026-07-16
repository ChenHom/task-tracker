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

// Global registry of elements created or matched
const appElement = new MockElement('div', { id: 'app' });
const mockSelectElement = new MockElement('select', { id: 'sidebar-ws-select' });
const documentElements = new Map<string, MockElement>([
  ['app', appElement],
  ['sidebar-ws-select', mockSelectElement]
]);
const documentListeners: { [event: string]: Function[] } = {};
const windowListeners: { [event: string]: Function[] } = {};

const mockDocument: any = {
  body: new MockElement('body'),
  createElement: (tag: string) => new MockElement(tag),
  getElementById: (id: string) => {
    return documentElements.get(id) || null;
  },
  querySelectorAll: (selector: string) => {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      const res: MockElement[] = [];
      const traverse = (el: MockElement) => {
        if (el.classList.contains(cls)) res.push(el);
        for (const child of el.childNodes) traverse(child);
      };
      traverse(mockDocument.body);
      // Also check elements registry
      for (const el of documentElements.values()) {
        if (el.classList.contains(cls) && !res.includes(el)) res.push(el);
      }
      return res;
    }
    return [];
  },
  addEventListener: (event: string, callback: Function) => {
    documentListeners[event] = documentListeners[event] || [];
    documentListeners[event].push(callback);
  },
  removeEventListener: (event: string, callback: Function) => {
    if (documentListeners[event]) {
      documentListeners[event] = documentListeners[event].filter(cb => cb !== callback);
    }
  }
};

let currentHash = '#/login';
const mockLocation: any = {
  origin: 'http://localhost',
  pathname: '/',
  get hash() {
    return currentHash;
  },
  set hash(val: string) {
    if (currentHash !== val) {
      currentHash = val;
      if (windowListeners['hashchange']) {
        for (const cb of [...windowListeners['hashchange']]) {
          cb();
        }
      }
    }
  }
};

const sessionStorageMap = new Map<string, string>();
const mockSessionStorage = {
  getItem: (key: string) => sessionStorageMap.get(key) ?? null,
  setItem: (key: string, value: any) => sessionStorageMap.set(key, String(value)),
  removeItem: (key: string) => sessionStorageMap.delete(key),
  clear: () => sessionStorageMap.clear()
};

let lastAlertMessage: string | null = null;
let fetchMock: ((url: string, init?: any) => Promise<any>) | null = null;

const sandbox = {
  document: mockDocument,
  window: {
    addEventListener: (event: string, callback: Function) => {
      windowListeners[event] = windowListeners[event] || [];
      windowListeners[event].push(callback);
    },
    removeEventListener: (event: string, callback: Function) => {
      if (windowListeners[event]) {
        windowListeners[event] = windowListeners[event].filter(cb => cb !== callback);
      }
    },
    location: mockLocation
  },
  location: mockLocation,
  sessionStorage: mockSessionStorage,
  alert: (msg: string) => {
    lastAlertMessage = msg;
  },
  fetch: async (url: string, init?: any) => {
    if (fetchMock) return fetchMock(url, init);
    throw new Error('fetch mock not configured');
  },
  console: console,
  URLSearchParams,
  globalThis: {} as any
};

vm.createContext(sandbox);

// 2. Loader helper
function loadModule(filename: string, exportsList: string[]) {
  const path = join(__dirname, '../public/js', filename);
  let code = readFileSync(path, 'utf8');
  
  // Strip import statements
  code = code.replace(/import\s+[\s\S]*?\s+from\s+['"].*?['"];?/g, '');
  
  // Convert all exports to normal declarations
  code = code.replace(/\bexport\s+/g, '');
  
  // Expose exports to globalThis
  for (const name of exportsList) {
    code += `\nglobalThis.${name} = typeof ${name} !== "undefined" ? ${name} : undefined;\n`;
  }
  
  vm.runInContext(code, sandbox);
}

// 3. Load the scripts in dependency order
loadModule('state.js', ['ROLE_RANK', 'ROLES', 'hasRole', 'state', 'STATUSES']);
loadModule('utils.js', ['requireWorkspace', 'formatTime', 'setText', 'showError', 'el']);
loadModule('api.js', ['api', 'logout']);
loadModule('quota-format.js', ['formatTaipeiResetTime', 'formatQuotaDetails', 'selectQuotaSummary']);
loadModule('quota.js', ['updateQuotaFooter']);
loadModule('router.js', ['registerRoute', 'navigate', 'currentRoute', 'setOnRouteCallback', 'route', 'initRouter']);
loadModule('sidebar.js', ['syncGlobalWorkspaces', 'renderWorkspaceSwitcher', 'initSwitcherListener', 'updateSidebar']);

// Extract functions from sandbox
const state = sandbox.globalThis.state;
const hasRole = sandbox.globalThis.hasRole;
const requireWorkspace = sandbox.globalThis.requireWorkspace;
const formatTime = sandbox.globalThis.formatTime;
const setText = sandbox.globalThis.setText;
const showError = sandbox.globalThis.showError;
const el = sandbox.globalThis.el;
const api = sandbox.globalThis.api;
const logout = sandbox.globalThis.logout;
const formatTaipeiResetTime = sandbox.globalThis.formatTaipeiResetTime;
const formatQuotaDetails = sandbox.globalThis.formatQuotaDetails;
const selectQuotaSummary = sandbox.globalThis.selectQuotaSummary;
const updateQuotaFooter = sandbox.globalThis.updateQuotaFooter;
const registerRoute = sandbox.globalThis.registerRoute;
const navigate = sandbox.globalThis.navigate;
const currentRoute = sandbox.globalThis.currentRoute;
const setOnRouteCallback = sandbox.globalThis.setOnRouteCallback;
const route = sandbox.globalThis.route;
const initRouter = sandbox.globalThis.initRouter;
const syncGlobalWorkspaces = sandbox.globalThis.syncGlobalWorkspaces;
const renderWorkspaceSwitcher = sandbox.globalThis.renderWorkspaceSwitcher;
const initSwitcherListener = sandbox.globalThis.initSwitcherListener;
const updateSidebar = sandbox.globalThis.updateSidebar;

// Helper to reset mocks
function resetMocks() {
  documentElements.clear();
  documentElements.set('app', appElement);
  documentElements.set('sidebar-ws-select', mockSelectElement);
  appElement.innerHTML = '';
  appElement.textContent = '';
  appElement.childNodes = [];
  mockSelectElement.innerHTML = '';
  mockSelectElement.textContent = '';
  mockSelectElement.childNodes = [];
  mockSelectElement.value = '';
  sessionStorageMap.clear();
  Object.keys(documentListeners).forEach(k => delete documentListeners[k]);
  Object.keys(windowListeners).forEach(k => delete windowListeners[k]);
  state.workspaceId = null;
  state.workspaceName = null;
  state.taskId = null;
  state.globalWorkspaces = [];
  lastAlertMessage = null;
  fetchMock = null;
  currentHash = '#/login';
  mockDocument.body = new MockElement('body');
}

async function runTests() {
  console.log('Running frontendCore.test.ts...');

  const toPlain = (obj: any) => obj === null || obj === undefined ? obj : JSON.parse(JSON.stringify(obj));

  // ==========================================
  // [utils.js] Tests
  // ==========================================
  
  // requireWorkspace - positive
  {
    resetMocks();
    state.workspaceId = 'ws-1';
    const container = new MockElement('div');
    const res = requireWorkspace(container);
    assert.strictEqual(res, true, 'requireWorkspace should return true when workspace is set');
    assert.strictEqual(container.innerHTML, '', 'container should remain empty');
  }

  // requireWorkspace - negative
  {
    resetMocks();
    state.workspaceId = null;
    const container = new MockElement('div');
    const res = requireWorkspace(container);
    assert.strictEqual(res, false, 'requireWorkspace should return false when workspace is null');
    assert.ok(container.innerHTML.includes('尚未選擇工作區'), 'container should show warning card');
    assert.ok(container.innerHTML.includes('#/workspaces'), 'warning card should contain link to workspaces');
  }

  // formatTime - positive
  {
    resetMocks();
    // Use fixed ISO strings
    const str1 = '2026-07-16T12:34:56.000Z';
    const formatted = formatTime(str1);
    // Since formatTime uses the host environment local timezone, we verify it parses correctly or has date pattern
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(formatted), `formatted time "${formatted}" should match YYYY-MM-DD HH:MM`);
  }

  // formatTime - negative
  {
    resetMocks();
    assert.strictEqual(formatTime(null), '未知時間', 'null time should return "未知時間"');
    assert.strictEqual(formatTime(undefined), '未知時間', 'undefined time should return "未知時間"');
    assert.strictEqual(formatTime(''), '未知時間', 'empty time should return "未知時間"');
    assert.strictEqual(formatTime('invalid-date'), 'NaN-NaN-NaN NaN:NaN', 'invalid date should return NaN representation');
  }

  // setText - positive
  {
    resetMocks();
    const mockEl = new MockElement('div', { id: 'target-el' });
    documentElements.set('target-el', mockEl);
    setText('target-el', 'New Content');
    assert.strictEqual(mockEl.textContent, 'New Content', 'setText should set textContent');
  }

  // setText - negative (element doesn't exist)
  {
    resetMocks();
    // Should not throw
    setText('non-existent-el', 'Some text');
  }

  // showError - positive
  {
    resetMocks();
    const mockEl = new MockElement('div', { id: 'err-el' });
    documentElements.set('err-el', mockEl);
    showError('err-el', 'Some Error');
    assert.strictEqual(mockEl.textContent, 'Some Error', 'showError should set text content');
    assert.strictEqual(mockEl.style.display, 'block', 'showError should set display block');

    // With Error object (created inside VM context to satisfy instanceof Error check)
    const vmErr = vm.runInContext("new Error('Obj Error')", sandbox);
    showError('err-el', vmErr);
    assert.strictEqual(mockEl.textContent, 'Obj Error');
  }

  // showError - negative (element doesn't exist, triggers alert)
  {
    resetMocks();
    showError('non-existent-el', 'Alert Error');
    assert.strictEqual(lastAlertMessage, 'Alert Error', 'showError should fallback to alert');
    
    const vmErr = vm.runInContext("new Error('Alert Error Obj')", sandbox);
    showError('non-existent-el', vmErr);
    assert.strictEqual(lastAlertMessage, 'Alert Error Obj', 'showError should fallback to alert with Error.message');
  }

  // el - positive
  {
    resetMocks();
    let clicked = false;
    const clickHandler = () => { clicked = true; };
    const node = el('a', { class: 'link-btn', href: 'https://test', onclick: clickHandler }, 'Click Me');
    
    assert.strictEqual(node.tag, 'a', 'should create tag element');
    assert.strictEqual(node.className, 'link-btn', 'should set class name');
    assert.strictEqual(node.href, 'https://test', 'should set custom attributes');
    assert.strictEqual(node.textContent, 'Click Me', 'should set text content');
    
    assert.ok(node.onclick, 'should bind onclick handler');
    node.onclick();
    assert.strictEqual(clicked, true, 'onclick handler should execute');
  }

  // ==========================================
  // [state.js] Tests
  // ==========================================
  
  // hasRole
  {
    assert.strictEqual(hasRole('Owner', 'Admin'), true);
    assert.strictEqual(hasRole('Admin', 'Admin'), true);
    assert.strictEqual(hasRole('Member', 'Admin'), false);
    assert.strictEqual(hasRole('Commenter', 'Member'), false);
    assert.strictEqual(hasRole('Commenter', 'Commenter'), true);
    assert.strictEqual(hasRole('Viewer', 'Commenter'), false);
  }

  // userEmail / userName Storage Integration
  {
    resetMocks();
    
    // Set email (trims & lowercase)
    state.userEmail = '  MyEMAIL@TEST.Local  ';
    assert.strictEqual(sessionStorageMap.get('user_email'), 'myemail@test.local', 'setter should trim and lowercase');
    assert.strictEqual(state.userEmail, 'myemail@test.local', 'getter should return trimmed lowercase email');

    // Remove email
    state.userEmail = null;
    assert.strictEqual(sessionStorageMap.has('user_email'), false, 'setter with null should remove item');
    assert.strictEqual(state.userEmail, null);

    state.userEmail = '   ';
    assert.strictEqual(sessionStorageMap.has('user_email'), false, 'setter with whitespace should remove item');

    // userName
    state.userName = 'Tester User';
    assert.strictEqual(sessionStorageMap.get('user_name'), 'Tester User');
    assert.strictEqual(state.userName, 'Tester User');

    state.userName = null;
    assert.strictEqual(sessionStorageMap.has('user_name'), false);
  }

  // state.clear()
  {
    resetMocks();
    state.workspaceId = 'ws-test';
    state.workspaceName = 'WS Name';
    state.taskId = 'task-test';
    state.globalWorkspaces = [{ workspace_id: 'ws-1', name: 'WS 1' }];
    state.userEmail = 'test@test.com';
    state.userName = 'Tester';

    state.clear();

    assert.strictEqual(state.workspaceId, null);
    assert.strictEqual(state.workspaceName, null);
    assert.strictEqual(state.taskId, null);
    assert.strictEqual(state.globalWorkspaces.length, 0);
    assert.strictEqual(sessionStorageMap.has('user_email'), false);
    assert.strictEqual(sessionStorageMap.has('user_name'), false);
  }

  // ==========================================
  // [api.js] Tests
  // ==========================================
  
  // api normal GET
  {
    resetMocks();
    let requestedUrl = '';
    let requestedInit: any = null;
    
    fetchMock = async (url: string, init?: any) => {
      requestedUrl = url;
      requestedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: [1, 2] })
      };
    };

    const res = await api('/api/workspaces');
    assert.strictEqual(requestedUrl, 'api/workspaces', 'should strip leading slash from path');
    assert.strictEqual(requestedInit.method, 'GET', 'default method should be GET');
    assert.deepStrictEqual(toPlain(res), { success: true, data: [1, 2] });
  }

  // api POST with body
  {
    resetMocks();
    let requestedUrl = '';
    let requestedInit: any = null;
    
    fetchMock = async (url: string, init?: any) => {
      requestedUrl = url;
      requestedInit = init;
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ created: true })
      };
    };

    const res = await api('/api/tasks', { method: 'POST', body: { title: 'New Task' } });
    assert.strictEqual(requestedUrl, 'api/tasks');
    assert.strictEqual(requestedInit.method, 'POST');
    assert.strictEqual(requestedInit.headers['Content-Type'], 'application/json');
    assert.strictEqual(requestedInit.body, JSON.stringify({ title: 'New Task' }));
    assert.deepStrictEqual(toPlain(res), { created: true });
  }

  // api negative - 401 Unauthorized handling
  {
    resetMocks();
    state.userEmail = 'login@test.com';
    currentHash = '#/tasks';

    fetchMock = async (url: string, init?: any) => {
      return {
        ok: false,
        status: 401,
        text: async () => 'Unauthorized'
      };
    };

    await assert.rejects(
      async () => {
        await api('/api/protected');
      },
      (err: Error) => {
        assert.strictEqual(err.message, '尚未登入，請重新登入');
        return true;
      },
      '401 response should throw unauthorized error'
    );

    assert.strictEqual(state.userEmail, null, '401 response should clear user session state');
    assert.strictEqual(currentHash, '#/login', '401 response should redirect location hash to login');
  }

  // api negative - non-ok status handling (with error details)
  {
    resetMocks();
    fetchMock = async (url: string, init?: any) => {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: '不允許的狀態轉換' })
      };
    };

    await assert.rejects(
      async () => {
        await api('/api/tasks/1', { method: 'PATCH', body: { status: 'Done' } });
      },
      (err: Error) => {
        assert.strictEqual(err.message, '不允許的狀態轉換');
        return true;
      }
    );
  }

  // api negative - non-ok status handling (fallback text)
  {
    resetMocks();
    fetchMock = async (url: string, init?: any) => {
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      };
    };

    await assert.rejects(
      async () => {
        await api('/api/fail');
      },
      (err: Error) => {
        assert.strictEqual(err.message, '發生錯誤（HTTP 500）');
        return true;
      }
    );
  }

  // logout
  {
    resetMocks();
    state.userEmail = 'test@test.com';
    currentHash = '#/tasks';
    let logoutCalled = false;

    fetchMock = async (url: string, init?: any) => {
      if (url === 'api/auth/logout') {
        logoutCalled = true;
        return {
          ok: true,
          status: 200,
          text: async () => 'OK'
        };
      }
      return { ok: false, status: 400, text: async () => '' };
    };

    await logout();
    assert.strictEqual(logoutCalled, true);
    assert.strictEqual(state.userEmail, null, 'logout should clear state');
    assert.strictEqual(currentHash, '#/login', 'logout should redirect hash');
  }

  // logout tolerance on fail
  {
    resetMocks();
    state.userEmail = 'test@test.com';
    currentHash = '#/tasks';

    fetchMock = async (url: string, init?: any) => {
      return {
        ok: false,
        status: 500,
        text: async () => 'Crash'
      };
    };

    // Should not throw, should still clean state
    await logout();
    assert.strictEqual(state.userEmail, null);
    assert.strictEqual(currentHash, '#/login');
  }

  // ==========================================
  // [quota.js & quota-format.js] Tests
  // ==========================================
  
  // formatTaipeiResetTime
  {
    assert.strictEqual(formatTaipeiResetTime(null), '尚無重置時間');
    assert.strictEqual(formatTaipeiResetTime('invalid'), '尚無重置時間');
    
    const formatted = formatTaipeiResetTime('2026-07-19T19:00:07.000Z');
    //台北時區應為 2026/07/20 03:00
    assert.strictEqual(formatted, '2026/07/20 03:00');
  }

  // formatQuotaDetails
  {
    const provider = {
      windows: [
        { window: 'five_hour', available: true, remaining: '80%', resetAt: '2026-07-19T19:00:07.000Z' },
        { window: 'seven_day', available: true, remaining: '40%', resetAt: null }
      ]
    };
    const details = formatQuotaDetails(provider);
    assert.ok(details.includes('5 小時：80% · 2026/07/20 03:00'));
    assert.ok(details.includes('7 天：40% · 尚無重置時間'));
    
    // Unavailable fallback
    const badProvider = {
      windows: [
        { window: 'five_hour', available: false, remaining: '80%' },
        { window: 'seven_day', available: true, remaining: null }
      ]
    };
    const badDetails = formatQuotaDetails(badProvider);
    assert.ok(badDetails.includes('5 小時：尚無資料'));
    assert.ok(badDetails.includes('7 天：尚無資料'));
  }

  // selectQuotaSummary
  {
    // Both available -> select five_hour
    const provider1 = {
      windows: [
        { window: 'five_hour', available: true, remaining: '90%' },
        { window: 'seven_day', available: true, remaining: '50%' }
      ]
    };
    assert.deepStrictEqual(toPlain(selectQuotaSummary(provider1)), { label: '5h', remaining: '90%' });

    // five_hour unavailable -> select seven_day
    const provider2 = {
      windows: [
        { window: 'five_hour', available: false, remaining: '90%' },
        { window: 'seven_day', available: true, remaining: '50%' }
      ]
    };
    assert.deepStrictEqual(toPlain(selectQuotaSummary(provider2)), { label: '7d', remaining: '50%' });

    // None available -> return null
    const provider3 = {
      windows: [
        { window: 'five_hour', available: false },
        { window: 'seven_day', available: false }
      ]
    };
    assert.strictEqual(selectQuotaSummary(provider3), null);
  }

  // updateQuotaFooter - positive
  {
    resetMocks();
    const mockFooter = new MockElement('div', { id: 'quota-footer' });
    documentElements.set('quota-footer', mockFooter);

    fetchMock = async (url: string) => {
      if (url === 'api/quota') {
        const data = [
          {
            provider: 'claude',
            unavailable: false,
            stale: false,
            windows: [{ window: 'five_hour', available: true, remaining: '75%', resetAt: null }]
          },
          {
            provider: 'codex',
            unavailable: true,
            stale: false,
            windows: []
          }
        ];
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(data)
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '[]'
      };
    };

    await updateQuotaFooter();
    assert.strictEqual(mockFooter.style.display, 'flex', 'footer should be displayed');
    
    // Check items rendered
    const items = mockFooter.childNodes.filter(node => node.className && node.className.includes('quota-item'));
    assert.strictEqual(items.length, 2, 'should render 2 quota items');

    // First item: Claude
    const claudeItem = items[0];
    assert.ok(claudeItem.classList.contains('quota-item'));
    assert.ok(!claudeItem.classList.contains('unavailable'));
    assert.strictEqual(claudeItem['aria-label'], 'Claude 5 小時：75% · 尚無重置時間；7 天：尚無資料');

    // Second item: Codex
    const codexItem = items[1];
    assert.ok(codexItem.classList.contains('quota-item'));
    assert.ok(codexItem.classList.contains('unavailable'), 'Codex should be marked unavailable');
    
    // Separator
    const separators = mockFooter.childNodes.filter(node => node.className === 'quota-sep');
    assert.strictEqual(separators.length, 1, 'should have 1 separator');
  }

  // updateQuotaFooter - negative (API fails)
  {
    resetMocks();
    const mockFooter = new MockElement('div', { id: 'quota-footer' });
    documentElements.set('quota-footer', mockFooter);

    fetchMock = async () => {
      throw new Error('API down');
    };

    await updateQuotaFooter();
    assert.strictEqual(mockFooter.style.display, 'none', 'footer should be hidden on API failure');
  }

  // ==========================================
  // [router.js] Tests
  // ==========================================
  
  // registerRoute, currentRoute, and navigate/route integration
  {
    resetMocks();
    const mockApp = appElement;
    documentElements.set('app', mockApp);

    let routeDetailsRendered: any = null;
    const mockView = {
      render: async (container: any, rest: string[], query: any) => {
        routeDetailsRendered = { rest, queryVal: query.get('sort') };
        container.innerHTML = '<h1>Rendered View</h1>';
      }
    };

    registerRoute('test-route', mockView);
    
    // Navigate using router
    navigate('#/test-route/param1/param2?sort=asc');
    assert.strictEqual(currentHash, '#/test-route/param1/param2?sort=asc');

    const parsed = currentRoute();
    assert.strictEqual(parsed.prefix, 'test-route');
    assert.deepStrictEqual(toPlain(parsed.rest), ['param1', 'param2']);
    assert.strictEqual(parsed.query.get('sort'), 'asc');

    // Run router routing evaluation
    let routeCallbackPrefix = '';
    setOnRouteCallback((prefix: string) => {
      routeCallbackPrefix = prefix;
    });

    await route();
    
    assert.strictEqual(mockApp.innerHTML, '<h1>Rendered View</h1>', 'View should render inside app container');
    assert.deepStrictEqual(toPlain(routeDetailsRendered.rest), ['param1', 'param2']);
    assert.strictEqual(routeDetailsRendered.queryVal, 'asc');
    assert.strictEqual(routeCallbackPrefix, 'test-route', 'setOnRouteCallback should trigger');
  }

  // router fallback to login
  {
    resetMocks();
    const mockApp = appElement;
    documentElements.set('app', mockApp);

    let loginRendered = false;
    const loginMockView = {
      render: async (container: any) => {
        loginRendered = true;
        container.innerHTML = 'Login page';
      }
    };
    registerRoute('login', loginMockView);

    navigate('#/unregistered-path');
    await route();
    
    assert.strictEqual(loginRendered, true, 'should fallback to login view when path unregistered');
  }

  // router error isolation
  {
    resetMocks();
    const mockApp = appElement;
    documentElements.set('app', mockApp);

    const badView = {
      render: async () => {
        throw new Error('Render Crash');
      }
    };
    registerRoute('bad-route', badView);
    navigate('#/bad-route');
    
    // This should not crash or throw, just log
    await route();
  }

  // ==========================================
  // [sidebar.js] Tests
  // ==========================================
  
  // syncGlobalWorkspaces - positive
  {
    resetMocks();
    state.userEmail = 'test@test.com';
    const mockSelect = mockSelectElement;

    fetchMock = async (url: string) => {
      if (url === 'api/workspaces') {
        const data = [
          { workspace_id: 'ws-1', name: 'Work 1', status: 'Active' },
          { workspace_id: 'ws-2', name: 'Work 2', status: 'deleted' }
        ];
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(data)
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '[]'
      };
    };

    await syncGlobalWorkspaces();
    assert.strictEqual(state.globalWorkspaces.length, 2);
    
    // Workspace Switcher Options Check
    // Options should contain default option + Work 1 + manage option (exclude deleted status)
    const options = mockSelect.childNodes;
    assert.strictEqual(options.length, 3, 'should render 3 options (default, ws-1, manage)');
    assert.strictEqual(options[0].textContent, '-- 切換工作區 --');
    assert.strictEqual(options[1].value, 'ws-1');
    assert.strictEqual(options[1].textContent, 'Work 1');
    assert.strictEqual(options[2].value, '__manage__');
  }

  // syncGlobalWorkspaces - negative (fails / not logged in)
  {
    resetMocks();
    state.userEmail = null;
    const mockSelect = mockSelectElement;

    await syncGlobalWorkspaces();
    assert.strictEqual(state.globalWorkspaces.length, 0);
    // switcher should still render default and manage options
    assert.strictEqual(mockSelect.childNodes.length, 2);
  }

  // initSwitcherListener - target navigation
  {
    resetMocks();
    const mockSelect = mockSelectElement;
    
    // Setup side elements (mobile sidebar indicators)
    const sidebar = new MockElement('div', { id: 'sidebar', class: 'open' });
    const backdrop = new MockElement('div', { id: 'sidebar-backdrop', class: 'visible' });
    const toggle = new MockElement('button', { id: 'sidebar-toggle' });
    toggle.textContent = '✖';
    documentElements.set('sidebar', sidebar);
    documentElements.set('sidebar-backdrop', backdrop);
    documentElements.set('sidebar-toggle', toggle);

    state.globalWorkspaces = [
      { workspace_id: 'ws-1', name: 'Work 1', status: 'Active' }
    ];

    initSwitcherListener();
    
    const changeListeners = mockSelect.eventListeners['change'];
    assert.ok(changeListeners && changeListeners.length > 0);

    // Simulate switching workspace to ws-1
    currentHash = '#/workspaces';
    await changeListeners[0]({ target: { value: 'ws-1' } });
    
    assert.strictEqual(state.workspaceId, 'ws-1');
    assert.strictEqual(state.workspaceName, 'Work 1');
    assert.strictEqual(currentHash, '#/tasks', 'should navigate to tasks view');

    // verify mobile sidebar collapse classes removed
    assert.strictEqual(sidebar.classList.contains('open'), false);
    assert.strictEqual(backdrop.classList.contains('visible'), false);
    assert.strictEqual(toggle.textContent, '☰');
  }

  // initSwitcherListener - target __manage__
  {
    resetMocks();
    const mockSelect = mockSelectElement;
    state.workspaceId = 'ws-original';

    initSwitcherListener();
    const changeListeners = mockSelect.eventListeners['change'];
    let targetSelectVal = '__manage__';

    // Mock target value writeback
    const mockEvent = {
      target: {
        get value() { return targetSelectVal; },
        set value(v) { targetSelectVal = v; }
      }
    };
    
    await changeListeners[0](mockEvent);
    assert.strictEqual(currentHash, '#/workspaces', 'should navigate to workspaces list');
    assert.strictEqual(targetSelectVal, 'ws-original', 'should restore selection to previous workspace ID');
  }

  // updateSidebar - highlights and display toggling
  {
    resetMocks();
    
    const navBtnLogin = new MockElement('a', { id: 'nav-login', class: 'nav-btn active' });
    const navBtnTasks = new MockElement('a', { id: 'nav-tasks', class: 'nav-btn' });
    const userEmailEl = new MockElement('span', { id: 'sidebar-user-email' });
    const logoutBtn = new MockElement('button', { id: 'logout-btn' });
    const wsNav = new MockElement('div', { id: 'workspace-nav' });
    const wsSection = new MockElement('div', { id: 'workspace-section' });
    const wsSelect = mockSelectElement;

    documentElements.set('nav-login', navBtnLogin);
    documentElements.set('nav-tasks', navBtnTasks);
    documentElements.set('sidebar-user-email', userEmailEl);
    documentElements.set('logout-btn', logoutBtn);
    documentElements.set('workspace-nav', wsNav);
    documentElements.set('workspace-section', wsSection);
    documentElements.set('sidebar-ws-select', wsSelect);

    // 1. Not logged in state
    state.userEmail = null;
    state.workspaceId = null;

    updateSidebar('login');
    assert.strictEqual(navBtnLogin.classList.contains('active'), true);
    assert.strictEqual(navBtnTasks.classList.contains('active'), false);
    assert.strictEqual(userEmailEl.textContent, '');
    assert.strictEqual(logoutBtn.style.display, 'none');
    assert.strictEqual(wsSection.style.display, 'none');
    assert.strictEqual(wsNav.style.display, 'none');

    // 2. Logged in and active workspace state
    state.userEmail = 'tester@test.com';
    state.userName = 'Tester User';
    state.workspaceId = 'ws-active';

    updateSidebar('tasks');
    assert.strictEqual(navBtnLogin.classList.contains('active'), false);
    assert.strictEqual(navBtnTasks.classList.contains('active'), true, 'tasks nav button should be active');
    assert.strictEqual(userEmailEl.textContent, 'Tester User (tester@test.com)', 'should combine name and email');
    assert.strictEqual(logoutBtn.style.display, 'inline-flex');
    assert.strictEqual(wsSection.style.display, 'block');
    assert.strictEqual(wsNav.style.display, 'flex', 'workspace navigation panel should be visible');
  }

  console.log('frontendCore.test.ts OK');
}

runTests().catch(err => {
  console.error('frontendCore.test.ts FAILED:', err);
  process.exit(1);
});
