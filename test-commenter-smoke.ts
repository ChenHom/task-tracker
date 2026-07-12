import { createWorkspace } from './src/workspace';
import { inviteMember } from './src/member';
import { createTask, applyTaskPatch, changeTaskDescription } from './src/task';
import { CommandError } from './src/eventStore';
import { db } from './src/db';
import assert from 'assert';

try {
  // 建立測試 workspace
  const wsId = createWorkspace('user1', 'Test WS', db);
  inviteMember(db, wsId, 'commenter@test.local', 'Commenter', 'u2');
  inviteMember(db, wsId, 'admin@test.local', 'Admin', 'u3');

  // Commenter 建立 task
  const taskId1 = createTask('u2', wsId, { title: 'Commenter Task', description: 'Original' }, db);
  console.log('✓ Commenter 建立 task:', taskId1);

  // 測試 1: Commenter 修改自己建立的 task 的 description
  try {
    changeTaskDescription('u2', taskId1, 'Modified', db);
    console.log('✓ Commenter 可以修改自己建立 task 的 description');
  } catch (e) {
    console.log('✗ Commenter 修改自己的 description 失敗:', (e as any).message);
  }

  // Admin 建立 task
  const taskId2 = createTask('u3', wsId, { title: 'Admin Task', description: 'Original' }, db);
  console.log('✓ Admin 建立 task:', taskId2);

  // 測試 2: Commenter 修改別人建立的 task 的 description
  try {
    changeTaskDescription('u2', taskId2, 'Modified', db);
    console.log('✗ Commenter 不該能修改別人的 description（但沒有被擋）');
  } catch (e) {
    console.log('✓ Commenter 修改別人描述被擋:', (e as any).message);
  }

  // 測試 3: Commenter 修改非 description 欄位
  try {
    applyTaskPatch('u2', taskId1, { status: 'Doing' }, db);
    console.log('✗ Commenter 不該能改 status（但沒有被擋）');
  } catch (e) {
    console.log('✓ Commenter 改 status 被擋:', (e as any).message);
  }
} catch (e) {
  console.error('Test setup error:', e);
}
