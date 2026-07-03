import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';

const db = new DatabaseSync(':memory:');
runMigrations(db);

const insert = db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)');
insert.run('u1', 'a@b.com', 'hash');

// UNIQUE email 約束必須擋掉重複註冊
assert.throws(() => insert.run('u2', 'a@b.com', 'hash2'), /UNIQUE/);

// created_at 自動填入
const row = db.prepare("SELECT created_at FROM users WHERE id = 'u1'").get() as { created_at: string };
assert.ok(row.created_at, 'created_at should be auto-filled');

console.log('schema.test.ts OK');
