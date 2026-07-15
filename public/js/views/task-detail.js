'use strict';

import { api } from '../api.js';
import { state, hasRole, MAIN_OWNER_EMAIL, MAIN_POLICY_TITLE } from '../state.js';
import { el, formatTime } from '../utils.js';

/**
 * @typedef {Object} TaskDetailModalOptions
 * @property {Array<Object>} cachedTasks - Cache list of all workspace tasks.
 * @property {Array<Object>} cachedMembers - Cache list of workspace members.
 * @property {Map<string, string>} memberMap - Map associating user IDs to display names or emails.
 * @property {Map<string, string>} memberEmailMap - Map associating user IDs to emails.
 * @property {function(): Promise<void>|void} onUpdate - Reload trigger callback to execute on updates.
 * @property {string} [currentRole='Member'] - Current workspace role.
 * @property {boolean} [isMainWorkspace=false] - Whether this is the fixed collaboration workspace.
 */

/**
 * Renders the modal overlay popup representing the detailed task specifications,
 * comments workflow panel, and file attachments stream list.
 * @param {string} taskId - The ID of the task to load and interact with.
 * @param {TaskDetailModalOptions} options - Input details for synchronization.
 * @returns {Promise<void>}
 */
export async function openTaskDetailModal(taskId, {
  cachedTasks,
  cachedMembers,
  memberMap,
  memberEmailMap,
  onUpdate,
  query,
  currentRole = 'Member',
  isMainWorkspace = false
}) {
  // 移除舊的 modal 並執行其清理函數以清除全域監聽器
  const existingModal = document.getElementById('task-detail-modal');
  if (existingModal) {
    if (existingModal.isSaving) {
      return; // 正在進行儲存轉場時，跳過重新建立 Modal
    }
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

  const canManageTask = hasRole(currentRole, 'Member')
    && (!isMainWorkspace || state.userEmail === MAIN_OWNER_EMAIL);
  const canComment = hasRole(currentRole, 'Commenter');
  const currentEmail = (state.userEmail || '').trim().toLowerCase();
  const currentUserId = cachedMembers.find(member => member.email?.trim().toLowerCase() === currentEmail)?.user_id;
  const canEditDescription = canManageTask
    || (currentRole === 'Commenter' && Boolean(currentUserId) && currentTask.creator_id === currentUserId);

  let titleInput, descInput, unsavedBadge, saveBtn, commUnsavedBadge;
  let overlay, container, closeBtn;
  let escHandler, hashChangeHandler;
  let activeReplyBoxClickCloseHandler; // Track reply box click close handler to prevent memory leaks
  let hasScrolledToComment = false;
  let cachedComments = [];

  if (document.body && document.body.classList) {
    document.body.classList.add('modal-open');
  }

  let originalTitle = currentTask.title;
  let originalDesc = currentTask.description || '';

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
    if (document.body && document.body.classList) {
      document.body.classList.remove('modal-open');
    }
    if (escHandler) {
      document.removeEventListener('keydown', escHandler, true);
      window.removeEventListener('keydown', escHandler, true);
    }
    if (hashChangeHandler) window.removeEventListener('hashchange', hashChangeHandler);
    if (activeReplyBoxClickCloseHandler) {
      document.removeEventListener('click', activeReplyBoxClickCloseHandler);
    }
    const replySelectBox = document.getElementById('reply-select-box');
    if (replySelectBox) replySelectBox.remove();
    if (overlay) overlay.remove();
  };

  /**
   * Triggers navigation back to the main Kanban board URL hash.
   * @returns {void}
   */
  const cleanupAndClose = () => {
    location.hash = '#/tasks';
  };

  /**
   * Submits task name and description modifications to the API.
   * @returns {Promise<boolean>} True if saved successfully, false otherwise.
   */
  async function saveTask() {
    const valTitle = titleInput ? titleInput.value.trim() : currentTask.title;
    const valDesc = descInput.value;
    if (!valTitle) {
      alert('錯誤：任務名稱為必填欄位！');
      return false;
    }
    if (saveBtn) saveBtn.disabled = true;
    if (overlay) overlay.isSaving = true; // Mark as saving to prevent recreation of this modal
    try {
      // 依序發送變更（因後端限制 PATCH 一次只能改一個欄位）
      if (titleInput && valTitle !== currentTask.title) {
        await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { title: valTitle } });
      }
      if (valDesc !== (currentTask.description || '')) {
        await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { description: valDesc } });
      }
      hideUnsavedBadge();

      // Update local and cached values on success before onUpdate() runs
      originalTitle = valTitle;
      originalDesc = valDesc;
      currentTask.title = valTitle;
      currentTask.description = valDesc;

      await onUpdate();
      return true;
    } catch (err) {
      alert(err.message);
      return false;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (overlay) overlay.isSaving = false;
    }
  }

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

  contentSec.appendChild(el('label', {}, '任務名稱 *'));
  if (canManageTask) {
    titleInput = el('input', { type: 'text', value: currentTask.title, required: true });
    titleInput.addEventListener('focus', () => {
      hideUnsavedBadge();
      setTimeout(() => {
        if (unsavedBadge && unsavedBadge.style.opacity === '0') {
          unsavedBadge.textContent = '還未';
        }
      }, 300);
    });
    contentSec.appendChild(titleInput);
  } else {
    contentSec.appendChild(el('div', { class: 'task-readonly-title' }, currentTask.title));
  }

  contentSec.appendChild(el('label', {}, '任務詳細描述'));
  if (canEditDescription) {
    descInput = el('textarea', { rows: '5', placeholder: '無描述。輸入些什麼以建立任務說明...' });
    descInput.value = currentTask.description || '';
    descInput.addEventListener('focus', () => {
      hideUnsavedBadge();
      setTimeout(() => {
        if (unsavedBadge && unsavedBadge.style.opacity === '0') {
          unsavedBadge.textContent = '還未';
        }
      }, 300);
    });
    descInput.addEventListener('keydown', async (e) => {
      if ((window.innerWidth === undefined || window.innerWidth > 768) && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        descInput.blur();

        if (unsavedBadge) {
          unsavedBadge.textContent = '等待';
          unsavedBadge.offsetHeight;
          showUnsavedBadge();
        }

        const savePromise = saveTask();
        const delayPromise = new Promise(resolve => setTimeout(resolve, 400));
        const [success] = await Promise.all([savePromise, delayPromise]);

        if (success) {
          hideUnsavedBadge();
          await new Promise(resolve => setTimeout(resolve, 400));
          if (unsavedBadge) {
            unsavedBadge.textContent = '完成';
            unsavedBadge.offsetHeight;
            showUnsavedBadge();
          }
        } else {
          hideUnsavedBadge();
          await new Promise(resolve => setTimeout(resolve, 400));
          if (unsavedBadge) unsavedBadge.textContent = '還未';
        }
      }
    });

    const descWrapper = el('div', { class: 'autocomplete-desc-wrapper' });
    descWrapper.appendChild(descInput);
    contentSec.appendChild(descWrapper);
    bindAutocomplete(descInput, descWrapper, cachedMembers, () => cachedComments, memberMap, cachedTasks);

    const saveBtnGroup = el('div', { class: 'detail-save-btn-group' });
    const saveWrapper = el('div', { class: 'save-badge-wrapper' });
    unsavedBadge = el('div', { class: 'unsaved-badge-popup' }, '還未');
    saveBtn = el('button', { type: 'button', class: 'detail-save-btn' }, '儲存');
    saveBtn.onclick = async () => {
      if (unsavedBadge) {
        unsavedBadge.textContent = '等待';
        unsavedBadge.offsetHeight;
        showUnsavedBadge();
      }

      const savePromise = saveTask();
      const delayPromise = new Promise(resolve => setTimeout(resolve, 400));
      const [success] = await Promise.all([savePromise, delayPromise]);

      if (success) {
        hideUnsavedBadge();
        await new Promise(resolve => setTimeout(resolve, 400));
        if (unsavedBadge) {
          unsavedBadge.textContent = '完成';
          unsavedBadge.offsetHeight;
          showUnsavedBadge();
        }
      } else {
        hideUnsavedBadge();
        await new Promise(resolve => setTimeout(resolve, 400));
        if (unsavedBadge) {
          unsavedBadge.textContent = '還未';
        }
      }
    };
    saveWrapper.appendChild(unsavedBadge);
    saveWrapper.appendChild(saveBtn);
    saveBtnGroup.appendChild(saveWrapper);
    contentSec.appendChild(saveBtnGroup);
  } else {
    const description = el('div', { class: 'task-readonly-description' });
    if (currentTask.description) {
      description.appendChild(renderRichText(currentTask.description, cachedMembers, cachedComments, cachedTasks));
    } else {
      description.textContent = '（無描述）';
    }
    contentSec.appendChild(description);
  }
  
  leftEl.appendChild(contentSec);

  // Comments Section
  const commSec = el('div', { class: 'detail-section sketch-box' });
  commSec.appendChild(el('h3', {}, '留言板'));
  const commList = el('ul', { class: 'comments-timeline' });
  commSec.appendChild(commList);
  let commForm = null;
  let commInput = null;
  if (canComment) {
    commForm = el('form', { class: 'comment-form' });
    const placeholderText = window.innerWidth <= 768
      ? '撰寫您的留言...'
      : '撰寫您的留言... (Shift+Enter 換行)';
    commInput = el('textarea', {
      class: 'comment-textarea',
      placeholder: placeholderText,
      required: true,
      rows: '1'
    });
    const commSubmit = el('button', { type: 'submit', class: 'comment-submit-btn' }, '留言');

    commInput.addEventListener('input', () => {
      commInput.style.height = 'auto';
      const newHeight = Math.min(commInput.scrollHeight, 150);
      commInput.style.height = `${newHeight}px`;
    });
    commInput.addEventListener('focus', () => {
      commForm.classList.add('focused');
    });
    commInput.addEventListener('blur', () => {
      setTimeout(() => {
        commInput.style.height = '38px';
      }, 150);
      setTimeout(() => {
        commForm.classList.remove('focused');
      }, 200);
    });
    commInput.addEventListener('keydown', (e) => {
      if (window.innerWidth > 768 && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (typeof commForm.requestSubmit === 'function') {
          commForm.requestSubmit();
        } else {
          commForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }
    });

    const commWrapper = el('div', { class: 'autocomplete-comm-wrapper' });
    commWrapper.appendChild(commInput);
    
    const commSaveWrapper = el('div', { class: 'save-badge-wrapper' });
    commUnsavedBadge = el('div', { class: 'unsaved-badge-popup' }, '完成');
    commSaveWrapper.appendChild(commUnsavedBadge);
    commSaveWrapper.appendChild(commSubmit);

    commForm.appendChild(commWrapper);
    commForm.appendChild(commSaveWrapper);
    commSec.appendChild(commForm);
    bindAutocomplete(commInput, commWrapper, cachedMembers, () => cachedComments, memberMap, cachedTasks);
  }
  const commErr = el('p', { class: 'error' });
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
      cachedComments = rows; // Cache comments for autocomplete and rich links
      if (rows.length === 0) {
        commList.appendChild(el('li', { class: 'muted detail-empty-item' }, '（尚無留言）'));
        return;
      }
      const currentEmail = state.userEmail;
      
      rows.forEach((c, i) => {
        const item = el('li', { class: 'comment-item', id: `comment-${c.comment_id}` });
        const header = el('div', { class: 'comment-header' });
        const authorEmail = memberEmailMap.get(c.user_id) || '';
        const authorName = memberMap.get(c.user_id) || `成員 (${c.user_id.slice(0, 8)})`;
        
        // Dynamic serial number (#流水號)
        const serialSpan = el('span', {
          class: 'comment-serial'
        }, `#${i + 1}`);

        serialSpan.onclick = (e) => {
          e.stopPropagation();
          // Remove any existing reply select box first
          const oldBox = document.getElementById('reply-select-box');
          if (oldBox) oldBox.remove();
          if (activeReplyBoxClickCloseHandler) {
            document.removeEventListener('click', activeReplyBoxClickCloseHandler);
            activeReplyBoxClickCloseHandler = null;
          }

          // Create the Neo-brutalism styled selection box
          const selectBox = el('div', {
            id: 'reply-select-box',
            class: 'reply-select-box',
            style: `left: ${e.pageX}px; top: ${e.pageY}px;`
          });

          if (canComment) {
            const replyBtn = el('button', {
              type: 'button',
              class: 'btn-secondary'
            }, '回覆');

            replyBtn.onclick = () => {
              let summary = c.content.trim();
              if (summary.includes('\n')) summary = summary.split('\n')[0].trim();
              if (summary.length > 20) summary = summary.substring(0, 20) + '...';

              const replyText = `>> #${i + 1} @${authorName}: ${summary}\n`;
              commInput.focus();
              const start = commInput.selectionStart;
              const end = commInput.selectionEnd;
              const val = commInput.value;
              commInput.value = val.substring(0, start) + replyText + val.substring(end);
              commInput.selectionStart = commInput.selectionEnd = start + replyText.length;
              commInput.dispatchEvent(new Event('input'));

              selectBox.remove();
              if (activeReplyBoxClickCloseHandler) {
                document.removeEventListener('click', activeReplyBoxClickCloseHandler);
                activeReplyBoxClickCloseHandler = null;
              }
            };
            selectBox.appendChild(replyBtn);
          }

          const shareBtn = el('button', {
            type: 'button',
            class: 'btn-secondary'
          }, '分享');

          shareBtn.onclick = async () => {
            const shareUrl = `${window.location.origin}${window.location.pathname}#/task/${taskId}?comment=${c.comment_id}`;
            try {
              await navigator.clipboard.writeText(shareUrl);
              alert('分享連結已複製到剪貼簿！');
            } catch (err) {
              alert(`分享連結：${shareUrl}`);
            }
            selectBox.remove();
            if (activeReplyBoxClickCloseHandler) {
              document.removeEventListener('click', activeReplyBoxClickCloseHandler);
              activeReplyBoxClickCloseHandler = null;
            }
          };

          selectBox.appendChild(shareBtn);
          document.body.appendChild(selectBox);

          // Click anywhere outside to close
          activeReplyBoxClickCloseHandler = (clickEv) => {
            if (!selectBox.contains(clickEv.target)) {
              selectBox.remove();
              document.removeEventListener('click', activeReplyBoxClickCloseHandler);
              activeReplyBoxClickCloseHandler = null;
            }
          };
          // Add to next event loop tick so this click event doesn't trigger it immediately
          setTimeout(() => {
            if (activeReplyBoxClickCloseHandler) {
              document.addEventListener('click', activeReplyBoxClickCloseHandler);
            }
          }, 0);
        };

        header.appendChild(serialSpan);
        header.appendChild(el('span', { class: 'comment-author' }, authorName));

        if (currentEmail && authorEmail && authorEmail === currentEmail) {
          header.appendChild(el('span', { class: 'badge comment-me-badge' }, '我'));
        }

        if (c.created_at) {
          header.appendChild(el('span', { class: 'muted comment-time' }, formatTime(c.created_at)));
        }

        item.appendChild(header);

        const bodyContainer = el('div', { class: 'comment-body' });
        const contentFrag = renderRichText(c.content, cachedMembers, cachedComments, cachedTasks);
        bodyContainer.appendChild(contentFrag);
        item.appendChild(bodyContainer);

        if (canComment && currentEmail && authorEmail === currentEmail) {
          const actions = el('div', { class: 'comment-actions' });
          const editBtn = el('button', { type: 'button', class: 'btn-secondary' }, '編輯');
          
          editBtn.onclick = async () => {
            if (editBtn.textContent === '編輯') {
              const input = el('textarea', { class: 'comment-edit-textarea', rows: '7' });
              input.value = c.content;
              bodyContainer.textContent = '';
              const editWrapper = el('div', { class: 'autocomplete-edit-wrapper' });
              editWrapper.appendChild(input);
              bodyContainer.appendChild(editWrapper);
              input.focus();
              editBtn.textContent = '儲存';
              bindAutocomplete(input, editWrapper, cachedMembers, () => cachedComments, memberMap, cachedTasks);
              
              input.onkeydown = async (ev) => {
                if (window.innerWidth > 768 && ev.key === 'Enter' && !ev.shiftKey) {
                  ev.preventDefault();
                  await saveEdit(input.value);
                } else if (ev.key === 'Escape') {
                  ev.preventDefault();
                  ev.stopPropagation();
                  await loadComments();
                }
              };
            } else {
              const input = bodyContainer.querySelector('.comment-edit-textarea');
              if (input) {
                await saveEdit(input.value);
              }
            }
          };

          const editSaveWrapper = el('div', { class: 'save-badge-wrapper' });
          const editUnsavedBadge = el('div', { class: 'unsaved-badge-popup' }, '完成');
          editSaveWrapper.appendChild(editUnsavedBadge);
          editSaveWrapper.appendChild(editBtn);

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
            if (editUnsavedBadge) {
              editUnsavedBadge.textContent = '等待';
              editUnsavedBadge.style.transform = 'translateX(0)';
              editUnsavedBadge.style.opacity = '1';
            }
            try {
              await api(`/api/comments/${c.comment_id}`, { method: 'PATCH', body: { content: val } });
              await loadComments();
              if (editUnsavedBadge) {
                editUnsavedBadge.style.transform = 'translateX(100%)';
                editUnsavedBadge.style.opacity = '0';
                await new Promise(resolve => setTimeout(resolve, 400));
                editUnsavedBadge.textContent = '完成';
                editUnsavedBadge.style.transform = 'translateX(0)';
                editUnsavedBadge.style.opacity = '1';
                setTimeout(() => {
                  editUnsavedBadge.style.transform = 'translateX(100%)';
                  editUnsavedBadge.style.opacity = '0';
                }, 1500);
              }
            } catch (err) {
              if (editUnsavedBadge) {
                editUnsavedBadge.style.transform = 'translateX(100%)';
                editUnsavedBadge.style.opacity = '0';
              }
              alert(err.message);
            }
          }

          actions.appendChild(editSaveWrapper);
          const deleteBtn = el('button', { type: 'button', class: 'btn-danger' }, '刪除');
          deleteBtn.onclick = async () => {
            if (!confirm('確定要刪除這則留言嗎？')) return;
            try {
              await api(`/api/comments/${c.comment_id}`, { method: 'DELETE' });
              await loadComments();
            } catch (err) {
              alert(err.message);
            }
          };
          actions.appendChild(deleteBtn);
          item.appendChild(actions);
        }
        commList.appendChild(item);
      });

      // 檢查是否有指定留言，如果有則捲動至該留言並加入閃爍效果
      if (!hasScrolledToComment && query && query.get('comment')) {
        const targetId = `comment-${query.get('comment')}`;
        setTimeout(() => {
          const targetEl = document.getElementById(targetId);
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetEl.classList.add('highlight-flash');
            hasScrolledToComment = true;
          }
        }, 100);
      }
    } catch (err) {
      commErr.textContent = err.message;
      commErr.style.display = 'block';
    }
  }

  if (canComment) {
    commForm.onsubmit = async (e) => {
      e.preventDefault();
      const content = commInput.value.trim();
      if (!content) {
        alert('請輸入留言內容！');
        return;
      }
      if (commUnsavedBadge) {
        commUnsavedBadge.textContent = '等待';
        commUnsavedBadge.style.transform = 'translateX(0)';
        commUnsavedBadge.style.opacity = '1';
      }
      try {
        await api(`/api/tasks/${taskId}/comments`, { method: 'POST', body: { content } });
        commInput.value = '';
        commInput.blur();
        commInput.style.height = '38px';
        await loadComments();
        if (commUnsavedBadge) {
          commUnsavedBadge.style.transform = 'translateX(100%)';
          commUnsavedBadge.style.opacity = '0';
          await new Promise(resolve => setTimeout(resolve, 400));
          commUnsavedBadge.textContent = '完成';
          commUnsavedBadge.style.transform = 'translateX(0)';
          commUnsavedBadge.style.opacity = '1';
          setTimeout(() => {
            commUnsavedBadge.style.transform = 'translateX(100%)';
            commUnsavedBadge.style.opacity = '0';
          }, 1500);
        }
      } catch (err) {
        if (commUnsavedBadge) {
          commUnsavedBadge.style.transform = 'translateX(100%)';
          commUnsavedBadge.style.opacity = '0';
        }
        commErr.textContent = err.message;
        commErr.style.display = 'block';
      }
    };
  }
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

  const statusBadge = el('div', { class: 'badge status-badge-lg' }, currentTask.status);
  statusBadge.style.backgroundColor = `var(--highlight-${currentTask.status.toLowerCase()})`;
  badgeSlot.appendChild(statusBadge);

  /**
   * Helper mapping state transition button clicks with safety guards.
   * @param {string} text - Button caption string.
   * @param {string} status - Target workflow status parameter.
   * @returns {HTMLElement} State adjustment action button.
   */
  function createTransitionBtn(text, status) {
    const btn = el('button', { type: 'button', class: 'status-change-btn' }, text);
    btn.onclick = async () => {
      // 限制：切換至 Doing 時，必須有負責人
      if (status === 'Doing' && !(isMainWorkspace && state.userEmail === MAIN_OWNER_EMAIL)) {
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

  if (canManageTask) {
    if (isMainWorkspace) {
      if (currentTask.title !== MAIN_POLICY_TITLE && currentTask.status === 'Todo') {
        rightSlot.appendChild(createTransitionBtn('→ Done', 'Done'));
      }
    } else if (currentTask.status === 'Todo') {
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
  }

  statusLine.appendChild(leftSlot);
  statusLine.appendChild(badgeSlot);
  statusLine.appendChild(rightSlot);
  attrSec.appendChild(statusLine);
  if (!canManageTask && isMainWorkspace && state.userEmail !== MAIN_OWNER_EMAIL) {
    attrSec.appendChild(el('p', { class: 'muted main-task-status-note' }, '狀態由 user01 協調'));
  }

  // Priority
  attrSec.appendChild(el('label', { class: 'attr-label' }, '優先度'));
  if (canManageTask) {
    const prioritySelect = el('select');
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
  } else {
    attrSec.appendChild(el('div', { class: 'task-readonly-attribute' }, currentTask.priority || 'Medium'));
  }

  // Assignee
  attrSec.appendChild(el('label', { class: 'attr-label' }, '指派'));
  if (canManageTask) {
    const assigneeSelect = el('select');
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
  } else {
    const assignee = currentTask.assignee_id ? memberMap.get(currentTask.assignee_id) : null;
    attrSec.appendChild(el('div', { class: 'task-readonly-attribute' }, assignee || '-- 無負責人 --'));
  }

  // Due date
  attrSec.appendChild(el('label', { class: 'attr-label' }, '截止日期'));
  if (canManageTask) {
    const dueDateInput = el('input', { type: 'date' });
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
  } else {
    const dueDate = currentTask.due_at ? new Date(currentTask.due_at).toISOString().split('T')[0] : '-- 無截止日期 --';
    attrSec.appendChild(el('div', { class: 'task-readonly-attribute' }, dueDate));
  }
  rightEl.appendChild(attrSec);

  // Attachments
  const attachSec = el('div', { class: 'detail-section sketch-box' });
  attachSec.appendChild(el('h3', {}, '附件'));
  const attachList = el('ul', { class: 'attachments-list' });
  attachSec.appendChild(attachList);
  let attachForm = null;
  let attachInput = null;
  if (canManageTask) {
    attachForm = el('form', { class: 'attach-form' });
    attachInput = el('input', { type: 'file', required: true });
    const attachSubmit = el('button', { type: 'submit' }, '上傳附件');
    attachForm.appendChild(attachInput);
    attachForm.appendChild(attachSubmit);
    attachSec.appendChild(attachForm);
  }
  const attachErr = el('p', { class: 'error' });
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
        attachList.appendChild(el('li', { class: 'muted detail-empty-item' }, '（尚無附件）'));
        return;
      }
      for (const a of rows) {
        const li = el('li', { class: 'attachment-item' });
        const link = el('a', {
          href: `api/attachments/${a.attachment_id}`,
          target: '_blank',
          rel: 'noopener noreferrer',
          download: a.original_name
        }, `${a.original_name} (${(a.size/1024).toFixed(1)} KB)`);
        li.appendChild(link);

        if (canManageTask) {
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
        }
        attachList.appendChild(li);
      }
    } catch (err) {
      attachErr.textContent = err.message;
      attachErr.style.display = 'block';
    }
  }

  if (canManageTask) {
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
  }
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

/**
 * Autocomplete / Mentions suggestion dropdown binder
 */
function bindAutocomplete(textarea, wrapper, cachedMembers, getComments, memberMap, cachedTasks) {
  let activeTrigger = null;
  let triggerIndex = -1;
  let selectedIndex = 0;
  let dropdown = null;

  const closeDropdown = () => {
    if (dropdown) {
      dropdown.remove();
      dropdown = null;
    }
    activeTrigger = null;
    triggerIndex = -1;
    selectedIndex = 0;
  };

  const getFilteredSuggestions = () => {
    if (!activeTrigger) return [];
    const text = textarea.value;
    const cursorPos = textarea.selectionStart;
    const query = text.substring(triggerIndex + 1, cursorPos).toLowerCase();

    if (activeTrigger === '@') {
      return cachedMembers
        .filter(m => {
          const name = (m.name || '').toLowerCase();
          const email = (m.email || '').toLowerCase();
          return name.includes(query) || email.includes(query);
        })
        .map(m => ({
          label: `${m.name || '未命名'} (${m.email})`,
          insertValue: `@${m.name || m.email} `,
          raw: m
        }));
    } else if (activeTrigger === '#') {
      const comments = getComments() || [];
      return comments
        .map((c, idx) => {
          const num = idx + 1;
          const author = memberMap.get(c.user_id) || `成員 (${c.user_id.slice(0, 8)})`;
          let snippet = c.content.trim().replace(/\n/g, ' ');
          if (snippet.length > 20) snippet = snippet.substring(0, 20) + '...';
          return {
            number: num,
            label: `#${num} - ${author}: ${snippet}`,
            insertValue: `#${num} `,
            raw: c
          };
        })
        .filter(item => {
          return String(item.number).includes(query) || item.label.toLowerCase().includes(query);
        });
    } else if (activeTrigger === '::') {
      const taskQuery = text.substring(triggerIndex + 2, cursorPos).toLowerCase();
      const tasks = cachedTasks || [];
      return tasks
        .map(t => {
          const shortId = t.task_id.split('-')[0];
          return {
            shortId,
            label: `::${shortId} - ${t.title}`,
            insertValue: `::${shortId} (${t.title}) `,
            raw: t
          };
        })
        .filter(item => {
          return item.shortId.toLowerCase().includes(taskQuery) || item.raw.title.toLowerCase().includes(taskQuery);
        });
    }
    return [];
  };

  const renderDropdown = () => {
    const suggestions = getFilteredSuggestions();
    if (suggestions.length === 0) {
      closeDropdown();
      return;
    }

    const rect = textarea.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    const itemHeight = 32;
    const targetCount = Math.min(suggestions.length, 3);
    const requiredSpace = targetCount * itemHeight + 12;

    let positionMode = 'below';
    if (spaceBelow >= requiredSpace) {
      positionMode = 'below';
    } else if (spaceAbove >= requiredSpace) {
      positionMode = 'above';
    } else {
      // If neither side has enough space for 3 options, do nothing (keep it in default below position)
      positionMode = 'below';
    }

    if (!dropdown) {
      dropdown = el('div', { class: 'mention-suggestions-box' });
      wrapper.appendChild(dropdown);
    }

    if (positionMode === 'above') {
      dropdown.classList.add('position-above');
    } else {
      dropdown.classList.remove('position-above');
    }

    dropdown.textContent = '';
    let activeItem = null;
    suggestions.forEach((s, idx) => {
      const isActive = idx === selectedIndex;
      const item = el('div', {
        class: `mention-suggestion-item${isActive ? ' active' : ''}`
      }, s.label);
      
      item.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectSuggestion(s);
      };

      dropdown.appendChild(item);
      if (isActive) {
        activeItem = item;
      }
    });

    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' });
    }

    if (selectedIndex >= suggestions.length) {
      selectedIndex = suggestions.length - 1;
      renderDropdown();
    }
  };

  const selectSuggestion = (suggestion) => {
    const text = textarea.value;
    const cursorPos = textarea.selectionStart;
    const before = text.substring(0, triggerIndex);
    const after = text.substring(cursorPos);
    const insertText = suggestion.insertValue;

    textarea.value = before + insertText + after;
    textarea.focus();
    
    const newCursorPos = triggerIndex + insertText.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);

    textarea.dispatchEvent(new Event('input'));
    closeDropdown();
  };

  textarea.addEventListener('keydown', (e) => {
    if (!dropdown) return;

    const suggestions = getFilteredSuggestions();
    if (suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % suggestions.length;
      renderDropdown();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length;
      renderDropdown();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectSuggestion(suggestions[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDropdown();
    }
  });

  textarea.addEventListener('input', () => {
    const text = textarea.value;
    const cursorPos = textarea.selectionStart;

    activeTrigger = null;
    triggerIndex = -1;

    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = text[i];
      if (char === ' ' || char === '\n') {
        break;
      }
      if (char === '@' || char === '#') {
        if (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\n') {
          activeTrigger = char;
          triggerIndex = i;
        }
        break;
      }
      if (char === ':' && i > 0 && text[i - 1] === ':') {
        if (i - 1 === 0 || text[i - 2] === ' ' || text[i - 2] === '\n') {
          activeTrigger = '::';
          triggerIndex = i - 1;
        }
        break;
      }
    }

    if (activeTrigger) {
      renderDropdown();
    } else {
      closeDropdown();
    }
  });

  textarea.addEventListener('blur', () => {
    setTimeout(closeDropdown, 200);
  });
}

