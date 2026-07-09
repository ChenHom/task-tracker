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
      <div class="sketch-box ws-create-container">
        <h2 style="margin-top: 0;">建立工作區 (Workspace)</h2>
        <form id="create-ws-form" class="ws-create-form">
          <input type="text" id="ws-name-input" placeholder="例如: 個人專案 / 團隊工作區" required>
          <button type="submit">建立工作區</button>
        </form>
        <p id="ws-error" class="error" style="display: none; margin-top: 1rem;"></p>
      </div>

      <h2 class="red-pen-underline ws-list-header">我的工作區列表</h2>
      <div id="ws-list-container" class="ws-list-grid">
        <!-- 卡片列表動態載入 -->
      </div>
      <div id="ws-pagination" class="pagination-container"></div>
    `;

    let currentPage = 1;
    const itemsPerPage = 8;
    let workspacesData = [];

    /**
     * Internal helper to render the current page of workspaces and pagination controls.
     * @returns {void}
     */
    function renderPage() {
      const list = document.getElementById('ws-list-container');
      const pagination = document.getElementById('ws-pagination');
      if (!list) return;

      list.textContent = '';
      if (pagination) pagination.textContent = '';

      if (workspacesData.length === 0) {
        list.appendChild(el('p', { class: 'muted ws-empty-text' }, '（尚無 workspace，請於上方建立新工作區）'));
        return;
      }

      // Calculate pagination indices
      const startIndex = (currentPage - 1) * itemsPerPage;
      const endIndex = Math.min(startIndex + itemsPerPage, workspacesData.length);
      const pageItems = workspacesData.slice(startIndex, endIndex);

      for (const row of pageItems) {
        const statusLower = row.status ? row.status.toLowerCase() : '';
        let cardClass = 'sketch-box task-card workspace-card';
        if (statusLower === 'archived') {
          cardClass += ' status-archived';
        } else if (statusLower === 'deleted') {
          cardClass += ' status-deleted';
        }
        const card = el('div', { class: cardClass });
        
        const title = el('h3', { class: 'ws-card-title' });
        
        // Status dot class mapping
        let dotClass = 'ws-status-dot';
        if (statusLower === 'active') {
          dotClass += ' active';
        } else if (statusLower === 'archived') {
          dotClass += ' archived';
        } else {
          dotClass += ' deleted';
        }
        const dot = el('span', { class: dotClass, title: row.status });
        
        title.appendChild(dot);
        title.appendChild(document.createTextNode(row.name));
        card.appendChild(title);

        const footer = el('div', { class: 'ws-card-footer muted' }, formatTime(row.created_at));
        card.appendChild(footer);

        card.addEventListener('click', () => {
          if (statusLower === 'deleted') {
            alert('此工作區已被刪除，無法進入。');
            return;
          }
          state.workspaceId = row.workspace_id;
          state.workspaceName = row.name;
          navigate('#/tasks');
        });
        list.appendChild(card);
      }

      // Render pagination controls if total items exceed itemsPerPage
      const totalPages = Math.ceil(workspacesData.length / itemsPerPage);
      if (totalPages > 1) {
        // Prev button
        const prevBtn = el('button', { class: 'pagination-btn', type: 'button' }, '上一頁');
        if (currentPage === 1) {
          prevBtn.disabled = true;
        } else {
          prevBtn.addEventListener('click', () => {
            currentPage--;
            renderPage();
          });
        }
        pagination.appendChild(prevBtn);

        // Page number buttons
        for (let p = 1; p <= totalPages; p++) {
          const pageBtn = el('button', { class: 'pagination-btn', type: 'button' }, String(p));
          if (p === currentPage) {
            pageBtn.classList.add('active');
          } else {
            pageBtn.addEventListener('click', () => {
              currentPage = p;
              renderPage();
            });
          }
          pagination.appendChild(pageBtn);
        }

        // Next button
        const nextBtn = el('button', { class: 'pagination-btn', type: 'button' }, '下一頁');
        if (currentPage === totalPages) {
          nextBtn.disabled = true;
        } else {
          nextBtn.addEventListener('click', () => {
            currentPage++;
            renderPage();
          });
        }
        pagination.appendChild(nextBtn);
      }
    }

    /**
     * Internal async helper to load workspaces list from the API.
     * @returns {Promise<void>}
     */
    async function load() {
      const list = document.getElementById('ws-list-container');
      const pagination = document.getElementById('ws-pagination');
      if (!list) return;
      list.textContent = '載入中...';
      if (pagination) pagination.textContent = '';
      try {
        workspacesData = await api('/api/workspaces');
        renderPage();
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
