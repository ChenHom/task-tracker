'use strict';

import { api } from '../api.js';
import { state, hasRole } from '../state.js';
import { el, requireWorkspace, showError } from '../utils.js';

export const GoalsView = {
  async render(container) {
    if (!requireWorkspace(container)) return;
    const workspaceId = state.workspaceId;
    container.innerHTML = `
      <h2 class="red-pen-underline">Goals</h2>
      <form id="goal-create-form" class="sketch-box goal-toolbar">
        <label>Project <select id="goal-project" required></select></label>
        <label>目標 <textarea id="goal-objective" required></textarea></label>
        <label>成功條件 <textarea id="goal-criteria" required></textarea></label>
        <button type="submit">建立 Goal</button>
      </form>
      <p id="goal-error" class="error"></p><div id="goal-list"></div>`;
    const list = document.getElementById('goal-list');
    const projectSelect = document.getElementById('goal-project');

    async function load() {
      try {
        const [goals, projects, members] = await Promise.all([
          api(`/api/workspaces/${encodeURIComponent(workspaceId)}/goals`),
          api(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`),
          api(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`),
        ]);
        const role = members.find(member => member.email === state.userEmail)?.role || 'Viewer';
        document.getElementById('goal-create-form').hidden = !hasRole(role, 'Member');
        projectSelect.textContent = '';
        projects.filter(project => project.status === 'active' && project.target_repo).forEach(project => {
          projectSelect.appendChild(el('option', { value: project.project_id }, `${project.name} — ${project.target_repo}`));
        });
        list.textContent = '';
        for (const goal of goals) {
          const card = el('article', { class: 'sketch-box goal-card' });
          card.appendChild(el('h3', {}, goal.objective));
          card.appendChild(el('div', { class: 'goal-meta' }, `${goal.status} / ${goal.discussion_phase || '—'} · revision ${goal.revision} · ${goal.source}`));
          card.appendChild(el('p', {}, `成功條件：${goal.success_criteria}`));
          const activity = await api(`/api/goals/${encodeURIComponent(goal.goal_id)}/activity`);
          card.appendChild(el('p', { class: 'muted' }, `參與 ${activity.participations.length} · Runs ${activity.runs.length} · Contributions ${activity.contributions.length}`));
          card.appendChild(el('p', { class: 'muted' }, `Token（實際優先／否則預估）in ${activity.tokenTotals.input} · out ${activity.tokenTotals.output} · Tasks ${activity.tasks.length}`));
          const evidence = JSON.parse(goal.evidence_refs_json || '[]');
          if (evidence.length) card.appendChild(el('p', {}, `證據：${evidence.join('、')}`));
          const controls = el('div', { class: 'goal-meta' });
          for (const action of hasRole(role, 'Member') ? (goal.status === 'Paused' ? ['resume', 'cancel'] : ['pause', 'cancel']) : []) {
            const button = el('button', { type: 'button', class: action === 'cancel' ? 'btn-danger' : 'btn-secondary' }, action);
            button.onclick = async () => { await api(`/api/goals/${goal.goal_id}/${action}`, { method: 'POST' }); await load(); };
            controls.appendChild(button);
          }
          card.appendChild(controls); list.appendChild(card);
        }
      } catch (error) { showError('goal-error', error); }
    }
    document.getElementById('goal-create-form').onsubmit = async event => {
      event.preventDefault();
      try {
        await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/goals`, { method: 'POST', body: {
          projectId: projectSelect.value,
          objective: document.getElementById('goal-objective').value,
          successCriteria: document.getElementById('goal-criteria').value,
        } });
        event.target.reset(); await load();
      } catch (error) { showError('goal-error', error); }
    };
    await load();
  },
};
