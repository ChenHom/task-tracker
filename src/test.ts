import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// 測試聚合入口：新增測試就多一行 import。任何 assert 失敗會讓 process 非零退出。
import './staticPath.test';
import './schema.test';
import './auth.test';
import './seed.test';
import './eventStore.test';
import './workspace.test';
import './member.test';
import './mainWorkspace.test';
import './mainDiscussion.test';
import './task.test';
import './project.test';
import './comment.test';
import './notification.test';
import './attachment.test';
import './search.test';
import './audit.test';
import './rateLimit.test';
import './archiveDoneTasks.test';
import './quota.test';
import './quotaFrontend.test';
import './notificationsFrontend.test';
import './escBack.test';
import './unicodeIdentifier.test';
import './frontend.test';
import './frontendCore.test';
import './frontendViews.test';

// server.test 需要獨立的暫存資料庫，避免與前面已載入的 in-process db 共用。
execFileSync(process.execPath, ['--import', 'tsx', join(__dirname, 'server.test.ts')], { stdio: 'inherit' });
