'use strict';

/**
 * @fileoverview @mention 通知中心視圖，以及桌機 sidebar／手機漢堡共用的未讀 badge 邏輯。
 * 依 docs/frontend/mentions-and-notifications.md 的 API 契約實作。
 * 通知列表走 GET /api/notifications?page=N&pageSize=15 的 opt-in 分頁回應
 * （{ items, page, pageSize, totalCount, totalPages, unreadTotal }）。
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

const PAGE_SIZE = 15;

function emptyPage() {
  return { items: [], page: 1, pageSize: PAGE_SIZE, totalCount: 0, totalPages: 1, unreadTotal: 0 };
}

let pageState = emptyPage();
let pollTimer = null;
let mounted = false;

function renderBadges() {
  const count = pageState.unreadTotal;
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
 * 重抓通知（目前頁，未掛載時固定第 1 頁）並同步 badge／（若通知頁在前景）清單畫面。
 * 供登入、頁籤切回前景、標記已讀後、以及通知頁輪詢共用呼叫。
 * @returns {Promise<void>}
 */
export async function refreshNotificationBadge() {
  if (!state.userEmail) {
    pageState = emptyPage();
    renderBadges();
    return;
  }
  try {
    pageState = await api(`/api/notifications?page=${mounted ? pageState.page : 1}&pageSize=${PAGE_SIZE}`);
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

async function loadPage(page) {
  try {
    pageState = await api(`/api/notifications?page=${page}&pageSize=${PAGE_SIZE}`);
  } catch {
    // 頁碼可能因資料變動而越界；退回第 1 頁重試一次
    if (page !== 1) {
      try {
        pageState = await api(`/api/notifications?page=1&pageSize=${PAGE_SIZE}`);
      } catch {
        // 忽略，維持既有畫面
      }
    }
  }
  renderBadges();
  renderList();
}

async function markRead(notificationId) {
  // 先做本地樂觀更新，讓 badge／清單立即反應
  const wasUnread = pageState.items.some(n => n.notification_id === notificationId && n.read_at === null);
  pageState = {
    ...pageState,
    items: pageState.items.map(n => (n.notification_id === notificationId && n.read_at === null)
      ? { ...n, read_at: new Date().toISOString() }
      : n),
    unreadTotal: wasUnread ? Math.max(0, pageState.unreadTotal - 1) : pageState.unreadTotal
  };
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

function renderPaginationNav() {
  const navEl = document.getElementById('notif-pagination');
  if (!navEl) return;
  navEl.textContent = '';
  if (pageState.totalPages <= 1) return;

  const prevBtn = el('button', {
    class: 'pagination-btn',
    type: 'button',
    onclick: () => loadPage(pageState.page - 1)
  }, '上一頁');
  if (pageState.page <= 1) prevBtn.disabled = true;
  navEl.appendChild(prevBtn);

  for (let p = 1; p <= pageState.totalPages; p++) {
    const isCurrent = p === pageState.page;
    const attrs = { class: `pagination-btn${isCurrent ? ' active' : ''}`, type: 'button', onclick: () => loadPage(p) };
    if (isCurrent) attrs['aria-current'] = 'page';
    const pageBtn = el('button', attrs, String(p));
    if (isCurrent) pageBtn.disabled = true;
    navEl.appendChild(pageBtn);
  }

  const nextBtn = el('button', {
    class: 'pagination-btn',
    type: 'button',
    onclick: () => loadPage(pageState.page + 1)
  }, '下一頁');
  if (pageState.page >= pageState.totalPages) nextBtn.disabled = true;
  navEl.appendChild(nextBtn);
}

function renderList() {
  const listEl = document.getElementById('notif-list');
  if (!listEl) return;
  listEl.textContent = '';

  if (pageState.items.length === 0) {
    listEl.appendChild(el('li', { class: 'muted' }, '目前沒有通知'));
    renderPaginationNav();
    return;
  }

  for (const n of pageState.items) {
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

  renderPaginationNav();
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
      <nav id="notif-pagination" class="pagination-container" aria-label="通知列表分頁"></nav>
    `;

    mounted = true;
    await loadPage(1);

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshNotificationBadge, 60000);
  }
};
