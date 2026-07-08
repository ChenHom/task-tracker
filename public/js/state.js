'use strict';

/**
 * @fileoverview Global state store and constants configuration for the task-tracker application.
 */

/**
 * List of roles permitted in workspaces.
 * @type {string[]}
 */
export const ROLES = ['Viewer', 'Member', 'Admin', 'Owner'];

/**
 * Valid workflow statuses for a task.
 * @type {string[]}
 */
export const STATUSES = ['Todo', 'Doing', 'Review', 'Done'];

/**
 * The reactive global state store representing the logged-in user, active workspace, active task,
 * and workspace listings cached in session storage.
 * @type {Object}
 * @property {string|null} workspaceId - The ID of the currently selected workspace.
 * @property {string|null} workspaceName - The name of the currently selected workspace.
 * @property {string|null} taskId - The ID of the task currently being inspected.
 * @property {Array<Object>} globalWorkspaces - The list of active workspaces associated with the user email.
 * @property {string|null} userEmail - Getter/setter for the logged-in user's email cached in sessionStorage.
 * @property {string|null} userName - Getter/setter for the logged-in user's display name cached in sessionStorage.
 */
export const state = {
  workspaceId: null,
  workspaceName: null,
  taskId: null,
  globalWorkspaces: [],

  /**
   * Retrieves the current user's email address from session storage.
   * @type {string|null}
   */
  get userEmail() {
    return sessionStorage.getItem('user_email');
  },
  
  /**
   * Sets or removes the current user's email address in session storage.
   * @type {string|null}
   */
  set userEmail(val) {
    if (val) sessionStorage.setItem('user_email', val);
    else sessionStorage.removeItem('user_email');
  },

  /**
   * Retrieves the current user's display name from session storage.
   * @type {string|null}
   */
  get userName() {
    return sessionStorage.getItem('user_name');
  },

  /**
   * Sets or removes the current user's display name in session storage.
   * @type {string|null}
   */
  set userName(val) {
    if (val) sessionStorage.setItem('user_name', val);
    else sessionStorage.removeItem('user_name');
  },

  /**
   * Clears the current active workspace, task, and clears sessionStorage cached values.
   * @return {void}
   */
  clear() {
    this.workspaceId = null;
    this.workspaceName = null;
    this.taskId = null;
    this.globalWorkspaces = [];
    sessionStorage.removeItem('user_email');
    sessionStorage.removeItem('user_name');
  }
};
