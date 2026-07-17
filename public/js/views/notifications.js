'use strict';

/**
 * @fileoverview @mention 通知中心視圖，以及桌機 sidebar／手機漢堡共用的未讀 badge 邏輯。
 * 依 docs/frontend/mentions-and-notifications.md 的 API 契約實作。
 */

import { api } from '../api.js';
import { state } from '../state.js';
import { el, formatTime } from '../utils.js';
import { navigate } from '../router.js';
import { syncGlobalWorkspaces } from '../sidebar.js';

// 後端 GET /api/tasks/:id 在無權限／不存在時回傳的原始錯誤字串，轉成通知卡片上的友善說明。
const FRIENDLY_SOURCE_ERROR = {
  '權限不足': '你目前沒有查看此來源的權限',
  'task 不存在': '來源已不存在'
};

let cached = [];
let pollTimer = null;
let mounted = false;

function unreadCount() {
  return cached.filter(n => n.read_at === null).length;
}

/**
 * 更新頁面上所有 .notif-badge 節點（桌機 sidebar + 手機漢堡鈕共用同一份資料）。
 * @returns {void}
 */
function renderBadges() {
  const count = unreadCount();
  document.querySelectorAll('.notif-badge').forEach(badgeEl => {
    if (count > 0) {
      badgeEl.textContent = count > 99 ? '99+' : String(count);
      badgeEl.style.display = 'inline-flex';
    } else {
      badgeEl.style.display = 'none';
    }
  });
}

/**
 * 重抓通知清單並同步 badge／（若通知頁在前景）清單畫面。
 * 供登入、頁籤切回前景、標記已讀後、以及通知頁輪詢共用呼叫。
 * @returns {Promise<void>}
 */
export async function refreshNotificationBadge() {
  if (!state.userEmail) {
    cached = [];
    renderBadges();
    return;
  }
  try {
    cached = await api('/api/notifications');
  } catch {
    // 拉取失敗不影響其他頁面，維持既有快取數字
  }
  renderBadges();
  if (mounted) renderList();
}

/**
 * 離開通知頁時停止 60 秒輪詢，避免背景持續打 API。
 * @returns {void}
 */
export function stopNotificationPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  mounted = false;
}

async function markRead(notificationId) {
  // 先做本地樂觀更新，讓 badge／清單立即反應
  cached = cached.map(n => (n.notification_id === notificationId && n.read_at === null)
    ? { ...n, read_at: new Date().toISOString() }
    : n);
  renderBadges();
  if (mounted) renderList();
  try {
    await api(`/api/notifications/${notificationId}/read`, { method: 'POST' });
  } catch {
    // 忽略：下面的背景重抓會校正
  }
  await refreshNotificationBadge();
}

function showSourceError(notificationId, message) {
  const box = document.querySelector(`#notif-card-${notificationId} .notif-error`);
  if (box) {
    box.textContent = message;
    box.style.display = 'block';
  }
}

/**
 * 點擊通知卡片：先確認來源 task 可讀取並解析所屬工作區，成功才導向並定位留言；
 * 403/404 時保留卡片、顯示友善原因，不導頁，避免未讀 badge 卡死。
 * @param {Object} n - 通知物件。
 * @returns {Promise<void>}
 */
async function openNotification(n) {
  let task;
  try {
    task = await api(`/api/tasks/${n.source_task_id}`);
  } catch (err) {
    showSourceError(n.notification_id, FRIENDLY_SOURCE_ERROR[err.message] || err.message);
    return;
  }

  let ws = state.globalWorkspaces.find(w => w.workspace_id === task.workspace_id);
  if (!ws) {
    await syncGlobalWorkspaces();
    ws = state.globalWorkspaces.find(w => w.workspace_id === task.workspace_id);
  }
  state.workspaceId = ws ? ws.workspace_id : null;
  state.workspaceName = ws ? ws.name : null;

  if (n.read_at === null) markRead(n.notification_id);
  const commentPart = n.source_comment_id ? `?comment=${encodeURIComponent(n.source_comment_id)}` : '';
  navigate(`#/task/${n.source_task_id}${commentPart}`);
}

function renderList() {
  const listEl = document.getElementById('notif-list');
  if (!listEl) return;
  listEl.textContent = '';

  if (cached.length === 0) {
    listEl.appendChild(el('li', { class: 'muted' }, '目前沒有通知'));
    return;
  }

  for (const n of cached) {
    const isUnread = n.read_at === null;
    const li = el('li', {
      id: `notif-card-${n.notification_id}`,
      class: `sketch-box notif-card${isUnread ? ' notif-unread' : ''}`
    });

    const body = el('div', { class: 'notif-body', onclick: () => openNotification(n) });
    body.appendChild(el('p', { class: 'notif-snippet' }, n.snippet));
    body.appendChild(el('p', { class: 'muted notif-time' }, formatTime(n.created_at)));
    li.appendChild(body);

    const actions = el('div', { class: 'notif-actions' });
    if (isUnread) {
      actions.appendChild(el('button', {
        type: 'button',
        class: 'notif-mark-read-btn',
        onclick: (e) => { e.stopPropagation(); markRead(n.notification_id); }
      }, '標示已讀'));
    }
    li.appendChild(actions);

    li.appendChild(el('p', { class: 'error notif-error' }));

    listEl.appendChild(li);
  }
}

/**
 * Controller representation for the Notifications view.
 * @type {Object}
 */
export const NotificationsView = {
  async render(container) {
    container.innerHTML = `
      <div class="sketch-box" style="padding: 0.75rem 1.5rem; background: #fff; margin-bottom: 1rem;">
        <h2 class="red-pen-underline" style="margin-top:0; margin-bottom:0;">通知</h2>
      </div>
      <ul id="notif-list" class="notif-list"><li class="muted">載入中...</li></ul>
    `;

    mounted = true;
    await refreshNotificationBadge();

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshNotificationBadge, 60000);
  }
};
