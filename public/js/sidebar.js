'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { el } from './utils.js';
import { navigate } from './router.js';

/**
 * Synchronizes list of active workspaces associated with the user from the backend.
 * Falls back to an empty cache listing upon auth failure, then re-renders the workspace switcher.
 * @returns {Promise<void>}
 */
export async function syncGlobalWorkspaces() {
  if (!state.userEmail) {
    state.globalWorkspaces = [];
    renderWorkspaceSwitcher();
    return;
  }
  try {
    state.globalWorkspaces = await api('/api/workspaces');
  } catch {
    state.globalWorkspaces = [];
  }
  renderWorkspaceSwitcher();
}

/**
 * Renders list options inside the sidebar's workspace switcher select box.
 * Automatically selects the option corresponding to the active workspace.
 * @returns {void}
 */
export function renderWorkspaceSwitcher() {
  const select = document.getElementById('sidebar-ws-select');
  if (!select) return;
  select.textContent = '';
  
  const defaultOpt = el('option', { value: '' }, '-- 切換工作區 --');
  select.appendChild(defaultOpt);

  for (const w of state.globalWorkspaces) {
    // 排除已刪除的工作區
    if (w.status === 'deleted') continue;
    const opt = el('option', { value: w.workspace_id }, w.name);
    if (w.workspace_id === state.workspaceId) opt.selected = true;
    select.appendChild(opt);
  }

  const manageOpt = el('option', { value: '__manage__' }, '管理工作區清單...');
  select.appendChild(manageOpt);
}

/**
 * Track if switcher event listener has been registered.
 * @type {boolean}
 */
let switcherInitialized = false;

/**
 * Attaches the change event listener to the workspace switcher selector.
 * Triggers state update, hash navigation, and collapses mobile menu viewports upon workspace selection.
 * @returns {void}
 */
export function initSwitcherListener() {
  if (switcherInitialized) return;
  const select = document.getElementById('sidebar-ws-select');
  if (!select) return;
  select.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === '__manage__') {
      navigate('#/workspaces');
      e.target.value = state.workspaceId || '';
    } else if (val) {
      const targetWS = state.globalWorkspaces.find(w => w.workspace_id === val);
      if (targetWS) {
        state.workspaceId = targetWS.workspace_id;
        state.workspaceName = targetWS.name;
        navigate('#/tasks');
      }
    }
    // 自動收折 mobile sidebar
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebar-backdrop');
    const tb = document.getElementById('sidebar-toggle');
    if (sb) sb.classList.remove('open');
    if (bd) bd.classList.remove('visible');
    if (tb) tb.textContent = '☰';
  });
  switcherInitialized = true;
}

/**
 * Updates sidebar DOM layout elements matching route changes and state session adjustments.
 * Re-evaluates active nav highlight tags, updates logged-in meta indicators, and sets visibility selectors.
 * @param {string} prefix - The current active page route prefix.
 * @returns {void}
 */
export function updateSidebar(prefix) {
  // 更新 nav 按鈕高亮
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`nav-${prefix}`);
  if (activeBtn) activeBtn.classList.add('active');

  const userEmail = state.userEmail;
  const userEmailEl = document.getElementById('sidebar-user-email');
  const logoutBtn = document.getElementById('logout-btn');
  const wsNav = document.getElementById('workspace-nav');
  const wsSection = document.getElementById('workspace-section');

  if (userEmail) {
    const userName = state.userName;
    userEmailEl.textContent = userName ? `${userName} (${userEmail})` : userEmail;
    logoutBtn.style.display = 'inline-flex';
    wsSection.style.display = 'block';
    initSwitcherListener();
    renderWorkspaceSwitcher();
  } else {
    userEmailEl.textContent = '';
    logoutBtn.style.display = 'none';
    wsSection.style.display = 'none';
  }

  if (state.workspaceId) {
    wsNav.style.display = 'flex';
  } else {
    wsNav.style.display = 'none';
  }
}
