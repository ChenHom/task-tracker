import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// 1. Define mock elements and event registry
const listeners: { [event: string]: Function[] } = {};
const windowListeners: { [event: string]: Function[] } = {};
const bodyChildren: MockElement[] = [];

class MockElement {
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

// 3. Create sandbox
const sandbox = {
  document: mockDocument,
  window: mockWindow,
  location: mockLocation,
  alert: () => {},
  console: console,
  api: async () => [],
  state: {
    user: { email: 'test@test.com' }
  },
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
  loadStyle: () => {},
  unloadStyle: () => {},
  Promise: Promise,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  globalThis: {} as any
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const openTaskDetailModal = sandbox.globalThis.openTaskDetailModal;

function findElement(el: MockElement, predicate: (element: MockElement) => boolean): MockElement | null {
  if (predicate(el)) return el;
  for (const child of el.childNodes) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

async function runTests() {
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

  console.log('frontend.test.ts OK');
}

runTests().catch(err => {
  console.error('frontend.test.ts FAILED:', err);
  process.exit(1);
});
