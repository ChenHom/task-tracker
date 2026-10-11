'use strict';

import { api } from '../api.js';
import { state } from '../state.js';
import { el, requireWorkspace, showError } from '../utils.js';

export const AgentsView = {
  async render(container) {
    if (!requireWorkspace(container)) return;
    const workspaceId = state.workspaceId;
    container.innerHTML = '<h2 class="red-pen-underline">Agents</h2><p id="agent-error" class="error"></p><div id="agent-list" class="agent-grid"></div>';
    const list = document.getElementById('agent-list');
    try {
      const agents = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`);
      for (const agent of agents) {
        const card = el('article', { class: 'sketch-box agent-card' });
        card.appendChild(el('h3', {}, `${agent.name} · ${agent.role}`));
        card.appendChild(el('p', {}, JSON.parse(agent.skill_profile_json).summary));
        const status = el('select', { 'aria-label': `${agent.name} 狀態` });
        status.disabled = state.userEmail !== 'user09@test.local';
        ['active', 'paused', 'error'].forEach(value => { const option = el('option', { value }, value); option.selected = agent.status === value; status.appendChild(option); });
        status.onchange = async () => { try { await api(`/api/workspaces/${workspaceId}/agents/${agent.agent_id}`, { method: 'PATCH', body: { status: status.value } }); } catch (error) { showError('agent-error', error); } };
        card.appendChild(status);
        card.appendChild(el('p', { class: 'muted' }, `Primary: ${agent.primary_adapter}/${agent.primary_model}`));
        card.appendChild(el('p', { class: 'muted' }, `Fallback: ${agent.fallback_adapter ? `${agent.fallback_adapter}/${agent.fallback_model}` : '—'}`));
        card.appendChild(el('p', { class: 'muted' }, `目前 Goal/Task: ${agent.current_goal_id || '—'} / ${agent.current_task_id || '—'}`));
        card.appendChild(el('p', { class: 'muted' }, `累積 token: ${(agent.total_input_tokens || 0) + (agent.total_output_tokens || 0)}`));
        list.appendChild(card);
      }
    } catch (error) { showError('agent-error', error); }
  },
};
