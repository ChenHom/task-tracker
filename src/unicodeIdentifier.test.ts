import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { domainToASCII } from 'node:url';
import { runMigrations } from './schema';
import { resetProjections } from './eventStore';
import { createUser } from './auth';
import { createWorkspace, listWorkspaces, registerWorkspaceProjections } from './workspace';
import { getMemberRole, inviteMember, joinWorkspace, listMembers, registerMemberProjections } from './member';
import { createAttachment, deleteAttachment, getAttachmentContext, listAttachments, readAttachment } from './attachment';

const database = new DatabaseSync(':memory:');
runMigrations(database);
resetProjections();
registerWorkspaceProjections();
registerMemberProjections();

const ownerId = createUser('owner@example.com', '同名顯示者', 'test1234', database);
const nfcEmail = 'café@example.com';
const nfdEmail = 'cafe\u0301@example.com';
const nfcName = '使用者é';
const nfdName = '使用者e\u0301';
const nfcUserId = createUser(nfcEmail, nfcName, 'test1234', database);
const nfdUserId = createUser(nfdEmail, nfdName, 'test1234', database);
const unicodeDomain = '例子.測試';
const unicodeDomainEmail = `User@${unicodeDomain}`;
const unicodeDomainUserId = createUser(unicodeDomainEmail, 'Unicode 網域', 'test1234', database);
const sameNameUserId = createUser('same-name@example.com', '同名顯示者', 'test1234', database);
const confusableLatin = 'paypal';
const confusableCyrillic = '\u0440\u0430ypal';
const confusableUserId = createUser('confusable@example.com', confusableCyrillic, 'test1234', database);
const mixedCaseUserId = createUser('  Case@Example.COM  ', '大小寫測試', 'test1234', database);

const storedEmails = database
  .prepare('SELECT id, email, name FROM users WHERE id IN (?, ?) ORDER BY email')
  .all(nfcUserId, nfdUserId) as Array<{ id: string; email: string; name: string }>;
assert.strictEqual(storedEmails.length, 2, 'NFC/NFD email fixture 應各自保存');
assert.notStrictEqual(storedEmails[0].email, storedEmails[1].email, '目前 email key 未做 NFC 正規化');
assert.strictEqual(storedEmails.find((row) => row.id === nfcUserId)?.email, nfcEmail, 'NFC email 應維持原始 code point');
assert.strictEqual(storedEmails.find((row) => row.id === nfdUserId)?.email, nfdEmail, 'NFD email 應維持原始 code point');
assert.notStrictEqual(nfcName, nfdName, 'NFC/NFD name fixture 應保留不同 code point');
assert.strictEqual(
  (database.prepare('SELECT name FROM users WHERE id = ?').get(nfcUserId) as { name: string }).name,
  nfcName,
  'NFC name readback 應保留原始 code point',
);
assert.strictEqual(
  (database.prepare('SELECT name FROM users WHERE id = ?').get(nfdUserId) as { name: string }).name,
  nfdName,
  'NFD name readback 應保留原始 code point',
);
assert.strictEqual(nfcEmail.normalize('NFC'), nfdEmail.normalize('NFC'), 'Node NFC 觀察值應顯示兩者可正規化為同值');

const domainRow = database
  .prepare('SELECT email FROM users WHERE id = ?')
  .get(unicodeDomainUserId) as { email: string };
assert.strictEqual(domainRow.email, unicodeDomainEmail.toLowerCase(), 'Unicode domain 目前只做 JS lower case，不轉 Punycode');
assert.ok(domainToASCII(unicodeDomain), 'Node IDNA probe 應能產生 ASCII/Punycode domain');
assert.strictEqual(
  (database.prepare('SELECT id FROM users WHERE email = ?').get(domainRow.email) as { id: string }).id,
  unicodeDomainUserId,
  'Unicode domain raw email 可用同一 raw key 查回',
);

const equality = database
  .prepare(
    `SELECT
       ? = ? AS binary_confusable_equal,
       ? = ? AS binary_ascii_case_equal,
       ? = ? COLLATE NOCASE AS nocase_ascii_case_equal`,
  )
  .get(confusableLatin, confusableCyrillic, 'A', 'a', 'A', 'a') as {
  binary_confusable_equal: number;
  binary_ascii_case_equal: number;
  nocase_ascii_case_equal: number;
};
assert.strictEqual(equality.binary_confusable_equal, 0, 'Latin/Cyrillic confusable 在 SQLite BINARY 下應保持不同');
assert.strictEqual(equality.binary_ascii_case_equal, 0, 'SQLite 預設 BINARY 不自動做 ASCII case-insensitive');
assert.strictEqual(equality.nocase_ascii_case_equal, 1, 'SQLite NOCASE 僅作為明確 query collation 才會合併 ASCII 大小寫');
assert.strictEqual(
  (database.prepare('SELECT name FROM users WHERE id = ?').get(confusableUserId) as { name: string }).name,
  confusableCyrillic,
  'confusable display name 不應被自動封鎖或改寫',
);
assert.strictEqual(
  (database.prepare('SELECT email FROM users WHERE id = ?').get(mixedCaseUserId) as { email: string }).email,
  'case@example.com',
  'createUser 的 canonical email key 是 trim + JS toLowerCase',
);

