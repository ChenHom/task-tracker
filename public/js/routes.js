'use strict';

/**
 * @fileoverview Route setup module. Imports all view controllers and registers them with the router.
 */

import { registerRoute } from './router.js';

// Import all view modules
import { LoginView } from './views/login.js';
import { ForgotPasswordView } from './views/forgot-password.js';
import { ResetPasswordView } from './views/reset-password.js';
import { WorkspacesView } from './views/workspaces.js';
import { KanbanView } from './views/kanban.js';
import { MembersView } from './views/members.js';
import { SearchView } from './views/search.js';
import { AuditView } from './views/audit.js';

// Register prefixes to target View controller instances
registerRoute('login', LoginView);
registerRoute('forgot-password', ForgotPasswordView);
registerRoute('reset-password', ResetPasswordView);
registerRoute('workspaces', WorkspacesView);
registerRoute('tasks', KanbanView);
registerRoute('task', KanbanView);
registerRoute('members', MembersView);
registerRoute('search', SearchView);
registerRoute('audit', AuditView);
