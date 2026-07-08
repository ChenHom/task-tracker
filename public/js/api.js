'use strict';

import { state } from './state.js';

/**
 * Decoupled wrapper around browser fetch to make HTTP requests to the backend endpoints.
 * Automatically clears the user session and navigates to the login screen upon a 401 Unauthorized status.
 * @param {string} path - The relative server path to execute the request against (e.g. '/api/workspaces').
 * @param {Object} [options] - Additional parameters for fetch.
 * @param {string} [options.method='GET'] - The HTTP method to use (e.g. 'GET', 'POST', 'PATCH', 'DELETE').
 * @param {*} [options.body] - Optional request body to be serialized to JSON.
 * @returns {Promise<*>} Evaluates to the parsed JSON response body, or null if response was empty.
 * @throws {Error} Throws an error on non-ok HTTP responses, or upon 401 redirect behavior.
 */
export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path.replace(/^\//, ''), opts);
  if (res.status === 401) {
    state.clear();
    location.hash = '#/login';
    throw new Error('尚未登入，請重新登入');
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `發生錯誤（HTTP ${res.status}）`);
  }
  return data;
}

/**
 * Executes a POST request to logout backend auth endpoint, clears the local storage state store,
 * and redirects browser hash to the login page.
 * @returns {Promise<void>}
 */
export async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // 忽略
  }
  state.clear();
  location.hash = '#/login';
}
