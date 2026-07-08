'use strict';

import { api } from '../api.js';
import { state } from '../state.js';
import { navigate } from '../router.js';
import { el, showError, formatTime, requireWorkspace } from '../utils.js';
import { openTaskDetailModal } from './task-detail.js';

/**
 * Controller representation for the Kanban Board View.
 * Handles loading columns, filtering tasks, transitioning status, and inline creation.
 * @type {Object}
 */
export const KanbanView = {
  /**
   * Renders the complete Kanban Board layout structure, loads items, and handles modals.
   * @param {HTMLElement} container - The DOM container element where the page is rendered.
   * @param {string[]} [rest] - Optional slash parameters matching active Task IDs.
   * @returns {Promise<void>}
   */
  async render(container, rest) {
    if (!requireWorkspace(container)) return;

    // Check if we are opening a specific task via `#/task/:taskId`
    // The router registers both 'tasks' and 'task' view.
    // When prefix is 'task', rest[0] contains the task ID.
    const openTaskId = rest && rest[0];

    container.innerHTML = `
      <!-- Kanban Top Header -->
      <div class="kanban-header-bar">
        <h2 class="red-pen-underline" style="margin-bottom: 0.8rem;">
          <span class="desktop-text">Kanban Board</span>
          <span class="mobile-text">Kanban</span>
        </h2>
        
        <!-- Project Filter and Manage Inline -->
        <div class="kanban-filters">
          <label style="font-weight: bold;">
            <span class="filter-label">專案篩選:</span>
            <select id="project-filter-select" style="font-size: 0.9rem; padding: 0.25rem 0.5rem; font-family: inherit;">
              <option value="all">所有專案</option>
              <option value="none">無專案</option>
            </select>
          </label>
          
          <label style="margin-left: clamp(0.3rem, 2vw, 1rem); font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 0.3rem;">
            <input type="checkbox" id="toggle-archived-checkbox">
            <span class="desktop-text">顯示已歸檔</span>
            <span class="mobile-text">已歸檔</span>
          </label>
        </div>
      </div>

      <p id="task-error" class="error" style="display: none; margin-bottom: 1.5rem;"></p>

      <!-- 4/5 Column Kanban Board -->
      <div class="kanban-board" id="kanban-board-el">
        <div class="kanban-column col-todo">
          <div class="kanban-column-title"><span>Todo</span><span class="inline-add-btn-slot" id="add-btn-Todo"></span></div>
          <div class="inline-add-form-slot" id="add-form-Todo"></div>
          <div class="kanban-cards" id="cards-Todo"></div>
        </div>
        <div class="kanban-column col-doing">
          <div class="kanban-column-title"><span>Doing</span><span class="inline-add-btn-slot" id="add-btn-Doing"></span></div>
          <div class="inline-add-form-slot" id="add-form-Doing"></div>
          <div class="kanban-cards" id="cards-Doing"></div>
        </div>
        <div class="kanban-column col-review">
          <div class="kanban-column-title"><span>Review</span><span class="inline-add-btn-slot" id="add-btn-Review"></span></div>
          <div class="inline-add-form-slot" id="add-form-Review"></div>
          <div class="kanban-cards" id="cards-Review"></div>
        </div>
        <div class="kanban-column col-done">
          <div class="kanban-column-title"><span>Done</span></div>
          <div class="kanban-cards" id="cards-Done"></div>
        </div>
        <div class="kanban-column col-archived" id="col-Archived-el" style="display: none;">
          <div class="kanban-column-title"><span>Archived</span></div>
          <div class="kanban-cards" id="cards-Archived"></div>
        </div>
      </div>
    `;

    /**
     * Instantiates "+" buttons and form templates for inline task creation in headers.
     * @returns {void}
     */
    function setupInlineAdders() {
      const colStatuses = ['Todo', 'Doing', 'Review'];
      for (const colStatus of colStatuses) {
        const btnSlot = document.getElementById(`add-btn-${colStatus}`);
        const formSlot = document.getElementById(`add-form-${colStatus}`);
        if (!btnSlot || !formSlot) continue;

        // Render the small "+" button inside the title bar
        const addBtn = el('button', {
          type: 'button',
          style: 'background: transparent; border: none; font-size: 1.1rem; cursor: pointer; padding: 0 0.2rem; line-height: 1; color: inherit; font-weight: bold;',
          title: '新增任務'
        }, '+');

        addBtn.onclick = () => {
          if (formSlot.querySelector('form')) {
            // Already open, close it
            formSlot.textContent = '';
            return;
          }
          formSlot.textContent = '';
          const form = el('form', { style: 'display: flex; gap: 0.3rem; margin-bottom: 0.5rem; padding: 0.3rem; background: #fdfdfd; border: 1px solid #ccc; border-radius: 4px; align-items: center;' });
          const input = el('input', {
            type: 'text',
            placeholder: '任務名稱...',
            required: 'true',
            style: 'flex: 1; font-size: 0.8rem; padding: 0.2 0.3rem; font-family: inherit; border: 1px solid #ccc; border-radius: 3px; min-width: 0;'
          });
          const submitBtn = el('button', { type: 'submit', style: 'font-size: 0.75rem; padding: 0.15rem 0.35rem; cursor: pointer; white-space: nowrap;' }, '確認');
          const cancelBtn = el('button', {
            type: 'button',
            style: 'font-size: 0.75rem; padding: 0.15rem 0.35rem; background: transparent; cursor: pointer; border: 1px solid #ccc; border-radius: 3px;'
          }, '✕');

          cancelBtn.onclick = () => { formSlot.textContent = ''; };

          form.appendChild(input);
          form.appendChild(submitBtn);
          form.appendChild(cancelBtn);

          form.onsubmit = async (e) => {
            e.preventDefault();
            const title = input.value.trim();
            if (!title) return;

            const filterVal = document.getElementById('project-filter-select').value;
            const projectId = (filterVal && filterVal !== 'all' && filterVal !== 'none') ? filterVal : null;

            try {
              await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/tasks`, {
                method: 'POST',
                body: {
                  title,
                  description: '',
                  priority: 'Medium',
                  status: colStatus,
                  projectId,
                  assigneeId: null,
                  dueAt: null
                }
              });
              formSlot.textContent = '';
              await loadAllData();
            } catch (err) {
              alert('建立任務失敗：' + err.message);
            }
          };

          formSlot.appendChild(form);
          input.focus();
        };

        btnSlot.textContent = '';
        btnSlot.appendChild(addBtn);
      }
    }

    let cachedTasks = [];
    let cachedProjects = [];
    let cachedMembers = [];
    let projectMap = new Map();
    let memberMap = new Map();
    let memberEmailMap = new Map();

    /**
     * Executes async API requests to retrieve workspace tasks, projects, and members,
     * populates query filters, and renders individual kanban cards.
     * @returns {Promise<void>}
     */
    async function loadAllData() {
      try {
        const [tasks, projects, members] = await Promise.all([
          api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/tasks`),
          api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/projects`),
          api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/members`)
        ]);
        cachedTasks = tasks;
        cachedProjects = projects;
        cachedMembers = members;
        projectMap = new Map(projects.map(p => [p.project_id, p.name]));
        memberMap = new Map(members.map(m => [m.user_id, m.name || m.email]));
        memberEmailMap = new Map(members.map(m => [m.user_id, m.email]));

        // 填充篩選選單
        const filterSelect = document.getElementById('project-filter-select');
        if (filterSelect) {
          const prevFilterVal = filterSelect.value;
          filterSelect.innerHTML = `
            <option value="all">所有專案</option>
            <option value="none">無專案</option>
          `;
          for (const p of projects) {
            filterSelect.appendChild(el('option', { value: p.project_id }, p.name));
          }
          filterSelect.appendChild(el('option', { value: '__create_new__', style: 'border-top: 1px dashed #ccc; font-weight: bold;' }, '+ 建立新專案...'));
          if (prevFilterVal && Array.from(filterSelect.options).some(o => o.value === prevFilterVal)) {
            filterSelect.value = prevFilterVal;
          }
        }

        renderKanbanCards(cachedTasks, projectMap, memberMap);

        // 如果有指定開啟任務，則彈出 modal
        if (openTaskId) {
          openTaskDetailModal(openTaskId, {
            cachedTasks,
            cachedMembers,
            memberMap,
            memberEmailMap,
            onUpdate: loadAllData
          });
        }
      } catch (err) {
        showError('task-error', err);
      }
    }

    /**
     * Distributes, filters, and renders individual task nodes within respective column elements.
     * @param {Array<Object>} tasks - Cached array of workspace tasks.
     * @param {Map<string, string>} projectMap - Associated workspace project mappings.
     * @param {Map<string, string>} memberMap - Member display names lookup.
     * @returns {void}
     */
    function renderKanbanCards(tasks, projectMap, memberMap) {
      const columns = ['Todo', 'Doing', 'Review', 'Done', 'Archived'];
      columns.forEach(s => {
        const container = document.getElementById(`cards-${s}`);
        if (container) container.textContent = '';
      });

      const filterSelect = document.getElementById('project-filter-select');
      const projectFilterVal = filterSelect ? filterSelect.value : 'all';
      
      const toggleArchivedCheckbox = document.getElementById('toggle-archived-checkbox');
      const showArchived = toggleArchivedCheckbox ? toggleArchivedCheckbox.checked : false;

      // 控制封存欄位顯示
      const archivedCol = document.getElementById('col-Archived-el');
      const boardEl = document.getElementById('kanban-board-el');
      if (archivedCol && boardEl) {
        if (showArchived) {
          archivedCol.style.display = 'flex';
          boardEl.classList.add('show-archived-col');
        } else {
          archivedCol.style.display = 'none';
          boardEl.classList.remove('show-archived-col');
        }
      }

      // 過濾任務
      const filtered = tasks.filter(t => {
        if (projectFilterVal !== 'all') {
          if (projectFilterVal === 'none') {
            if (t.project_id) return false;
          } else {
            if (t.project_id !== projectFilterVal) return false;
          }
        }
        if (t.status === 'Archived' && !showArchived) return false;
        return true;
      });

      for (const task of filtered) {
        const card = el('div', { class: 'task-card' });

        // Top Section: Title & Description
        const topEl = el('div', { class: 'task-card-top' });
        topEl.onclick = () => navigate(`#/task/${task.task_id}`);

        const titleEl = el('h4', { class: 'task-card-title' });
        const titleLink = el('a', { href: `#/task/${task.task_id}` }, task.title);
        titleEl.appendChild(titleLink);
        topEl.appendChild(titleEl);

        // Description snippet
        if (task.description) {
          const descEl = el('p', { class: 'task-card-desc' }, task.description);
          topEl.appendChild(descEl);
        }
        card.appendChild(topEl);

        // Mid Section: Meta, Assignee, Time
        const midEl = el('div', { class: 'task-card-mid' });
        midEl.onclick = () => navigate(`#/task/${task.task_id}`);

        // Meta (Priority, Project)
        const metaEl = el('div', { class: 'task-card-meta' });
        const pClass = `badge badge-${task.priority.toLowerCase()}`;
        metaEl.appendChild(el('span', { class: pClass }, task.priority));

        if (task.project_id) {
          const projName = projectMap.get(task.project_id) || '未知專案';
          metaEl.appendChild(el('span', { class: 'badge badge-project' }, projName));
        }
        midEl.appendChild(metaEl);

        // Assignee mapping
        if (task.assignee_id) {
          const name = memberMap.get(task.assignee_id) || '未知成員';
          midEl.appendChild(el('div', { class: 'task-card-assignee' }, `Assignee: ${name}`));
        }

        // Due date & Last updated time
        const timeContainer = el('div', { style: 'display: flex; flex-direction: column; gap: 0.1rem;' });
        if (task.due_at) {
          const d = new Date(task.due_at).toISOString().split('T')[0];
          timeContainer.appendChild(el('div', { class: 'muted', style: 'font-size:0.75rem;' }, `Due: ${d}`));
        }
        if (task.updated_at) {
          timeContainer.appendChild(el('div', { class: 'muted', style: 'font-size:0.75rem;' }, `更新: ${formatTime(task.updated_at)}`));
        }
        if (timeContainer.hasChildNodes()) {
          midEl.appendChild(timeContainer);
        }
        card.appendChild(midEl);

        // Transitions & Action buttons
        const actionsEl = el('div', { class: 'task-card-actions' });
        
        // Row 1: Flow buttons
        const flowEl = el('div', { class: 'task-card-flow' });
        const flowLeft = el('div', { class: 'flow-left' });
        const flowRight = el('div', { class: 'flow-right' });
        if (task.status === 'Todo') {
          flowRight.appendChild(createStateBtn('→ Doing', 'Doing', task.task_id));
        } else if (task.status === 'Doing') {
          flowLeft.appendChild(createStateBtn('← Todo', 'Todo', task.task_id));
          flowRight.appendChild(createStateBtn('Review →', 'Review', task.task_id));
        } else if (task.status === 'Review') {
          flowLeft.appendChild(createStateBtn('← Doing', 'Doing', task.task_id));
          flowRight.appendChild(createStateBtn('Done →', 'Done', task.task_id));
        } else if (task.status === 'Done') {
          flowLeft.appendChild(createStateBtn('← Review', 'Review', task.task_id));
        }
        flowEl.appendChild(flowLeft);
        flowEl.appendChild(flowRight);
        actionsEl.appendChild(flowEl);

        // Row 2: Utility buttons
        const utilityEl = el('div', { class: 'task-card-utils' });
        if (task.status !== 'Archived') {
          const archiveBtn = el('button', { type: 'button', class: 'btn-secondary' }, 'Archive');
          archiveBtn.onclick = () => archiveTask(task.task_id);
          utilityEl.appendChild(archiveBtn);
        }
        const deleteBtn = el('button', { type: 'button', class: 'btn-danger' }, 'Delete');
        deleteBtn.onclick = () => deleteTask(task.task_id);
        utilityEl.appendChild(deleteBtn);
        
        actionsEl.appendChild(utilityEl);
        card.appendChild(actionsEl);

        const targetContainer = document.getElementById(`cards-${task.status}`);
        if (targetContainer) targetContainer.appendChild(card);
      }
    }

    /**
     * Builds state-shifting control buttons with validation checks.
     * @param {string} text - Button caption text.
     * @param {string} newStatus - Target workflow status parameter.
     * @param {string} taskId - The ID of the target task.
     * @returns {HTMLElement} State shifting action button.
     */
    function createStateBtn(text, newStatus, taskId) {
      const btn = el('button', { type: 'button' }, text);
      btn.onclick = async () => {
        // 限制：切換至 Doing 時，必須有負責人
        if (newStatus === 'Doing') {
          const task = cachedTasks.find(t => t.task_id === taskId);
          if (task && !task.assignee_id) {
            alert('錯誤：切換至 Doing 狀態前，必須先指派負責人！');
            return;
          }
        }
        try {
          await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { status: newStatus } });
          await loadAllData();
        } catch (err) {
          showError('task-error', err);
        }
      };
      return btn;
    }

    /**
     * Sends API call to archive a given task.
     * @param {string} taskId - Target task ID.
     * @returns {Promise<void>}
     */
    async function archiveTask(taskId) {
      try {
        await api(`/api/tasks/${taskId}/archive`, { method: 'POST' });
        await loadAllData();
      } catch (err) {
        showError('task-error', err);
      }
    }

    /**
     * Sends API call to delete a given task with confirmation prompt.
     * @param {string} taskId - Target task ID.
     * @returns {Promise<void>}
     */
    async function deleteTask(taskId) {
      if (!confirm('確定要刪除這項任務嗎？此動作無法復原。')) return;
      try {
        await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
        await loadAllData();
      } catch (err) {
        showError('task-error', err);
      }
    }

    // 事件綁定：專案篩選與封存切換
    const filterSelect = document.getElementById('project-filter-select');
    let lastSelectedProject = filterSelect ? filterSelect.value : 'all';

    if (filterSelect) {
      filterSelect.addEventListener('change', async () => {
        const val = filterSelect.value;
        if (val === '__create_new__') {
          const name = prompt('請輸入新專案名稱：');
          if (name && name.trim()) {
            try {
              const res = await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/projects`, {
                method: 'POST',
                body: { name: name.trim() }
              });
              await loadAllData();
              filterSelect.value = res.id;
              lastSelectedProject = res.id;
              renderKanbanCards(cachedTasks, projectMap, memberMap);
            } catch (err) {
              alert('建立專案失敗：' + err.message);
              filterSelect.value = lastSelectedProject;
            }
          } else {
            filterSelect.value = lastSelectedProject;
          }
        } else {
          lastSelectedProject = val;
          renderKanbanCards(cachedTasks, projectMap, memberMap);
        }
      });
    }

    const toggleArchivedCheckbox = document.getElementById('toggle-archived-checkbox');
    if (toggleArchivedCheckbox) {
      toggleArchivedCheckbox.addEventListener('change', () => {
        renderKanbanCards(cachedTasks, projectMap, memberMap);
      });
    }

    setupInlineAdders();
    loadAllData();
  }
};
