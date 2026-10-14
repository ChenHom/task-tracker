import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// 1. Define mock elements and event registry
const listeners: { [event: string]: Function[] } = {};
const windowListeners: { [event: string]: Function[] } = {};
const bodyChildren: MockElement[] = [];

class MockElement {
  [key: string]: any;
  tag: string;
  id: string;
  className: string;
  style: any = {};
  childNodes: MockElement[] = [];
  onclick: Function | null = null;
  textContent: string = '';
  value: string = '';
  cleanup: Function | null = null;
  eventListeners: { [event: string]: Function[] } = {};
  disabled: boolean = false;
  selectionStart: number = 0;
  selectionEnd: number = 0;
  offsetHeight: number = 0;
  _innerHTML: string = '';

  get options() {
    return this.childNodes;
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    this.childNodes = [];
    if (this.tag === 'select') {
      const matches = val.matchAll(/value="([^"]+)"[^>]*>([^<]+)/g);
      for (const match of matches) {
        const opt = new MockElement('option', { value: match[1] });
        opt.textContent = match[2];
        this.appendChild(opt);
      }
    } else {
      if (val.includes('class="kanban-header-bar"')) {
        const header = new MockElement('div', { class: 'kanban-header-bar' });
        const titleWrapper = new MockElement('div', { class: 'kanban-title-wrapper' });
        header.appendChild(titleWrapper);
        this.appendChild(header);

        const contextMatch = val.match(/<section id="project-context"[^>]*aria-live="([^"]+)"[^>]*>([^<]*)<\/section>/);
        if (contextMatch) {
          const context = new MockElement('section', { id: 'project-context', class: 'sketch-box', 'aria-live': contextMatch[1] });
          context.textContent = contextMatch[2];
          const filterMarkerIndex = val.indexOf('<!-- Project Filter and Manage Inline -->');
          const contextIndex = val.indexOf('id="project-context"');
          (contextIndex < filterMarkerIndex ? titleWrapper : header).appendChild(context);
        }
      }
      if (val.includes('id="goal-error"')) {
        this.appendChild(new MockElement('p', { id: 'goal-error' }));
      }
      if (val.includes('id="goal-detail"')) {
        this.appendChild(new MockElement('div', { id: 'goal-detail' }));
      }
      for (const match of val.matchAll(/id="(cards-[A-Za-z]+)"/g)) {
        this.appendChild(new MockElement('div', { id: match[1] }));
      }
      for (const match of val.matchAll(/id="((?:manage|create)-project-button)"/g)) {
        this.appendChild(new MockElement('button', { id: match[1] }));
      }
      if (val.includes('id="project-filter-select"')) {
        const select = new MockElement('select', { id: 'project-filter-select' });
        const optAll = new MockElement('option', { value: 'all' });
        optAll.textContent = '所有專案';
        select.appendChild(optAll);
        const optNone = new MockElement('option', { value: 'none' });
        optNone.textContent = '無專案';
        select.appendChild(optNone);
        this.appendChild(select);
      }
      if (val.includes('id="toggle-archived-checkbox"')) {
        const isChecked = val.includes('checked');
        const checkbox = new MockElement('input', {
          type: 'checkbox',
          id: 'toggle-archived-checkbox',
          checked: isChecked
        });
        this.appendChild(checkbox);
      }
      if (val.includes('id="kanban-board-el"')) {
        const board = new MockElement('div', { id: 'kanban-board-el' });
        const colArchived = new MockElement('div', { id: 'col-Archived-el' });
        board.appendChild(colArchived);
        this.appendChild(board);
      }
      if (val.includes('id="add-btn-Todo"')) {
        this.appendChild(new MockElement('span', { id: 'add-btn-Todo' }));
      }
      if (val.includes('id="add-form-Todo"')) {
        this.appendChild(new MockElement('div', { id: 'add-form-Todo' }));
      }
      if (val.includes('id="ws-list-container"')) {
        const wsList = new MockElement('div', { id: 'ws-list-container' });
        this.appendChild(wsList);
      }
      if (val.includes('id="ws-pagination"')) {
        const pagination = new MockElement('div', { id: 'ws-pagination' });
        this.appendChild(pagination);
      }
      if (val.includes('id="create-ws-form"')) {
        const createForm = new MockElement('form', { id: 'create-ws-form' });
        const wsInput = new MockElement('input', { id: 'ws-name-input' });
        createForm.appendChild(wsInput);
        this.appendChild(createForm);
      }
      if (val.includes('id="notif-filter"')) {
        this.appendChild(new MockElement('select', { id: 'notif-filter' }));
      }
      if (val.includes('id="notif-page-size"')) {
        this.appendChild(new MockElement('select', { id: 'notif-page-size' }));
      }
      if (val.includes('id="notif-list"')) {
        this.appendChild(new MockElement('ul', { id: 'notif-list', class: 'notif-list' }));
      }
      if (val.includes('id="notif-pagination"')) {
        this.appendChild(new MockElement('nav', { id: 'notif-pagination' }));
      }
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

  remove() {
    if (this.cleanup) {
      const cb = this.cleanup;
      this.cleanup = null;
      cb();
    }
  }

  hasChildNodes() {
    return this.childNodes.length > 0;
  }

  contains(target: MockElement | null): boolean {
    if (!target) return false;
    return this === target || this.childNodes.some(child => child.contains(target));
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

  blur() {}
  focus() {}

  querySelector(selector: string): MockElement | null {
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      const findRec = (node: MockElement): MockElement | null => {
        if (node.classList && node.classList.contains(className)) return node;
        for (const child of node.childNodes) {
          const res = findRec(child);
          if (res) return res;
        }
        return null;
      };
      return findRec(this);
    }
    const findRecTag = (node: MockElement): MockElement | null => {
      if (node.tag === selector) return node;
      for (const child of node.childNodes) {
        const res = findRecTag(child);
        if (res) return res;
      }
      return null;
    };
    return findRecTag(this);
  }
}

const mockDocument: any = {
  listeners: listeners,
  body: {
    classList: {
      classes: [] as string[],
      add: function(cls: string) {
        if (!this.classes.includes(cls)) this.classes.push(cls);
      },
      remove: function(cls: string) {
        const idx = this.classes.indexOf(cls);
        if (idx !== -1) this.classes.splice(idx, 1);
      }
    },
    appendChild: (child: MockElement) => {
      bodyChildren.push(child);
    }
  },
  getElementById: (id: string) => {
    if (id === 'task-detail-modal') {
      const el = new MockElement('div', { id: 'task-detail-modal' });
      el.cleanup = () => {
        // Trigger document and window cleanup removal of keydown listener
        if (mockDocument.listeners['keydown']) {
          mockDocument.listeners['keydown'] = [];
        }
        if (mockWindow.listeners['keydown']) {
          mockWindow.listeners['keydown'] = [];
        }
        if (mockWindow.listeners['hashchange']) {
          mockWindow.listeners['hashchange'] = [];
        }
      };
      return el;
    }
    const findRec = (node: MockElement): MockElement | null => {
      if (node.id === id) return node;
      for (const child of node.childNodes) {
        const found = findRec(child);
        if (found) return found;
      }
      return null;
    };
    for (const root of bodyChildren) {
      const found = findRec(root);
      if (found) return found;
    }
    return null;
  },
  createDocumentFragment: () => new MockElement('#fragment'),
  createTextNode: (text: string) => {
    const node = new MockElement('#text');
    node.textContent = text;
    return node;
  },
  querySelector: (selector: string) => {
    const match = selector.match(/^#([^ ]+) \.([^ ]+)$/);
    const root = match ? mockDocument.getElementById(match[1]) : null;
    return root && match ? root.querySelector(`.${match[2]}`) : null;
  },
  querySelectorAll: (selector: string) => {
    const matches: MockElement[] = [];
    const visit = (node: MockElement) => {
      if (selector.startsWith('.') && node.classList.contains(selector.slice(1))) matches.push(node);
      for (const child of node.childNodes) visit(child);
    };
    for (const root of bodyChildren) visit(root);
    return matches;
  },
  addEventListener: (event: string, callback: Function) => {
    listeners[event] = listeners[event] || [];
    listeners[event].push(callback);
  },
  removeEventListener: (event: string, callback: Function) => {
    if (listeners[event]) {
      listeners[event] = listeners[event].filter(cb => cb !== callback);
    }
  }
};

const mockWindow: any = {
  listeners: windowListeners,
  addEventListener: (event: string, callback: Function) => {
    windowListeners[event] = windowListeners[event] || [];
    windowListeners[event].push(callback);
  },
  removeEventListener: (event: string, callback: Function) => {
    if (windowListeners[event]) {
      windowListeners[event] = windowListeners[event].filter(cb => cb !== callback);
    }
  },
  get location() {
    return mockLocation;
  }
};

let currentHash = '#/task/task-1';
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
        // Execute a copy to avoid mutation errors during iteration
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
const localStorageMap = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => localStorageMap.get(key) ?? null,
  setItem: (key: string, value: any) => localStorageMap.set(key, String(value))
};

// 2. Read and transform public/js/views/task-detail.js
let code = readFileSync(join(__dirname, '../public/js/views/task-detail.js'), 'utf8');

