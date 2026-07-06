'use strict';

// ── 全域狀態（記憶體） ───────────────────────────────────────────
const state = {
  workspaceId: null,
  workspaceName: null,
  taskId: null,
};

const ROLES = ['Viewer', 'Member', 'Admin', 'Owner'];
const STATUSES = ['Todo', 'Doing', 'Review', 'Done'];

const app = document.getElementById('app');

function navigate(hash) {
  location.hash = hash;
}

function formatTime(isoStr) {
  if (!isoStr) return '未知時間';
  const date = new Date(isoStr);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

// ── fetch 包裝 ──────────────────────────────────────────────────────
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path.replace(/^\//, ''), opts);
  if (res.status === 401) {
    sessionStorage.removeItem('user_email');
    navigate('#/login');
    throw new Error('尚未登入，請重新登入');
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `發生錯誤（HTTP ${res.status}）`);
  }
  return data;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function showError(id, err) {
  const val = err instanceof Error ? err.message : String(err);
  const el = document.getElementById(id);
  if (el) {
    el.textContent = val;
    el.style.display = 'block';
  } else {
    alert(val);
  }
}

// 建立 DOM element 的小 helper
function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'onclick' || k === 'onchange' || k === 'onsubmit') node[k] = v;
      else node.setAttribute(k, v);
    }
  }
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// ── Sidebar 動態更新 ───────────────────────────────────────────────
function updateSidebar() {
  const { prefix } = currentRoute();
  
  // 更新 nav 按鈕高亮
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`nav-${prefix}`);
  if (activeBtn) activeBtn.classList.add('active');

  const userEmail = sessionStorage.getItem('user_email');
  const userEmailEl = document.getElementById('sidebar-user-email');
  const logoutBtn = document.getElementById('logout-btn');
  const wsNav = document.getElementById('workspace-nav');
  const wsSection = document.getElementById('workspace-section');
  const wsNameEl = document.getElementById('sidebar-ws-name');

  if (userEmail) {
    userEmailEl.textContent = userEmail;
    logoutBtn.style.display = 'inline-flex';
  } else {
    userEmailEl.textContent = '';
    logoutBtn.style.display = 'none';
  }

  if (state.workspaceId) {
    wsNav.style.display = 'flex';
    wsSection.style.display = 'block';
    wsNameEl.textContent = state.workspaceName || '未命名';
  } else {
    wsNav.style.display = 'none';
    wsSection.style.display = 'none';
    wsNameEl.textContent = '未選擇';
  }
}

// ── Router ──────────────────────────────────────────────────────────
function currentRoute() {
  const raw = location.hash.slice(1) || '/login';
  const [path, queryStr] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { prefix: parts[0] || 'login', rest: parts.slice(1), query: new URLSearchParams(queryStr || '') };
}

function route() {
  const { prefix, rest, query } = currentRoute();
  let routePromise;
  switch (prefix) {
    case 'login': routePromise = renderLogin(); break;
    case 'forgot-password': routePromise = renderForgotPassword(); break;
    case 'reset-password': routePromise = renderResetPassword(query.get('token')); break;
    case 'workspaces': routePromise = renderWorkspaces(); break;
    case 'tasks': routePromise = renderTasks(); break;
    case 'task': routePromise = renderTasks(rest[0]); break;
    case 'members': routePromise = renderMembers(); break;
    case 'search': routePromise = renderSearch(); break;
    case 'audit': routePromise = renderAudit(); break;
    default: routePromise = renderLogin(); break;
  }
  updateSidebar();
  return routePromise;
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // 忽略
    }
    state.workspaceId = null;
    state.workspaceName = null;
    state.taskId = null;
    sessionStorage.removeItem('user_email');
    navigate('#/login');
  });
  route();
});

// ── 畫面：登入 ───────────────────────────────────────────────────
function renderLogin() {
  app.innerHTML = `
    <div class="sketch-box" style="max-width: 450px; margin: 3rem auto; padding: 2rem; background: #fff;">
      <h2 style="margin-top: 0; text-align: center; font-size: 2rem;">使用者登入</h2>
      <form id="login-form">
        <div>
          <label>電子信箱 (Email)</label>
          <input type="email" id="login-email" placeholder="example@test.local" required style="width: 100%;">
        </div>
        <div>
          <label>密碼 (Password)</label>
          <input type="password" id="login-password" required style="width: 100%;">
        </div>
        <button type="submit" style="width: 100%; margin-top: 1rem; font-size: 1.1rem; padding: 0.6rem;">登入</button>
      </form>
      <p id="login-error" class="error" style="display: none; margin-top: 1rem;"></p>
      <div style="margin-top: 1.5rem; text-align: center; display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.95rem;">
        <span class="muted">預設帳號: user01@test.local / test1234</span>
        <a href="#/forgot-password" class="muted">忘記密碼？</a>
      </div>
    </div>
  `;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    try {
      await api('/api/auth/login', { method: 'POST', body: { email, password } });
      sessionStorage.setItem('user_email', email);
      navigate('#/workspaces');
    } catch (err) {
      showError('login-error', err);
    }
  });
}

