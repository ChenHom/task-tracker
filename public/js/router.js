import { loadStyle, unloadStyle } from './utils.js';

const ROUTE_CSS = {
  'login': 'login.css',
  'forgot-password': 'login.css',
  'reset-password': 'login.css',
  'workspaces': 'workspaces.css',
  'tasks': 'kanban.css',
  'task': 'kanban.css',
  'members': 'members.css',
  'search': 'kanban.css',
  'audit': 'audit.css'
};

/**
 * Registry of routing mappings matching hash prefixes to view rendering modules.
 * @type {Map<string, Object>}
 */
const routes = new Map();

/**
 * Main DOM container element where active views are rendered.
 * @type {HTMLElement}
 */
const appContainer = document.getElementById('app');

/**
 * Registers a view module mapping under a path prefix.
 * @param {string} pathPrefix - The route prefix matching the location hash (e.g. 'tasks', 'login').
 * @param {Object} viewModule - The view module implementing render interface: render(container, rest, query).
 * @returns {void}
 */
export function registerRoute(pathPrefix, viewModule) {
  routes.set(pathPrefix, viewModule);
}

/**
 * Changes location hash to trigger hashchange event routing.
 * @param {string} hash - The hash path with prefix (e.g. '#/workspaces').
 * @returns {void}
 */
export function navigate(hash) {
  location.hash = hash;
}

/**
 * @typedef {Object} RouteDetails
 * @property {string} prefix - The first segment of the route path (e.g., 'tasks').
 * @property {string[]} rest - Remaining slash-separated route path segments (e.g. IDs).
 * @property {URLSearchParams} query - Parsed URL search parameters object from query string.
 */

/**
 * Parses the current location hash to retrieve path prefixes, parameters, and query parameters.
 * @returns {RouteDetails} The parsed route detail segments.
 */
export function currentRoute() {
  const raw = location.hash.slice(1) || '/login';
  const [path, queryStr] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return {
    prefix: parts[0] || 'login',
    rest: parts.slice(1),
    query: new URLSearchParams(queryStr || '')
  };
}

/**
 * Callback function triggered after a route change occurs.
 * @type {function(string): void|null}
 */
let onRouteCallback = null;

/**
 * Configures the post-routing callback listener. Used to sync sidebar navigation.
 * @param {function(string): void} cb - The route change callback listener.
 * @returns {void}
 */
export function setOnRouteCallback(cb) {
  onRouteCallback = cb;
}

/**
 * Evaluates the current route prefix and triggers rendering of the associated view component.
 * Executes post-routing navigation triggers (e.g. sidebar highlight sync) upon completion.
 * @returns {Promise<void>}
 */
export async function route() {
  const { prefix, rest, query } = currentRoute();

  const cssFile = ROUTE_CSS[prefix];
  if (window.currentViewCss && window.currentViewCss !== cssFile) {
    unloadStyle('view-css');
    window.currentViewCss = null;
  }
  if (cssFile) {
    loadStyle('view-css', `css/${cssFile}`);
    window.currentViewCss = cssFile;
  }

  const view = routes.get(prefix) || routes.get('login');

  if (view) {
    try {
      await view.render(appContainer, rest, query);
    } catch (err) {
      console.error(`Error rendering route ${prefix}:`, err);
    }
  }

  if (onRouteCallback) {
    onRouteCallback(prefix);
  }
}

window.addEventListener('hashchange', route);

/**
 * Bootstraps and evaluates routing matching the initial loaded location hash.
 * @returns {void}
 */
export function initRouter() {
  route();
}
