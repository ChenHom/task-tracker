'use strict';

/**
 * @fileoverview 桌面版全域 #/tasks 頁的階層式 Escape 返回。
 * 判斷邏輯抽成純函式，方便不靠真實 DOM 測試。
 */

/**
 * 任一命中即代表畫面上有可關閉的介面（modal / drawer / menu / dropdown）。
 * 這次 Escape 交給該介面自己關，同一個事件不得接續導頁。
 * @type {string}
 */
export const OVERLAY_SELECTOR =
  '.modal-overlay, .task-action-popup, .mention-suggestions-box, #sidebar.open';

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
 * 這次按鍵是否該從全域 tasks 頁返回工作區列表。
 * @param {Object} input - 按鍵當下的狀態快照。
 * @param {string} input.key - KeyboardEvent.key。
 * @param {boolean} [input.isComposing] - IME 是否正在組字。
 * @param {string} input.hash - location.hash 完整值。
 * @param {boolean} [input.overlayOpen] - 按鍵開始時是否已有可關閉介面。
 * @param {boolean} [input.editable] - 焦點是否在編輯元素。
 * @returns {boolean} true 表示應導向 #/workspaces。
 */
export function shouldEscBack({ key, isComposing, hash, overlayOpen, editable }) {
  if (key !== 'Escape') return false;
  if (isComposing || overlayOpen || editable) return false;
  // 完整 hash 精確比對：#/task/:id（工作區任務 modal）沿用它自己的 Esc 返回行為，不走這裡
  return hash === '#/tasks' || hash === '#/tasks/';
}