const workspaceName = '協作\u200d區\u202eA';
const workspaceId = createWorkspace(ownerId, workspaceName, database);
assert.strictEqual(listWorkspaces(ownerId, database)[0].name, workspaceName, 'workspace display name 應保留 ZWJ/Bidi code point');

inviteMember(ownerId, workspaceId, sameNameUserId, 'Member', database);
joinWorkspace(sameNameUserId, workspaceId, database);
inviteMember(ownerId, workspaceId, nfcUserId, 'Member', database);
joinWorkspace(nfcUserId, workspaceId, database);
assert.strictEqual(getMemberRole(workspaceId, sameNameUserId, database), 'Member', 'RBAC lookup 應用 user UUID');
assert.strictEqual(getMemberRole(workspaceId, nfcUserId, database), 'Member', '不同 UUID 的同類成員應各自有 membership');
assert.strictEqual(getMemberRole(workspaceId, '同名顯示者', database), null, '顯示名稱不可被當成 RBAC user key');
const memberRows = listMembers(workspaceId, database);
assert.strictEqual(memberRows.filter((row) => row.name === '同名顯示者').length, 2, '同名 display value 不應合併成一名成員');
for (const row of memberRows) {
  assert.deepStrictEqual(Object.keys(row).sort(), ['email', 'joined_at', 'name', 'role', 'user_id'], 'member readback 應維持既有 allowlist');
}

const taskId = 'unicode-baseline-task';
database
  .prepare(
    'INSERT INTO tasks_read_model (task_id, workspace_id, title, description, status, priority, assignee_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  .run(taskId, workspaceId, 'Unicode fixture', '', 'Todo', 'Medium', sameNameUserId, 1);
const attachmentName = '報告\u200d2026\u202e.txt';
const attachmentId = createAttachment(taskId, attachmentName, 'text/plain', Buffer.from('unicode fixture'), database);
assert.strictEqual(getAttachmentContext(attachmentId, database)!.workspace_id, workspaceId, 'attachment context 應以 task/workspace UUID 連接');
const attachmentRows = listAttachments(taskId, database);
assert.strictEqual(attachmentRows[0].original_name, attachmentName, 'attachment original_name 應保留 ZWJ/Bidi display code point');
assert.deepStrictEqual(
  Object.keys(attachmentRows[0]).sort(),
  ['attachment_id', 'mime_type', 'original_name', 'size', 'task_id'],
  'attachment list readback 不應外洩 stored_name',
);
const attachmentFile = readAttachment(attachmentId, database)!;
assert.strictEqual(attachmentFile.originalName, attachmentName, 'attachment download metadata 應保留 display name');
assert.deepStrictEqual(Object.keys(attachmentFile).sort(), ['data', 'mime', 'originalName'], 'attachment download readback 應維持 allowlist');
const storedName = (database.prepare('SELECT stored_name FROM attachments WHERE attachment_id = ?').get(attachmentId) as { stored_name: string }).stored_name;
assert.match(storedName, /^[0-9a-f-]{36}$/i, 'stored_name 應是 server-generated UUID');
assert.notStrictEqual(storedName, attachmentName, 'stored_name 不應採用原始檔名');
deleteAttachment(attachmentId, database);

const collations = database.prepare('PRAGMA collation_list').all() as Array<{ seq: number; name: string }>;
const sqliteVersion = (database.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
const usersColumns = database.prepare('PRAGMA table_info(users)').all() as Array<{ name: string; type: string; notnull: number }>;

console.log(
  JSON.stringify(
    {
      runtime: {
        node: process.versions.node,
        icu: process.versions.icu,
        unicode: process.versions.unicode,
        cldr: process.versions.cldr,
        sqlite: sqliteVersion,
      },
      sqlite: {
        collations: collations.map((row) => row.name),
        usersEmailColumn: usersColumns.find((row) => row.name === 'email'),
        defaultEquality: equality.binary_ascii_case_equal,
        explicitNoCaseEquality: equality.nocase_ascii_case_equal,
      },
      observed: {
        nfcEqualsNfdAfterNfc: nfcEmail.normalize('NFC') === nfdEmail.normalize('NFC'),
        storedNfcEmail: nfcEmail,
        storedNfdEmail: nfdEmail,
        unicodeDomainRaw: domainRow.email,
        unicodeDomainAscii: domainToASCII(unicodeDomain),
        confusableRawValuesRemainDistinct: equality.binary_confusable_equal === 0,
        workspaceDisplayValue: workspaceName,
        attachmentDisplayValue: attachmentName,
        rbacKey: 'workspace_members_read_model.(workspace_id,user_id)',
        attachmentKey: 'attachments.(attachment_id,stored_name)',
      },
    },
    null,
    2,
  ),
);
console.log('unicodeIdentifier.test.ts OK');
