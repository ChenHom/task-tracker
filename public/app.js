'use strict';

// ── 全域狀態（記憶體，不用 localStorage）───────────────────────────
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

// ── fetch 包裝：JSON in/out，401 一律導回登入頁 ─────────────────────
// path 一律用相對路徑（去掉開頭 /），讓瀏覽器依目前頁面網址解析——
// 這樣不管這支 app 是掛在網站根目錄還是 nginx 的某個 path prefix 下都正確，
// 不用寫死 prefix。呼叫端仍可寫 '/api/...'，這裡統一去掉開頭斜線。
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path.replace(/^\//, ''), opts);
  if (res.status === 401) {
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
  document.getElementById(id).textContent = value;
}

function showError(id, err) {
  setText(id, err instanceof Error ? err.message : String(err));
}

// 建立 DOM element 的小 helper：所有動態文字一律走 textContent，不碰 innerHTML。
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

// ── Router：hash 前綴查表 + switch，無 pattern-matching 抽象 ────────
function currentRoute() {
  const raw = location.hash.slice(1) || '/login'; // 去掉開頭的 '#'
  const [path, queryStr] = raw.split('?');
  const parts = path.split('/').filter(Boolean); // '/tasks' -> ['tasks']
  return { prefix: parts[0] || 'login', rest: parts.slice(1), query: new URLSearchParams(queryStr || '') };
}

function route() {
  const { prefix, rest, query } = currentRoute();
  switch (prefix) {
    case 'login': return renderLogin();
    case 'forgot-password': return renderForgotPassword();
    case 'reset-password': return renderResetPassword(query.get('token'));
    case 'workspaces': return renderWorkspaces();
    case 'tasks': return renderTasks();
    case 'task': return renderTaskDetail(rest[0]);
    case 'members': return renderMembers();
    case 'search': return renderSearch();
    case 'audit': return renderAudit();
    default: return renderLogin();
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // 忽略：反正接下來都會導去登入頁
    }
    state.workspaceId = null;
    state.workspaceName = null;
    state.taskId = null;
    navigate('#/login');
  });
  route();
});

// ── 畫面：登入 ───────────────────────────────────────────────────
function renderLogin() {
  app.innerHTML = `
    <h2>登入</h2>
    <form id="login-form">
      <div><label>Email <input type="email" id="login-email" required></label></div>
      <div><label>Password <input type="password" id="login-password" required></label></div>
      <button type="submit">登入</button>
    </form>
    <p id="login-error" class="error"></p>
    <p><a href="#/forgot-password">忘記密碼？</a></p>
  `;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    try {
      await api('/api/auth/login', { method: 'POST', body: { email, password } });
      navigate('#/workspaces');
    } catch (err) {
      showError('login-error', err);
    }
  });
}

// ── 畫面：忘記密碼 ───────────────────────────────────────────────
function renderForgotPassword() {
  app.innerHTML = `
    <h2>忘記密碼</h2>
    <form id="forgot-form">
      <div><label>Email <input type="email" id="forgot-email" required></label></div>
      <button type="submit">寄送重設連結</button>
    </form>
    <p id="forgot-message"></p>
    <p><a href="#/login">回登入</a></p>
  `;
  document.getElementById('forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value;
    try {
      const data = await api('/api/auth/forgot-password', { method: 'POST', body: { email } });
      setText('forgot-message', data.message || '若該 email 已註冊，重設連結已寄出');
    } catch (err) {
      showError('forgot-message', err);
    }
  });
}

// ── 畫面：重設密碼（token 從 hash query 帶入）───────────────────────
function renderResetPassword(token) {
  if (!token) {
    app.innerHTML = `<h2>重設密碼</h2><p class="error">缺少重設 token，請重新從 email 連結進入。</p><p><a href="#/login">回登入</a></p>`;
    return;
  }
  app.innerHTML = `
    <h2>重設密碼</h2>
    <form id="reset-form">
      <div><label>新密碼 <input type="password" id="reset-password-input" required></label></div>
      <button type="submit">重設密碼</button>
    </form>
    <p id="reset-message"></p>
  `;
  document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('reset-password-input').value;
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: { token, password } });
      const msg = document.getElementById('reset-message');
      msg.textContent = '密碼已重設，請重新登入。';
      msg.className = 'message';
      msg.appendChild(document.createElement('br'));
      const link = el('a', { href: '#/login' }, '前往登入');
      msg.appendChild(link);
    } catch (err) {
      showError('reset-message', err);
    }
  });
}

