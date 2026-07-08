'use strict';

import { api } from '../api.js';
import { state } from '../state.js';
import { el, formatTime } from '../utils.js';

/**
 * @typedef {Object} TaskDetailModalOptions
 * @property {Array<Object>} cachedTasks - Cache list of all workspace tasks.
 * @property {Array<Object>} cachedMembers - Cache list of workspace members.
 * @property {Map<string, string>} memberMap - Map associating user IDs to display names or emails.
 * @property {Map<string, string>} memberEmailMap - Map associating user IDs to emails.
 * @property {function(): Promise<void>|void} onUpdate - Reload trigger callback to execute on updates.
 */

/**
 * Renders the modal overlay popup representing the detailed task specifications,
 * comments workflow panel, and file attachments stream list.
 * @param {string} taskId - The ID of the task to load and interact with.
 * @param {TaskDetailModalOptions} options - Input details for synchronization.
 * @returns {Promise<void>}
 */
export async function openTaskDetailModal(taskId, { cachedTasks, cachedMembers, memberMap, memberEmailMap, onUpdate }) {
  // 移除舊的 modal 並執行其清理函數以清除全域監聽器
  const existingModal = document.getElementById('task-detail-modal');
  if (existingModal) {
    if (typeof existingModal.cleanup === 'function') {
      existingModal.cleanup();
    } else {
      existingModal.remove();
    }
  }

  const currentTask = cachedTasks.find(t => t.task_id === taskId);
  if (!currentTask) {
    alert('找不到該任務，或已被刪除！');
    location.hash = '#/tasks';
    return;
  }

  let titleInput, descInput, unsavedBadge;
  let overlay, container, closeBtn;
  let escHandler, hashChangeHandler;

  const originalTitle = currentTask.title;
  const originalDesc = currentTask.description || '';

  /**
   * Normalizes text by removing CRLF line endings and trimming whitespace.
   * @param {string|null|undefined} str - Raw text.
   * @returns {string} Normalized string.
   */
  const normalizeText = (str) => {
    if (str === null || str === undefined) return '';
    return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  };

  /**
   * Evaluates if changes were made to name/description inputs inside the form viewport.
   * @returns {boolean} True if modified, false otherwise.
   */
  const isModified = () => {
    const curTitle = normalizeText(titleInput ? titleInput.value : originalTitle);
    const curDesc = normalizeText(descInput ? descInput.value : originalDesc);
    const oTitle = normalizeText(originalTitle);
    const oDesc = normalizeText(originalDesc);
    return curTitle !== oTitle || curDesc !== oDesc;
  };

  /**
   * Shows the 'Unsaved' warning badge by sliding it out.
   * @returns {void}
   */
  const showUnsavedBadge = () => {
    if (unsavedBadge) {
      unsavedBadge.style.transform = 'translateX(0)';
      unsavedBadge.style.opacity = '1';
    }
  };

  /**
   * Hides the 'Unsaved' warning badge by sliding it back under the Save button.
   * @returns {void}
   */
  const hideUnsavedBadge = () => {
    if (unsavedBadge) {
      unsavedBadge.style.transform = 'translateX(100%)';
      unsavedBadge.style.opacity = '0';
    }
  };

  /**
   * Attempts to close the modal viewport. If modifications were performed, slides out 'Unsaved' warning and shakes the close button.
   * @returns {void}
   */
  const closeModalOrShake = () => {
    if (isModified()) {
      showUnsavedBadge();
      if (closeBtn) {
        closeBtn.classList.add('shake-anim');
        closeBtn.addEventListener('animationend', () => {
          closeBtn.classList.remove('shake-anim');
        }, { once: true });
      }
    } else {
      cleanupAndClose();
    }
  };

  /**
   * Detaches modal elements and removes global window/document event listeners.
   * @returns {void}
   */
  const cleanup = () => {
    if (escHandler) {
      document.removeEventListener('keydown', escHandler, true);
      window.removeEventListener('keydown', escHandler, true);
    }
    if (hashChangeHandler) window.removeEventListener('hashchange', hashChangeHandler);
    if (overlay) overlay.remove();
  };

  /**
   * Triggers navigation back to the main Kanban board URL hash.
   * @returns {void}
   */
  const cleanupAndClose = () => {
    location.hash = '#/tasks';
  };

  // Define global event handlers
  escHandler = (e) => {
    if (e.key === 'Escape' || e.keyCode === 27) {
      e.preventDefault();
      closeModalOrShake();
    }
  };

  hashChangeHandler = () => {
    if (!location.hash.startsWith(`#/task/${taskId}`)) {
      cleanup();
    }
  };

  // Register event listeners
  document.addEventListener('keydown', escHandler, true);
  window.addEventListener('keydown', escHandler, true);
  window.addEventListener('hashchange', hashChangeHandler);

  overlay = el('div', { id: 'task-detail-modal', class: 'modal-overlay' });
  overlay.cleanup = cleanup; // 綁定清理函數以供後續覆蓋時註銷監聽器
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      closeModalOrShake();
    }
  };

  container = el('div', { class: 'modal-container sketch-box' });
  
  // 關閉按鈕 [X]
  closeBtn = el('button', { type: 'button', class: 'modal-close-btn' }, '×');
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
  titleInput.addEventListener('focus', hideUnsavedBadge);
  contentSec.appendChild(titleInput);
  
  contentSec.appendChild(el('label', { style: 'font-size:1.15rem; font-weight:bold; display:block; margin-bottom:0.3rem;' }, '任務詳細描述'));
  descInput = el('textarea', { rows: '5', placeholder: '無描述。輸入些什麼以建立任務說明...', style: 'width:100%; margin-bottom:1rem;' });
  descInput.value = currentTask.description || '';
  descInput.addEventListener('focus', hideUnsavedBadge);
  contentSec.appendChild(descInput);
  
  const saveBtnGroup = el('div', { style: 'display:flex; justify-content:flex-end; margin-top:1rem;' });
  
  const saveWrapper = el('div', {
    style: 'position:relative; display:inline-flex; align-items:stretch; overflow:visible;'
  });

  unsavedBadge = el('div', {
    style: 'position: absolute; right: 100%; top: 3px; bottom: 3px; margin-right: -2.5px; background: #fff; color: #ef4444; border: 2px solid #000000; border-right: none; border-radius: 6px 0 0 6px; display: flex; align-items: center; justify-content: center; padding: 0 0.6rem; font-size: 0.85rem; font-weight: bold; z-index: 1; transform: translateX(100%); opacity: 0; pointer-events: none; transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1); white-space: nowrap;'
  }, '還未');

  const saveBtn = el('button', {
    type: 'button',
    style: 'position: relative; z-index: 2; background: #fff; margin: 0;'
  }, '儲存');

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
      hideUnsavedBadge();
      await onUpdate();
    } catch (err) {
      alert(err.message);
    }
  };

  saveWrapper.appendChild(unsavedBadge);
  saveWrapper.appendChild(saveBtn);
  saveBtnGroup.appendChild(saveWrapper);
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
  
  /**
   * Fetches comment lists and updates timeline list HTML components securely.
   * @returns {Promise<void>}
   */
  async function loadComments() {
    commList.textContent = '';
    commErr.style.display = 'none';
    try {
      const rows = await api(`/api/tasks/${taskId}/comments`);
      if (rows.length === 0) {
        commList.appendChild(el('li', { class: 'muted', style: 'list-style:none; text-align:center;' }, '（尚無留言）'));
        return;
      }
      const currentEmail = state.userEmail;
      for (const c of rows) {
        const item = el('li', { class: 'comment-item' });
        const header = el('div', { class: 'comment-header' });
        const authorEmail = memberEmailMap.get(c.user_id) || '';
        const authorName = memberMap.get(c.user_id) || `成員 (${c.user_id.slice(0, 8)})`;
        header.appendChild(el('span', { class: 'comment-author' }, authorName));

        if (currentEmail && authorEmail && authorEmail === currentEmail) {
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
                  ev.stopPropagation();
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

          /**
           * Submits updated comment content modifications to backend client endpoints.
           * @param {string} newVal - The edited content value.
           * @returns {Promise<void>}
           */
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

  /**
   * Helper mapping state transition button clicks with safety guards.
   * @param {string} text - Button caption string.
   * @param {string} status - Target workflow status parameter.
   * @returns {HTMLElement} State adjustment action button.
   */
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
        await onUpdate();
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
      await onUpdate();
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
    const opt = el('option', { value: m.user_id }, m.name || m.email);
    if (m.user_id === currentTask.assignee_id) opt.selected = true;
    assigneeSelect.appendChild(opt);
  }
  assigneeSelect.onchange = async (e) => {
    const val = e.target.value || null;
    try {
      await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { assignee: val } });
      await onUpdate();
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
      await onUpdate();
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

  /**
   * Fetches task attachment listings and appends list items with delete handlers.
   * @returns {Promise<void>}
   */
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
        state.clear();
        location.hash = '#/login';
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