// Replace imports with stubs
code = code.replace(/import\s+[\s\S]*?\s+from\s+['"].*?['"];?/g, '');

// Convert export to globalThis mapping
code = code.replace(/export\s+async\s+function\s+openTaskDetailModal/g, 'globalThis.openTaskDetailModal = async function openTaskDetailModal');
code = code.replace(/export\s+function\s+safeHttpUrl/g, 'function safeHttpUrl');
code += '\nglobalThis.safeHttpUrl = typeof safeHttpUrl === "function" ? safeHttpUrl : undefined;';
code += '\nglobalThis.renderRichText = typeof renderRichText === "function" ? renderRichText : undefined;';

// 2.5 Read and transform public/js/views/kanban.js
let kanbanCode = readFileSync(join(__dirname, '../public/js/views/kanban.js'), 'utf8');
kanbanCode = kanbanCode.replace(/import\s+[\s\S]*?\s+from\s+['"].*?['"];?/g, '');
kanbanCode = kanbanCode.replace(/export\s+const\s+KanbanView\s*=\s*/g, 'globalThis.KanbanView = ');

// 2.6 Read and transform public/js/views/goals.js
let goalsCode = readFileSync(join(__dirname, '../public/js/views/goals.js'), 'utf8');
goalsCode = goalsCode.replace(/import\s+[\s\S]*?\s+from\s+['"].*?['"];?/g, '');
goalsCode = goalsCode.replace(/export\s+const\s+GoalsView\s*=\s*/g, 'globalThis.GoalsView = ');

// 2.7 Read and transform public/js/views/workspaces.js
let workspacesCode = readFileSync(join(__dirname, '../public/js/views/workspaces.js'), 'utf8');
workspacesCode = workspacesCode.replace(/import\s+[\s\S]*?\s+from\s+['"].*?['"];?/g, '');
workspacesCode = workspacesCode.replace(/export\s+const\s+WorkspacesView\s*=\s*/g, 'globalThis.WorkspacesView = ');

// 2.8 Read and transform public/js/views/notifications.js
let notificationsCode = readFileSync(join(__dirname, '../public/js/views/notifications.js'), 'utf8');
notificationsCode = notificationsCode.replace(/import\s+[\s\S]*?\s+from\s+['"].*?['"];?/g, '');
notificationsCode = notificationsCode.replace(/export\s+async\s+function\s+/g, 'async function ');
notificationsCode = notificationsCode.replace(/export\s+function\s+/g, 'function ');
notificationsCode = notificationsCode.replace(/export\s+const\s+NotificationsView\s*=\s*/g, 'globalThis.NotificationsView = ');

// 3. Create sandbox
const sandbox = {
  document: mockDocument,
  window: mockWindow,
  location: mockLocation,
  sessionStorage: mockSessionStorage,
  localStorage: mockLocalStorage,
  alert: (msg?: any) => {},
  console: console,
  Event,
  URL,
  api: (async () => []) as (...args: any[]) => Promise<any>,
  state: {
    userEmail: 'test@test.com',
    workspaceId: 'ws-test-1',
    workspaceName: 'Workspace A',
    globalWorkspaces: [] as any[],
    clear: () => {}
  },
  hasRole: (role: string, minimum: string) => {
    const ranks: Record<string, number> = { Viewer: 0, Commenter: 1, Member: 2, Admin: 3, Owner: 4 };
    return ranks[role] >= ranks[minimum];
  },
  MAIN_OWNER_EMAIL: 'user01@test.local',
  MAIN_POLICY_TITLE: '[規則] 主工作區協作與交接',
  MAIN_WORKSPACE_ID: '11a82028-fc50-466a-a723-e002032cd9a6',
  MAIN_DISCUSSION_DESCRIPTION_TEMPLATE: '',
  navigate: (hash?: string) => {},
  el: (tag: string, attrs: any = {}, ...children: any[]) => {
    const element = new MockElement(tag, attrs);
    for (const child of children) {
      if (typeof child === 'string') {
        element.textContent = child;
      } else if (child instanceof MockElement) {
        element.appendChild(child);
      }
    }
    return element;
  },
  requireWorkspace: () => true,
  syncGlobalWorkspaces: async () => {},
  navigator: {
    clipboard: {
      writeText: async (text: string) => {}
    }
  },
  showError: () => {},
  formatTime: () => '',
  Promise: Promise,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: () => 1,
  clearInterval: () => {},
  globalThis: {} as any
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox);
vm.runInContext(kanbanCode, sandbox);
vm.runInContext(goalsCode, sandbox);
vm.runInContext(workspacesCode, sandbox);
vm.runInContext(notificationsCode, sandbox);

const openTaskDetailModal = sandbox.globalThis.openTaskDetailModal;
const safeHttpUrl = sandbox.globalThis.safeHttpUrl;
const renderRichText = sandbox.globalThis.renderRichText;
const KanbanView = sandbox.globalThis.KanbanView;
const WorkspacesView = sandbox.globalThis.WorkspacesView;
const NotificationsView = sandbox.globalThis.NotificationsView;

const localPartMention = renderRichText('@user02', [{
  user_id: 'user-02',
  name: '小美',
  email: 'user02@test.local'
}], [], []);
assert.strictEqual(localPartMention.childNodes.length, 1, 'email local-part mention should render as one element');
assert.strictEqual(localPartMention.childNodes[0].className, 'rich-mention', 'email local-part mention should use mention styling');
assert.strictEqual(localPartMention.childNodes[0].textContent, '@小美', 'email local-part mention should display the member name');

// ── DOM sink 合成字元 fixture：HTML/script 樣式輸入只能落成文字節點，不可被解析成真實元素 ──
const xssPlainText = renderRichText('<script>alert(1)</script><img src=x onerror=alert(2)>', [], [], []);
assert.strictEqual(xssPlainText.childNodes.length, 1, 'raw HTML-like 內容應整段落為單一節點，不應被 regex 拆成連結／mention');
assert.strictEqual(xssPlainText.childNodes[0].tag, '#text', '不得建立 script/img 等真實 DOM 元素');
assert.strictEqual(
  xssPlainText.childNodes[0].textContent,
  '<script>alert(1)</script><img src=x onerror=alert(2)>',
  '內容須原樣以文字呈現',
);

// ── 跨帳號情境：即使成員顯示名稱本身含 HTML 特殊字元，mention 仍只能經 el()/textContent 顯示，不建立子元素 ──
const evilMember = { user_id: 'evil-1', name: '<img src=x onerror=alert(1)>', email: 'evil@test.local' };
const mentionWithEvilName = renderRichText('@evil@test.local', [evilMember], [], []);
assert.strictEqual(mentionWithEvilName.childNodes.length, 1);
assert.strictEqual(mentionWithEvilName.childNodes[0].tag, 'span', '應建立單一 span，而非注入解析後的子元素');
assert.strictEqual(mentionWithEvilName.childNodes[0].className, 'rich-mention');
assert.strictEqual(
  mentionWithEvilName.childNodes[0].textContent,
  '@<img src=x onerror=alert(1)>',
  '顯示名稱應以 textContent 原樣顯示，不被當成 HTML 解析',
);
assert.strictEqual(mentionWithEvilName.childNodes[0].childNodes.length, 0, '不應產生任何子元素（證明走的是 textContent 而非 innerHTML）');

// ── URL 屬性斷點：URL 正則排除 <>"'，屬性 context 不會被提早關閉注入額外內容 ──
const urlBreakout = renderRichText('https://evil.com/"><script>alert(1)</script>', [], [], []);
const urlLink = urlBreakout.childNodes.find((n: MockElement) => n.tag === 'a');
assert.ok(urlLink, '合法前綴仍應被渲染成連結');
assert.strictEqual(urlLink!.href, 'https://evil.com/', 'href 應在遇到 " 時提前截斷，不含後續注入片段');
assert.ok(
  urlBreakout.childNodes.some((n: MockElement) => n.tag === '#text' && n.textContent.includes('<script>')),
  '截斷後的殘餘字串仍應以純文字節點呈現，不會被解析成元素',
);

function findElement(el: MockElement, predicate: (element: MockElement) => boolean): MockElement | null {
  if (predicate(el)) return el;
  for (const child of el.childNodes) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

async function runTests() {
  const stateSource = readFileSync(join(__dirname, '../public/js/state.js'), 'utf8');
  const kanbanSource = readFileSync(join(__dirname, '../public/js/views/kanban.js'), 'utf8');
  const membersSource = readFileSync(join(__dirname, '../public/js/views/members.js'), 'utf8');
  const taskDetailSource = readFileSync(join(__dirname, '../public/js/views/task-detail.js'), 'utf8');
  const goalsSource = readFileSync(join(__dirname, '../public/js/views/goals.js'), 'utf8');
  const agentsSource = readFileSync(join(__dirname, '../public/js/views/agents.js'), 'utf8');
  const routesSource = readFileSync(join(__dirname, '../public/js/routes.js'), 'utf8');
  const kanbanCssSource = readFileSync(join(__dirname, '../public/css/kanban.css'), 'utf8');
  const taskDetailCssSource = readFileSync(join(__dirname, '../public/css/task-detail.css'), 'utf8');

  // State should canonicalize both legacy and newly assigned email identities.
  const sessionValues = new Map<string, string>([['user_email', ' USER01@TEST.LOCAL ']]);
  const stateSandbox = {
    sessionStorage: {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => sessionValues.set(key, value),
      removeItem: (key: string) => sessionValues.delete(key)
    },
    globalThis: {} as any
  };
  const stateCode = stateSource.replace(/export\s+const\s+/g, 'const ')
    + '\nglobalThis.state = state;';
  vm.createContext(stateSandbox);
  vm.runInContext(stateCode, stateSandbox);
  assert.strictEqual(stateSandbox.globalThis.state.userEmail, 'user01@test.local');
  stateSandbox.globalThis.state.userEmail = ' USER02@TEST.LOCAL ';
  assert.strictEqual(sessionValues.get('user_email'), 'user02@test.local');

  // Test 1: Opening modal should register keydown listener on document and window
  listeners['keydown'] = [];
  windowListeners['keydown'] = [];
  windowListeners['hashchange'] = [];
  mockLocation.hash = '#/task/task-1';

  await openTaskDetailModal('task-1', {
    cachedTasks: [{ task_id: 'task-1', title: 'Test Task', description: 'Test Desc', status: 'todo' }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {}
  });

  assert.ok(listeners['keydown'] && listeners['keydown'].length === 1, 'Should register keydown listener on document');
  assert.ok(windowListeners['keydown'] && windowListeners['keydown'].length === 1, 'Should register keydown listener on window');
  assert.ok(windowListeners['hashchange'] && windowListeners['hashchange'].length === 1, 'Should register hashchange listener');

  // Test 2: Triggering Escape key should trigger cleanup and route back to #/tasks
  const preventDefaultCalled = { val: false };
  const mockEvent = {
    key: 'Escape',
    preventDefault: () => { preventDefaultCalled.val = true; }
  };
  
  // Call the registered keydown listener
  listeners['keydown'][0](mockEvent);

  assert.strictEqual(mockLocation.hash, '#/tasks', 'Escape key should redirect to /tasks');

  // Test 3: Opening modal again should run cleanup on existing modal and not leak listeners
  listeners['keydown'] = [() => {}]; // Simulate one existing listener
  windowListeners['keydown'] = [() => {}];
  mockLocation.hash = '#/task/task-1';
  
  // We mock document.getElementById to return a mock modal with cleanup
  await openTaskDetailModal('task-1', {
    cachedTasks: [{ task_id: 'task-1', title: 'Test Task', description: 'Test Desc', status: 'todo' }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {}
  });

  // After opening, keydown listeners should be cleaned up and set to exactly the new listener (length 1)
  assert.strictEqual(listeners['keydown'].length, 1, 'Duplicate open should cleanup previous keydown listeners on document');
  assert.strictEqual(windowListeners['keydown'].length, 1, 'Duplicate open should cleanup previous keydown listeners on window');

  // Task detail 不顯示 Project（2026-10-14 使用者決定移除），左欄第一區是任務名稱。
  const assertNoProjectSection = (overlay: MockElement, mode: string) => {
    const leftColumn = findElement(overlay, (element) => element.classList.contains('task-detail-left'));
    assert.ok(leftColumn, `${mode} Task detail 應顯示左欄`);
    const sections = leftColumn.childNodes.filter((element) => element.classList.contains('detail-section'));
    assert.strictEqual(sections[0]?.childNodes[0]?.textContent, '任務名稱 *', `${mode} Task detail 左欄第一區應為任務名稱`);
    assert.ok(!sections.some((section) => section.childNodes[0]?.textContent === 'Project'), `${mode} Task detail 不應有 Project 區塊`);
    assert.strictEqual(findElement(overlay, (element) => element['aria-label'] === 'Task Project'), null, `${mode} Task detail 不應有 Project 選單`);
  };

  bodyChildren.length = 0;
  await openTaskDetailModal('task-project-order-editable', {
    cachedTasks: [{ task_id: 'task-project-order-editable', title: 'Editable Task', description: '', status: 'Todo', project_id: 'project-1' }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {},
  });
  assertNoProjectSection(bodyChildren.at(-1)!, '可編輯');

  bodyChildren.length = 0;
  await openTaskDetailModal('task-project-order-readonly', {
    cachedTasks: [{ task_id: 'task-project-order-readonly', title: 'Read-only Task', description: '', status: 'Todo', project_id: 'project-1' }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {},
    currentRole: 'Viewer',
  });
  assertNoProjectSection(bodyChildren.at(-1)!, '唯讀');

  // Test 4: Description input keydown save and transition flow
  bodyChildren.length = 0;
  mockLocation.hash = '#/task/task-1';
  
  await openTaskDetailModal('task-1', {
    cachedTasks: [{ task_id: 'task-1', title: 'Test Task', description: 'Test Desc', status: 'todo' }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {}
  });

  const overlay = bodyChildren[bodyChildren.length - 1];
  assert.ok(overlay, 'Modal overlay should be appended');

  const descInput = findElement(overlay, (el) => el.tag === 'textarea');
  const unsavedBadge = findElement(overlay, (el) => el.tag === 'div' && el.textContent === '還未');
  const saveBtn = findElement(overlay, (el) => el.tag === 'button' && el.textContent === '儲存');

  assert.ok(descInput, 'Description input textarea should exist');
  assert.ok(unsavedBadge, 'Unsaved warning badge should exist');
  assert.ok(saveBtn, 'Save button should exist');

  // Accessibility regression (WCAG 受限試點): dialog 語意、關閉鈕可及名稱、留言框 label
  const modalContainerEl = findElement(overlay, (n) => n.tag === 'div' && n.className.includes('modal-container'));
  assert.ok(modalContainerEl, 'Modal container should exist');
  assert.strictEqual(modalContainerEl.role, 'dialog', 'Modal container should expose role="dialog"');
  assert.strictEqual(modalContainerEl['aria-modal'], 'true', 'Modal container should expose aria-modal="true"');
  assert.strictEqual(modalContainerEl['aria-label'], 'Test Task', 'Modal container should be labelled with the task title');

  const modalCloseBtn = findElement(overlay, (n) => n.tag === 'button' && n.className === 'modal-close-btn');
  assert.ok(modalCloseBtn, 'Close button should exist');
  assert.strictEqual(modalCloseBtn['aria-label'], '關閉', 'Close button needs an accessible name beyond the "×" glyph');

  const commentTextarea = findElement(overlay, (n) => n.tag === 'textarea' && n.className === 'comment-textarea');
  assert.ok(commentTextarea, 'Comment textarea should exist');
  assert.strictEqual(commentTextarea['aria-label'], '留言內容', 'Comment textarea needs a label beyond its placeholder');

  // Trigger Enter key on descInput
  let preventDefaultCalled4 = false;
  let blurred = false;
  descInput.blur = () => { blurred = true; };
  
  // We mock the api call inside the sandbox
  sandbox.api = async () => {
    // Verify saveBtn is disabled during saving, and badge text is '等待'
    assert.strictEqual(saveBtn.disabled, true, 'Save button should be disabled during saving');
    assert.strictEqual(unsavedBadge.textContent, '等待', 'Badge text should be "等待" during saving');
    return [];
  };

  const keydownEvent4 = {
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => { preventDefaultCalled4 = true; }
  };

  // Find keydown handler on descInput
  const keydownListeners = descInput.eventListeners['keydown'];
  assert.ok(keydownListeners && keydownListeners.length > 0, 'Should have keydown listener on descInput');

  // Trigger keydown
  const keydownPromise = keydownListeners[0](keydownEvent4);

  assert.strictEqual(preventDefaultCalled4, true, 'Should call preventDefault on Enter key');
  assert.strictEqual(blurred, true, 'Should blur descInput');

  // Wait 100ms for saveTask to complete (it should finish immediately since API is mock)
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.strictEqual(saveBtn.disabled, false, 'Save button should be re-enabled after saving');
  assert.strictEqual(unsavedBadge.textContent, '等待', 'Badge text should still be "等待"');

  // Wait 400ms more (total 500ms). The save delay has resolved and success is shown immediately.
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.strictEqual(unsavedBadge.textContent, '完成', 'Badge text should update to "完成" after saving');

  // Wait 450ms more (total 950ms). The success badge remains visible until its delayed hide.
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.strictEqual(unsavedBadge.textContent, '完成', 'Badge text should remain "完成" before its delayed hide');

  // Now await keydownPromise to wait for the rest of the sequence
  await keydownPromise;

  // Verify badge text remains '完成' and did not auto-reset
  assert.strictEqual(unsavedBadge.textContent, '完成', 'Badge text should remain "完成" after keydown resolves');

  // Trigger focus on descInput to hide it and reset text
  const focusListeners = descInput.eventListeners['focus'];
  assert.ok(focusListeners && focusListeners.length > 0, 'Should have focus listener on descInput');
  
  focusListeners[0](); // Trigger focus

  // Check that the hide transition starts immediately (sets opacity to '0')
  assert.strictEqual(unsavedBadge.style.opacity, '0', 'Badge opacity should be "0" immediately on focus');

  // Wait 350ms (300ms delay + 50ms buffer) for focus transition to finish and check if text resets to '還未'
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.strictEqual(unsavedBadge.textContent, '還未', 'Badge text should reset to "還未" after focus transition delay');

  // Test 4.5: Description save on mobile (window.innerWidth <= 768) should trigger unsavedBadge transition
  mockWindow.innerWidth = 375; // Set to mobile width

  // Trigger Save button click
  const saveBtnClick = saveBtn.onclick;
  assert.ok(saveBtnClick, 'Save button should have click handler');
  
  // Set new description value
  descInput.value = 'New Mobile Description';
  
  // Mock the api function in sandbox to simulate successful description patch
  const patchedBodies: any[] = [];
  sandbox.api = async (url: string, init: any) => {
    patchedBodies.push(init?.body);
    assert.strictEqual(unsavedBadge.textContent, '等待', 'Badge text should be "等待" during saving');
    return [];
  };

  await saveBtnClick();

  // Verify description change was patched, and badge text is "完成"
  assert.strictEqual(patchedBodies.length, 1, 'Should patch description once');
  assert.strictEqual(patchedBodies[0]?.description, 'New Mobile Description', 'Should patch new description');
  assert.strictEqual(unsavedBadge.textContent, '完成', 'Badge text should be "完成" after saving');

  // Cleanup
  delete mockWindow.innerWidth;

  // Test 5: Verify body.classList.classes for modal-open state and backToTopBtn visibility
  listeners['keydown'] = [];
  mockLocation.hash = '#/task/task-1';
  mockDocument.body.classList.classes = []; // Reset classes array

  await openTaskDetailModal('task-1', {
    cachedTasks: [{ task_id: 'task-1', title: 'Test Task', description: 'Test Desc', status: 'todo' }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {}
  });

  assert.ok(mockDocument.body.classList.classes.includes('modal-open'), 'Body should have "modal-open" class when modal is open');

  // Trigger Escape to close and verify cleanup
  const mockEvent5 = {
    key: 'Escape',
    preventDefault: () => {}
  };
  listeners['keydown'][0](mockEvent5);
  assert.ok(!mockDocument.body.classList.classes.includes('modal-open'), 'Body should lose "modal-open" class after cleanup');

  // Test 6: Commenters can discuss main-workspace tasks without task mutation controls
  bodyChildren.length = 0;
  mockLocation.hash = '#/task/task-1';
  sandbox.api = async (path: string) => path.endsWith('/comments')
    ? [{ comment_id: 'comment-own', user_id: 'user-1', content: 'Own comment', created_at: '2026-07-11T00:00:00.000Z' }]
    : [];

  await openTaskDetailModal('task-1', {
    cachedTasks: [{
      task_id: 'task-1',
      creator_id: 'user-2',
      title: 'Discussion Task',
      description: 'Discuss only',
      status: 'Todo',
      priority: 'Medium',
      assignee_id: null,
      due_at: null
    }],
    cachedMembers: [{ user_id: 'user-1', name: 'Tester', email: 'test@test.com' }],
    memberMap: new Map([['user-1', 'Tester']]),
    memberEmailMap: new Map([['user-1', 'test@test.com']]),
    onUpdate: async () => {},
    currentRole: 'Commenter',
    isMainWorkspace: true
  });

  const commenterOverlay = bodyChildren[bodyChildren.length - 1];
  assert.ok(findElement(commenterOverlay, (node) => node.textContent === 'Discussion Task'), 'Commenter should see the task title');
  assert.ok(findElement(commenterOverlay, (node) => node.tag === 'button' && node.textContent === '留言'), 'Commenter should have comment submit');
  assert.ok(findElement(commenterOverlay, (node) => node.tag === 'button' && node.textContent === '編輯'), 'Commenter should edit their own comment');
  assert.strictEqual(findElement(commenterOverlay, (node) => node.tag === 'button' && node.textContent === '刪除'), null, 'Commenter should not delete their own comment as deletion is removed');
  assert.strictEqual(findElement(commenterOverlay, (node) => node.tag === 'button' && node.textContent === '儲存'), null, 'Commenter should not have task save');
  assert.strictEqual(findElement(commenterOverlay, (node) => node.classList.contains('status-change-btn')), null, 'Commenter should not have status controls');
  assert.strictEqual(findElement(commenterOverlay, (node) => node.tag === 'select'), null, 'Commenter should not have task attribute selects');
  assert.strictEqual(findElement(commenterOverlay, (node) => node.tag === 'input'), null, 'Commenter should not have task, date, or upload inputs');

  // Test 6.1: Comment creation badge on mobile (window.innerWidth <= 768)
  {
    mockWindow.innerWidth = 375; // Set to mobile
    
    const commTextarea = findElement(commenterOverlay, (node) => node.tag === 'textarea' && node.classList.contains('comment-textarea'));
    const commFormEl = findElement(commenterOverlay, (node) => node.tag === 'form' && node.classList.contains('comment-form'));
    assert.ok(commTextarea && commFormEl, 'Comment input and form should exist');

    const commUnsavedBadge = findElement(commenterOverlay, (node) => node.tag === 'div' && node.classList.contains('unsaved-badge-popup') && node.textContent === '完成');
    assert.ok(commUnsavedBadge, 'Comment submit badge should exist');
    
    commTextarea.value = 'New mobile comment content';
    
    const postedComments: any[] = [];
    sandbox.api = async (path: string, options?: any) => {
      if (path.endsWith('/comments')) {
        if (options?.method === 'POST') {
          postedComments.push(options.body);
          assert.strictEqual(commUnsavedBadge.textContent, '等待', 'Comment badge should show "等待" during submit');
        }
        return [];
      }
      return [];
    };
    
    const mockSubmitEvent = {
      preventDefault: () => {}
    };
    
    assert.ok(commFormEl.onsubmit, 'Comment form should have an onsubmit handler');
    await commFormEl.onsubmit(mockSubmitEvent);
    assert.strictEqual(postedComments.length, 1, 'Should post a comment');
    assert.strictEqual(postedComments[0]?.content, 'New mobile comment content');
    assert.strictEqual(commUnsavedBadge.textContent, '完成', 'Comment badge should show "完成" after submit');
    
    // Test 6.1.1: Comment input focus/blur behavior
    assert.strictEqual(commFormEl.classList.contains('focused'), false, 'Form should not be focused initially');
    
    // Simulate focus
    const focusHandlers = commTextarea.eventListeners['focus'];
    assert.ok(focusHandlers && focusHandlers.length > 0, 'Textarea should have a focus listener');
    focusHandlers[0]();
    assert.strictEqual(commFormEl.classList.contains('focused'), true, 'Form should have focused class after focus');
    
    // Simulate blur
    const blurHandlers = commTextarea.eventListeners['blur'];
    assert.ok(blurHandlers && blurHandlers.length > 0, 'Textarea should have a blur listener');
    blurHandlers[0]();
    
    // Immediately after blur, it should still have the class due to 200ms delay
    assert.strictEqual(commFormEl.classList.contains('focused'), true, 'Form should retain focused class immediately after blur');
    
    // Wait 250ms for delay to resolve
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.strictEqual(commFormEl.classList.contains('focused'), false, 'Form should lose focused class after 200ms delay');

    // Cleanup
    delete mockWindow.innerWidth;
  }

  // Test 6.2: Comment edit badge on mobile (window.innerWidth <= 768)
  {
    mockWindow.innerWidth = 375; // Set to mobile
    
    const editBtn = findElement(commenterOverlay, (node) => node.tag === 'button' && node.textContent === '編輯');
    assert.ok(editBtn && editBtn.onclick, 'Edit button should exist with click handler');
    
    const editUnsavedBadge = findElement(commenterOverlay, (node) => node.tag === 'div' && node.classList.contains('unsaved-badge-popup') && node.textContent === '完成');
    assert.ok(editUnsavedBadge, 'Edit badge should exist');

    // Trigger edit mode
    await editBtn.onclick();
    assert.strictEqual(editBtn.textContent, '儲存', 'Button text should toggle to 儲存');
    
    const editInput = findElement(commenterOverlay, (node) => node.tag === 'textarea' && node.classList.contains('comment-edit-textarea'));
    assert.ok(editInput, 'Edit textarea should exist');
    editInput.value = 'Updated comment content';
    
    const patchedComments: any[] = [];
    sandbox.api = async (path: string, options?: any) => {
      if (path.includes('/comments/')) {
        if (options?.method === 'PATCH') {
          patchedComments.push(options.body);
          assert.strictEqual(editUnsavedBadge.textContent, '等待', 'Edit badge should show "等待" during save');
        }
        return [];
      }
      return [];
    };
    
    // Click Save button to submit edited comment
    assert.ok(editBtn.onclick, 'Edit/Save button should have a click handler');
    await editBtn.onclick();
    assert.strictEqual(patchedComments.length, 1, 'Should patch comment');
    assert.strictEqual(patchedComments[0]?.content, 'Updated comment content');
    assert.strictEqual(editUnsavedBadge.textContent, '完成', 'Edit badge should show "完成" after save');
    
    // Cleanup
    delete mockWindow.innerWidth;
  }

  // A Commenter may edit only the description of a task they created.
  bodyChildren.length = 0;
  mockLocation.hash = '#/task/task-1';
  sandbox.state.userEmail = ' TEST@TEST.COM ';
  const ownTaskPatches: any[] = [];
  sandbox.api = async (_path: string, options?: any) => {
    if (options?.method === 'PATCH') ownTaskPatches.push(options.body);
    return [];
  };
  await openTaskDetailModal('task-1', {
    cachedTasks: [{
      task_id: 'task-1',
      creator_id: 'user-1',
      title: 'Own Discussion Task',
      description: 'Original description',
      status: 'Todo',
      priority: 'Medium',
      assignee_id: null,
      due_at: null
    }],
    cachedMembers: [{ user_id: 'user-1', name: 'Tester', email: 'test@test.com' }],
    memberMap: new Map([['user-1', 'Tester']]),
    memberEmailMap: new Map([['user-1', 'test@test.com']]),
    onUpdate: async () => {},
    currentRole: 'Commenter'
  });

  const ownTaskOverlay = bodyChildren[bodyChildren.length - 1];
  assert.ok(findElement(ownTaskOverlay, (node) => node.classList.contains('task-readonly-title') && node.textContent === 'Own Discussion Task'), 'Commenter should see a read-only title for their own task');
  const ownDescription = findElement(ownTaskOverlay, (node) => node.tag === 'textarea' && node.rows === '5');
  const ownSave = findElement(ownTaskOverlay, (node) => node.tag === 'button' && node.textContent === '儲存');
  assert.ok(ownDescription, 'Commenter should edit their own task description');
  assert.ok(ownSave, 'Commenter should save their own task description');
  assert.strictEqual(findElement(ownTaskOverlay, (node) => node.tag === 'input'), null, 'Commenter should not have title, date, or upload inputs');
  assert.strictEqual(findElement(ownTaskOverlay, (node) => node.classList.contains('status-change-btn')), null, 'Commenter should not have status controls on their own task');
  assert.strictEqual(findElement(ownTaskOverlay, (node) => node.tag === 'select'), null, 'Commenter should not have task attribute selects on their own task');
  assert.strictEqual(findElement(ownTaskOverlay, (node) => node.tag === 'button' && node.textContent === '刪除'), null, 'Commenter should not have attachment delete on their own task');
  ownDescription.value = 'Updated description';
  const saveOwnDescription = ownSave.onclick;
  assert.ok(saveOwnDescription, 'Commenter save button should have a click handler');
  await saveOwnDescription();
  assert.deepStrictEqual(ownTaskPatches.map(body => ({ ...body })), [{ description: 'Updated description' }], 'Commenter save should PATCH only the description');

  // Main-workspace Member data must not grant task management to a non-owner.
  bodyChildren.length = 0;
  mockLocation.hash = '#/task/task-1';
  sandbox.state.userEmail = 'user02@test.local';
  sandbox.api = async () => [];
  await openTaskDetailModal('task-1', {
    cachedTasks: [{
      task_id: 'task-1',
      title: 'Main Member Task',
      description: 'Discuss only',
      status: 'Todo',
      priority: 'Medium',
      assignee_id: null,
      due_at: null
    }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {},
    currentRole: 'Member',
    isMainWorkspace: true
  });
  const mainMemberOverlay = bodyChildren[bodyChildren.length - 1];
  assert.ok(findElement(mainMemberOverlay, (node) => node.tag === 'button' && node.textContent === '留言'), 'Main Member should retain comments');
  assert.strictEqual(findElement(mainMemberOverlay, (node) => node.tag === 'button' && node.textContent === '儲存'), null, 'Main Member should not save tasks');
  assert.strictEqual(findElement(mainMemberOverlay, (node) => node.classList.contains('status-change-btn')), null, 'Main Member should not transition tasks');
  assert.strictEqual(findElement(mainMemberOverlay, (node) => node.tag === 'select'), null, 'Main Member should not edit task attributes');
  assert.ok(findElement(mainMemberOverlay, (node) => node.tag === 'input' && node.type === 'file'), 'Main Member should have attachment upload permission (backend writeAttachment only requires Member)');

  // Bug fix regression: a main-workspace Admin (non-owner) must retain attachment upload/delete
  // (backend ACCESS_ROLE.writeAttachment only requires Member) even though task attribute
  // management (status/priority/assignee/due date/title/description) stays Owner-only.
  bodyChildren.length = 0;
  mockLocation.hash = '#/task/task-1';
  sandbox.state.userEmail = 'user09@test.local';
  sandbox.api = async (path: string) => path.endsWith('/attachments')
    ? [{ attachment_id: 'attachment-9', original_name: 'admin-upload.txt', size: 2048 }]
    : [];
  await openTaskDetailModal('task-1', {
    cachedTasks: [{
      task_id: 'task-1',
      title: 'Main Admin Task',
      description: 'Discuss only',
      status: 'Todo',
      priority: 'Medium',
      assignee_id: null,
      due_at: null
    }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {},
    currentRole: 'Admin',
    isMainWorkspace: true
  });
  const mainAdminOverlay = bodyChildren[bodyChildren.length - 1];
  assert.strictEqual(findElement(mainAdminOverlay, (node) => node.tag === 'button' && node.textContent === '儲存'), null, 'Main Admin should not save task title/description');
  assert.strictEqual(findElement(mainAdminOverlay, (node) => node.classList.contains('status-change-btn')), null, 'Main Admin should not transition tasks');
  assert.strictEqual(findElement(mainAdminOverlay, (node) => node.tag === 'select'), null, 'Main Admin should not edit task attributes');
  assert.ok(findElement(mainAdminOverlay, (node) => node.tag === 'input' && node.type === 'file'), 'Main Admin should see the attachment upload input');
  assert.ok(findElement(mainAdminOverlay, (node) => node.tag === 'button' && node.textContent === '上傳附件'), 'Main Admin should see the upload button');
  assert.ok(findElement(mainAdminOverlay, (node) => node.tag === 'button' && node.textContent === '刪除' && node.classList.contains('btn-danger')), 'Main Admin should see attachment delete controls');
  sandbox.state.userEmail = 'test@test.com';

  // Test 7: Viewers retain task, comment, sharing, and attachment reads without mutation controls
  bodyChildren.length = 0;
  mockLocation.hash = '#/task/task-1';
  sandbox.state.userEmail = 'test@test.com';
  sandbox.api = async (path: string) => {
    if (path.endsWith('/comments')) {
      return [{ comment_id: 'comment-1', user_id: 'user-1', content: 'handoff https://example.com/run/1.。', created_at: '2026-07-11T00:00:00.000Z' }];
    }
    if (path.endsWith('/attachments')) {
      return [{ attachment_id: 'attachment-1', original_name: 'handoff.txt', size: 1024 }];
    }
    return [];
  };

  await openTaskDetailModal('task-1', {
    cachedTasks: [{
      task_id: 'task-1',
      title: 'Read Only Task',
      description: '請 @user02 確認唯讀描述。',
      status: 'Todo',
      priority: 'Low',
      assignee_id: null,
      due_at: null
    }],
    cachedMembers: [
      { user_id: 'user-1', name: 'Tester', email: 'test@test.com' },
      { user_id: 'user-02', name: '小美', email: 'user02@test.local' }
    ],
    memberMap: new Map([['user-1', 'Tester']]),
    memberEmailMap: new Map([['user-1', 'test@test.com']]),
    onUpdate: async () => {},
    currentRole: 'Viewer',
    isMainWorkspace: true
  });

  const viewerOverlay = bodyChildren[bodyChildren.length - 1];
  assert.ok(findElement(viewerOverlay, (node) => node.textContent === 'Read Only Task'), 'Viewer should see the task title');
  const readOnlyDescriptionMention = findElement(viewerOverlay, (node) => node.classList.contains('task-readonly-description'));
  assert.ok(readOnlyDescriptionMention, 'Viewer should see the read-only task description');
  assert.ok(findElement(readOnlyDescriptionMention, (node) => node.classList.contains('rich-mention') && node.textContent === '@小美'), 'Read-only task descriptions should display local-part mentions using member names');
  assert.ok(findElement(viewerOverlay, (node) => node.textContent === 'handoff.txt (1.0 KB)' && node.tag === 'a'), 'Viewer should retain attachment downloads');
  const urlLink = findElement(viewerOverlay, (node) => node.classList.contains('rich-url-link'));
  assert.ok(urlLink, 'Viewer should see safe handoff URLs as links');
  assert.strictEqual(urlLink.href, 'https://example.com/run/1');
  assert.strictEqual(urlLink.rel, 'noopener noreferrer');
  assert.ok(findElement(viewerOverlay, (node) => node.tag === '#text' && node.textContent === '.。'), 'Trailing URL punctuation should remain text');
  assert.strictEqual(findElement(viewerOverlay, (node) => node.tag === 'button' && (['留言', '編輯'].includes(node.textContent) || node.classList.contains('btn-danger'))), null, 'Viewer should not have comment or attachment mutations');

  const serial = findElement(viewerOverlay, (node) => node.classList.contains('comment-serial'));
  assert.ok(serial && serial.onclick, 'Viewer should retain the comment share menu');
  serial.onclick({ stopPropagation: () => {}, pageX: 0, pageY: 0 });
  const viewerPopup = bodyChildren[bodyChildren.length - 1];
  assert.ok(findElement(viewerPopup, (node) => node.tag === 'button' && node.textContent === '分享'), 'Viewer should retain comment sharing');
  assert.strictEqual(findElement(viewerPopup, (node) => node.tag === 'button' && node.textContent === '回覆'), null, 'Viewer should not have reply controls');

  // Test 7.1: Main-workspace Owner only sees the direct Todo -> Done control.
  bodyChildren.length = 0;
  sandbox.state.userEmail = 'user01@test.local';
  await openTaskDetailModal('task-1', {
    cachedTasks: [{
      task_id: 'task-1',
      creator_id: 'user-2',
      title: 'Discussion Task',
      description: 'Discuss only',
      status: 'Todo',
      priority: 'Medium',
      assignee_id: null,
      due_at: null
    }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {},
    currentRole: 'Owner',
    isMainWorkspace: true
  });
  const ownerOverlay = bodyChildren[bodyChildren.length - 1];
  assert.ok(findElement(ownerOverlay, (node) => node.classList.contains('status-change-btn') && node.textContent === '→ Done'), 'Main Owner should see direct Done control');
  assert.strictEqual(findElement(ownerOverlay, (node) => node.textContent === '→ Doing'), null, 'Main Owner should not see Doing control');
  sandbox.state.userEmail = 'test@test.com';

  // Test 8: Only absolute HTTP(S) URLs are linkable
  assert.strictEqual(safeHttpUrl('http://example.com/path'), 'http://example.com/path');
  assert.strictEqual(safeHttpUrl('https://example.com/path?x=1#handoff'), 'https://example.com/path?x=1#handoff');
  assert.strictEqual(safeHttpUrl('javascript:alert(1)'), null);
  assert.strictEqual(safeHttpUrl('/relative/path'), null);
  assert.strictEqual(safeHttpUrl('not a url'), null);

  // Y20 D1: Goal 詳情必須實際渲染 activity API 的欄位與 Goal 關係連結。
  {
    const GoalsView = sandbox.globalThis.GoalsView;
    assert.ok(GoalsView, 'GoalsView should be loaded into the DOM sandbox');
    const goalContainer = new MockElement('div');
    bodyChildren.length = 0;
    bodyChildren.push(goalContainer);
    sandbox.state.workspaceId = 'ws-goal-detail';
    sandbox.api = async (url: string) => {
      if (url === '/api/goals/goal-child') return {
        goal_id: 'goal-child', project_id: 'project-1', objective: 'Ship Goal detail', status: 'Discussing',
        discussion_phase: 'round_2', revision: 3, success_criteria: 'All behavior is visible',
        data_scope: 'workspace data', parent_goal_id: 'goal-parent',
      };
      if (url === '/api/goals/goal-child/activity') return {
        participations: [{ agent_id: 'agent-1', reason: 'Selected for frontend expertise', assignment: 'Review UI' }],
        contributions: [
          { round: 'round_1', stance: 'analysis', claim: 'Round one contribution', reason: 'Initial evidence', evidence_json: '[]' },
          { round: 'round_2', stance: 'agree', claim: 'Round two contribution', reason: 'Confirmed evidence', evidence_json: '[]' },
        ],
        synthesis: {
          summary: 'Synthesis summary', decision_rationale: 'Decision uses both rounds', change_scope: 'UI tests', uncertainties_json: '[]',
        },
        tasks: [],
        runs: [{ phase: 'round_2', agent_id: 'agent-1', adapter: 'codex', model: 'test-model', status: 'succeeded', session_id: 'session-1', actual_total_tokens: 4321 }],
        childGoals: [{ goal_id: 'goal-grandchild', objective: 'Follow-up Goal' }],
        deliveryEvidence: [{ kind: 'commit', ref: 'abc123', detail: 'test evidence' }],
        tokenTotals: { input: 0, output: 0 },
      };
      if (url === '/api/workspaces/ws-goal-detail/projects') return [{ project_id: 'project-1', name: 'Project One' }];
      if (url === '/api/workspaces/ws-goal-detail/members') return [{ email: 'test@test.com', role: 'Viewer' }];
      if (url === '/api/workspaces/ws-goal-detail/agents') return [{ agent_id: 'agent-1', name: 'Frontend Agent' }];
      throw new Error(`Unexpected Goal detail API: ${url}`);
    };

    await GoalsView.render(goalContainer, ['goal-child']);
    const renderedText: string[] = [];
    const collectText = (node: MockElement) => {
      if (node.textContent) renderedText.push(node.textContent);
      node.childNodes.forEach(collectText);
    };
    collectText(goalContainer);
    const text = renderedText.join('\n');
    for (const expected of [
      'Selected for frontend expertise', 'round_1', 'Round one contribution', 'round_2',
      'Round two contribution', 'Decision uses both rounds', '4321', 'commit', 'abc123',
    ]) assert.ok(text.includes(expected), `Goal detail should render ${expected}`);
    assert.ok(findElement(goalContainer, node => node.tag === 'a' && node.href === '#/goals/goal-parent'), 'Goal detail should link its parent Goal');
    assert.ok(findElement(goalContainer, node => node.tag === 'a' && node.href === '#/goals/goal-grandchild'), 'Goal detail should link its child Goal');
  }

  // Y20 D3: 建立 Task 的 Project 預選與 POST body 必須由實際 DOM 操作驗證。
  {
    const kanbanContainer = new MockElement('div');
    bodyChildren.length = 0;
    bodyChildren.push(kanbanContainer);
    sandbox.state.workspaceId = 'ws-task-project';
    sandbox.state.userEmail = 'test@test.com';
    sandbox.sessionStorage.clear();
    sandbox.sessionStorage.setItem('kanban_filter_project_ws-task-project', 'project-selected');
    let createTaskBody: any = null;
    sandbox.api = async (url: string, options?: any) => {
      if (url === '/api/workspaces/ws-task-project/tasks' && options?.method === 'POST') {
        createTaskBody = options.body;
        return { id: 'task-created' };
      }
      if (url === '/api/workspaces/ws-task-project/tasks') return [];
      if (url === '/api/workspaces/ws-task-project/projects') return [
        { project_id: 'project-selected', name: 'Selected Project', status: 'active' },
        { project_id: 'project-other', name: 'Other Project', status: 'active' },
      ];
      if (url === '/api/workspaces/ws-task-project/members') return [{ user_id: 'user-1', email: 'test@test.com', role: 'Member' }];
      if (url === '/api/workspaces/ws-task-project/goals' || url === '/api/workspaces/ws-task-project/repositories') return [];
      throw new Error(`Unexpected Kanban API: ${url}`);
    };

    await KanbanView.render(kanbanContainer);
    await new Promise(resolve => setTimeout(resolve, 20));
    const addButton = findElement(kanbanContainer, node => node.classList.contains('column-add-task-btn'));
    assert.ok(addButton?.onclick, 'Todo column should render its add Task button');
    addButton.onclick();
    const projectSelect = findElement(kanbanContainer, node => node.classList.contains('column-add-task-project'));
    assert.ok(projectSelect, 'Create Task form should render a Project select');
    assert.strictEqual(projectSelect.value, 'project-selected', 'Create Task Project should default to the selected Project filter');
    const titleInput = findElement(kanbanContainer, node => node.classList.contains('column-add-task-input'));
    const form = findElement(kanbanContainer, node => node.classList.contains('column-add-task-form'));
    assert.ok(titleInput && form?.onsubmit, 'Create Task form should be submittable');
    titleInput.value = 'Task under selected Project';
    await form.onsubmit({ preventDefault: () => {} });
    assert.strictEqual(createTaskBody?.projectId, 'project-selected', 'Create Task POST body should include the selected Project');
    bodyChildren.length = 0;
  }

  // K2: Project context 是 header 最後一行，總覽時留空（CSS :empty 收起），選定 Project 後顯示資訊。
  {
    const kanbanContainer = new MockElement('div');
    bodyChildren.length = 0;
    bodyChildren.push(kanbanContainer);
    sandbox.state.workspaceId = 'ws-project-context';
    sandbox.state.userEmail = 'test@test.com';
    sandbox.sessionStorage.clear();
    sandbox.api = async (url: string) => {
      if (url === '/api/workspaces/ws-project-context/tasks') return [];
      if (url === '/api/workspaces/ws-project-context/projects') return [
        { project_id: 'project-context-1', name: 'Placement Project', description: 'Header context', target_repo: '/repos/placement', status: 'active' },
      ];
      if (url === '/api/workspaces/ws-project-context/members') return [{ user_id: 'user-1', email: 'test@test.com', role: 'Member' }];
      if (url === '/api/workspaces/ws-project-context/goals' || url === '/api/workspaces/ws-project-context/repositories') return [];
      throw new Error(`Unexpected Kanban context API: ${url}`);
    };

    await KanbanView.render(kanbanContainer);
    await new Promise(resolve => setTimeout(resolve, 20));
    const header = findElement(kanbanContainer, node => node.classList.contains('kanban-header-bar'));
    const context = findElement(kanbanContainer, node => node.id === 'project-context');
    assert.ok(header && context, 'Kanban header 應有 Project context');
    assert.ok(header.contains(context), 'Project context 應位於 header 內');
    assert.strictEqual(context['aria-live'], 'polite', 'Project context 應保留 polite live region');
    assert.strictEqual(context.textContent, '', '總覽時 Project context 應留空');
    const manageButton = findElement(kanbanContainer, node => node.id === 'manage-project-button');
    assert.strictEqual(manageButton?.hidden, true, '總覽時不應顯示「編輯」Project');

    const projectSelect = findElement(kanbanContainer, node => node.id === 'project-filter-select');
    assert.ok(projectSelect, 'Kanban 應顯示 Project filter');
    projectSelect.value = 'project-context-1';
    await projectSelect.eventListeners.change[0]();
    assert.ok(context.textContent.includes('Header context'), '選定 Project 後 context 應顯示描述');
    assert.strictEqual(manageButton.hidden, false, '選定 Project 後應顯示「編輯」Project');
    assert.ok(context.textContent.includes('/repos/placement'), '選定 Project 後 context 應顯示 repo');
    assert.strictEqual(context.title, context.textContent, '選定 Project 後 title 應與完整文字一致');
    bodyChildren.length = 0;
  }

  // 卡片 Project 標籤只在「所有專案」總覽顯示；選定單一 Project 時標題旁已有 Project 資訊。
  {
    const kanbanContainer = new MockElement('div');
    bodyChildren.length = 0;
    bodyChildren.push(kanbanContainer);
    sandbox.state.workspaceId = 'ws-card-badge';
    sandbox.state.userEmail = 'test@test.com';
    sandbox.sessionStorage.clear();
    sandbox.api = async (url: string) => {
      if (url === '/api/workspaces/ws-card-badge/tasks') return [{
        task_id: 'badge-task-1', workspace_id: 'ws-card-badge', project_id: 'badge-project-1', title: 'Badge task',
        description: '', status: 'Todo', priority: 'Medium', assignee_id: 'user-1', creator_id: 'user-1',
        due_at: null, updated_at: '2026-10-14T00:00:00.000Z',
      }];
      if (url === '/api/workspaces/ws-card-badge/projects') return [
        { project_id: 'badge-project-1', name: 'Badge Project', description: '', target_repo: null, status: 'active' },
      ];
      if (url === '/api/workspaces/ws-card-badge/members') return [{ user_id: 'user-1', email: 'test@test.com', role: 'Member' }];
      if (url === '/api/workspaces/ws-card-badge/goals' || url === '/api/workspaces/ws-card-badge/repositories') return [];
      throw new Error(`Unexpected Kanban badge API: ${url}`);
    };

    await KanbanView.render(kanbanContainer);
    await new Promise(resolve => setTimeout(resolve, 20));
    const todoColumn = () => mockDocument.getElementById('cards-Todo');
    const badgeOf = () => findElement(todoColumn(), node => node.classList.contains('badge-project'));
    assert.ok(findElement(todoColumn(), node => node.textContent === 'Badge task'), '總覽時應顯示卡片');
    assert.ok(badgeOf(), '總覽時卡片應顯示 Project 標籤');
    assert.strictEqual(badgeOf()?.textContent, 'Badge Project');

    const projectSelect = findElement(kanbanContainer, node => node.id === 'project-filter-select');
    assert.ok(projectSelect, 'Kanban 應顯示 Project filter');
    // MockElement 的 textContent 是一般欄位，renderKanbanCards 的 `textContent = ''` 清不掉子節點；真實 DOM 會清，這裡手動模擬
    todoColumn()!.childNodes.length = 0;
    projectSelect.value = 'badge-project-1';
    await projectSelect.eventListeners.change[0]();
    assert.ok(findElement(todoColumn(), node => node.textContent === 'Badge task'), '選定 Project 後卡片仍應顯示');
    assert.strictEqual(badgeOf(), null, '選定單一 Project 時卡片不應再顯示 Project 標籤');
    bodyChildren.length = 0;
  }

  // Keep broad view policy checks source-level; the modal behavior above owns the DOM harness.
  assert.match(stateSource, /ROLE_RANK[\s\S]*Commenter:\s*1[\s\S]*MAIN_WORKSPACE_ID[\s\S]*MAIN_OWNER_EMAIL[\s\S]*MAIN_POLICY_TITLE/);
  assert.match(stateSource, /MAIN_DISCUSSION_DESCRIPTION_TEMPLATE/);
  assert.match(kanbanSource, /main-workspace-policy/);
  assert.match(kanbanSource, /<dialog id="project-dialog"[\s\S]*project-target-repo[\s\S]*project-archive-selected/);
  assert.doesNotMatch(kanbanSource, /id="project-target-repo"\s+required/, 'Project target repo 必須選填');
  assert.match(kanbanSource, /不設定（此 Project 無法啟動 Goal）/);
  assert.match(kanbanSource, /docs\/operations\.md[\s\S]*Goal-driven collaboration[\s\S]*cachedRepos\.length/,
    '空 repo registry 必須顯示操作文件提示');
  assert.match(kanbanSource, /targetRepo:\s*document\.getElementById\(['"]project-target-repo['"]\)\.value\s*\|\|\s*null/,
    '建立或編輯未設定 repo 的 Project 必須送出 null');
  assert.doesNotMatch(kanbanSource, /prompt\(['"]請輸入新專案名稱/);
  assert.match(routesSource, /registerRoute\(['"]goals['"],[\s\S]*registerRoute\(['"]agents['"]/);
  assert.match(goalsSource, /successCriteria/);
  assert.match(goalsSource, /goal-data-scope/);
  assert.match(goalsSource, /method:\s*'PATCH'/);
  assert.match(goalsSource, /activity[\s\S]*participations[\s\S]*runs[\s\S]*contributions/);
  assert.match(goalsSource, /pause_requested[\s\S]*暫停請求已排定/);
  assert.match(goalsSource, /button\.onclick\s*=\s*async[\s\S]*try[\s\S]*showError\(['"]goal-error['"]/,
    'Goal action 錯誤必須顯示在 UI');
  assert.match(goalsSource, /goal\.status === ['"]Blocked['"][\s\S]*window\.prompt[\s\S]*changeDescription/,
    'Blocked 恢復必須要求人類輸入變更說明');
  assert.match(goalsSource, /rest\?\.\[0\][\s\S]*renderGoalDetail/, 'Goals route 必須支援獨立詳情頁');
  for (const field of ['participations', 'contributions', 'synthesis', 'tasks', 'runs', 'deliveryEvidence', 'parent_goal_id', 'childGoals']) {
    assert.match(goalsSource, new RegExp(field), `Goal 詳情必須顯示 ${field}`);
  }
  assert.match(goalsSource, /@Owner[\s\S]*\/comments/, 'Goal 詳情必須提供 @Owner 留言入口');
  assert.match(goalsSource, /changeDescription[\s\S]*successCriteria/, 'Goal 詳情必須保留 Blocked 恢復與成功條件修改');
  assert.match(readFileSync(join(__dirname, '../public/css/goals.css'), 'utf8'), /@media \(max-width: 768px\)[\s\S]*overflow-wrap:\s*anywhere/,
    'Goal 詳情行動版不得造成水平捲動');
  assert.match(agentsSource, /primary_adapter[\s\S]*fallback_adapter/);
  assert.match(agentsSource, /latest_preflight[\s\S]*latest_run[\s\S]*fallback_count[\s\S]*unknown_usage_count/,
    'Agents 頁必須顯示最近 preflight、Run、fallback 與未知 usage');
  assert.match(agentsSource, /hasRole\(role, ['"]Admin['"]\)/);
  assert.doesNotMatch(agentsSource, /user09@test\.local/, 'Agent 管理 UI 應依 RBAC，不可寫死 email');
  assert.match(kanbanSource, /canCreateTask[\s\S]*canManageTask/);
  assert.match(kanbanSource, /column-add-task-project[\s\S]*projectId:\s*projectSelect\.value\s*\|\|\s*null/,
    '建立 Task 表單必須明示 Project 並以選取值送出');
  assert.match(kanbanSource, /projectTasks[\s\S]*Done[\s\S]*進度：/,
    'Project context 必須顯示 Task 完成進度');
  assert.match(kanbanSource, /MAIN_POLICY_TITLE[\s\S]*\.sort\(/);
  assert.match(kanbanSource, /const\s+renderWorkspaceId\s*=\s*state\.workspaceId[\s\S]*let\s+loadGeneration\s*=\s*0[\s\S]*async\s+function\s+loadAllData\(\)\s*\{\s*if\s*\(state\.workspaceId\s*!==\s*renderWorkspaceId\)\s*return;[\s\S]*encodeURIComponent\(renderWorkspaceId\)[\s\S]*generation\s*!==\s*loadGeneration[\s\S]*state\.workspaceId\s*!==\s*renderWorkspaceId/);
  assert.match(kanbanSource, /hasRole\(currentRole,\s*['"]Member['"]\)[\s\S]*:\s*\{\s*title,\s*description\s*\}/);
  assert.match(kanbanSource, /MAIN_DISCUSSION_DESCRIPTION_TEMPLATE[\s\S]*column-add-task-description/);
  assert.doesNotMatch(kanbanSource, /\$\{isMainWorkspace \? '' : `[\s\S]*?col-doing/);
  assert.match(kanbanSource, /<div class="kanban-column col-doing">[\s\S]*?<div class="kanban-column col-review">/);
  assert.doesNotMatch(kanbanSource, /main-discussion-board/);
  assert.doesNotMatch(kanbanCssSource, /\.kanban-board\.main-discussion-board/);
  assert.match(taskDetailCssSource, /\.comment-actions\s*\{[\s\S]*?flex-direction:\s*row-reverse/);
  assert.match(taskDetailCssSource, /@media \(max-width: 768px\)[\s\S]*?\.comment-actions\s*\{[\s\S]*?flex-direction:\s*column/);
  assert.match(kanbanSource, /isMainWorkspace[\s\S]*status === ['"]Todo['"][\s\S]*createStateBtn\(['"]→ Done['"], ['"]Done['"]\)/);
  assert.doesNotMatch(`${kanbanSource}\n${taskDetailSource}`, /deadline|overdue|absence|reply tracker|等待天數選擇器/iu);
  assert.match(membersSource, /hasRole[\s\S]*MAIN_WORKSPACE_ID[\s\S]*canManageMembers/);
  assert.match(membersSource, /const\s+renderWorkspaceId\s*=\s*state\.workspaceId[\s\S]*let\s+loadGeneration\s*=\s*0[\s\S]*async\s+function\s+load\(\)\s*\{\s*if\s*\(state\.workspaceId\s*!==\s*renderWorkspaceId\)\s*return;[\s\S]*encodeURIComponent\(renderWorkspaceId\)[\s\S]*generation\s*!==\s*loadGeneration[\s\S]*state\.workspaceId\s*!==\s*renderWorkspaceId/);
  assert.match(membersSource, /const\s+searchGeneration\s*=\s*loadGeneration[\s\S]*setTimeout\(async\s*\(\)\s*=>\s*\{\s*if\s*\(!canManageMembers\s*\|\|\s*state\.workspaceId\s*!==\s*renderWorkspaceId\s*\|\|\s*searchGeneration\s*!==\s*loadGeneration\)\s*return;[\s\S]*await\s+api\([\s\S]*if\s*\(!canManageMembers\s*\|\|\s*state\.workspaceId\s*!==\s*renderWorkspaceId\s*\|\|\s*searchGeneration\s*!==\s*loadGeneration\)\s*return;[\s\S]*suggestionsDatalist\.innerHTML/);
  // Test 9: KanbanView filter state persistence
  {
    const kanbanContainer = new MockElement('div');
    bodyChildren.push(kanbanContainer);

    // Setup API mock for Kanban data load
    sandbox.api = async (url: string) => {
      if (url.includes('/tasks')) {
        return [{ task_id: 'task-1', title: 'Task 1', status: 'Todo', priority: 'Medium' }];
      }
      if (url.includes('/projects')) {
        return [{ project_id: 'proj-1', name: 'Project 1' }];
      }
      if (url.includes('/members')) {
        return [{ user_id: 'user-1', email: 'test@test.com', role: 'Member' }];
      }
      return [];
    };

    // Preset filter states in sessionStorage for workspace 'ws-test-1'
    sandbox.sessionStorage.clear();
    sandbox.sessionStorage.setItem('kanban_filter_project_ws-test-1', 'proj-1');
    sandbox.sessionStorage.setItem('kanban_filter_show_archived_ws-test-1', 'true');

    // Render KanbanView for workspace 'ws-test-1'
    sandbox.state.workspaceId = 'ws-test-1';
    await KanbanView.render(kanbanContainer);

    // Verify checked state and selector values are loaded from sessionStorage
    const projectSelect = findElement(kanbanContainer, (el) => el.id === 'project-filter-select');
    const toggleArchived = findElement(kanbanContainer, (el) => el.id === 'toggle-archived-checkbox');
    assert.ok(projectSelect, 'Project select should be rendered');
    assert.ok(toggleArchived, 'Toggle archived checkbox should be rendered');
    assert.strictEqual(toggleArchived.checked, true, 'Archived toggle checkbox should be checked from sessionStorage');

    // Trigger api/data loading to check that select dropdown value is restored
    // wait for loadAllData async tasks inside render
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(projectSelect.value, 'proj-1', 'Project select value should be proj-1 from sessionStorage');

    // Trigger select value change and verify it is saved in sessionStorage
    projectSelect.value = 'none';
    const selectChangeHandlers = projectSelect.eventListeners['change'];
    assert.ok(selectChangeHandlers && selectChangeHandlers.length > 0, 'Project select should have change listener');
    await selectChangeHandlers[0]();
    assert.strictEqual(sandbox.sessionStorage.getItem('kanban_filter_project_ws-test-1'), 'none', 'sessionStorage should be updated to none');

    // Trigger checkbox state change and verify it is saved in sessionStorage
    toggleArchived.checked = false;
    const checkboxChangeHandlers = toggleArchived.eventListeners['change'];
    assert.ok(checkboxChangeHandlers && checkboxChangeHandlers.length > 0, 'Toggle archived checkbox should have change listener');
    checkboxChangeHandlers[0]();
    assert.strictEqual(sandbox.sessionStorage.getItem('kanban_filter_show_archived_ws-test-1'), 'false', 'sessionStorage show_archived should be updated to false');

    // Clean up first container from bodyChildren before testing the next workspace
    const idx1 = bodyChildren.indexOf(kanbanContainer);
    if (idx1 !== -1) bodyChildren.splice(idx1, 1);

    // Render for a different workspace and ensure filters are defaulted/isolated
    sandbox.state.workspaceId = 'ws-test-2';
    const kanbanContainer2 = new MockElement('div');
    bodyChildren.push(kanbanContainer2);
    await KanbanView.render(kanbanContainer2);

    const projectSelect2 = findElement(kanbanContainer2, (el) => el.id === 'project-filter-select');
    const toggleArchived2 = findElement(kanbanContainer2, (el) => el.id === 'toggle-archived-checkbox');
    assert.ok(projectSelect2 && toggleArchived2);
    assert.strictEqual(toggleArchived2.checked, false, 'New workspace should default archived toggle to false');

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(projectSelect2.value, 'all', 'New workspace should default project filter to all');

    // Cleanup from bodyChildren
    const idx2 = bodyChildren.indexOf(kanbanContainer2);
    if (idx2 !== -1) bodyChildren.splice(idx2, 1);
  }

  // Test 10: WorkspacesView data-short-id rendering
  {
    const wsContainer = new MockElement('div');
    bodyChildren.push(wsContainer);

    sandbox.api = async (url: string) => {
      if (url === '/api/workspaces') {
        return [
          { workspace_id: '11111111-2222-3333-4444-555555555555', name: 'WS 1', status: 'Active' },
          { workspace_id: '88888888-9999-0000-1111-222222222222', name: 'WS 2', status: 'Archived' }
        ];
      }
      return [];
    };

    await WorkspacesView.render(wsContainer);

    // Wait for the async load() inside render
    await new Promise(resolve => setTimeout(resolve, 50));

    const wsListContainer = findElement(wsContainer, (el) => el.id === 'ws-list-container');
    assert.ok(wsListContainer, 'ws-list-container should be rendered');

    // Retrieve all workspace cards
    const cards: MockElement[] = [];
    const collectCards = (node: MockElement) => {
      if (node.classList && node.classList.contains('workspace-card')) {
        cards.push(node);
      }
      for (const child of node.childNodes) {
        collectCards(child);
      }
    };
    collectCards(wsListContainer);

    assert.strictEqual(cards.length, 1, 'Archived workspace should be hidden by default');
    assert.strictEqual(cards[0]['data-short-id'], '::11111111', 'First workspace card should have short ID ::11111111');

    // Test clicking the ID pseudo-element to open popup
    cards[0].getBoundingClientRect = () => ({
      left: 100,
      top: 100,
      width: 200,
      height: 200
    } as any);

    let copiedText = '';
    sandbox.navigator.clipboard.writeText = async (text: string) => {
      copiedText = text;
    };

    let navigatedHash = '';
    sandbox.navigate = (hash?: string) => {
      navigatedHash = hash || '';
    };

    // Trigger click on the pseudo-element area (e.g. left + 50, top + 15)
    const clickEvent = {
      clientX: 150,
      clientY: 115,
      pageX: 150,
      pageY: 115,
      stopPropagation: () => {},
      preventDefault: () => {}
    };

    const clickHandlers = cards[0].eventListeners['click'];
    assert.ok(clickHandlers && clickHandlers.length > 0, 'Card should have a click event handler');
    clickHandlers[0](clickEvent);

    // Verify popup is appended
    const popup = bodyChildren.find(el => el.id === 'task-action-popup');
    assert.ok(popup, 'Action popup should be created');

    const openBtn = findElement(popup, (el) => el.tag === 'button' && el.textContent === '開啟');
    const shareBtn = findElement(popup, (el) => el.tag === 'button' && el.textContent === '分享');
    const copyIdBtn = findElement(popup, (el) => el.tag === 'button' && el.textContent === '複製 id');
    assert.ok(openBtn && shareBtn && copyIdBtn, 'Should have 開啟, 分享, and 複製 id buttons');

    // Click "開啟"
    openBtn.onclick!({} as any);
    assert.strictEqual(sandbox.state.workspaceId, '11111111-2222-3333-4444-555555555555', 'Workspace ID should be selected');
    assert.strictEqual(navigatedHash, '#/tasks', 'Should navigate to tasks page');

    // Re-trigger click to test "分享"
    clickHandlers[0](clickEvent);
    const popup2 = bodyChildren.find(el => el.id === 'task-action-popup');
    assert.ok(popup2);
    const shareBtn2 = findElement(popup2, (el) => el.tag === 'button' && el.textContent === '分享');
    assert.ok(shareBtn2);
    await shareBtn2.onclick!({} as any);
    assert.ok(copiedText.includes('#/workspaces'), 'Share URL should point to workspaces view');

    // Re-trigger click to test "複製 id"
    clickHandlers[0](clickEvent);
    const popup3 = bodyChildren.find(el => el.id === 'task-action-popup');
    assert.ok(popup3);
    const copyIdBtn2 = findElement(popup3, (el) => el.tag === 'button' && el.textContent === '複製 id');
    assert.ok(copyIdBtn2);
    await copyIdBtn2.onclick!({} as any);
    assert.strictEqual(copiedText, '11111111-2222-3333-4444-555555555555', 'Should copy the exact workspace ID');

    // Cleanup from bodyChildren
    const idx = bodyChildren.indexOf(wsContainer);
    if (idx !== -1) bodyChildren.splice(idx, 1);
  }

  // Test 11: Goal-only notifications resolve and select the Goal workspace before navigation.
  {
    const notification = {
      notification_id: 'notif-goal-1',
      source_goal_id: 'goal-b',
      source_task_id: null,
      source_comment_id: null,
      snippet: 'Goal B updated',
      created_at: '2026-10-14T00:00:00.000Z',
      read_at: null
    };
    const notificationContainer = new MockElement('div');
    bodyChildren.push(notificationContainer);
    sandbox.state.workspaceId = 'workspace-a';
    sandbox.state.workspaceName = 'Workspace A';
    sandbox.state.globalWorkspaces = [
      { workspace_id: 'workspace-a', name: 'Workspace A' },
      { workspace_id: 'workspace-b', name: 'Workspace B' }
    ];
    const calls: Array<{ url: string; method?: string }> = [];
    let navigatedHash = '';
    sandbox.navigate = (hash?: string) => { navigatedHash = hash || ''; };
    sandbox.api = async (url: string, options?: { method?: string }) => {
      calls.push({ url, method: options?.method });
      if (url.startsWith('/api/notifications?')) {
        return { items: [notification], page: 1, pageSize: 15, totalCount: 1, totalPages: 1, unreadTotal: 1 };
      }
      if (url === '/api/goals/goal-b') return { goal_id: 'goal-b', workspace_id: 'workspace-b' };
      if (url === '/api/notifications/notif-goal-1/read') return null;
      throw new Error(`unexpected API call: ${url}`);
    };

    await NotificationsView.render(notificationContainer);
    const card = mockDocument.getElementById('notif-card-notif-goal-1');
    const body = card?.querySelector('.notif-body');
    assert.ok(body?.onclick, 'Goal 通知卡片應可點擊');
    await body.onclick();

    assert.strictEqual(sandbox.state.workspaceId, 'workspace-b', '點開 Goal 通知應切到 Goal 所屬 Workspace');
    assert.strictEqual(sandbox.state.workspaceName, 'Workspace B');
    assert.strictEqual(navigatedHash, '#/goals/goal-b');
    assert.ok(calls.some(call => call.url === '/api/notifications/notif-goal-1/read' && call.method === 'POST'), '通知應標為已讀');

    const idx = bodyChildren.indexOf(notificationContainer);
    if (idx !== -1) bodyChildren.splice(idx, 1);
  }

  // Test 12: A missing Goal keeps its notification card and does not navigate.
  {
    const notification = {
      notification_id: 'notif-goal-missing',
      source_goal_id: 'goal-missing',
      source_task_id: null,
      source_comment_id: null,
      snippet: 'Missing Goal',
      created_at: '2026-10-14T00:00:00.000Z',
      read_at: null
    };
    const notificationContainer = new MockElement('div');
    bodyChildren.push(notificationContainer);
    sandbox.state.workspaceId = 'workspace-a';
    let navigatedHash = '';
    sandbox.navigate = (hash?: string) => { navigatedHash = hash || ''; };
    sandbox.api = async (url: string) => {
      if (url.startsWith('/api/notifications?')) {
        return { items: [notification], page: 1, pageSize: 15, totalCount: 1, totalPages: 1, unreadTotal: 1 };
      }
      if (url === '/api/goals/goal-missing') throw new Error('goal 不存在');
      throw new Error(`unexpected API call: ${url}`);
    };

    await NotificationsView.render(notificationContainer);
    const card = mockDocument.getElementById('notif-card-notif-goal-missing');
    const body = card?.querySelector('.notif-body');
    assert.ok(body?.onclick, 'Goal 通知卡片應可點擊');
    await body.onclick();

    assert.strictEqual(navigatedHash, '', 'Goal API 回 404 時不應導頁');
    assert.strictEqual(mockDocument.getElementById('notif-card-notif-goal-missing'), card, 'Goal API 回 404 時通知卡片應保留');
    const error = card?.querySelector('.notif-error');
    assert.strictEqual(error?.style.display, 'block', 'Goal API 回 404 時應顯示原因');
    assert.ok(error?.textContent, 'Goal API 回 404 時應顯示非空白原因');

    const idx = bodyChildren.indexOf(notificationContainer);
    if (idx !== -1) bodyChildren.splice(idx, 1);
  }

  console.log('frontend.test.ts OK');
}

runTests().catch(err => {
  console.error('frontend.test.ts FAILED:', err);
  process.exit(1);
});
