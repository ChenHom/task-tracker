import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// public/js/escBack.js 是瀏覽器 ESM，用 vm 載入純函式部分（同 frontendCore.test.ts 作法）
const sandbox: any = { console };
vm.createContext(sandbox);
let code = readFileSync(join(__dirname, '../public/js/escBack.js'), 'utf8').replace(/\bexport\s+/g, '');
code += '\nglobalThis.escAction = escAction; globalThis.isEditableTarget = isEditableTarget;'
  + '\nglobalThis.OVERLAY_SELECTOR = OVERLAY_SELECTOR; globalThis.DRAWER_SELECTOR = DRAWER_SELECTOR;';
vm.runInContext(code, sandbox);
const escAction = sandbox.escAction as (i: Record<string, unknown>) => string;
const isEditableTarget = sandbox.isEditableTarget as (t: unknown) => boolean;

const base = { key: 'Escape', isComposing: false, hash: '#/tasks', overlayOpen: false, drawerOpen: false, editable: false };

// ── 全域 tasks 頁、無任何介面、非編輯：返回工作區列表 ──
assert.strictEqual(escAction(base), 'back', '#/tasks 無遮罩非編輯時應返回');
assert.strictEqual(escAction({ ...base, hash: '#/tasks/' }), 'back', '尾斜線也算全域 tasks');

// ── 其他頁面完全不介入（完整 hash 精確比對）──
for (const hash of ['#/task/abc-123', '#/tasks/ws-1', '#/workspaces', '#/search', '#/notifications']) {
  assert.strictEqual(escAction({ ...base, hash }), 'none', `${hash} 不得被全域 handler 介入`);
  // 其他頁面即使側欄開著也不介入：那是第一版刻意不擴大的範圍
  assert.strictEqual(escAction({ ...base, hash, drawerOpen: true }), 'none', `${hash} 開著側欄也不得介入`);
}

// ── modal / menu / dropdown 自己會關，讓給它們，同一次事件不接續導頁 ──
assert.strictEqual(escAction({ ...base, overlayOpen: true }), 'none', '有 modal/menu/dropdown 時不介入');
assert.strictEqual(
  escAction({ ...base, overlayOpen: true, drawerOpen: true }),
  'none',
  'modal 疊在側欄之上時，先讓 modal 自己關，不得越過它去關側欄',
);

// ── 側欄抽屜沒有自己的 Escape 邏輯，必須由這裡關掉，而不是只擋住導頁 ──
assert.strictEqual(escAction({ ...base, drawerOpen: true }), 'close-drawer', '側欄開著時 Escape 應關側欄');
assert.strictEqual(escAction({ ...base, drawerOpen: false }), 'back', '側欄關上後同一路徑才返回');

// ── 編輯與 IME 組字一律不介入（側欄開著也一樣）──
assert.strictEqual(escAction({ ...base, editable: true }), 'none', '焦點在編輯元素時不介入');
assert.strictEqual(escAction({ ...base, isComposing: true }), 'none', 'IME 組字中不介入');
assert.strictEqual(escAction({ ...base, editable: true, drawerOpen: true }), 'none', '編輯中不得順手關側欄');
assert.strictEqual(escAction({ ...base, isComposing: true, drawerOpen: true }), 'none', 'IME 組字中不得順手關側欄');

// ── 非 Escape 一律不動 ──
for (const key of ['Enter', 'Tab', 'a', 'ArrowLeft']) {
  assert.strictEqual(escAction({ ...base, key }), 'none', `${key} 不得觸發任何行為`);
}

// ── 選擇器分工：側欄不能留在 overlay 選擇器裡，否則又會被當成「別人會關」而變死鍵 ──
assert.ok(!String(sandbox.OVERLAY_SELECTOR).includes('#sidebar'), '側欄不得混在 OVERLAY_SELECTOR，它沒有自己的 Escape 邏輯');
assert.ok(String(sandbox.DRAWER_SELECTOR).includes('#sidebar'), 'DRAWER_SELECTOR 應指向側欄');
for (const sel of ['.modal-overlay', '.task-action-popup', '.mention-suggestions-box']) {
  assert.ok(String(sandbox.OVERLAY_SELECTOR).includes(sel), `OVERLAY_SELECTOR 應涵蓋 ${sel}`);
}

// ── isEditableTarget ──
for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
  assert.ok(isEditableTarget({ tagName: tag }), `${tag} 應視為編輯中`);
}
assert.ok(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), 'contenteditable 應視為編輯中');
assert.ok(!isEditableTarget({ tagName: 'DIV' }), '一般 DIV 不算編輯中');
assert.ok(!isEditableTarget(null), 'null 焦點不算編輯中');

console.log('escBack.test.ts OK');
