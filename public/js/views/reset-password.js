'use strict';

import { api } from '../api.js';
import { showError, el } from '../utils.js';

/**
 * Controller representation for the Reset Password page View.
 * @type {Object}
 */
export const ResetPasswordView = {
  /**
   * Renders the Reset Password view. Requires token inside query parameters.
   * @param {HTMLElement} container - The DOM container element where the page is rendered.
   * @param {string[]} rest - Slash parameters.
   * @param {URLSearchParams} query - The query parameters parsed by the router.
   * @returns {Promise<void>}
   */
  async render(container, rest, query) {
    const token = query.get('token');
    if (!token) {
      container.innerHTML = `
        <div class="sketch-box" style="max-width: 450px; margin: 3rem auto; padding: 2rem; background: #fff; text-align: center;">
          <h2 style="margin-top:0;">重設密碼</h2>
          <p class="error">缺少重設 token，請重新從 email 連結進入。</p>
          <a href="#/login" class="nav-btn" style="margin-top: 1rem;">返回登入</a>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="sketch-box" style="max-width: 450px; margin: 3rem auto; padding: 2rem; background: #fff;">
        <h2 style="margin-top: 0; text-align: center;">重設密碼</h2>
        <form id="reset-form">
          <div>
            <label>新密碼 (New Password)</label>
            <input type="password" id="reset-password-input" required style="width: 100%;">
          </div>
          <button type="submit" style="width: 100%; margin-top: 1rem;">重設密碼</button>
        </form>
        <p id="reset-message" class="message" style="display: none; margin-top: 1rem;"></p>
      </div>
    `;

    document.getElementById('reset-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('reset-password-input').value;
      try {
        await api('/api/auth/reset-password', { method: 'POST', body: { token, password } });
        const msg = document.getElementById('reset-message');
        if (msg) {
          msg.textContent = '密碼已重設，請重新登入。';
          msg.className = 'message';
          msg.style.display = 'block';
          msg.appendChild(document.createElement('br'));
          const link = el('a', { href: '#/login', class: 'nav-btn', style: 'margin-top:0.8rem; display:inline-block;' }, '前往登入');
          msg.appendChild(link);
        }
      } catch (err) {
        showError('reset-message', err);
      }
    });
  }
};
