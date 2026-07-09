'use strict';

import { state } from './state.js';

/**
 * Validates if a workspace is selected. If not, renders a placeholder message
 * indicating that the user needs to select a workspace and returns false.
 * @param {HTMLElement} container - The DOM container element where the placeholder message is rendered.
 * @returns {boolean} True if workspace is selected, false otherwise.
 */
export function requireWorkspace(container) {
  if (!state.workspaceId) {
    container.innerHTML = `
      <div class="sketch-box" style="padding: 2rem; background: #fff; text-align: center; max-width: 500px; margin: 3rem auto;">
        <h2>尚未選擇工作區</h2>
        <p class="muted">請先回到工作區選單選擇一個工作區以繼續。</p>
        <a href="#/workspaces" class="nav-btn" style="margin-top: 1rem; display:inline-block;">前往選擇工作區</a>
      </div>
    `;
    return false;
  }
  return true;
}

/**
 * Formats an ISO date string into a custom YYYY-MM-DD HH:MM readable representation.
 * @param {string|null|undefined} isoStr - The ISO 8601 timestamp string.
 * @returns {string} The formatted timestamp or '未知時間' if invalid/null.
 */
export function formatTime(isoStr) {
  if (!isoStr) return '未知時間';
  const date = new Date(isoStr);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * Utility to set text content of a DOM element by ID.
 * @param {string} id - The ID of the target DOM element.
 * @param {string} value - The text content to set.
 * @returns {void}
 */
export function setText(id, value) {
  const target = document.getElementById(id);
  if (target) target.textContent = value;
}

/**
 * Renders an error message to a target DOM element or triggers an alert if the element does not exist.
 * @param {string} id - The ID of the DOM element to place the error.
 * @param {Error|string} err - The Error object or text string to extract the message from.
 * @returns {void}
 */
export function showError(id, err) {
  const val = err instanceof Error ? err.message : String(err);
  const target = document.getElementById(id);
  if (target) {
    target.textContent = val;
    target.style.display = 'block';
  } else {
    alert(val);
  }
}

/**
 * Helper function to instantiate a DOM element with given attributes and text content.
 * Any attribute matching 'onclick', 'onchange', or 'onsubmit' is registered as a handler property on the node.
 * All other properties are registered via setAttribute.
 * @param {string} tag - The HTML tag name (e.g. 'div', 'button', 'a').
 * @param {Object.<string, *>} [attrs] - Key-value pair attributes object.
 * @param {string|null} [text] - Text content to render within the element securely via textContent.
 * @returns {HTMLElement} The created DOM element.
 */
export function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'onclick' || k === 'onchange' || k === 'onsubmit') node[k] = v;
      else node.setAttribute(k, v);
    }
  }
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * Dynamically loads a stylesheet.
 * @param {string} id - Unique ID for the link tag.
 * @param {string} href - URL of the stylesheet.
 * @returns {void}
 */
export function loadStyle(id, href) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

/**
 * Dynamically removes a stylesheet.
 * @param {string} id - Unique ID of the link tag.
 * @returns {void}
 */
export function unloadStyle(id) {
  const link = document.getElementById(id);
  if (link) link.remove();
}