// ── 畫面：Workspace 列表 + 建立 ──────────────────────────────────
function renderWorkspaces() {
  app.innerHTML = `
    <h2>Workspaces</h2>
    <form id="create-ws-form">
      <input type="text" id="ws-name-input" placeholder="workspace 名稱" required>
      <button type="submit">建立</button>
    </form>
    <p id="ws-error" class="error"></p>
    <ul id="ws-list"></ul>
  `;

  async function load() {
    const list = document.getElementById('ws-list');
    list.textContent = '';
    try {
      const rows = await api('/api/workspaces');
      if (rows.length === 0) {
        list.appendChild(el('li', { class: 'muted' }, '（尚無 workspace）'));
      }
      for (const row of rows) {
        const li = el('li');
        const btn = el('button', { type: 'button' }, `${row.name} [${row.status}]`);
        btn.addEventListener('click', () => {
          state.workspaceId = row.workspace_id;
          state.workspaceName = row.name;
          navigate('#/tasks');
        });
        li.appendChild(btn);
        list.appendChild(li);
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

// 小工具：workspace-scoped 畫面若尚未選 workspace，顯示提示並中止。
function requireWorkspace() {
  if (!state.workspaceId) {
    app.innerHTML = `<p>請先<a href="#/workspaces">選擇一個 workspace</a>。</p>`;
    return false;
  }
  return true;
}

function workspaceSubnav() {
  return `
    <p class="muted">
      Workspace: <span id="ws-name-label"></span> —
      <a href="#/tasks">Tasks</a> |
      <a href="#/members">Members</a> |
      <a href="#/search">Search</a> |
      <a href="#/audit">Audit</a>
    </p>
  `;
}

// ── 畫面：Task 列表 ──────────────────────────────────────────────
function renderTasks() {
  if (!requireWorkspace()) return;
  app.innerHTML = `
    <h2>Tasks</h2>
    ${workspaceSubnav()}
    <form id="create-task-form">
      <div><input type="text" id="task-title-input" placeholder="title（必填）" required></div>
      <div><input type="text" id="task-desc-input" placeholder="description（選填）"></div>
      <button type="submit">新增 task</button>
    </form>
    <p id="task-error" class="error"></p>
    <table>
      <thead><tr><th>Title</th><th>Status</th><th>Priority</th><th>操作</th></tr></thead>
      <tbody id="task-tbody"></tbody>
    </table>
  `;
  setText('ws-name-label', state.workspaceName || state.workspaceId);

  async function load() {
    const tbody = document.getElementById('task-tbody');
    tbody.textContent = '';
    try {
      const rows = await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/tasks`);
      for (const task of rows) {
        const tr = el('tr');

        const titleTd = el('td');
        const titleLink = el('a', { href: '#' }, task.title);
        titleLink.addEventListener('click', (e) => {
          e.preventDefault();
          state.taskId = task.task_id;
          navigate(`#/task/${task.task_id}`);
        });
        titleTd.appendChild(titleLink);
        tr.appendChild(titleTd);

        const statusTd = el('td');
        const select = el('select');
        for (const s of STATUSES) {
          const opt = el('option', { value: s }, s);
          if (s === task.status) opt.selected = true;
          select.appendChild(opt);
        }
        if (task.status === 'Archived') {
          // Archived 不在下拉選單裡；額外附一個唯讀選項讓畫面看得出現況。
          const archivedOpt = el('option', { value: 'Archived' }, 'Archived');
          archivedOpt.selected = true;
          select.insertBefore(archivedOpt, select.firstChild);
        }
        select.addEventListener('change', async () => {
          try {
            await api(`/api/tasks/${task.task_id}`, { method: 'PATCH', body: { status: select.value } });
            await load();
          } catch (err) {
            showError('task-error', err);
            await load(); // 還原成伺服器現況
          }
        });
        statusTd.appendChild(select);
        tr.appendChild(statusTd);

        tr.appendChild(el('td', {}, task.priority));

        const actionsTd = el('td');
        const archiveBtn = el('button', { type: 'button' }, 'Archive');
        archiveBtn.addEventListener('click', async () => {
          try {
            await api(`/api/tasks/${task.task_id}/archive`, { method: 'POST' });
            await load();
          } catch (err) {
            showError('task-error', err);
          }
        });
        const deleteBtn = el('button', { type: 'button' }, 'Delete');
        deleteBtn.addEventListener('click', async () => {
          try {
            await api(`/api/tasks/${task.task_id}`, { method: 'DELETE' });
            await load();
          } catch (err) {
            showError('task-error', err);
          }
        });
        actionsTd.appendChild(archiveBtn);
        actionsTd.appendChild(deleteBtn);
        tr.appendChild(actionsTd);

        tbody.appendChild(tr);
      }
    } catch (err) {
      showError('task-error', err);
    }
  }

  document.getElementById('create-task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('task-title-input').value;
    const description = document.getElementById('task-desc-input').value;
    try {
      await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/tasks`, {
        method: 'POST',
        body: { title, description },
      });
      document.getElementById('task-title-input').value = '';
      document.getElementById('task-desc-input').value = '';
      await load();
    } catch (err) {
      showError('task-error', err);
    }
  });

  load();
}

// ── 畫面：Task 詳情（comments + attachments）────────────────────────
function renderTaskDetail(taskId) {
  if (!requireWorkspace()) return;
  if (!taskId) {
    app.innerHTML = `<p class="error">缺少 task id。</p><p><a href="#/tasks">回 Task 列表</a></p>`;
    return;
  }
  state.taskId = taskId;
  app.innerHTML = `
    <h2>Task 詳情</h2>
    ${workspaceSubnav()}
    <p><a href="#/tasks">← 回 Task 列表</a></p>
    <p class="muted">task_id: <span id="detail-task-id"></span></p>

    <h3>Comments</h3>
    <ul id="comment-list"></ul>
    <form id="comment-form">
      <input type="text" id="comment-input" placeholder="留言內容" required>
      <button type="submit">送出</button>
    </form>
    <p id="comment-error" class="error"></p>

    <h3>Attachments</h3>
    <ul id="attachment-list"></ul>
    <form id="attachment-form">
      <input type="file" id="attachment-input" required>
      <button type="submit">上傳</button>
    </form>
    <p id="attachment-error" class="error"></p>
  `;
  setText('ws-name-label', state.workspaceName || state.workspaceId);
  setText('detail-task-id', taskId);

  async function loadComments() {
    const list = document.getElementById('comment-list');
    list.textContent = '';
    try {
      const rows = await api(`/api/tasks/${taskId}/comments`);
      for (const c of rows) {
        list.appendChild(el('li', {}, c.content));
      }
    } catch (err) {
      showError('comment-error', err);
    }
  }

  async function loadAttachments() {
    const list = document.getElementById('attachment-list');
    list.textContent = '';
    try {
      const rows = await api(`/api/tasks/${taskId}/attachments`);
      for (const a of rows) {
        const li = el('li');
        const link = el('a', { href: `api/attachments/${a.attachment_id}` }, `${a.original_name} (${a.size} bytes)`);
        li.appendChild(link);
        const delBtn = el('button', { type: 'button' }, '刪除');
        delBtn.addEventListener('click', async () => {
          try {
            await api(`/api/attachments/${a.attachment_id}`, { method: 'DELETE' });
            await loadAttachments();
          } catch (err) {
            showError('attachment-error', err);
          }
        });
        li.appendChild(document.createTextNode(' '));
        li.appendChild(delBtn);
        list.appendChild(li);
      }
    } catch (err) {
      showError('attachment-error', err);
    }
  }

  document.getElementById('comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = document.getElementById('comment-input').value;
    try {
      await api(`/api/tasks/${taskId}/comments`, { method: 'POST', body: { content } });
      document.getElementById('comment-input').value = '';
      await loadComments();
    } catch (err) {
      showError('comment-error', err);
    }
  });

  document.getElementById('attachment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('attachment-input');
    const file = input.files[0];
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
        navigate('#/login');
        return;
      }
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error((data && data.error) || `發生錯誤（HTTP ${res.status}）`);
      input.value = '';
      await loadAttachments();
    } catch (err) {
      showError('attachment-error', err);
    }
  });

  loadComments();
  loadAttachments();
}

// ── 畫面：Member 管理 ───────────────────────────────────────────
function renderMembers() {
  if (!requireWorkspace()) return;
  app.innerHTML = `
    <h2>Members</h2>
    ${workspaceSubnav()}
    <form id="invite-form">
      <input type="email" id="invite-email" placeholder="email" required>
      <select id="invite-role"></select>
      <button type="submit">邀請</button>
    </form>
    <p id="member-error" class="error"></p>
    <table>
      <thead><tr><th>Email</th><th>Role</th><th>Joined</th><th>操作</th></tr></thead>
      <tbody id="member-tbody"></tbody>
    </table>
  `;
  setText('ws-name-label', state.workspaceName || state.workspaceId);

  const inviteRoleSelect = document.getElementById('invite-role');
  for (const r of ROLES) inviteRoleSelect.appendChild(el('option', { value: r }, r));

  async function load() {
    const tbody = document.getElementById('member-tbody');
    tbody.textContent = '';
    try {
      const rows = await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/members`);
      for (const m of rows) {
        const tr = el('tr');
        tr.appendChild(el('td', {}, m.email));

        const roleTd = el('td');
        const select = el('select');
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

        tr.appendChild(el('td', {}, m.joined_at));

        const actionsTd = el('td');
        const removeBtn = el('button', { type: 'button' }, '移除');
        removeBtn.addEventListener('click', async () => {
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

// ── 畫面：Search ─────────────────────────────────────────────────
function renderSearch() {
  if (!requireWorkspace()) return;
  app.innerHTML = `
    <h2>Search</h2>
    ${workspaceSubnav()}
    <form id="search-form">
      <input type="text" id="search-input" placeholder="搜尋 task / project / comment">
      <button type="submit">搜尋</button>
    </form>
    <p id="search-error" class="error"></p>
    <div id="search-results"></div>
  `;
  setText('ws-name-label', state.workspaceName || state.workspaceId);

  document.getElementById('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = document.getElementById('search-input').value;
    const results = document.getElementById('search-results');
    results.textContent = '';
    try {
      const data = await api(
        `/api/search?workspace=${encodeURIComponent(state.workspaceId)}&q=${encodeURIComponent(q)}`,
      );

      const tasksH = el('h3', {}, `Tasks (${data.tasks.length})`);
      results.appendChild(tasksH);
      const taskList = el('ul');
      for (const t of data.tasks) taskList.appendChild(el('li', {}, `${t.title} [${t.status}]`));
      results.appendChild(taskList);

      const projH = el('h3', {}, `Projects (${data.projects.length})`);
      results.appendChild(projH);
      const projList = el('ul');
      for (const p of data.projects) projList.appendChild(el('li', {}, p.name));
      results.appendChild(projList);

      const commH = el('h3', {}, `Comments (${data.comments.length})`);
      results.appendChild(commH);
      const commList = el('ul');
      for (const c of data.comments) commList.appendChild(el('li', {}, c.content));
      results.appendChild(commList);
    } catch (err) {
      showError('search-error', err);
    }
  });
}

// ── 畫面：Audit ──────────────────────────────────────────────────
function renderAudit() {
  app.innerHTML = `
    <h2>Audit</h2>
    <form id="audit-form">
      <input type="text" id="audit-aggregate-input" placeholder="aggregate_id" required>
      <button type="submit">查詢</button>
    </form>
    <p id="audit-error" class="error"></p>
    <ul id="audit-list"></ul>
  `;

  document.getElementById('audit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const aggregateId = document.getElementById('audit-aggregate-input').value;
    const list = document.getElementById('audit-list');
    list.textContent = '';
    try {
      const events = await api(`/api/audit?aggregate_id=${encodeURIComponent(aggregateId)}`);
      if (events.length === 0) {
        list.appendChild(el('li', { class: 'muted' }, '（沒有事件）'));
      }
      for (const ev of events) {
        const li = el('li');
        li.appendChild(el('strong', {}, `${ev.event_type} `));
        li.appendChild(el('span', { class: 'muted' }, ev.occurred_at));
        const pre = el('pre');
        pre.textContent = JSON.stringify({ payload: ev.payload, metadata: ev.metadata }, null, 2);
        li.appendChild(pre);
        list.appendChild(li);
      }
    } catch (err) {
      showError('audit-error', err);
    }
  });
}
