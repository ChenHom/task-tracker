'use strict';

/**
 * @fileoverview 桌面版全域 #/tasks 頁的階層式 Escape 返回。
 * 判斷邏輯抽成純函式，方便不靠真實 DOM 測試。
 */

/**
 * modal / menu / dropdown：這些介面各自有 Escape 關閉邏輯，Escape 交給它們處理。
 * @type {string}
 */
export const OVERLAY_SELECTOR = '.modal-overlay, .task-action-popup, .mention-suggestions-box';

/**
 * 手機側欄抽屜。它沒有自己的 Escape 關閉邏輯，只把它當遮罩擋住導頁會讓 Escape 變成死鍵，
 * 所以要由這裡負責關。
 * @type {string}
 */
export const DRAWER_SELECTOR = '#sidebar.open';

/**
 * 焦點是否落在編輯中的元素（含搜尋欄，它就是 input）。
 * @param {{tagName?: string, isContentEditable?: boolean}|null|undefined} target - 目前焦點元素。
 * @returns {boolean} 是否處於編輯狀態。
 */
export function isEditableTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * 完整 hash 精確比對全域 tasks 頁。#/task/:id（任務 modal）與 #/tasks/:wsId 都不算。
 * @param {string} hash - location.hash 完整值。
 * @returns {boolean}
 */
function isGlobalTasksRoute(hash) {
  return hash === '#/tasks' || hash === '#/tasks/';
}

/**
 * 這次按鍵在全域 tasks 頁該做什麼。階層式：最上層的介面先關，都沒有才返回工作區列表。
 * @param {Object} input - 按鍵當下的狀態快照。
 * @param {string} input.key - KeyboardEvent.key。
 * @param {boolean} [input.isComposing] - IME 是否正在組字。
 * @param {string} input.hash - location.hash 完整值。
 * @param {boolean} [input.overlayOpen] - 按鍵開始時是否有 modal／menu／dropdown。
 * @param {boolean} [input.drawerOpen] - 按鍵開始時手機側欄抽屜是否開著。
 * @param {boolean} [input.editable] - 焦點是否在編輯元素。
 * @returns {'none'|'close-drawer'|'back'} none = 不介入；close-drawer = 只關側欄；back = 導向 #/workspaces。
 */
export function escAction({ key, isComposing, hash, overlayOpen, drawerOpen, editable }) {
  if (key !== 'Escape') return 'none';
  if (isComposing || editable) return 'none';
  // 其他頁面（含 #/task/:id 的任務 modal）行為完全不變，一律不介入
  if (!isGlobalTasksRoute(hash)) return 'none';
  if (overlayOpen) return 'none';
  if (drawerOpen) return 'close-drawer';
  return 'back';
}
