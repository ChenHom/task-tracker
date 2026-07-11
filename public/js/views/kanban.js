'use strict';

import { api } from '../api.js';
import {
  state,
  hasRole,
  MAIN_WORKSPACE_ID,
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_TITLE
} from '../state.js';
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
  async render(container, rest, query) {
    if (!requireWorkspace(container)) return;

    // Check if we are opening a specific task via `#/task/:taskId`
    // The router registers both 'tasks' and 'task' view.
    // When prefix is 'task', rest[0] contains the task ID.
    const openTaskId = rest && rest[0];
    const isMainWorkspace = state.workspaceId === MAIN_WORKSPACE_ID;
    let currentRole = 'Viewer';
    let canCreateTask = false;
    let canManageTask = false;

    container.innerHTML = `
      <!-- Kanban Top Header -->
      <div class="kanban-header-bar">
        <h2 class="red-pen-underline" style="margin-bottom: 0.8rem;">
          <span class="desktop-text">Kanban Board</span>
          <span class="mobile-text">Kanban</span>
        </h2>
        
        <!-- Project Filter and Manage Inline -->
        <div class="kanban-filters">
          <label class="project-filter-label">
            <span class="filter-label">專案篩選:</span>
            <select id="project-filter-select">
              <option value="all">所有專案</option>
              <option value="none">無專案</option>
            </select>
          </label>
          
          <label class="toggle-archived-label">
            <input type="checkbox" id="toggle-archived-checkbox">
            <span class="desktop-text">顯示已歸檔</span>
            <span class="mobile-text">已歸檔</span>
          </label>
        </div>
      </div>

      ${isMainWorkspace ? `
        <section class="main-workspace-policy" aria-label="主工作區協作規則">
          <strong>主工作區協作規則</strong>
          <span>只討論，不在主工作區實作。</span>
          <span>所有人可新增 Todo 與留言。</span>
          <span>只有 user01 可調整任務狀態。</span>
          <span>開始處理時自動指派給 user01。</span>
          <span>決議先判斷 target repo，再於 canonical 或對應 workspace 建立 task 並回寫連結。</span>
        </section>
      ` : ''}

      <p id="task-error" class="error" style="display: none; margin-bottom: 1.5rem;"></p>

      <!-- 4/5 Column Kanban Board -->
      <div class="kanban-board" id="kanban-board-el" style="position: relative;">
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
    function clearInlineAdders() {
      for (const colStatus of ['Todo', 'Doing', 'Review']) {
        const btnSlot = document.getElementById(`add-btn-${colStatus}`);
        const formSlot = document.getElementById(`add-form-${colStatus}`);
        if (btnSlot) btnSlot.textContent = '';
        if (formSlot) formSlot.textContent = '';
      }
    }

    function setupInlineAdders() {
      clearInlineAdders();
      if (!canCreateTask) return;
      const colStatuses = isMainWorkspace || !hasRole(currentRole, 'Member')
        ? ['Todo']
        : ['Todo', 'Doing', 'Review'];
      for (const colStatus of colStatuses) {
        const btnSlot = document.getElementById(`add-btn-${colStatus}`);
        const formSlot = document.getElementById(`add-form-${colStatus}`);
        if (!btnSlot || !formSlot) continue;

        // Render the small "+" button inside the title bar
        const addBtn = el('button', {
          type: 'button',
          class: 'column-add-task-btn',
          title: '新增任務'
        }, '+');

        addBtn.onclick = () => {
          if (formSlot.querySelector('form')) {
            // Already open, close it
            formSlot.textContent = '';
            return;
          }
          formSlot.textContent = '';
          const form = el('form', { class: 'column-add-task-form' });
          const input = el('input', {
            type: 'text',
            placeholder: '任務名稱...',
            required: 'true',
            class: 'column-add-task-input'
          });
          const submitBtn = el('button', { type: 'submit', class: 'column-add-task-submit' }, '確認');
          const cancelBtn = el('button', {
            type: 'button',
            class: 'column-add-task-cancel'
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
              const body = hasRole(currentRole, 'Member')
                ? {
                    title,
                    description: '',
                    priority: 'Medium',
                    status: colStatus,
                    projectId,
                    assigneeId: null,
                    dueAt: null
                  }
                : { title, description: '' };
              await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/tasks`, {
                method: 'POST',
                body
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
      clearInlineAdders();
      // 顯示載入指示器
      const boardEl = document.getElementById('kanban-board-el');
      let loadingOverlay = document.getElementById('kanban-loading-overlay');
      if (!loadingOverlay && boardEl) {
        loadingOverlay = el('div', {
          id: 'kanban-loading-overlay'
        }, '載入中...');
        boardEl.appendChild(loadingOverlay);
      }

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
        const currentMember = members.find(m => m.email === state.userEmail);
        currentRole = currentMember ? currentMember.role : 'Viewer';
        canCreateTask = hasRole(currentRole, 'Commenter');
        canManageTask = hasRole(currentRole, 'Member')
          && (!isMainWorkspace || state.userEmail === MAIN_OWNER_EMAIL);
        setupInlineAdders();

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
          if (canManageTask) {
            filterSelect.appendChild(el('option', { value: '__create_new__', class: 'select-create-new-option' }, '+ 建立新專案...'));
          }
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
            onUpdate: loadAllData,
            query,
            currentRole,
            isMainWorkspace
          });
        }
      } catch (err) {
        showError('task-error', err);
      } finally {
        if (loadingOverlay) {
          loadingOverlay.remove();
        }
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
      }).sort((a, b) => Number(b.title === MAIN_POLICY_TITLE) - Number(a.title === MAIN_POLICY_TITLE));

      for (const task of filtered) {
        const card = el('div', {
          class: 'task-card',
          'data-task-id': task.task_id,
          'data-short-id': `::${task.task_id.split('-')[0]}`
        });

        // Top Section: Title & Description
        const topEl = el('div', { class: 'task-card-top clickable-section' });

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
        const midEl = el('div', { class: 'task-card-mid clickable-section' });

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
        const timeContainer = el('div', { class: 'card-time-container' });
        if (task.due_at) {
          const d = new Date(task.due_at).toISOString().split('T')[0];
          timeContainer.appendChild(el('div', { class: 'muted card-time-item' }, `Due: ${d}`));
        }
        if (task.updated_at) {
          timeContainer.appendChild(el('div', { class: 'muted card-time-item' }, `更新: ${formatTime(task.updated_at)}`));
        }
        if (timeContainer.hasChildNodes()) {
          midEl.appendChild(timeContainer);
        }
        card.appendChild(midEl);

        if (canManageTask) {
          const actionsEl = el('div', { class: 'task-card-actions' });
          const flowEl = el('div', { class: 'task-card-flow' });
          const flowLeft = el('div', { class: 'flow-left' });
          const flowRight = el('div', { class: 'flow-right' });
          if (task.status === 'Todo') {
            flowRight.appendChild(createStateBtn('→ Doing', 'Doing'));
          } else if (task.status === 'Doing') {
            flowLeft.appendChild(createStateBtn('← Todo', 'Todo'));
            flowRight.appendChild(createStateBtn('Review →', 'Review'));
          } else if (task.status === 'Review') {
            flowLeft.appendChild(createStateBtn('← Doing', 'Doing'));
            flowRight.appendChild(createStateBtn('Done →', 'Done'));
          } else if (task.status === 'Done') {
            flowLeft.appendChild(createStateBtn('← Review', 'Review'));
          }
          flowEl.appendChild(flowLeft);
          flowEl.appendChild(flowRight);
          actionsEl.appendChild(flowEl);

          const utilityEl = el('div', { class: 'task-card-utils' });
          if (task.status !== 'Archived') {
            const archiveBtn = el('button', { type: 'button', class: 'btn-secondary', 'data-action': 'archive' }, 'Archive');
            utilityEl.appendChild(archiveBtn);
          }
          const deleteBtn = el('button', { type: 'button', class: 'btn-danger', 'data-action': 'delete' }, 'Delete');
          utilityEl.appendChild(deleteBtn);
          actionsEl.appendChild(utilityEl);
          card.appendChild(actionsEl);
        }

        const targetContainer = document.getElementById(`cards-${task.status}`);
        if (targetContainer) targetContainer.appendChild(card);
      }
    }

    /**
     * Builds state-shifting control buttons with validation datasets.
     * @param {string} text - Button caption text.
     * @param {string} newStatus - Target workflow status parameter.
     * @returns {HTMLElement} State shifting action button.
     */
    function createStateBtn(text, newStatus) {
      return el('button', {
        type: 'button',
        'data-action': 'transition',
        'data-status': newStatus
      }, text);
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

    // 事件委派：綁定在全域的看板元件容器上
    const boardEl = document.getElementById('kanban-board-el');
    if (boardEl) {
      boardEl.addEventListener('click', async (e) => {
        // 尋找點擊所在的卡片
        const card = e.target.closest('.task-card');
        if (!card) return;
        const taskId = card.getAttribute('data-task-id');

        // Check if clicked the ::before pseudo-element in the top-left area
        const rect = card.getBoundingClientRect();
        const isClickOnPseudo = (
          e.clientX >= rect.left + 8 &&
          e.clientX <= rect.left + 95 &&
          e.clientY >= rect.top + 5 &&
          e.clientY <= rect.top + 28
        );

        if (isClickOnPseudo) {
          e.stopPropagation();
          e.preventDefault();

          // Remove any existing task action popup
          const oldPopup = document.getElementById('task-action-popup');
          if (oldPopup) oldPopup.remove();

          const popup = el('div', {
            id: 'task-action-popup',
            class: 'task-action-popup'
          });
          popup.style.left = `${e.pageX}px`;
          popup.style.top = `${e.pageY}px`;

          const openBtn = el('button', { type: 'button', class: 'btn-secondary' }, '開啟');
          openBtn.onclick = () => {
            navigate(`#/task/${taskId}`);
            popup.remove();
          };

          const shareBtn = el('button', { type: 'button', class: 'btn-secondary' }, '分享');
          shareBtn.onclick = async () => {
            const shareUrl = `${window.location.origin}${window.location.pathname}#/task/${taskId}`;
            try {
              await navigator.clipboard.writeText(shareUrl);
              alert('分享連結已複製到剪貼簿！');
            } catch (err) {
              alert(`分享連結：${shareUrl}`);
            }
            popup.remove();
          };

          const copyIdBtn = el('button', { type: 'button', class: 'btn-secondary' }, '複製 id');
          copyIdBtn.onclick = async () => {
            try {
              await navigator.clipboard.writeText(taskId);
              alert('任務 ID 已複製到剪貼簿！');
            } catch (err) {
              alert(`任務 ID：${taskId}`);
            }
            popup.remove();
          };

          popup.appendChild(openBtn);
          popup.appendChild(shareBtn);
          popup.appendChild(copyIdBtn);
          document.body.appendChild(popup);

          const closeHandler = (clickEv) => {
            if (!popup.contains(clickEv.target)) {
              popup.remove();
              document.removeEventListener('click', closeHandler);
            }
          };
          setTimeout(() => {
            document.addEventListener('click', closeHandler);
          }, 0);
          return;
        }

        // 判斷點擊的是否為動作按鈕
        const actionEl = e.target.closest('[data-action]');
        if (actionEl && canManageTask) {
          const action = actionEl.getAttribute('data-action');
          if (action === 'archive') {
            await archiveTask(taskId);
          } else if (action === 'delete') {
            await deleteTask(taskId);
          } else if (action === 'transition') {
            const newStatus = actionEl.getAttribute('data-status');
            // 限制：切換至 Doing 時，必須有負責人
            if (newStatus === 'Doing' && !(isMainWorkspace && state.userEmail === MAIN_OWNER_EMAIL)) {
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
          }
          return;
        }

        // 判斷點擊的是否為卡片文字或背景跳轉區域
        const clickable = e.target.closest('.clickable-section');
        if (clickable) {
          navigate(`#/task/${taskId}`);
        }
      });
    }

    // 事件綁定：專案篩選與封存切換
    const filterSelect = document.getElementById('project-filter-select');
    let lastSelectedProject = filterSelect ? filterSelect.value : 'all';

    if (filterSelect) {
      filterSelect.addEventListener('change', async () => {
        const val = filterSelect.value;
        if (val === '__create_new__') {
          if (!canManageTask) {
            filterSelect.value = lastSelectedProject;
            return;
          }
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

    loadAllData();
  }
};