export function safeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Rich Text renderer for parsing mentions (@name) and comment links (#N)
 */
function renderRichText(text, cachedMembers, cachedComments, cachedTasks) {
  const fragment = document.createDocumentFragment();
  if (!text) return fragment;

  const regex = /(https?:\/\/[^\s<>"']+|@(?:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|[^\s@#\(\)]+)|#\d+|::[a-fA-F0-9]{8}(?:\s*\([^)]+\))?)/g;
  const parts = text.split(regex);

  parts.forEach(part => {
    if (!part) return;

    const punctuation = part.startsWith('http') ? part.match(/[.,;:!?。！？，；：]+$/)?.[0] || '' : '';
    const urlText = punctuation ? part.slice(0, -punctuation.length) : part;
    const href = safeHttpUrl(urlText);
    if (href) {
      fragment.appendChild(el('a', {
        class: 'rich-url-link',
        href,
        target: '_blank',
        rel: 'noopener noreferrer'
      }, urlText));
      if (punctuation) fragment.appendChild(document.createTextNode(punctuation));
    } else if (part.startsWith('@')) {
      const nameOrEmail = part.slice(1);
      const member = cachedMembers.find(m => m.name === nameOrEmail || m.email === nameOrEmail || m.user_id === nameOrEmail || m.email?.split('@', 1)[0]?.toLowerCase() === nameOrEmail.toLowerCase());
      if (member) {
        const mentionEl = el('span', {
          class: 'rich-mention',
          title: member.email
        }, `@${member.name || member.email}`);
        fragment.appendChild(mentionEl);
      } else {
        fragment.appendChild(document.createTextNode(part));
      }
    } else if (part.startsWith('#') && /^\d+$/.test(part.slice(1))) {
      const num = parseInt(part.slice(1), 10);
      const commentIdx = num - 1;
      if (cachedComments && commentIdx >= 0 && commentIdx < cachedComments.length) {
        const comment = cachedComments[commentIdx];
        const link = el('a', {
          href: '#',
          class: 'rich-comment-link'
        }, `#${num}`);
        link.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetEl = document.getElementById(`comment-${comment.comment_id}`);
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetEl.classList.remove('highlight-flash');
            void targetEl.offsetWidth; // trigger reflow
            targetEl.classList.add('highlight-flash');
          } else {
            alert(`找不到留言 #${num}`);
          }
        };
        fragment.appendChild(link);
      } else {
        fragment.appendChild(document.createTextNode(part));
      }
    } else if (part.startsWith('::')) {
      const shortId = part.slice(2, 10);
      const tasks = cachedTasks || [];
      const targetTask = tasks.find(t => t.task_id.startsWith(shortId));
      if (targetTask) {
        const link = el('a', {
          href: '#',
          class: 'rich-task-link',
          title: targetTask.title
        }, part);
        link.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.location.hash = `#/task/${targetTask.task_id}`;
        };
        fragment.appendChild(link);
      } else {
        fragment.appendChild(document.createTextNode(part));
      }
    } else {
      fragment.appendChild(document.createTextNode(part));
    }
  });

  return fragment;
}
