'use strict';

import { api } from '../api.js';
import { state, ROLES, hasRole, MAIN_WORKSPACE_ID } from '../state.js';
import { el, showError, requireWorkspace } from '../utils.js';

/**
 * Controller representation for the Workspace Members management View.
 * @type {Object}
 */
export const MembersView = {
  /**
   * Renders the members administration viewport, lists workspace roles, and wires email search datalist autocomplete triggers.
   * @param {HTMLElement} container - The DOM container element where the page is rendered.
   * @returns {Promise<void>}
   */
  async render(container) {
    if (!requireWorkspace(container)) return;
    const renderWorkspaceId = state.workspaceId;
    let loadGeneration = 0;

    container.innerHTML = `
      <div id="invite-panel" class="sketch-box" hidden style="padding: 0.75rem 1.5rem; background: #fff; margin-bottom: 1rem;">
        <h2 style="margin-top: 0;">邀請新成員</h2>
        <form id="invite-form" style="display: flex; gap: 0.5rem; flex-wrap: wrap; max-width: 600px;">
          <input type="email" id="invite-email" list="email-suggestions" placeholder="成員 Email 帳號" required style="flex-grow: 1;">
          <datalist id="email-suggestions"></datalist>
          <select id="invite-role"></select>
          <button type="submit">邀請加入</button>
        </form>
      </div>

      <p id="member-error" class="error" style="display: none; margin-bottom: 1rem;"></p>

      <h2 class="red-pen-underline" style="margin-bottom: 1.2rem;">成員清單 (Members)</h2>
      <table>
        <thead>
          <tr>
            <th>名稱 (Name)</th>
            <th>電子信箱 (Email)</th>
            <th>角色權限 (Role)</th>
            <th>加入時間 (Joined)</th>
            <th style="text-align: right;">操作</th>
          </tr>
        </thead>
        <tbody id="member-tbody"></tbody>
      </table>
    `;

    const inviteRoleSelect = document.getElementById('invite-role');
    if (inviteRoleSelect) {
      for (const r of ROLES) inviteRoleSelect.appendChild(el('option', { value: r }, r));
      inviteRoleSelect.value = 'Member';
    }
    let canManageMembers = false;
    let managementControlsBound = false;
    let searchTimer = null;
    let searchAbortController = null;

    /**
     * Async loader representing member metadata fetching and list item creation.
     * @returns {Promise<void>}
     */
    async function load() {
      if (state.workspaceId !== renderWorkspaceId) return;
      const generation = ++loadGeneration;
      const tbody = document.getElementById('member-tbody');
      if (!tbody) return;
      tbody.textContent = '';
      try {
        const rows = await api(`/api/workspaces/${encodeURIComponent(renderWorkspaceId)}/members`);
        if (generation !== loadGeneration || state.workspaceId !== renderWorkspaceId) return;
        const currentMember = rows.find(m => m.email === state.userEmail);
        const currentRole = currentMember ? currentMember.role : 'Viewer';
        canManageMembers = hasRole(currentRole, 'Admin') && renderWorkspaceId !== MAIN_WORKSPACE_ID;
        const invitePanel = document.getElementById('invite-panel');
        if (invitePanel) invitePanel.hidden = !canManageMembers;
        if (canManageMembers) bindManagementControls();
        if (rows.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="muted text-center">（尚無成員）</td></tr>';
          return;
        }
        for (const m of rows) {
          const tr = el('tr');
          tr.appendChild(el('td', { class: 'member-name' }, m.name || ''));
          tr.appendChild(el('td', {}, m.email));

          const roleTd = el('td');
          if (canManageMembers) {
            const select = el('select', { class: 'member-role-select' });
            for (const r of ROLES) {
              const opt = el('option', { value: r }, r);
              if (r === m.role) opt.selected = true;
              select.appendChild(opt);
            }
            select.addEventListener('change', async () => {
              try {
                await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/members/${m.user_id}`, {
                  method: 'PATCH',
                  body: { role: select.value },
                });
                await load();
              } catch (err) {
                showError('member-error', err);
                await load();
              }
            });
            roleTd.appendChild(select);
          } else {
            roleTd.appendChild(el('span', { class: 'member-role-text' }, m.role));
          }
          tr.appendChild(roleTd);

          tr.appendChild(el('td', { class: 'muted member-joined-time' }, new Date(m.joined_at).toLocaleString()));

          const actionsTd = el('td', { class: 'member-actions-td' });
          if (canManageMembers) {
            const removeBtn = el('button', { type: 'button', class: 'btn-danger' }, '移除');
            removeBtn.addEventListener('click', async () => {
              if (!confirm(`確定要將成員 ${m.email} 移出此工作區嗎？`)) return;
              try {
                await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/members/${m.user_id}`, {
                  method: 'DELETE',
                });
                await load();
              } catch (err) {
                showError('member-error', err);
              }
            });
            actionsTd.appendChild(removeBtn);
          }
          tr.appendChild(actionsTd);

          tbody.appendChild(tr);
        }
      } catch (err) {
        if (generation === loadGeneration && state.workspaceId === renderWorkspaceId) {
          showError('member-error', err);
        }
      }
    }

    function bindManagementControls() {
      if (managementControlsBound) return;
      const inviteForm = document.getElementById('invite-form');
      const inviteEmailInput = document.getElementById('invite-email');
      const suggestionsDatalist = document.getElementById('email-suggestions');
      if (!inviteForm || !inviteEmailInput || !suggestionsDatalist) return;
      managementControlsBound = true;

      inviteForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!canManageMembers) return;
        const email = inviteEmailInput.value;
        const role = inviteRoleSelect.value;
        try {
          await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/members`, {
            method: 'POST',
            body: { email, role },
          });
          inviteEmailInput.value = '';
          await load();
        } catch (err) {
          showError('member-error', err);
        }
      });
      inviteEmailInput.addEventListener('input', () => {
        if (!canManageMembers) return;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          if (!canManageMembers) return;
          const val = inviteEmailInput.value.trim();
          if (val.length < 1) {
            suggestionsDatalist.innerHTML = '';
            return;
          }
          if (searchAbortController) {
            searchAbortController.abort();
          }
          searchAbortController = new AbortController();
          try {
            const list = await api(`/api/users/search?q=${encodeURIComponent(val)}`, {
              signal: searchAbortController.signal
            });
            suggestionsDatalist.innerHTML = '';
            for (const item of list) {
              suggestionsDatalist.appendChild(el('option', { value: item.email }, `${item.name} (${item.email})`));
            }
          } catch (err) {
            if (err.name === 'AbortError') {
              console.log('Autocomplete search aborted');
            } else {
              // 靜態忽略其他錯誤
            }
          }
        }, 500);
      });
    }

    load();
  }
};
