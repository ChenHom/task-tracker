import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// 1. Define mock elements and event registry
const listeners: { [event: string]: Function[] } = {};
const windowListeners: { [event: string]: Function[] } = {};

class MockElement {
  id: string;
  className: string;
  style: any = {};
  childNodes: MockElement[] = [];
  onclick: Function | null = null;
  textContent: string = '';
  value: string = '';
  cleanup: Function | null = null;

  constructor(tag: string, attrs: any = {}) {
    this.id = attrs.id || '';
    this.className = attrs.class || '';
    if (attrs.value !== undefined) {
      this.value = attrs.value;
    }
  }

  appendChild(child: MockElement) {
    this.childNodes.push(child);
  }

  remove() {
    if (this.cleanup) this.cleanup();
  }

  addEventListener() {}
  removeEventListener() {}
  addEventListenerOnce() {}
  classList = {
    add: () => {},
    remove: () => {}
  };
}

const mockDocument: any = {
  listeners: listeners,
  body: {
    appendChild: () => {}
  },
  getElementById: (id: string) => {
    if (id === 'task-detail-modal') {
      const el = new MockElement('div', { id: 'task-detail-modal' });
      el.cleanup = () => {
        // Trigger document cleanup removal of keydown listener
        if (mockDocument.listeners['keydown']) {
          mockDocument.listeners['keydown'] = [];
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

const mockLocation: any = {
  hash: '#/task/task-1'
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
  el: (tag: string, attrs: any = {}) => {
    return new MockElement(tag, attrs);
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

async function runTests() {
  // Test 1: Opening modal should register keydown listener
  listeners['keydown'] = [];
  windowListeners['hashchange'] = [];
  mockLocation.hash = '#/task/task-1';

  await openTaskDetailModal('task-1', {
    cachedTasks: [{ task_id: 'task-1', title: 'Test Task', description: 'Test Desc', status: 'todo' }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {}
  });

  assert.ok(listeners['keydown'] && listeners['keydown'].length === 1, 'Should register keydown listener');
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
  mockLocation.hash = '#/task/task-1';
  
  // We mock document.getElementById to return a mock modal with cleanup
  await openTaskDetailModal('task-1', {
    cachedTasks: [{ task_id: 'task-1', title: 'Test Task', description: 'Test Desc', status: 'todo' }],
    cachedMembers: [],
    memberMap: new Map(),
    memberEmailMap: new Map(),
    onUpdate: async () => {}
  });

  // After opening, listeners['keydown'] should be cleaned up and set to exactly the new listener (length 1)
  assert.strictEqual(listeners['keydown'].length, 1, 'Duplicate open should cleanup previous keydown listeners');

  console.log('frontend.test.ts OK');
}

runTests().catch(err => {
  console.error('frontend.test.ts FAILED:', err);
  process.exit(1);
});
