'use strict';

import { api } from './api.js';

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

    // Capitalize provider name for display
    const formatName = (p) => {
      if (p === 'codex') return 'Codex';
      if (p === 'claude') return 'Claude';
      if (p === 'agy') return 'AGY';
      return p;
    };

    let html = '';
    providers.forEach((item, index) => {
      const isUnavailable = !!item.unavailable;
      const providerName = formatName(item.provider);
      const valueText = isUnavailable ? 'N/A' : (item.remaining || 'N/A');
      const titleAttr = item.resetAt ? `title="Resets at: ${new Date(item.resetAt).toLocaleString()}"` : '';

      html += `
        <span class="quota-item ${isUnavailable ? 'unavailable' : ''}" ${titleAttr}>
          <span class="quota-label">${providerName}</span>
          <span class="quota-value">${valueText}</span>
        </span>
      `;

      if (index < providers.length - 1) {
        html += `<span class="quota-sep">·</span>`;
      }
    });

    footerEl.innerHTML = html.trim();
    footerEl.style.display = 'flex';
  } catch (err) {
    footerEl.style.display = 'none';
  }
}