// ── 畫面：忘記密碼 ───────────────────────────────────────────────
function renderForgotPassword() {
  app.innerHTML = `
    <div class="sketch-box" style="max-width: 450px; margin: 3rem auto; padding: 2rem; background: #fff;">
      <h2 style="margin-top: 0; text-align: center; font-size: 2rem;">忘記密碼</h2>
      <p class="muted" style="font-size: 0.95rem; margin-bottom: 1.5rem;">輸入您的 Email，系統將會寄送密碼重設連結到您的信箱（模擬寄信將會輸出在伺服器終端機 Console）。</p>
      <form id="forgot-form">
        <div>
          <label>電子信箱 (Email)</label>
          <input type="email" id="forgot-email" required style="width: 100%;">
        </div>
        <button type="submit" style="width: 100%; margin-top: 1rem; font-size: 1.1rem; padding: 0.6rem;">寄送重設連結</button>
      </form>
      <p id="forgot-message" class="message" style="display: none; margin-top: 1rem;"></p>
      <div style="margin-top: 1.5rem; text-align: center;">
        <a href="#/login" class="muted">返回登入</a>
      </div>
    </div>
  `;
  document.getElementById('forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value;
    try {
      const data = await api('/api/auth/forgot-password', { method: 'POST', body: { email } });
      const msgEl = document.getElementById('forgot-message');
      msgEl.textContent = data.message || '若該 email 已註冊，重設連結已寄出';
      msgEl.className = 'message';
      msgEl.style.display = 'block';
    } catch (err) {
      showError('forgot-message', err);
    }
  });
}

// ── 畫面：重設密碼 ───────────────────────────────────────────────
function renderResetPassword(token) {
  if (!token) {
    app.innerHTML = `
      <div class="sketch-box" style="max-width: 450px; margin: 3rem auto; padding: 2rem; background: #fff; text-align: center;">
        <h2 style="margin-top:0;">重設密碼</h2>
        <p class="error">缺少重設 token，請重新從 email 連結進入。</p>
        <a href="#/login" class="nav-btn" style="margin-top: 1rem;">返回登入</a>
      </div>
    `;
    return;
  }
  app.innerHTML = `
    <div class="sketch-box" style="max-width: 450px; margin: 3rem auto; padding: 2rem; background: #fff;">
      <h2 style="margin-top: 0; text-align: center;">重設密碼</h2>
      <form id="reset-form">
        <div>
          <label>新密碼 (New Password)</label>
          <input type="password" id="reset-password-input" required style="width: 100%;">
        </div>
        <button type="submit" style="width: 100%; margin-top: 1rem;">重設密碼</button>
      </form>
      <p id="reset-message" class="message" style="display: none; margin-top: 1rem;"></p>
    </div>
  `;
  document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('reset-password-input').value;
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: { token, password } });
      const msg = document.getElementById('reset-message');
      msg.textContent = '密碼已重設，請重新登入。';
      msg.className = 'message';
      msg.style.display = 'block';
      msg.appendChild(document.createElement('br'));
      const link = el('a', { href: '#/login', class: 'nav-btn', style: 'margin-top:0.8rem; display:inline-block;' }, '前往登入');
      msg.appendChild(link);
    } catch (err) {
      showError('reset-message', err);
    }
  });
}

// ── 畫面：Workspace 列表 ──────────────────────────────────────────
function renderWorkspaces() {
  app.innerHTML = `
    <div class="sketch-box" style="padding: 1.5rem; background: #fff; margin-bottom: 2rem;">
      <h2 style="margin-top: 0;">建立工作區 (Workspace)</h2>
      <form id="create-ws-form" style="display: flex; gap: 0.5rem; max-width: 500px;">
        <input type="text" id="ws-name-input" placeholder="例如: 個人專案 / 團隊工作區" required style="flex-grow: 1;">
        <button type="submit">建立工作區</button>
      </form>
      <p id="ws-error" class="error" style="display: none; margin-top: 1rem;"></p>
    </div>

    <h2 style="margin-bottom: 1rem;">我的工作區列表</h2>
    <div id="ws-list-container" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.5rem;">
      <!-- 卡片列表動態載入 -->
    </div>
  `;

  async function load() {
    const list = document.getElementById('ws-list-container');
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
        
        const title = el('h3', { style: 'margin: 0 0 0.8rem 0; font-size:1.4rem;' }, row.name);
        card.appendChild(title);

        const status = el('div', { style: 'font-size:0.9rem; margin-bottom: 0.8rem;' });
        status.appendChild(document.createTextNode('狀態: '));
        const statusBadge = el('span', { class: 'badge' }, row.status);
        statusBadge.style.backgroundColor = row.status === 'Active' ? 'var(--highlight-done)' : 'var(--highlight-archived)';
        status.appendChild(statusBadge);
        card.appendChild(status);

        const footer = el('div', { class: 'muted', style: 'font-size:0.8rem; border-top:1px dashed #ccc; padding-top:0.5rem; text-align:right;' }, `建立於: ${new Date(row.created_at).toLocaleDateString()}`);
        card.appendChild(footer);

        card.addEventListener('click', () => {
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
      await load();
    } catch (err) {
      showError('ws-error', err);
    }
  });

  load();
}

// ── Workspace 守門 ─────────────────────────────────────────────────
function requireWorkspace() {
  if (!state.workspaceId) {
    app.innerHTML = `
      <div class="sketch-box" style="padding: 2rem; background: #fff; text-align: center; max-width: 500px; margin: 3rem auto;">
        <h2>尚未選擇工作區</h2>
        <p class="muted">請先回到工作區選單選擇一個工作區以繼續。</p>
        <a href="#/workspaces" class="nav-btn" style="margin-top: 1rem; display:inline-block;">前往選擇工作區</a>
      </div>
    `;
    return false;
  }
  return true;
}

