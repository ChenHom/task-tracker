'use strict';

import { api } from '../api.js';
import { state } from '../state.js';
import { navigate } from '../router.js';
import { syncGlobalWorkspaces } from '../sidebar.js';
import { showError } from '../utils.js';

/**
 * Controller representation for the Login page View.
 * @type {Object}
 */
export const LoginView = {
  /**
   * Renders the Login page into the target container and binds authentication actions.
   * @param {HTMLElement} container - The DOM container element where the page is rendered.
   * @returns {Promise<void>}
   */
  async render(container) {
    container.innerHTML = `
      <div class="sketch-box" style="max-width: 450px; margin: 3rem auto; padding: 2rem; background: #fff;">
        <h2 style="margin-top: 0; text-align: center; font-size: 2rem;">使用者登入</h2>
        <form id="login-form">
          <div>
            <label>電子信箱 (Email)</label>
            <input type="email" id="login-email" placeholder="example@test.local" required style="width: 100%;">
          </div>
          <div>
            <label>密碼 (Password)</label>
            <input type="password" id="login-password" required style="width: 100%;">
          </div>
          <button type="submit" style="width: 100%; margin-top: 1rem; font-size: 1.1rem; padding: 0.6rem;">登入</button>
        </form>
        <p id="login-error" class="error" style="display: none; margin-top: 1rem;"></p>
        <div style="margin-top: 1.5rem; text-align: center; display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.95rem;">
          <span class="muted">預設帳號: user09@test.local / test1234</span>
          <a href="#/forgot-password" class="muted">忘記密碼？</a>
        </div>
      </div>
    `;

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      try {
        await api('/api/auth/login', { method: 'POST', body: { email, password } });
        state.userEmail = email;
        try {
          const user = await api('/api/auth/me');
          if (user && user.name) {
            state.userName = user.name;
          }
        } catch (meErr) {
          // ignore
        }
        await syncGlobalWorkspaces();
        navigate('#/workspaces');
      } catch (err) {
        showError('login-error', err);
      }
    });
  }
};
