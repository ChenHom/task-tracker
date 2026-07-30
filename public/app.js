'use strict';

/**
 * @fileoverview Main entry point and orchestrator for the task-tracker single page application (SPA).
 * Performs DOM bootstrapping, sets up mobile sidebar navigation collapse, resolves
 * authentication persistence from cookie headers on page load, and initializes routers.
 */

import { state } from './js/state.js';
import { api, logout } from './js/api.js';
import { initRouter, setOnRouteCallback, navigate } from './js/router.js';
import { escAction, isEditableTarget, OVERLAY_SELECTOR, DRAWER_SELECTOR } from './js/escBack.js';
import { syncGlobalWorkspaces, updateSidebar } from './js/sidebar.js';
import { updateQuotaFooter } from './js/quota.js';
import { refreshNotificationBadge, stopNotificationPolling } from './js/views/notifications.js';

// Setup routes and register all views via side-effect imports
import './js/routes.js';

// Set callback to sync sidebar UI on route change
setOnRouteCallback((prefix) => {
  updateSidebar(prefix);
  if (prefix !== 'login' && prefix !== 'forgot-password' && prefix !== 'reset-password') {
    updateQuotaFooter();
  } else {
    const footerEl = document.getElementById('quota-footer');
    if (footerEl) footerEl.style.display = 'none';
  }
  // 離開通知頁就停止其 60 秒前景輪詢
  if (prefix !== 'notifications') {
    stopNotificationPolling();
  }
});

// 頁籤切回前景時重抓通知，避免長時間背景分頁 badge 數字過期
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.userEmail) {
    refreshNotificationBadge();
  }
});

/**
 * Collapses the sidebar viewport on mobile resolutions.
 * 模組層級：Escape handler 與 DOMContentLoaded 內的 toggle／backdrop／導覽連結共用同一份。
 * @returns {void}
 */
function closeSidebar() {
  const sidebarEl = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const toggleBtn = document.getElementById('sidebar-toggle');
  if (sidebarEl) sidebarEl.classList.remove('open');
  if (backdrop) backdrop.classList.remove('visible');
  if (toggleBtn) toggleBtn.textContent = '☰';
}

// 全域 #/tasks 的階層式 Escape：modal / menu / dropdown 自己會關，讓給它們；側欄抽屜沒有
// 自己的 Escape 邏輯，由這裡關掉（只當遮罩擋住導頁會讓 Escape 變成按了沒反應的死鍵）；
// 都沒有、也不在編輯或 IME 組字時，才退回工作區列表。
// 用 window capture 且在模組載入時就註冊（早於 task-detail modal 的 listener），
// 讀到的是「按鍵開始時」的介面狀態，不會被同一次事件關掉的 modal 影響。
window.addEventListener('keydown', (e) => {
  const action = escAction({
    key: e.key,
    isComposing: e.isComposing,
    hash: location.hash,
    overlayOpen: !!document.querySelector(OVERLAY_SELECTOR),
    drawerOpen: !!document.querySelector(DRAWER_SELECTOR),
    editable: isEditableTarget(document.activeElement)
  });
  if (action === 'none') return;
  e.preventDefault();
  if (action === 'close-drawer') closeSidebar();
  else navigate('#/workspaces');
}, true);

window.addEventListener('DOMContentLoaded', async () => {
  // Bind logout action
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await logout();
    });
  }

  // Restore current authentication state from server
  try {
    const user = await api('/api/auth/me');
    if (user && user.email) {
      state.userEmail = user.email;
      if (user.name) {
        state.userName = user.name;
      }
    }
  } catch (err) {
    state.clear();
  }

  // Sync workspaces list
  await syncGlobalWorkspaces();
  // 已登入（含重新整理後還原的 session）就抓一次通知未讀數
  refreshNotificationBadge();

  // ── Sidebar Toggle Collapsible (mobile) ──────────────────────
  const sidebarEl = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');

  /**
   * Opens the sidebar viewport on mobile resolutions.
   * @returns {void}
   */
  function openSidebar() {
    if (sidebarEl) sidebarEl.classList.add('open');
    if (backdrop) backdrop.classList.add('visible');
    if (toggleBtn) toggleBtn.textContent = '✕';
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (sidebarEl && sidebarEl.classList.contains('open')) {
        closeSidebar();
      } else {
        openSidebar();
      }
    });
  }
  
  if (backdrop) {
    backdrop.addEventListener('click', closeSidebar);
  }

  // Auto-close sidebar on mobile navigation
  document.querySelectorAll('#nav-menu a.nav-btn').forEach(link => {
    link.addEventListener('click', closeSidebar);
  });

  // ── Semi-transparent sidebar-toggle on scroll ───────────────
  let scrollTimeout = null;
  window.addEventListener('scroll', () => {
    if (toggleBtn) {
      toggleBtn.classList.add('scrolling');
    }
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      if (toggleBtn) {
        toggleBtn.classList.remove('scrolling');
      }
    }, 250);
  }, { passive: true });

  // Initialize and run the router
  initRouter();
});
