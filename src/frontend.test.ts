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
    return null;
  },
  createDocumentFragment: () => new MockElement('#fragment'),
  createTextNode: (text: string) => {
    const node = new MockElement('#text');
    node.textContent = text;
    return node;
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
  }
};

let currentHash = '#/task/task-1';
const mockLocation: any = {
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

// 2. Read and transform public/js/views/task-detail.js
let code = readFileSync(join(__dirname, '../public/js/views/task-detail.js'), 'utf8');

// Replace imports with stubs
code = code.replace(/import\s+[\s\S]*?\s+from\s+['"].*?['"];?/g, '');

// Convert export to globalThis mapping
code = code.replace(/export\s+async\s+function\s+openTaskDetailModal/g, 'globalThis.openTaskDetailModal = async function openTaskDetailModal');
code = code.replace(/export\s+function\s+safeHttpUrl/g, 'function safeHttpUrl');
code += '\nglobalThis.safeHttpUrl = typeof safeHttpUrl === "function" ? safeHttpUrl : undefined;';
code += '\nglobalThis.renderRichText = typeof renderRichText === "function" ? renderRichText : undefined;';

// 3. Create sandbox
const sandbox = {
  document: mockDocument,
  window: mockWindow,
  location: mockLocation,
  alert: (msg?: any) => {},
  console: console,
  Event,
  URL,
  api: (async () => []) as (...args: any[]) => Promise<any>,
  state: {
    userEmail: 'test@test.com',
    clear: () => {}
  },
  hasRole: (role: string, minimum: string) => {
    const ranks: Record<string, number> = { Viewer: 0, Commenter: 1, Member: 2, Admin: 3, Owner: 4 };
    return ranks[role] >= ranks[minimum];
  },
  MAIN_OWNER_EMAIL: 'user01@test.local',
  MAIN_POLICY_TITLE: '[規則] 主工作區協作與交接',
  navigate: () => {},
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
  showError: () => {},
  formatTime: () => '',
  Promise: Promise,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  globalThis: {} as any
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const openTaskDetailModal = sandbox.globalThis.openTaskDetailModal;
const safeHttpUrl = sandbox.globalThis.safeHttpUrl;
const renderRichText = sandbox.globalThis.renderRichText;

const localPartMention = renderRichText('@user02', [{
  user_id: 'user-02',
  name: '小美',
  email: 'user02@test.local'
}], [], []);
assert.strictEqual(localPartMention.childNodes.length, 1, 'email local-part mention should render as one element');
assert.strictEqual(localPartMention.childNodes[0].className, 'rich-mention', 'email local-part mention should use mention styling');
assert.strictEqual(localPartMention.childNodes[0].textContent, '@小美', 'email local-part mention should display the member name');

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

  // Wait 400ms more (total 500ms). Promise.all (400ms) has resolved, hideUnsavedBadge() has run and is waiting for its 400ms delay.
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.strictEqual(unsavedBadge.textContent, '等待', 'Badge text should still be "等待" while hide animation is running');

  // Wait 450ms more (total 950ms). The hide delay (400ms) has resolved, text changed to '完成', showUnsavedBadge() has run.
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.strictEqual(unsavedBadge.textContent, '完成', 'Badge text should update to "完成" after hide transition');

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
  assert.ok(findElement(commenterOverlay, (node) => node.tag === 'button' && node.textContent === '刪除'), 'Commenter should delete their own comment');
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
  assert.strictEqual(findElement(mainMemberOverlay, (node) => node.tag === 'input'), null, 'Main Member should not upload attachments');

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

  // Keep broad view policy checks source-level; the modal behavior above owns the DOM harness.
  assert.match(stateSource, /ROLE_RANK[\s\S]*Commenter:\s*1[\s\S]*MAIN_WORKSPACE_ID[\s\S]*MAIN_OWNER_EMAIL[\s\S]*MAIN_POLICY_TITLE/);
  assert.match(stateSource, /MAIN_DISCUSSION_DESCRIPTION_TEMPLATE/);
  assert.match(kanbanSource, /main-workspace-policy/);
  assert.match(kanbanSource, /canCreateTask[\s\S]*canManageTask/);
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
  assert.match(taskDetailSource, /rich-url-link[\s\S]*rel:\s*['"]noopener noreferrer['"]/);

  console.log('frontend.test.ts OK');
}

runTests().catch(err => {
  console.error('frontend.test.ts FAILED:', err);
  process.exit(1);
});
