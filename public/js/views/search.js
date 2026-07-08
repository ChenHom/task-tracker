'use strict';

import { api } from '../api.js';
import { state } from '../state.js';
import { el, showError, requireWorkspace } from '../utils.js';

/**
 * Controller representation for the global Search View.
 * @type {Object}
 */
export const SearchView = {
  /**
   * Renders the search form interface, accepts query input, and displays aggregated matches (tasks, projects, comments).
   * @param {HTMLElement} container - The DOM container element where the page is rendered.
   * @returns {Promise<void>}
   */
  async render(container) {
    if (!requireWorkspace(container)) return;

    container.innerHTML = `
      <div class="sketch-box" style="padding: 0.75rem 1.5rem; background: #fff; margin-bottom: 1rem;">
        <h2 class="red-pen-underline" style="margin-top:0; margin-bottom:1rem;">搜尋</h2>
        <form id="search-form" style="display: flex; gap: 0.5rem;">
          <input type="text" id="search-input" placeholder="輸入關鍵字搜尋任務、專案或留言..." required style="flex-grow: 1;">
          <button type="submit">搜尋</button>
        </form>
        <p id="search-error" class="error" style="display: none; margin-top: 1rem;"></p>
      </div>

      <div id="search-results" class="search-results-section"></div>
    `;

    let abortController = null;

    const searchForm = document.getElementById('search-form');
    if (searchForm) {
      searchForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = document.getElementById('search-input').value;
        const results = document.getElementById('search-results');
        if (!results) return;
        results.textContent = '搜尋中...';

        if (abortController) {
          abortController.abort();
        }
        abortController = new AbortController();

        try {
          const data = await api(`/api/search?workspace=${encodeURIComponent(state.workspaceId)}&q=${encodeURIComponent(q)}`, {
            signal: abortController.signal
          });
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
          if (err.name === 'AbortError') {
            console.log('Search query aborted');
          } else {
            showError('search-error', err);
          }
        }
      });
    }
  }
};
