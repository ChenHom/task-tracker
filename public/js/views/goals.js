'use strict';

import { api } from '../api.js';
import { state, hasRole } from '../state.js';
import { el, requireWorkspace, showError } from '../utils.js';

function jsonArray(value) {
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

function appendRows(parent, title, rows, render) {
  const section = el('section', { class: 'goal-detail-section' });
  section.appendChild(el('h3', {}, title));
  if (!rows.length) section.appendChild(el('p', { class: 'muted' }, '尚無資料'));
  rows.forEach(row => section.appendChild(render(row)));
  parent.appendChild(section);
}

async function renderGoalDetail(container, workspaceId, goalId) {
  container.innerHTML = '<p id="goal-error" class="error"></p><div id="goal-detail"></div>';
  const root = document.getElementById('goal-detail');
  try {
    const [goal, activity, projects, members, agents] = await Promise.all([
      api(`/api/goals/${encodeURIComponent(goalId)}`),
      api(`/api/goals/${encodeURIComponent(goalId)}/activity`),
      api(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`),
      api(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`),
      api(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`),
    ]);
    const role = members.find(member => member.email === state.userEmail)?.role || 'Viewer';
    const agentNames = new Map(agents.map(agent => [agent.agent_id, agent.name]));
    const project = projects.find(candidate => candidate.project_id === goal.project_id);
    root.appendChild(el('a', { href: '#/goals' }, '← Goals'));
    root.appendChild(el('h2', { class: 'red-pen-underline' }, goal.objective));
    root.appendChild(el('p', { class: 'goal-meta' }, `${goal.status} / ${goal.discussion_phase || '—'} · revision ${goal.revision} · ${project?.name || goal.project_id}`));
    root.appendChild(el('p', {}, `成功條件：${goal.success_criteria}`));
    root.appendChild(el('p', {}, `資料範圍：${goal.data_scope || '未設定'}`));

    const relations = el('section', { class: 'goal-detail-section' });
    relations.appendChild(el('h3', {}, '關係'));
    if (goal.parent_goal_id) relations.appendChild(el('a', { href: `#/goals/${goal.parent_goal_id}` }, `父 Goal：${goal.parent_goal_id}`));
    if (!goal.parent_goal_id && !activity.childGoals.length) relations.appendChild(el('p', { class: 'muted' }, '無 parent／child Goal'));
    activity.childGoals.forEach(child => relations.appendChild(el('a', { href: `#/goals/${child.goal_id}` }, `子 Goal：${child.objective}`)));
    root.appendChild(relations);

    appendRows(root, '參與 Agent 與選人理由', activity.participations, row => el('div', { class: 'goal-detail-row' }, `${agentNames.get(row.agent_id) || row.agent_id}：${row.reason} — ${row.assignment}`));
    appendRows(root, '各輪 Contribution', activity.contributions, row => el('div', { class: 'goal-detail-row' }, `${row.round} / ${row.stance} · ${row.claim}\n理由：${row.reason}\n證據：${jsonArray(row.evidence_json).join('、') || '無'}`));

    const synthesis = activity.synthesis;
    appendRows(root, 'Owner synthesis', synthesis ? [synthesis] : [], row => el('div', { class: 'goal-detail-row' }, `${row.summary}\n決策：${row.decision_rationale}\n範圍：${row.change_scope}\n不確定性：${jsonArray(row.uncertainties_json).join('、') || '無'}`));
    appendRows(root, 'Task 列表', activity.tasks, row => el('a', { class: 'goal-detail-row', href: `#/tasks/${row.task_id}` }, `${row.status} · ${row.title} · ${agentNames.get(row.assignee_id) || row.assignee_id || '未指派'}`));
    appendRows(root, 'Run 與用量', activity.runs, row => el('div', { class: 'goal-detail-row' }, `${row.phase} · ${row.agent_id} · ${row.adapter}/${row.model} · ${row.status}\nsession ${row.session_id || '—'} · tokens ${row.actual_total_tokens ?? ((row.actual_input_tokens ?? row.estimated_input_tokens) + (row.actual_output_tokens ?? row.estimated_output_tokens))}`));
    appendRows(root, 'commit、CI、merge、deploy 證據', activity.deliveryEvidence, row => el('div', { class: 'goal-detail-row' }, `${row.kind} · ${row.ref}${row.detail ? ` · ${row.detail}` : ''}`));

    if (hasRole(role, 'Member')) {
      const controls = el('div', { class: 'goal-meta goal-detail-controls' });
      const actions = goal.status === 'Blocked' ? ['resume', 'cancel']
        : goal.status === 'Paused' ? ['resume', 'cancel']
          : goal.status === 'Queued' ? ['start', 'cancel']
            : ['Discussing', 'Executing', 'Verifying'].includes(goal.status) ? ['pause', 'cancel'] : [];
      actions.forEach(action => {
        const button = el('button', { type: 'button', class: action === 'cancel' ? 'btn-danger' : 'btn-secondary' }, action);
        button.onclick = async () => {
          const changeDescription = action === 'resume' && goal.status === 'Blocked' ? window.prompt('請說明解除 Blocked 前完成的實質變更：') : null;
          if (action === 'resume' && goal.status === 'Blocked' && changeDescription === null) return;
          try {
            await api(`/api/goals/${goal.goal_id}/${action}`, { method: 'POST', ...(changeDescription !== null ? { body: { changeDescription } } : {}) });
            await renderGoalDetail(container, workspaceId, goalId);
          } catch (error) { showError('goal-error', error); }
        };
        controls.appendChild(button);
      });
      const criteria = el('button', { type: 'button', class: 'btn-secondary' }, '修改成功條件');
      criteria.onclick = async () => {
        const successCriteria = window.prompt('修改成功條件', goal.success_criteria);
        if (successCriteria === null) return;
        try {
          await api(`/api/goals/${goal.goal_id}`, { method: 'PATCH', body: { successCriteria } });
          await renderGoalDetail(container, workspaceId, goalId);
        } catch (error) { showError('goal-error', error); }
      };
      controls.appendChild(criteria); root.appendChild(controls);

      const commentTask = activity.tasks.find(task => task.status !== 'Archived') || activity.tasks[0];
      if (commentTask) {
        const form = el('form', { class: 'goal-comment-form' });
        const input = el('textarea', { required: 'required', placeholder: '@Owner 留言' });
        form.appendChild(input); form.appendChild(el('button', { type: 'submit' }, '送出 @Owner 留言'));
        form.onsubmit = async event => {
          event.preventDefault();
          try {
            const content = input.value.trim();
            await api(`/api/tasks/${commentTask.task_id}/comments`, { method: 'POST', body: { content: content.startsWith('@Owner') ? content : `@Owner ${content}` } });
            input.value = '';
          } catch (error) { showError('goal-error', error); }
        };
        root.appendChild(form);
      }
    }
  } catch (error) { showError('goal-error', error); }
}

export const GoalsView = {
  async render(container, rest = []) {
    if (!requireWorkspace(container)) return;
    const workspaceId = state.workspaceId;
    if (rest?.[0]) return renderGoalDetail(container, workspaceId, rest[0]);
    container.innerHTML = `
      <h2 class="red-pen-underline">Goals</h2>
      <form id="goal-create-form" class="sketch-box goal-toolbar">
        <label>Project <select id="goal-project" required></select></label>
        <label>目標 <textarea id="goal-objective" required></textarea></label>
        <label>成功條件 <textarea id="goal-criteria" required></textarea></label>
        <label>資料範圍 <textarea id="goal-data-scope"></textarea></label>
        <button type="submit">建立 Goal</button>
      </form>
      <p id="goal-error" class="error"></p><div id="goal-list"></div>`;
    const list = document.getElementById('goal-list');
    const projectSelect = document.getElementById('goal-project');

    async function load() {
      try {
        const [goals, projects, members, agents] = await Promise.all([
          api(`/api/workspaces/${encodeURIComponent(workspaceId)}/goals`),
          api(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`),
          api(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`),
          api(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`),
        ]);
        const role = members.find(member => member.email === state.userEmail)?.role || 'Viewer';
        const projectNames = new Map(projects.map(project => [project.project_id, project.name]));
        const agentNames = new Map(agents.map(agent => [agent.agent_id, agent.name]));
        document.getElementById('goal-create-form').hidden = !hasRole(role, 'Member');
        projectSelect.textContent = '';
        projects.filter(project => project.status === 'active' && project.target_repo).forEach(project => {
          projectSelect.appendChild(el('option', { value: project.project_id }, `${project.name} — ${project.target_repo}`));
        });
        list.textContent = '';
        for (const goal of goals) {
          const card = el('article', { class: 'sketch-box goal-card' });
          card.appendChild(el('a', { href: `#/goals/${goal.goal_id}` }, goal.objective));
          card.appendChild(el('div', { class: 'goal-meta' }, `${goal.status} / ${goal.discussion_phase || '—'} · revision ${goal.revision} · ${goal.source}`));
          card.appendChild(el('p', {}, `Project：${projectNames.get(goal.project_id) || goal.project_id} · Owner：${agentNames.get(goal.owner_agent_id) || goal.owner_agent_id}`));
          if (goal.parent_goal_id) card.appendChild(el('p', { class: 'muted' }, `父 Goal：${goal.parent_goal_id}`));
          card.appendChild(el('p', {}, `成功條件：${goal.success_criteria}`));
          card.appendChild(el('p', {}, `資料範圍：${goal.data_scope || '未設定'}`));
          if (goal.pause_requested) card.appendChild(el('p', { class: 'muted' }, '暫停請求已排定，將在下一個安全 checkpoint 套用。'));
          const activity = await api(`/api/goals/${encodeURIComponent(goal.goal_id)}/activity`);
          card.appendChild(el('p', { class: 'muted' }, `參與 ${activity.participations.length} · Runs ${activity.runs.length} · Contributions ${activity.contributions.length}`));
          card.appendChild(el('p', { class: 'muted' }, `Token（實際優先／否則預估）in ${activity.tokenTotals.input} · out ${activity.tokenTotals.output} · Tasks ${activity.tasks.length}`));
          card.appendChild(el('p', { class: 'muted' }, `Delivery evidence ${activity.deliveryEvidence.length} · 最近事件 ${activity.heartbeats.at(-1)?.phase || '—'}`));
          const evidence = JSON.parse(goal.evidence_refs_json || '[]');
          if (evidence.length) card.appendChild(el('p', {}, `證據：${evidence.join('、')}`));
          const controls = el('div', { class: 'goal-meta' });
          const actions = goal.status === 'Queued' ? ['start', 'cancel']
            : goal.status === 'Paused' ? ['resume', 'cancel']
              : goal.status === 'Blocked' ? ['resume', 'cancel']
              : ['Discussing', 'Executing', 'Verifying'].includes(goal.status) ? (goal.pause_requested ? ['cancel'] : ['pause', 'cancel']) : [];
          for (const action of hasRole(role, 'Member') ? actions : []) {
            const button = el('button', { type: 'button', class: action === 'cancel' ? 'btn-danger' : 'btn-secondary' }, action);
            button.onclick = async () => {
              try {
                const changeDescription = action === 'resume' && goal.status === 'Blocked'
                  ? window.prompt('請說明解除 Blocked 前完成的實質變更：')
                  : null;
                if (action === 'resume' && goal.status === 'Blocked' && changeDescription === null) return;
                await api(`/api/goals/${goal.goal_id}/${action}`, {
                  method: 'POST',
                  ...(changeDescription !== null ? { body: { changeDescription } } : {}),
                });
                await load();
              } catch (error) { showError('goal-error', error); }
            };
            controls.appendChild(button);
          }
          if (hasRole(role, 'Member') && !['Done', 'Cancelled'].includes(goal.status)) {
            for (const [field, label, current] of [
              ['successCriteria', '修改成功條件', goal.success_criteria],
              ['dataScope', '修改資料範圍', goal.data_scope || ''],
            ]) {
              const button = el('button', { type: 'button', class: 'btn-secondary' }, label);
              button.onclick = async () => {
                const value = window.prompt(label, current);
                if (value === null) return;
                try {
                  await api(`/api/goals/${goal.goal_id}`, { method: 'PATCH', body: { [field]: value } });
                  await load();
                } catch (error) { showError('goal-error', error); }
              };
              controls.appendChild(button);
            }
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
          dataScope: document.getElementById('goal-data-scope').value || undefined,
        } });
        event.target.reset(); await load();
      } catch (error) { showError('goal-error', error); }
    };
    await load();
  },
};
