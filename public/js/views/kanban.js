'use strict';

import { api } from '../api.js';
import {
  state,
  hasRole,
  MAIN_WORKSPACE_ID,
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_TITLE,
  MAIN_DISCUSSION_DESCRIPTION_TEMPLATE
} from '../state.js';
import { navigate } from '../router.js';
import { el, showError, formatTime, requireWorkspace } from '../utils.js';
import { openTaskDetailModal } from './task-detail.js';
import { syncGlobalWorkspaces } from '../sidebar.js';

/**
 * Renders a deep-link failure message (task not found / no access) in place of the board.
 * @param {HTMLElement} container - The DOM container element where the page is rendered.
 * @param {string} message - Human-readable failure reason from the API or lookup.
 * @returns {void}
 */
function renderTaskLinkError(container, message) {
  container.innerHTML = '';
  const box = el('div', {
    class: 'sketch-box task-link-error-card'
  });
  box.appendChild(el('h2', {}, '無法開啟此任務'));
  box.appendChild(el('p', { class: 'error' }, message));
  box.appendChild(el('a', {
    href: '#/workspaces',
    class: 'nav-btn task-link-error-link'
  }, '前往工作區清單'));
  container.appendChild(box);
}

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
    // Check if we are opening a specific task via `#/task/:taskId`
    // The router registers both 'tasks' and 'task' view.
    // When prefix is 'task', rest[0] contains the task ID.
    const openTaskId = rest && rest[0];

    // Cold start / refresh landing directly on #/task/:id: state.workspaceId is
    // still empty (it's in-memory only), so resolve it from the task itself
    // before falling back to the "no workspace selected" placeholder.
    if (!state.workspaceId && openTaskId) {
      container.innerHTML = '<p class="muted task-link-loading-placeholder">載入任務中...</p>';
      let task;
      try {
        task = await api(`/api/tasks/${openTaskId}`);
      } catch (err) {
        renderTaskLinkError(container, err.message);
        return;
      }
      let ws = state.globalWorkspaces.find(w => w.workspace_id === task.workspace_id);
      if (!ws) {
        await syncGlobalWorkspaces();
        ws = state.globalWorkspaces.find(w => w.workspace_id === task.workspace_id);
      }
      if (!ws) {
        renderTaskLinkError(container, '找不到此任務所屬的工作區，或您無權限存取');
        return;
      }
      state.workspaceId = ws.workspace_id;
      state.workspaceName = ws.name;
    }

    if (!requireWorkspace(container)) return;
    const renderWorkspaceId = state.workspaceId;
    let loadGeneration = 0;

    const savedShowArchived = sessionStorage.getItem(`kanban_filter_show_archived_${renderWorkspaceId}`) === 'true';

    const isMainWorkspace = renderWorkspaceId === MAIN_WORKSPACE_ID;
    let currentRole = 'Viewer';
    let canCreateTask = false;
    let canManageTask = false;

    container.innerHTML = `
      <!-- Kanban Top Header -->
      <div class="kanban-header-bar">
        <div class="kanban-title-wrapper">
          <h2 class="red-pen-underline" style="margin-bottom: 0.8rem;">
            Board
          </h2>
          <div class="kanban-workspace-name" id="kanban-workspace-name-el" style="font-size: 1.1rem; font-weight: bold; margin-top: 0.4rem; color: var(--pencil-color);">
            看板：${state.workspaceName || ''}
          </div>
          <section id="project-context" class="sketch-box" aria-live="polite" title="目前為總覽；選擇 Project 後顯示描述、repo 與 active Goal。">目前為總覽；選擇 Project 後顯示描述、repo 與 active Goal。</section>
        </div>
        
        <!-- Project Filter and Manage Inline -->
        <div class="kanban-filters">
          <label class="project-filter-label">
            <span class="filter-label">專案篩選:</span>
            <select id="project-filter-select">
              <option value="all">所有專案</option>
              <option value="none">無專案</option>
            </select>
          </label>
          <input id="project-search-input" type="search" placeholder="搜尋 Project" aria-label="搜尋 Project">
          <label><input type="checkbox" id="show-archived-projects"> 顯示已封存 Project</label>
          <button type="button" id="create-project-button" class="btn-secondary">新增 Project</button>
          <button type="button" id="manage-project-button" class="btn-secondary">編輯選取 Project</button>
          
          <label class="toggle-archived-label">
            <input type="checkbox" id="toggle-archived-checkbox"${savedShowArchived ? ' checked' : ''}>
            <span class="desktop-text">顯示已歸檔</span>
            <span class="mobile-text">已歸檔</span>
          </label>
        </div>
      </div>
      <dialog id="project-dialog" aria-labelledby="project-dialog-title">
        <form id="project-form" method="dialog" class="goal-toolbar">
          <h3 id="project-dialog-title">建立 Project</h3>
          <label>名稱 <input id="project-name" required maxlength="200"></label>
          <label>描述 <textarea id="project-description" maxlength="2000"></textarea></label>
          <label>已登記 target repo <select id="project-target-repo"></select></label>
          <p id="project-repo-empty-hint" class="muted" hidden>尚無已登記 repo；設定方式見 docs/operations.md「Goal-driven collaboration」。</p>
          <div><button type="submit" id="project-submit">建立</button><button type="button" id="project-dialog-cancel" class="btn-secondary">取消</button></div>
          <button type="button" id="project-archive-selected" class="btn-danger">封存目前選取的 Project</button>
        </form>
      </dialog>

      ${isMainWorkspace ? `
        <section class="main-workspace-policy" aria-label="主工作區協作規則">
          <strong>主工作區協作規則</strong>
          <span>只討論，不在主工作區實作。</span>
          <span>所有人可新增 Todo 與留言。</span>
          <span>user01 先留下方向，再通知成員討論。</span>
          <span>期限後直接完成討論；實作另開於目標工作區。</span>
          <span>原討論只記錄工作區與 TASK 名稱。</span>
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
          <div class="kanban-column-title"><span>Doing</span></div>
          <div class="kanban-cards" id="cards-Doing"></div>
        </div>
        <div class="kanban-column col-review">
          <div class="kanban-column-title"><span>Review</span></div>
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
      for (const colStatus of ['Todo']) {
        const btnSlot = document.getElementById(`add-btn-${colStatus}`);
        const formSlot = document.getElementById(`add-form-${colStatus}`);
        if (btnSlot) btnSlot.textContent = '';
        if (formSlot) formSlot.textContent = '';
      }
    }

    function setupInlineAdders() {
      clearInlineAdders();
      if (!canCreateTask) return;
      const colStatuses = ['Todo'];
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
          const descriptionInput = isMainWorkspace
            ? el('textarea', {
                class: 'column-add-task-description',
                rows: '4',
                'aria-label': '討論描述'
              })
            : null;
          const projectSelect = el('select', { class: 'column-add-task-project', 'aria-label': 'Project' });
          projectSelect.appendChild(el('option', { value: '' }, '無 Project'));
          cachedProjects.filter(project => project.status === 'active').forEach(project => {
            projectSelect.appendChild(el('option', { value: project.project_id }, project.name));
          });
          const currentProject = document.getElementById('project-filter-select')?.value;
          if (currentProject && !['all', 'none'].includes(currentProject)) projectSelect.value = currentProject;
          if (descriptionInput) descriptionInput.value = MAIN_DISCUSSION_DESCRIPTION_TEMPLATE;
          const submitBtn = el('button', { type: 'submit', class: 'column-add-task-submit' }, '確認');
          const cancelBtn = el('button', {
            type: 'button',
            class: 'column-add-task-cancel'
          }, '✕');

          cancelBtn.onclick = () => { formSlot.textContent = ''; };

          form.appendChild(input);
          if (descriptionInput) form.appendChild(descriptionInput);
          if (hasRole(currentRole, 'Member')) form.appendChild(projectSelect);
          form.appendChild(submitBtn);
          form.appendChild(cancelBtn);

          form.onsubmit = async (e) => {
            e.preventDefault();
            const title = input.value.trim();
            if (!title) return;

            const description = descriptionInput ? descriptionInput.value : '';

            try {
              const body = hasRole(currentRole, 'Member')
                ? {
                    title,
                    description,
                    priority: 'Medium',
                    projectId: projectSelect.value || null,
                    assigneeId: null,
                    dueAt: null
                  }
                : { title, description };
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
    let cachedGoals = [];
    let cachedRepos = [];
    let memberMap = new Map();
    let memberEmailMap = new Map();

    /**
     * Executes async API requests to retrieve workspace tasks, projects, and members,
     * populates query filters, and renders individual kanban cards.
     * @returns {Promise<void>}
     */
    async function loadAllData() {
      if (state.workspaceId !== renderWorkspaceId) return;
      const generation = ++loadGeneration;
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
        const [tasks, projects, members, goals, repos] = await Promise.all([
          api(`/api/workspaces/${encodeURIComponent(renderWorkspaceId)}/tasks`),
          api(`/api/workspaces/${encodeURIComponent(renderWorkspaceId)}/projects`),
          api(`/api/workspaces/${encodeURIComponent(renderWorkspaceId)}/members`),
          api(`/api/workspaces/${encodeURIComponent(renderWorkspaceId)}/goals`),
          api(`/api/workspaces/${encodeURIComponent(renderWorkspaceId)}/repositories`)
        ]);
        if (generation !== loadGeneration || state.workspaceId !== renderWorkspaceId) return;
        cachedTasks = tasks;
        cachedProjects = projects;
        cachedMembers = members;
        cachedGoals = goals;
        cachedRepos = repos;
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
          const prevFilterVal = sessionStorage.getItem(`kanban_filter_project_${renderWorkspaceId}`) || filterSelect.value || 'all';
          filterSelect.innerHTML = `
            <option value="all">所有專案</option>
            <option value="none">無專案</option>
          `;
          const showArchivedProjects = document.getElementById('show-archived-projects')?.checked;
          const search = (document.getElementById('project-search-input')?.value || '').trim().toLowerCase();
          for (const p of projects.filter(project => (project.status !== 'archived' || showArchivedProjects) && (!search || project.name.toLowerCase().includes(search)))) {
            filterSelect.appendChild(el('option', { value: p.project_id }, p.name));
          }
          if (prevFilterVal && Array.from(filterSelect.options).some(o => o.value === prevFilterVal)) {
            filterSelect.value = prevFilterVal;
          } else {
            filterSelect.value = 'all';
          }
        }

        const selectedProject = projects.find(project => project.project_id === filterSelect?.value);
        const context = document.getElementById('project-context');
        if (context) {
          const projectTasks = selectedProject
            ? cachedTasks.filter(task => task.project_id === selectedProject.project_id && task.status !== 'Archived')
            : [];
          const completedTasks = projectTasks.filter(task => task.status === 'Done').length;
          const progress = projectTasks.length ? `${completedTasks}/${projectTasks.length} (${Math.round(completedTasks / projectTasks.length * 100)}%)` : '0/0';
          context.textContent = selectedProject
            ? `${selectedProject.name} · ${selectedProject.description || '無描述'} · ${selectedProject.target_repo || '未設定 repo'} · 進度：${progress} · Active Goal：${goals.find(goal => goal.project_id === selectedProject.project_id && !['Done', 'Cancelled'].includes(goal.status))?.status || '無'}`
            : '目前為總覽；選擇 Project 後顯示描述、repo 與 active Goal。';
          context.title = context.textContent;
        }

        renderKanbanCards(cachedTasks, memberMap);

        // 如果有指定開啟任務，則彈出 modal
        if (openTaskId) {
          openTaskDetailModal(openTaskId, {
            cachedTasks,
            cachedProjects,
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
        if (generation === loadGeneration && state.workspaceId === renderWorkspaceId) {
          showError('task-error', err);
        }
      } finally {
        if (generation === loadGeneration && state.workspaceId === renderWorkspaceId && loadingOverlay) {
          loadingOverlay.remove();
        }
      }
    }

    /**
     * Distributes, filters, and renders individual task nodes within respective column elements.
     * @param {Array<Object>} tasks - Cached array of workspace tasks.
     * @param {Map<string, string>} memberMap - Member display names lookup.
     * @returns {void}
     */
    function renderKanbanCards(tasks, memberMap) {
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

        // Meta (Priority)
        const metaEl = el('div', { class: 'task-card-meta' });
        const pClass = `badge badge-${task.priority.toLowerCase()}`;
        metaEl.appendChild(el('span', { class: pClass }, task.priority));

        midEl.appendChild(metaEl);

        // Creator & Assignee
        if (task.creator_id || task.assignee_id) {
          const peopleEl = el('div', { class: 'task-card-people' });
          if (task.creator_id) {
            const creatorName = memberMap.get(task.creator_id) || '未知成員';
            peopleEl.appendChild(el('span', {}, `建：${creatorName}`));
          }
          if (task.assignee_id) {
            const assigneeName = memberMap.get(task.assignee_id) || '未知成員';
            peopleEl.appendChild(el('span', { class: 'task-card-assignee-label' }, `指：${assigneeName}`));
          }
          midEl.appendChild(peopleEl);
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
          if (isMainWorkspace) {
            if (task.title !== MAIN_POLICY_TITLE && task.status === 'Todo') {
              flowRight.appendChild(createStateBtn('→ Done', 'Done'));
            }
          } else if (task.status === 'Todo') {
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
              document.removeEventListener('keydown', escHandler, true);
            }
          };
          // Esc 先關這層 menu；全域 #/tasks 的返回 handler 看到 popup 還在就不會導頁
          const escHandler = (keyEv) => {
            if (keyEv.key !== 'Escape') return;
            popup.remove();
            document.removeEventListener('click', closeHandler);
            document.removeEventListener('keydown', escHandler, true);
          };
          document.addEventListener('keydown', escHandler, true);
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
    let lastSelectedProject = filterSelect ? filterSelect.value : (sessionStorage.getItem(`kanban_filter_project_${state.workspaceId}`) || 'all');

    if (filterSelect) {
      filterSelect.addEventListener('change', async () => {
        const val = filterSelect.value;
        lastSelectedProject = val;
        sessionStorage.setItem(`kanban_filter_project_${state.workspaceId}`, val);
        await loadAllData();
      });
    }

    const projectDialog = document.getElementById('project-dialog');
    let editingProjectId = null;
    const openProjectDialog = project => {
      editingProjectId = project?.project_id || null;
      document.getElementById('project-dialog-title').textContent = editingProjectId ? '編輯 Project' : '建立 Project';
      document.getElementById('project-submit').textContent = editingProjectId ? '儲存' : '建立';
      document.getElementById('project-name').value = project?.name || '';
      document.getElementById('project-description').value = project?.description || '';
      const repoSelect = document.getElementById('project-target-repo');
      repoSelect.textContent = '';
      repoSelect.appendChild(el('option', { value: '' }, '不設定（此 Project 無法啟動 Goal）'));
      for (const repo of cachedRepos) repoSelect.appendChild(el('option', { value: repo.targetRepo }, repo.targetRepo));
      repoSelect.value = project?.target_repo || '';
      document.getElementById('project-repo-empty-hint').hidden = cachedRepos.length !== 0;
      document.getElementById('project-archive-selected').hidden = !editingProjectId;
      projectDialog?.showModal();
    };
    document.getElementById('create-project-button')?.addEventListener('click', () => {
      if (canManageTask) openProjectDialog(null);
    });
    document.getElementById('manage-project-button')?.addEventListener('click', () => {
      if (!canManageTask) return;
      const project = cachedProjects.find(item => item.project_id === filterSelect?.value);
      if (!project) return showError('task-error', new Error('請先選取要編輯的 Project'));
      openProjectDialog(project);
    });
    document.getElementById('project-dialog-cancel')?.addEventListener('click', () => projectDialog?.close());
    document.getElementById('project-archive-selected')?.addEventListener('click', async () => {
      const projectId = editingProjectId;
      if (!projectId || projectId === 'all' || projectId === 'none') return showError('task-error', new Error('請先選取要封存的 Project'));
      try {
        await api(`/api/projects/${encodeURIComponent(projectId)}/archive`, { method: 'POST' });
        projectDialog?.close(); sessionStorage.setItem(`kanban_filter_project_${state.workspaceId}`, 'all'); await loadAllData();
      } catch (error) { showError('task-error', error); }
    });
    document.getElementById('project-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        const values = {
          name: document.getElementById('project-name').value,
          description: document.getElementById('project-description').value,
          targetRepo: document.getElementById('project-target-repo').value || null,
        };
        let selectedId = editingProjectId;
        if (editingProjectId) {
          const current = cachedProjects.find(project => project.project_id === editingProjectId);
          for (const [field, value] of Object.entries(values)) {
            const storedField = field === 'targetRepo' ? 'target_repo' : field;
            if (current?.[storedField] !== value) await api(`/api/projects/${encodeURIComponent(editingProjectId)}`, { method: 'PATCH', body: { [field]: value } });
          }
        } else {
          const res = await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/projects`, { method: 'POST', body: values });
          selectedId = res.id;
        }
        projectDialog?.close();
        sessionStorage.setItem(`kanban_filter_project_${state.workspaceId}`, selectedId);
        await loadAllData();
      } catch (error) { showError('task-error', error); }
    });
    document.getElementById('project-search-input')?.addEventListener('input', loadAllData);
    document.getElementById('show-archived-projects')?.addEventListener('change', loadAllData);

    const toggleArchivedCheckbox = document.getElementById('toggle-archived-checkbox');
    if (toggleArchivedCheckbox) {
      toggleArchivedCheckbox.addEventListener('change', () => {
        sessionStorage.setItem(`kanban_filter_show_archived_${state.workspaceId}`, toggleArchivedCheckbox.checked);
        renderKanbanCards(cachedTasks, memberMap);
      });
    }

    loadAllData();
  }
};
