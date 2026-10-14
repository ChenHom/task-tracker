'use strict';

import { api } from '../api.js';
import { state, hasRole } from '../state.js';
import { el, requireWorkspace, showError } from '../utils.js';

export const AgentsView = {
  async render(container) {
    if (!requireWorkspace(container)) return;
    const workspaceId = state.workspaceId;
    container.innerHTML = '<h2 class="red-pen-underline">Agents</h2><p id="agent-error" class="error"></p><div id="agent-list" class="agent-grid"></div>';
    const list = document.getElementById('agent-list');
    try {
      const [agents, members] = await Promise.all([
        api(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`),
        api(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`),
      ]);
      const role = members.find(member => member.email === state.userEmail)?.role || 'Viewer';
      const canManage = hasRole(role, 'Admin');
      for (const agent of agents) {
        const card = el('article', { class: 'sketch-box agent-card' });
        card.appendChild(el('h3', {}, `${agent.name} · ${agent.role}`));
        card.appendChild(el('p', {}, JSON.parse(agent.skill_profile_json).summary));
        const status = el('select', { 'aria-label': `${agent.name} 狀態` });
        status.disabled = !canManage;
        ['active', 'paused', 'error'].forEach(value => { const option = el('option', { value }, value); option.selected = agent.status === value; status.appendChild(option); });
        card.appendChild(status);
        const primaryAdapter = el('select', { 'aria-label': `${agent.name} primary adapter` });
        const fallbackAdapter = el('select', { 'aria-label': `${agent.name} fallback adapter` });
        for (const select of [primaryAdapter, fallbackAdapter]) {
          if (select === fallbackAdapter) select.appendChild(el('option', { value: '' }, '無 fallback'));
          for (const value of ['claude', 'codex', 'agy']) select.appendChild(el('option', { value }, value));
          select.disabled = !canManage;
        }
        primaryAdapter.value = agent.primary_adapter;
        fallbackAdapter.value = agent.fallback_adapter || '';
        const primaryModel = el('input', { value: agent.primary_model, 'aria-label': `${agent.name} primary model` });
        const fallbackModel = el('input', { value: agent.fallback_model || '', 'aria-label': `${agent.name} fallback model` });
        primaryModel.disabled = fallbackModel.disabled = !canManage;
        const primary = el('label', {}, 'Primary '); primary.append(primaryAdapter, primaryModel); card.appendChild(primary);
        const fallback = el('label', {}, 'Fallback '); fallback.append(fallbackAdapter, fallbackModel); card.appendChild(fallback);
        if (canManage) {
          const save = el('button', { type: 'button' }, '儲存 Agent 設定');
          save.onclick = async () => {
            try {
              await api(`/api/workspaces/${workspaceId}/agents/${agent.agent_id}`, { method: 'PATCH', body: {
                status: status.value,
                primaryAdapter: primaryAdapter.value,
                primaryModel: primaryModel.value,
                fallbackAdapter: fallbackAdapter.value || null,
                fallbackModel: fallbackAdapter.value ? fallbackModel.value : null,
              } });
            } catch (error) { showError('agent-error', error); }
          };
          card.appendChild(save);
        }
        card.appendChild(el('p', { class: 'muted' }, `目前 Goal/Task: ${agent.current_goal_id || '—'} / ${agent.current_task_id || '—'}`));
        card.appendChild(el('p', { class: 'muted' }, `累積 token: ${(agent.total_input_tokens || 0) + (agent.total_output_tokens || 0)}`));
        card.appendChild(el('p', { class: 'muted' }, `最近 preflight: ${agent.latest_preflight ? `${agent.latest_preflight.status} · ${agent.latest_preflight.error_category || 'ok'} · ${agent.latest_preflight.created_at}` : '—'}`));
        card.appendChild(el('p', { class: 'muted' }, `最近 Run: ${agent.latest_run ? `${agent.latest_run.phase} · ${agent.latest_run.adapter}/${agent.latest_run.model} · ${agent.latest_run.status}` : '—'}`));
        card.appendChild(el('p', { class: 'muted' }, `fallback 次數: ${agent.fallback_count || 0} · usage 未知次數: ${agent.unknown_usage_count || 0}`));
        list.appendChild(card);
      }
    } catch (error) { showError('agent-error', error); }
  },
};
