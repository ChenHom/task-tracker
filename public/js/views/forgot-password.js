'use strict';

import { api } from '../api.js';
import { showError } from '../utils.js';

/**
 * Controller representation for the Forgot Password page View.
 * @type {Object}
 */
export const ForgotPasswordView = {
  /**
   * Renders the Forgot Password page and attaches email submission handler.
   * @param {HTMLElement} container - The DOM container element where the page is rendered.
   * @returns {Promise<void>}
   */
  async render(container) {
    container.innerHTML = `
      <div class="sketch-box" style="max-width: 450px; margin: 3rem auto; padding: 2rem; background: #fff;">
        <h2 style="margin-top: 0; text-align: center; font-size: 2rem;">忘記密碼</h2>
        <p class="muted" style="font-size: 0.95rem; margin-bottom: 1.5rem;">輸入您的 Email，系統將會寄送密碼重設連結到您的信箱（模擬寄信將會輸出在伺服器終端機 Console）。</p>
        <form id="forgot-form">
          <div>
            <label>電子信箱 (Email)</label>
            <input type="email" id="forgot-email" required style="width: 100%;">
          </div>
          <button type="submit" style="width: 100%; margin-top: 1rem; font-size: 1.1rem; padding: 0.6rem;">寄送重設連結</button>
        </form>
        <p id="forgot-message" class="message" style="display: none; margin-top: 1rem;"></p>
        <div style="margin-top: 1.5rem; text-align: center;">
          <a href="#/login" class="muted">返回登入</a>
        </div>
      </div>
    `;

    document.getElementById('forgot-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('forgot-email').value;
      try {
        const data = await api('/api/auth/forgot-password', { method: 'POST', body: { email } });
        const msgEl = document.getElementById('forgot-message');
        if (msgEl) {
          msgEl.textContent = data.message || '若該 email 已註冊，重設連結已寄出';
          msgEl.className = 'message';
          msgEl.style.display = 'block';
        }
      } catch (err) {
        showError('forgot-message', err);
      }
    });
  }
};
