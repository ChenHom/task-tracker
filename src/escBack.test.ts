import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// public/js/escBack.js 是瀏覽器 ESM，用 vm 載入純函式部分（同 frontendCore.test.ts 作法）
const sandbox: any = { console };
vm.createContext(sandbox);
let code = readFileSync(join(__dirname, '../public/js/escBack.js'), 'utf8').replace(/\bexport\s+/g, '');
code += '\nglobalThis.shouldEscBack = shouldEscBack; globalThis.isEditableTarget = isEditableTarget;';
vm.runInContext(code, sandbox);
const shouldEscBack = sandbox.shouldEscBack as (i: Record<string, unknown>) => boolean;
const isEditableTarget = sandbox.isEditableTarget as (t: unknown) => boolean;

const base = { key: 'Escape', isComposing: false, hash: '#/tasks', overlayOpen: false, editable: false };

// ── 全域 tasks 頁、無遮罩、非編輯：返回 ──
assert.ok(shouldEscBack(base), '#/tasks 無遮罩非編輯時應返回');
assert.ok(shouldEscBack({ ...base, hash: '#/tasks/' }), '尾斜線也算全域 tasks');

// ── 其他頁面不導頁（完整 hash 精確比對）──
assert.ok(!shouldEscBack({ ...base, hash: '#/task/abc-123' }), '任務 modal 路由沿用既有行為');
assert.ok(!shouldEscBack({ ...base, hash: '#/tasks/ws-1' }), '工作區 tasks 不走全域 handler');
assert.ok(!shouldEscBack({ ...base, hash: '#/workspaces' }), '工作區列表頁不導頁');
assert.ok(!shouldEscBack({ ...base, hash: '#/search' }), '其他頁面行為不變');

// ── 只關最上層介面，同一次事件不接續導頁 ──
assert.ok(!shouldEscBack({ ...base, overlayOpen: true }), '已有 modal/drawer/menu/dropdown 時不導頁');

// ── 編輯與 IME 組字不導頁 ──
assert.ok(!shouldEscBack({ ...base, editable: true }), '焦點在編輯元素時不導頁');
assert.ok(!shouldEscBack({ ...base, isComposing: true }), 'IME 組字中不導頁');

// ── 非 Escape 一律不動 ──
assert.ok(!shouldEscBack({ ...base, key: 'Enter' }), '非 Escape 不導頁');

// ── isEditableTarget ──
for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
  assert.ok(isEditableTarget({ tagName: tag }), `${tag} 應視為編輯中`);
}
assert.ok(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), 'contenteditable 應視為編輯中');
assert.ok(!isEditableTarget({ tagName: 'DIV' }), '一般 DIV 不算編輯中');
assert.ok(!isEditableTarget(null), 'null 焦點不算編輯中');

console.log('escBack.test.ts OK');
