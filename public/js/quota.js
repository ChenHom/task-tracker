'use strict';

import { api } from './api.js';
import { el } from './utils.js';
import { formatQuotaDetails, selectQuotaSummary } from './quota-format.js';

/**
 * Fetches the API quota status and updates the footer display.
 * If not logged in or request fails, the footer is hidden.
 */
export async function updateQuotaFooter() {
  const footerEl = document.getElementById('quota-footer');
  if (!footerEl) return;

  try {
    const providers = await api('/api/quota');
    if (!providers || !Array.isArray(providers)) {
      footerEl.style.display = 'none';
      return;
    }

    const formatName = (p) => {
      if (p === 'codex') return 'Codex';
      if (p === 'claude') return 'Claude';
      if (p === 'agy') return 'AGY';
      return p;
    };

    footerEl.textContent = '';
    providers.forEach((item, index) => {
      const isUnavailable = !!item.unavailable;
      const providerName = formatName(item.provider);
      const summary = selectQuotaSummary(item);
      const valueText = isUnavailable || !summary
        ? 'N/A'
        : `${summary.label} ${summary.remaining || 'N/A'}`;
      const details = formatQuotaDetails(item);
      const classes = ['quota-item'];
      if (isUnavailable) classes.push('unavailable');
      if (item.stale) classes.push('stale');
      const itemEl = el('span', {
        class: classes.join(' '),
        tabindex: '0',
        'data-tooltip': details,
        'aria-label': `${providerName} ${details.replaceAll('\n', '；')}`,
      });
      itemEl.appendChild(el('span', { class: 'quota-label' }, providerName));
      itemEl.appendChild(el('span', { class: 'quota-value' }, valueText));
      footerEl.appendChild(itemEl);

      if (index < providers.length - 1) {
        footerEl.appendChild(el('span', { class: 'quota-sep', 'aria-hidden': 'true' }, '·'));
      }
    });

    footerEl.style.display = 'flex';
  } catch (err) {
    footerEl.style.display = 'none';
  }
}
