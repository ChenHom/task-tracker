'use strict';

import { api } from '../api.js';
import { state, ROLES } from '../state.js';
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

    container.innerHTML = `
      <div class="sketch-box" style="padding: 0.75rem 1.5rem; background: #fff; margin-bottom: 1rem;">
        <h2 style="margin-top: 0;">邀請新成員</h2>
        <form id="invite-form" style="display: flex; gap: 0.5rem; flex-wrap: wrap; max-width: 600px;">
          <input type="email" id="invite-email" list="email-suggestions" placeholder="成員 Email 帳號" required style="flex-grow: 1;">
          <datalist id="email-suggestions"></datalist>
          <select id="invite-role"></select>
          <button type="submit">邀請加入</button>
        </form>
        <p id="member-error" class="error" style="display: none; margin-top: 1rem;"></p>
      </div>

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

    /**
     * Async loader representing member metadata fetching and list item creation.
     * @returns {Promise<void>}
     */
    async function load() {
      const tbody = document.getElementById('member-tbody');
      if (!tbody) return;
      tbody.textContent = '';
      try {
        const rows = await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/members`);
        if (rows.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center;">（尚無成員）</td></tr>';
          return;
        }
        for (const m of rows) {
          const tr = el('tr');
          tr.appendChild(el('td', { style: 'font-weight: bold;' }, m.name || ''));
          tr.appendChild(el('td', {}, m.email));

          const roleTd = el('td');
          const select = el('select', { style: 'padding: 0.25rem;' });
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
          tr.appendChild(roleTd);

          tr.appendChild(el('td', { class: 'muted', style: 'font-size:0.9rem;' }, new Date(m.joined_at).toLocaleString()));

          const actionsTd = el('td', { style: 'text-align: right;' });
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
          tr.appendChild(actionsTd);

          tbody.appendChild(tr);
        }
      } catch (err) {
        showError('member-error', err);
      }
    }

    const inviteForm = document.getElementById('invite-form');
    if (inviteForm) {
      inviteForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('invite-email').value;
        const role = inviteRoleSelect.value;
        try {
          await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/members`, {
            method: 'POST',
            body: { email, role },
          });
          document.getElementById('invite-email').value = '';
          await load();
        } catch (err) {
          showError('member-error', err);
        }
      });
    }

    const inviteEmailInput = document.getElementById('invite-email');
    const suggestionsDatalist = document.getElementById('email-suggestions');
    let searchTimer = null;
    
    if (inviteEmailInput && suggestionsDatalist) {
      inviteEmailInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          const val = inviteEmailInput.value.trim();
          if (val.length < 1) {
            suggestionsDatalist.innerHTML = '';
            return;
          }
          try {
            const list = await api(`/api/users/search?q=${encodeURIComponent(val)}`);
            suggestionsDatalist.innerHTML = '';
            for (const item of list) {
              suggestionsDatalist.appendChild(el('option', { value: item.email }, `${item.name} (${item.email})`));
            }
          } catch (err) {
            // 靜態忽略
          }
        }, 500);
      });
    }

    load();
  }
};
