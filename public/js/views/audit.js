'use strict';

import { api } from '../api.js';
import { el, showError } from '../utils.js';

/**
 * Controller representation for the Audit Trail View.
 * @type {Object}
 */
export const AuditView = {
  /**
   * Renders the event audit lookup page, allowing querying workspace aggregates (Workspaces/Tasks) and tracking event timelines.
   * @param {HTMLElement} container - The DOM container element where the page is rendered.
   * @returns {Promise<void>}
   */
  async render(container) {
    container.innerHTML = `
      <div class="sketch-box" style="padding: 0.75rem 1.5rem; background: #fff; margin-bottom: 1rem;">
        <h2 class="red-pen-underline" style="margin-top: 0; margin-bottom:1.2rem;">工作區審計日誌</h2>
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

    /**
     * Translates backend event store event types into human-readable description texts.
     * @param {string} eventType - The classification domain string of the event (e.g. 'workspace.created').
     * @param {Object} payload - Associated values carried by the event.
     * @returns {string} Human-readable translation.
     */
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
          return payload.dueAt ? `變更任務截止日期為 ${new Date(payload.dueAt).toLocaleDateString()}` : `移成了截止日期`;
        case 'task.archived':
          return `封存了此任務`;
        case 'task.deleted':
          return `移除了此任務`;
        default:
          return `執行了 "${eventType}" 操作`;
      }
    }

    const auditForm = document.getElementById('audit-form');
    if (auditForm) {
      auditForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const aggregateId = document.getElementById('audit-aggregate-input').value;
        const list = document.getElementById('audit-list');
        if (!list) return;
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
  }
};
