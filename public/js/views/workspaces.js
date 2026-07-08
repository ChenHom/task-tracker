'use strict';

import { api } from '../api.js';
import { state } from '../state.js';
import { navigate } from '../router.js';
import { syncGlobalWorkspaces } from '../sidebar.js';
import { el, showError, formatTime } from '../utils.js';

/**
 * Controller representation for the Workspaces listing and creation View.
 * @type {Object}
 */
export const WorkspacesView = {
  /**
   * Renders the workspaces viewport, loads the workspaces, and binds creation event handlers.
   * @param {HTMLElement} container - The DOM container element where the page is rendered.
   * @returns {Promise<void>}
   */
  async render(container) {
    container.innerHTML = `
      <div class="sketch-box" style="padding: 0.75rem 1.5rem; background: #fff; margin-bottom: 1rem;">
        <h2 style="margin-top: 0;">建立工作區 (Workspace)</h2>
        <form id="create-ws-form" style="display: flex; gap: 0.5rem; max-width: 500px;">
          <input type="text" id="ws-name-input" placeholder="例如: 個人專案 / 團隊工作區" required style="flex-grow: 1;">
          <button type="submit">建立工作區</button>
        </form>
        <p id="ws-error" class="error" style="display: none; margin-top: 1rem;"></p>
      </div>

      <h2 class="red-pen-underline" style="margin-bottom: 1.2rem;">我的工作區列表</h2>
      <div id="ws-list-container" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.5rem;">
        <!-- 卡片列表動態載入 -->
      </div>
    `;

    /**
     * Internal async helper to load workspaces list and append cards securely.
     * @returns {Promise<void>}
     */
    async function load() {
      const list = document.getElementById('ws-list-container');
      if (!list) return;
      list.textContent = '載入中...';
      try {
        const rows = await api('/api/workspaces');
        list.textContent = '';
        if (rows.length === 0) {
          list.appendChild(el('p', { class: 'muted', style: 'grid-column: 1/-1; text-align: center; font-size:1.2rem;' }, '（尚無 workspace，請於上方建立新工作區）'));
          return;
        }
        for (const row of rows) {
          const card = el('div', { class: 'sketch-box task-card', style: 'padding: 1.2rem; background: #fff; cursor: pointer;' });
          
          const title = el('h3', { style: 'margin: 0 0 0.8rem 0; font-size:1.4rem; display: flex; align-items: center; gap: 0.5rem;' });
          const dot = el('span', { title: row.status });
          dot.style.display = 'inline-block';
          dot.style.width = '10px';
          dot.style.height = '10px';
          dot.style.borderRadius = '50%';
          dot.style.flexShrink = '0';
          if (row.status === 'active') {
            dot.style.backgroundColor = '#22c55e';
            dot.style.border = '1px solid #22c55e';
          } else if (row.status === 'archived') {
            dot.style.backgroundColor = '#9ca3af';
            dot.style.border = '1px solid #9ca3af';
          } else { // deleted
            dot.style.backgroundColor = 'transparent';
            dot.style.border = '1.5px solid #9ca3af';
          }
          title.appendChild(dot);
          title.appendChild(document.createTextNode(row.name));
          card.appendChild(title);

          const footer = el('div', { class: 'muted', style: 'font-size:0.8rem; border-top:1px dashed #ccc; padding-top:0.5rem; text-align:right;' }, formatTime(row.created_at));
          card.appendChild(footer);

          card.addEventListener('click', () => {
            if (row.status === 'Deleted') {
              alert('此工作區已被刪除，無法進入。');
              return;
            }
            state.workspaceId = row.workspace_id;
            state.workspaceName = row.name;
            navigate('#/tasks');
          });
          list.appendChild(card);
        }
      } catch (err) {
        showError('ws-error', err);
      }
    }

    document.getElementById('create-ws-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('ws-name-input').value;
      try {
        await api('/api/workspaces', { method: 'POST', body: { name } });
        document.getElementById('ws-name-input').value = '';
        await syncGlobalWorkspaces();
        await load();
      } catch (err) {
        showError('ws-error', err);
      }
    });

    load();
  }
};