// ── 畫面：看板 (Kanban Board) ──────────────────────────────────────
function renderTasks(openTaskId = null) {
  if (!requireWorkspace()) return;

  app.innerHTML = `
    <!-- Kanban Top Header -->
    <div class="kanban-header-bar">
      <h2>Kanban Board</h2>
      
      <!-- Project Filter and Manage Inline -->
      <div class="kanban-filters">
        <form id="create-project-form" style="display:inline-flex; gap:0.4rem; align-items:center;">
          <input type="text" id="project-name-input" placeholder="新專案名稱" required style="font-size:0.85rem; padding:0.25rem 0.5rem; width:130px;">
          <button type="submit" style="font-size:0.8rem; padding:0.25rem 0.5rem;">+ 專案</button>
        </form>
        
        <label style="margin-left: 1rem; font-weight: bold;">
          專案篩選:
          <select id="project-filter-select" style="font-size: 0.9rem; padding: 0.25rem 0.5rem;">
            <option value="all">所有專案</option>
            <option value="none">無專案</option>
          </select>
        </label>
        
        <label style="margin-left: 1rem; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 0.3rem;">
          <input type="checkbox" id="toggle-archived-checkbox"> 顯示已歸檔
        </label>
      </div>
    </div>

    <p id="task-error" class="error" style="display: none; margin-bottom: 1.5rem;"></p>

    <!-- 4/5 Column Kanban Board -->
    <div class="kanban-board" id="kanban-board-el">
      <div class="kanban-column col-todo">
        <div class="kanban-column-title">Todo</div>
        <div class="kanban-cards" id="cards-Todo"></div>
      </div>
      <div class="kanban-column col-doing">
        <div class="kanban-column-title">Doing</div>
        <div class="kanban-cards" id="cards-Doing"></div>
      </div>
      <div class="kanban-column col-review">
        <div class="kanban-column-title">Review</div>
        <div class="kanban-cards" id="cards-Review"></div>
      </div>
      <div class="kanban-column col-done">
        <div class="kanban-column-title">Done</div>
        <div class="kanban-cards" id="cards-Done"></div>
      </div>
      <div class="kanban-column col-archived" id="col-Archived-el" style="display: none;">
        <div class="kanban-column-title">Archived</div>
        <div class="kanban-cards" id="cards-Archived"></div>
      </div>
    </div>

    <!-- Quick Add Task Card -->
    <div class="quick-add-task sketch-box">
      <h3 style="margin-top:0;">+ 建立新任務</h3>
      <form id="create-task-form">
        <div class="quick-add-grid">
          <div>
            <label>任務名稱 *</label>
            <input type="text" id="task-title-input" placeholder="輸入任務主旨" required>
          </div>
          <div>
            <label>描述</label>
            <input type="text" id="task-desc-input" placeholder="簡短任務說明（選填）">
          </div>
          <div>
            <label>優先度</label>
            <select id="task-priority-select">
              <option value="Low">Low</option>
              <option value="Medium" selected>Medium</option>
              <option value="High">High</option>
            </select>
          </div>
          <div>
            <label>專案</label>
            <select id="task-project-select">
              <option value="">-- 無專案 --</option>
            </select>
          </div>
          <div>
            <label>指派人員</label>
            <select id="task-assignee-select">
              <option value="">-- 無負責人 --</option>
            </select>
          </div>
          <div>
            <label>截止日期</label>
            <input type="date" id="task-due-date-input">
          </div>
        </div>
        <div class="quick-add-btn-container">
          <button type="submit">+ 新增任務卡片</button>
        </div>
      </form>
    </div>
  `;

  let cachedTasks = [];
  let cachedProjects = [];
  let cachedMembers = [];
  let projectMap = new Map();
  let memberMap = new Map();

  async function loadAllData() {
    try {
      const [tasks, members, workspaces] = await Promise.all([
        api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/tasks`),
        api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/members`),
        api('/api/workspaces')
      ]);

      const allProjectsArrays = await Promise.all(
        workspaces.map(w => 
          api(`/api/workspaces/${encodeURIComponent(w.workspace_id)}/projects`)
            .catch(() => [])
        )
      );

      const allProjects = [];
      const workspaceMap = new Map(workspaces.map(w => [w.workspace_id, w.name]));
      
      allProjectsArrays.forEach((projList, index) => {
        const wsId = workspaces[index].workspace_id;
        const wsName = workspaceMap.get(wsId) || '';
        projList.forEach(p => {
          allProjects.push({
            project_id: p.project_id,
            workspace_id: p.workspace_id,
            name: `${p.name} (${wsName})`,
            rawName: p.name
          });
        });
      });

      const currentWorkspaceProjects = allProjects.filter(p => p.workspace_id === state.workspaceId);

      cachedTasks = tasks;
      cachedProjects = currentWorkspaceProjects;
      cachedMembers = members;
      
      projectMap = new Map(allProjects.map(p => [p.project_id, p.rawName]));
      memberMap = new Map(members.map(m => [m.user_id, m.email]));

      // 填充篩選選單
      const filterSelect = document.getElementById('project-filter-select');
      const prevFilterVal = filterSelect.value;
      filterSelect.innerHTML = `
        <option value="all">所有專案</option>
        <option value="none">無專案</option>
      `;
      for (const p of currentWorkspaceProjects) {
        filterSelect.appendChild(el('option', { value: p.project_id }, p.rawName));
      }
      filterSelect.value = prevFilterVal;

      // 填充表單下拉 (顯示所有工作區的專案)
      const formProjectSelect = document.getElementById('task-project-select');
      formProjectSelect.innerHTML = '<option value="">-- 無專案 --</option>';
      for (const p of allProjects) {
        formProjectSelect.appendChild(el('option', { value: p.project_id }, p.name));
      }

      const formAssigneeSelect = document.getElementById('task-assignee-select');
      formAssigneeSelect.innerHTML = '<option value="">-- 無負責人 --</option>';
      for (const m of members) {
        formAssigneeSelect.appendChild(el('option', { value: m.user_id }, m.email));
      }

      renderKanbanCards(cachedTasks, projectMap, memberMap);

      // 如果有指定開啟任務，則彈出 modal
      if (openTaskId) {
        openTaskDetailModal(openTaskId);
      }
    } catch (err) {
      showError('task-error', err);
    }
  }

  function renderKanbanCards(tasks, projectMap, memberMap) {
    const columns = ['Todo', 'Doing', 'Review', 'Done', 'Archived'];
    columns.forEach(s => {
      const container = document.getElementById(`cards-${s}`);
      if (container) container.textContent = '';
    });

    const projectFilterVal = document.getElementById('project-filter-select').value;
    const showArchived = document.getElementById('toggle-archived-checkbox').checked;

    // 控制封存欄位顯示
    const archivedCol = document.getElementById('col-Archived-el');
    const boardEl = document.getElementById('kanban-board-el');
    if (showArchived) {
      archivedCol.style.display = 'flex';
      boardEl.classList.add('show-archived-col');
    } else {
      archivedCol.style.display = 'none';
      boardEl.classList.remove('show-archived-col');
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
        const email = memberMap.get(task.assignee_id) || '未知成員';
        midEl.appendChild(el('div', { class: 'task-card-assignee' }, `Assignee: ${email}`));
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

  async function archiveTask(taskId) {
    try {
      await api(`/api/tasks/${taskId}/archive`, { method: 'POST' });
      await loadAllData();
    } catch (err) {
      showError('task-error', err);
    }
  }

  async function deleteTask(taskId) {
    if (!confirm('確定要刪除這項任務嗎？此動作無法復原。')) return;
    try {
      await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
      await loadAllData();
    } catch (err) {
      showError('task-error', err);
    }
  }

  // ── 任務詳情彈出視窗 (Modal Overlay) ──────────────────────────────────
  async function openTaskDetailModal(taskId) {
    // 移除舊的 modal
    const existingModal = document.getElementById('task-detail-modal');
    if (existingModal) existingModal.remove();

    const currentTask = cachedTasks.find(t => t.task_id === taskId);
    if (!currentTask) {
      alert('找不到該任務，或已被刪除！');
      navigate('#/tasks');
      return;
    }

    let titleInput, descInput;
    const originalTitle = currentTask.title;
    const originalDesc = currentTask.description || '';

    const isModified = () => {
      const curTitle = (titleInput ? titleInput.value.trim() : originalTitle);
      const curDesc = (descInput ? descInput.value : originalDesc);
      return curTitle !== originalTitle || curDesc !== originalDesc;
    };

    const closeModalOrShake = () => {
      if (isModified()) {
        closeBtn.classList.add('shake-anim');
        closeBtn.addEventListener('animationend', () => {
          closeBtn.classList.remove('shake-anim');
        }, { once: true });
      } else {
        cleanupAndClose();
      }
    };

    const cleanupAndClose = () => {
      document.removeEventListener('keydown', escHandler);
      overlay.remove();
      navigate('#/tasks');
    };

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModalOrShake();
      }
    };
    document.addEventListener('keydown', escHandler);

    const overlay = el('div', { id: 'task-detail-modal', class: 'modal-overlay' });
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        closeModalOrShake();
      }
    };

    const container = el('div', { class: 'modal-container sketch-box' });
    
    // 關閉按鈕 [X]
    const closeBtn = el('button', { type: 'button', class: 'modal-close-btn' }, '×');
    closeBtn.onclick = closeModalOrShake;
    container.appendChild(closeBtn);

    // Modal Content Grid
    const detailContainer = el('div', { class: 'task-detail-container' });
    
    // Left side: Name, Description, Comments
    const leftEl = el('div', { class: 'task-detail-left' });
    
    // Name & Description Section
    const contentSec = el('div', { class: 'detail-section sketch-box' });
    
    contentSec.appendChild(el('label', { style: 'font-size:1.15rem; font-weight:bold; display:block; margin-bottom:0.3rem;' }, '任務名稱 *'));
    titleInput = el('input', { type: 'text', value: currentTask.title, required: true, style: 'width:100%; margin-bottom:1rem;' });
    contentSec.appendChild(titleInput);
    
    contentSec.appendChild(el('label', { style: 'font-size:1.15rem; font-weight:bold; display:block; margin-bottom:0.3rem;' }, '任務詳細描述'));
    descInput = el('textarea', { rows: '5', placeholder: '無描述。輸入些什麼以建立任務說明...', style: 'width:100%; margin-bottom:1rem;' });
    descInput.value = currentTask.description || '';
    contentSec.appendChild(descInput);
    
    const saveBtnGroup = el('div', { style: 'display:flex; justify-content:flex-end;' });
    const saveBtn = el('button', { type: 'button' }, '儲存');
    saveBtn.onclick = async () => {
      const valTitle = titleInput.value.trim();
      const valDesc = descInput.value;
      if (!valTitle) {
        alert('錯誤：任務名稱為必填欄位！');
        return;
      }
      try {
        // 依序發送變更（因後端限制 PATCH 一次只能改一個欄位）
        if (valTitle !== currentTask.title) {
          await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { title: valTitle } });
        }
        if (valDesc !== (currentTask.description || '')) {
          await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { description: valDesc } });
        }
        await loadAllData();
      } catch (err) {
        alert(err.message);
      }
    };
    saveBtnGroup.appendChild(saveBtn);
    contentSec.appendChild(saveBtnGroup);
    
    leftEl.appendChild(contentSec);

    // Comments Section
    const commSec = el('div', { class: 'detail-section sketch-box' });
    commSec.appendChild(el('h3', {}, '留言板'));
    const commList = el('ul', { class: 'comments-timeline' });
    const commForm = el('form', { style: 'margin-top:1rem; display:flex; gap:0.5rem;' });
    const commInput = el('input', { type: 'text', placeholder: '撰寫您的留言...', required: true, style: 'flex-grow:1;' });
    const commSubmit = el('button', { type: 'submit' }, '留言');
    commForm.appendChild(commInput);
    commForm.appendChild(commSubmit);
    commSec.appendChild(commList);
    commSec.appendChild(commForm);
    const commErr = el('p', { class: 'error', style: 'display:none;' });
    commSec.appendChild(commErr);
    
    async function loadComments() {
      commList.textContent = '';
      commErr.style.display = 'none';
      try {
        const rows = await api(`/api/tasks/${taskId}/comments`);
        if (rows.length === 0) {
          commList.appendChild(el('li', { class: 'muted', style: 'list-style:none; text-align:center;' }, '（尚無留言）'));
          return;
        }
        const currentEmail = sessionStorage.getItem('user_email');
        for (const c of rows) {
          const item = el('li', { class: 'comment-item' });
          const header = el('div', { class: 'comment-header' });
          const authorEmail = memberMap.get(c.user_id) || `成員 (${c.user_id.slice(0, 8)})`;
          header.appendChild(el('span', { class: 'comment-author' }, authorEmail));

          if (currentEmail && authorEmail === currentEmail) {
            header.appendChild(el('span', { class: 'badge', style: 'font-size:0.7rem; background:rgba(99,102,241,0.1); border-color:#6366f1; color:#6366f1; margin-left: 0.3rem;' }, '我'));
          }

          if (c.created_at) {
            header.appendChild(el('span', { class: 'muted', style: 'font-size:0.75rem; margin-left: auto;' }, formatTime(c.created_at)));
          }

          item.appendChild(header);

          const bodyContainer = el('div', { class: 'comment-body' });
          const contentText = el('span', { class: 'comment-content-text' }, c.content);
          bodyContainer.appendChild(contentText);
          item.appendChild(bodyContainer);

          if (currentEmail && authorEmail === currentEmail) {
            const actions = el('div', { class: 'comment-actions', style: 'margin-top:0.3rem;' });
            const editBtn = el('button', { type: 'button', class: 'btn-secondary', style: 'font-size:0.7rem; padding:0.15rem 0.4rem;' }, '編輯');
            
            editBtn.onclick = () => {
              if (editBtn.textContent === '編輯') {
                const input = el('input', { type: 'text', value: c.content, style: 'width: 100%; font-size: 0.85rem;' });
                bodyContainer.textContent = '';
                bodyContainer.appendChild(input);
                input.focus();
                editBtn.textContent = '儲存';
                
                input.onkeydown = async (ev) => {
                  if (ev.key === 'Enter') {
                    ev.preventDefault();
                    await saveEdit(input.value);
                  } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    await loadComments();
                  }
                };
              } else {
                const input = bodyContainer.querySelector('input');
                if (input) {
                  saveEdit(input.value);
                }
              }
            };

            async function saveEdit(newVal) {
              const val = newVal.trim();
              if (!val) {
                alert('留言內容不可為空！');
                return;
              }
              try {
                await api(`/api/comments/${c.comment_id}`, { method: 'PATCH', body: { content: val } });
                await loadComments();
              } catch (err) {
                alert(err.message);
              }
            }

            actions.appendChild(editBtn);
            item.appendChild(actions);
          }
          commList.appendChild(item);
        }
      } catch (err) {
        commErr.textContent = err.message;
        commErr.style.display = 'block';
      }
    }

    commForm.onsubmit = async (e) => {
      e.preventDefault();
      const content = commInput.value;
      try {
        await api(`/api/tasks/${taskId}/comments`, { method: 'POST', body: { content } });
        commInput.value = '';
        await loadComments();
      } catch (err) {
        commErr.textContent = err.message;
        commErr.style.display = 'block';
      }
    };
    leftEl.appendChild(commSec);
    detailContainer.appendChild(leftEl);

    // Right side: Attributes, Attachments
    const rightEl = el('div', { class: 'task-detail-right' });
    
    // Attributes
    const attrSec = el('div', { class: 'detail-section sketch-box' });
    attrSec.appendChild(el('h3', {}, '任務屬性'));
    
    // Status
    attrSec.appendChild(el('label', {}, '看板狀態'));
    const statusLine = el('div', { class: 'status-line-container' });
    const leftSlot = el('div', { class: 'status-btn-slot left-slot' });
    const badgeSlot = el('div', { class: 'status-badge-slot' });
    const rightSlot = el('div', { class: 'status-btn-slot right-slot' });

    const statusBadge = el('div', { class: 'badge', style: 'display:block; text-align:center; font-size:1.1rem; padding:0.3rem; margin:0;' }, currentTask.status);
    statusBadge.style.backgroundColor = `var(--highlight-${currentTask.status.toLowerCase()})`;
    badgeSlot.appendChild(statusBadge);

    function createTransitionBtn(text, status) {
      const btn = el('button', { type: 'button', style: 'width:100%; font-size:0.8rem; padding:0.25rem 0.4rem; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;' }, text);
      btn.onclick = async () => {
        // 限制：切換至 Doing 時，必須有負責人
        if (status === 'Doing') {
          const t = cachedTasks.find(x => x.task_id === taskId);
          if (t && !t.assignee_id) {
            alert('錯誤：切換至 Doing 狀態前，必須先指派負責人！');
            return;
          }
        }
        try {
          await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { status } });
          await loadAllData();
        } catch (err) {
          alert(err.message);
        }
      };
      return btn;
    }

    if (currentTask.status === 'Todo') {
      rightSlot.appendChild(createTransitionBtn('→ Doing', 'Doing'));
    } else if (currentTask.status === 'Doing') {
      leftSlot.appendChild(createTransitionBtn('← Todo', 'Todo'));
      rightSlot.appendChild(createTransitionBtn('Review →', 'Review'));
    } else if (currentTask.status === 'Review') {
      leftSlot.appendChild(createTransitionBtn('← Doing', 'Doing'));
      rightSlot.appendChild(createTransitionBtn('Done →', 'Done'));
    } else if (currentTask.status === 'Done') {
      leftSlot.appendChild(createTransitionBtn('← Review', 'Review'));
    }

    statusLine.appendChild(leftSlot);
    statusLine.appendChild(badgeSlot);
    statusLine.appendChild(rightSlot);
    attrSec.appendChild(statusLine);

    // Priority
    attrSec.appendChild(el('label', { style: 'margin-top:1rem; display:block;' }, '優先度'));
    const prioritySelect = el('select', { style: 'width:100%;' });
    ['Low', 'Medium', 'High'].forEach(p => {
      const opt = el('option', { value: p }, p);
      if (p === currentTask.priority) opt.selected = true;
      prioritySelect.appendChild(opt);
    });
    prioritySelect.onchange = async (e) => {
      try {
        await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { priority: e.target.value } });
        await loadAllData();
      } catch (err) {
        alert(err.message);
      }
    };
    attrSec.appendChild(prioritySelect);

    // Assignee
    attrSec.appendChild(el('label', { style: 'margin-top:1rem; display:block;' }, '指派'));
    const assigneeSelect = el('select', { style: 'width:100%;' });
    assigneeSelect.appendChild(el('option', { value: '' }, '-- 無負責人 --'));
    for (const m of cachedMembers) {
      const opt = el('option', { value: m.user_id }, m.email);
      if (m.user_id === currentTask.assignee_id) opt.selected = true;
      assigneeSelect.appendChild(opt);
    }
    assigneeSelect.onchange = async (e) => {
      const val = e.target.value || null;
      try {
        await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { assignee: val } });
        await loadAllData();
      } catch (err) {
        alert(err.message);
      }
    };
    attrSec.appendChild(assigneeSelect);

    // Due date
    attrSec.appendChild(el('label', { style: 'margin-top:1rem; display:block;' }, '截止日期'));
    const dueDateInput = el('input', { type: 'date', style: 'width:100%;' });
    if (currentTask.due_at) {
      dueDateInput.value = new Date(currentTask.due_at).toISOString().split('T')[0];
    }
    dueDateInput.onchange = async (e) => {
      const val = e.target.value ? new Date(e.target.value).toISOString() : null;
      try {
        await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { dueAt: val } });
        await loadAllData();
      } catch (err) {
        alert(err.message);
      }
    };
    attrSec.appendChild(dueDateInput);
    rightEl.appendChild(attrSec);

    // Attachments
    const attachSec = el('div', { class: 'detail-section sketch-box' });
    attachSec.appendChild(el('h3', {}, '附件'));
    const attachList = el('ul', { class: 'attachments-list' });
    const attachForm = el('form', { style: 'margin-top:1rem; display:flex; flex-direction:column; gap:0.5rem;' });
    const attachInput = el('input', { type: 'file', required: true, style: 'width:100%;' });
    const attachSubmit = el('button', { type: 'submit' }, '上傳附件');
    attachForm.appendChild(attachInput);
    attachForm.appendChild(attachSubmit);
    attachSec.appendChild(attachList);
    attachSec.appendChild(attachForm);
    const attachErr = el('p', { class: 'error', style: 'display:none;' });
    attachSec.appendChild(attachErr);

    async function loadAttachments() {
      attachList.textContent = '';
      attachErr.style.display = 'none';
      try {
        const rows = await api(`/api/tasks/${taskId}/attachments`);
        if (rows.length === 0) {
          attachList.appendChild(el('li', { class: 'muted', style: 'list-style:none; text-align:center;' }, '（尚無附件）'));
          return;
        }
        for (const a of rows) {
          const li = el('li', { class: 'attachment-item' });
          const link = el('a', { href: `api/attachments/${a.attachment_id}`, target: '_blank', download: a.original_name }, `${a.original_name} (${(a.size/1024).toFixed(1)} KB)`);
          li.appendChild(link);
          
          const delBtn = el('button', { type: 'button', class: 'btn-danger' }, '刪除');
          delBtn.onclick = async () => {
            if (!confirm('確定要刪除附件嗎？')) return;
            try {
              await api(`/api/attachments/${a.attachment_id}`, { method: 'DELETE' });
              await loadAttachments();
            } catch (err) {
              alert(err.message);
            }
          };
          li.appendChild(delBtn);
          attachList.appendChild(li);
        }
      } catch (err) {
        attachErr.textContent = err.message;
        attachErr.style.display = 'block';
      }
    }

    attachForm.onsubmit = async (e) => {
      e.preventDefault();
      const file = attachInput.files[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const res = await fetch(`api/tasks/${taskId}/attachments`, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Filename': encodeURIComponent(file.name),
          },
          body: buf,
        });
        if (res.status === 401) {
          sessionStorage.removeItem('user_email');
          navigate('#/login');
          return;
        }
        const text = await res.text();
        const data = text ? JSON.parse(text) : null;
        if (!res.ok) throw new Error((data && data.error) || `發生錯誤（HTTP ${res.status}）`);
        attachInput.value = '';
        await loadAttachments();
      } catch (err) {
        attachErr.textContent = err.message;
        attachErr.style.display = 'block';
      }
    };
    rightEl.appendChild(attachSec);
    detailContainer.appendChild(rightEl);

    const scrollArea = el('div', { class: 'modal-scroll-area' });
    scrollArea.appendChild(detailContainer);
    container.appendChild(scrollArea);
    overlay.appendChild(container);
    document.body.appendChild(overlay);

    // Initial loads
    await Promise.all([loadComments(), loadAttachments()]);
  }

  // 事件綁定：專案篩選與封存切換
  document.getElementById('project-filter-select').addEventListener('change', () => {
    renderKanbanCards(cachedTasks, projectMap, memberMap);
  });
  document.getElementById('toggle-archived-checkbox').addEventListener('change', () => {
    renderKanbanCards(cachedTasks, projectMap, memberMap);
  });

  // 專案建立
  document.getElementById('create-project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('project-name-input');
    const name = input.value;
    try {
      await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/projects`, {
        method: 'POST',
        body: { name }
      });
      input.value = '';
      await loadAllData();
    } catch (err) {
      showError('task-error', err);
    }
  });

  // 任務建立
  document.getElementById('create-task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('task-title-input').value;
    const description = document.getElementById('task-desc-input').value;
    const priority = document.getElementById('task-priority-select').value;
    const projectId = document.getElementById('task-project-select').value || null;
    const assigneeId = document.getElementById('task-assignee-select').value || null;
    const dueAtVal = document.getElementById('task-due-date-input').value;
    const dueAt = dueAtVal ? new Date(dueAtVal).toISOString() : null;

    try {
      await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/tasks`, {
        method: 'POST',
        body: { title, description, priority, projectId, assigneeId, dueAt }
      });
      document.getElementById('task-title-input').value = '';
      document.getElementById('task-desc-input').value = '';
      document.getElementById('task-priority-select').value = 'Medium';
      document.getElementById('task-project-select').value = '';
      document.getElementById('task-assignee-select').value = '';
      document.getElementById('task-due-date-input').value = '';
      await loadAllData();
    } catch (err) {
      showError('task-error', err);
    }
  });

  loadAllData();
}

// ── 畫面：成員管理 ───────────────────────────────────────────────
function renderMembers() {
  if (!requireWorkspace()) return;
  app.innerHTML = `
    <div class="sketch-box" style="padding: 1.5rem; background: #fff; margin-bottom: 2rem;">
      <h2 style="margin-top: 0;">邀請新成員</h2>
      <form id="invite-form" style="display: flex; gap: 0.5rem; flex-wrap: wrap; max-width: 600px;">
        <input type="email" id="invite-email" placeholder="成員 Email 帳號" required style="flex-grow: 1;">
        <select id="invite-role"></select>
        <button type="submit">邀請加入</button>
      </form>
      <p id="member-error" class="error" style="display: none; margin-top: 1rem;"></p>
    </div>

    <h2>成員清單 (Members)</h2>
    <table>
      <thead>
        <tr>
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
  for (const r of ROLES) inviteRoleSelect.appendChild(el('option', { value: r }, r));
  inviteRoleSelect.value = 'Member';

  async function load() {
    const tbody = document.getElementById('member-tbody');
    tbody.textContent = '';
    try {
      const rows = await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/members`);
      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;">（尚無成員）</td></tr>';
        return;
      }
      for (const m of rows) {
        const tr = el('tr');
        tr.appendChild(el('td', { style: 'font-weight: bold;' }, m.email));

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

  document.getElementById('invite-form').addEventListener('submit', async (e) => {
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

  load();
}

// ── 畫面：搜尋 ───────────────────────────────────────────────────
function renderSearch() {
  if (!requireWorkspace()) return;
  app.innerHTML = `
    <div class="sketch-box" style="padding: 1.5rem; background: #fff; margin-bottom: 2rem;">
      <h2 style="margin-top:0;">搜尋</h2>
      <form id="search-form" style="display: flex; gap: 0.5rem;">
        <input type="text" id="search-input" placeholder="輸入關鍵字搜尋任務、專案或留言..." required style="flex-grow: 1;">
        <button type="submit">搜尋</button>
      </form>
      <p id="search-error" class="error" style="display: none; margin-top: 1rem;"></p>
    </div>

    <div id="search-results" class="search-results-section"></div>
  `;

  document.getElementById('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = document.getElementById('search-input').value;
    const results = document.getElementById('search-results');
    results.textContent = '搜尋中...';
    try {
      const data = await api(`/api/search?workspace=${encodeURIComponent(state.workspaceId)}&q=${encodeURIComponent(q)}`);
      results.textContent = '';

      // Render Tasks
      const taskGroup = el('div', { class: 'result-group' });
      taskGroup.appendChild(el('h3', {}, `任務搜尋結果 (${data.tasks.length})`));
      const taskList = el('ul', { class: 'result-list' });
      if (data.tasks.length === 0) {
        taskList.appendChild(el('li', { class: 'muted' }, '（查無匹配任務）'));
      } else {
        for (const t of data.tasks) {
          const li = el('li');
          const link = el('a', { href: `#/task/${t.task_id}` }, `${t.title} [${t.status}]`);
          li.appendChild(link);
          taskList.appendChild(li);
        }
      }
      taskGroup.appendChild(taskList);
      results.appendChild(taskGroup);

      // Render Projects
      const projGroup = el('div', { class: 'result-group' });
      projGroup.appendChild(el('h3', {}, `專案搜尋結果 (${data.projects.length})`));
      const projList = el('ul', { class: 'result-list' });
      if (data.projects.length === 0) {
        projList.appendChild(el('li', { class: 'muted' }, '（查無匹配專案）'));
      } else {
        for (const p of data.projects) {
          projList.appendChild(el('li', {}, p.name));
        }
      }
      projGroup.appendChild(projList);
      results.appendChild(projGroup);

      // Render Comments
      const commGroup = el('div', { class: 'result-group' });
      commGroup.appendChild(el('h3', {}, `留言搜尋結果 (${data.comments.length})`));
      const commList = el('ul', { class: 'result-list' });
      if (data.comments.length === 0) {
        commList.appendChild(el('li', { class: 'muted' }, '（查無匹配留言）'));
      } else {
        for (const c of data.comments) {
          const li = el('li');
          const link = el('a', { href: `#/task/${c.task_id}` }, `留言內容: "${c.content.slice(0, 40)}..."`);
          li.appendChild(link);
          commList.appendChild(li);
        }
      }
      commGroup.appendChild(commList);
      results.appendChild(commGroup);
    } catch (err) {
      showError('search-error', err);
    }
  });
}

// ── 畫面：審計日誌 (Audit Trail) ──────────────────────────────────
function renderAudit() {
  app.innerHTML = `
    <div class="sketch-box" style="padding: 1.5rem; background: #fff; margin-bottom: 2rem;">
      <h2 style="margin-top: 0;">工作區審計日誌</h2>
      <p class="muted" style="font-size:0.95rem; margin-bottom: 1.2rem;">輸入要查詢的聚合實體 ID (Aggregate ID) 進行完整事件流追蹤 (例如 Workspace UUID 或 Task UUID)。</p>
      <form id="audit-form" style="display: flex; gap: 0.5rem; max-width: 600px;">
        <input type="text" id="audit-aggregate-input" placeholder="輸入 aggregate_id" required style="flex-grow: 1;">
        <button type="submit">查詢審計鏈</button>
      </form>
      <p id="audit-error" class="error" style="display: none; margin-top: 1rem;"></p>
    </div>

    <div id="audit-results-container">
      <ul id="audit-list" class="audit-timeline"></ul>
    </div>
  `;

  function getReadableEventText(eventType, payload) {
    switch (eventType) {
      case 'workspace.created':
        return `建立了工作區 "${payload.name}"`;
      case 'workspace.renamed':
        return `將工作區重新命名為 "${payload.name}"`;
      case 'workspace.archived':
        return `封存了此工作區`;
      case 'workspace.deleted':
        return `刪除了此工作區`;
      case 'member.invited':
        return `邀請了使用者加入，指派角色為 ${payload.role}`;
      case 'member.joined':
        return `使用者接受邀請加入了工作區`;
      case 'member.role_changed':
        return `變更成員角色權限為 ${payload.role}`;
      case 'member.removed':
        return `移除了成員`;
      case 'task.created':
        return `建立了任務 "${payload.title}" (優先度: ${payload.priority})`;
      case 'task.title_changed':
        return `將任務重新命名為 "${payload.title}"`;
      case 'task.description_changed':
        return `修改了任務描述說明`;
      case 'task.status_changed':
        return `將任務看板狀態移至 "${payload.status}"`;
      case 'task.priority_changed':
        return `將任務優先度修改為 "${payload.priority}"`;
      case 'task.assignee_changed':
        return payload.assigneeId ? `將任務指派給負責人` : `移除了任務負責人指派`;
      case 'task.due_date_changed':
        return payload.dueAt ? `變更任務截止日期為 ${new Date(payload.dueAt).toLocaleDateString()}` : `移除了截止日期`;
      case 'task.archived':
        return `封存了此任務`;
      case 'task.deleted':
        return `移除了此任務`;
      default:
        return `執行了 "${eventType}" 操作`;
    }
  }

  document.getElementById('audit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const aggregateId = document.getElementById('audit-aggregate-input').value;
    const list = document.getElementById('audit-list');
    list.textContent = '載入中...';
    try {
      const events = await api(`/api/audit?aggregate_id=${encodeURIComponent(aggregateId)}`);
      list.textContent = '';
      if (events.length === 0) {
        list.appendChild(el('li', { class: 'muted', style: 'list-style:none; text-align:center; padding: 2rem;' }, '（無相關事件日誌）'));
        return;
      }
      for (const ev of events) {
        const card = el('div', { class: 'audit-card sketch-box' });
        
        const header = el('div', { class: 'audit-card-header' });
        header.appendChild(el('span', { style: 'font-weight:bold; font-size:1.15rem; color:#475569;' }, ev.event_type));
        header.appendChild(el('span', { class: 'muted', style: 'font-size:0.85rem;' }, new Date(ev.occurred_at).toLocaleString()));
        card.appendChild(header);

        // Readable payload description
        const readableText = getReadableEventText(ev.event_type, ev.payload);
        card.appendChild(el('div', { style: 'font-size: 1.15rem; margin: 0.6rem 0; font-weight: bold; color: #1e3a8a;' }, readableText));

        // Metadata (actor, IP)
        const actor = ev.metadata?.actor_id || '系統 (System)';
        const ip = ev.metadata?.ip || 'unknown';
        const userAgent = ev.metadata?.user_agent || 'unknown';
        card.appendChild(el('div', { class: 'audit-card-meta' }, `操作者: ${actor} | IP: ${ip}`));

        // JSON block toggle
        const detailsBtn = el('button', { type: 'button', style: 'padding: 0.1rem 0.4rem; font-size: 0.75rem; margin-top: 0.5rem;' }, '顯示原始資料');
        const pre = el('pre', { class: 'audit-card-payload', style: 'display:none; margin-top: 0.5rem; max-height: 250px; overflow: auto;' });
        pre.textContent = JSON.stringify({ payload: ev.payload, metadata: ev.metadata }, null, 2);
        
        detailsBtn.onclick = () => {
          if (pre.style.display === 'none') {
            pre.style.display = 'block';
            detailsBtn.textContent = '隱藏原始資料';
          } else {
            pre.style.display = 'none';
            detailsBtn.textContent = '顯示原始資料';
          }
        };

        card.appendChild(detailsBtn);
        card.appendChild(pre);
        list.appendChild(card);
      }
    } catch (err) {
      showError('audit-error', err);
    }
  });
}
