import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

export type CapabilityKind = 'safeDiscussion' | 'ownerInternal' | 'memberInternal';

export interface CapabilityProfile {
  kind: CapabilityKind;
  tools: string;
  repoRoot: string | null;
}

const TASK_TRACKER_ROOT = resolve(__dirname, '..');

export const SAFE_DISCUSSION_PROFILE: CapabilityProfile = {
  kind: 'safeDiscussion',
  tools: 'WebSearch,WebFetch',
  repoRoot: null,
};

export const INTERNAL_OWNER_TOOLS = 'Bash(curl:*),Bash(npx:*),Bash(npm:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git merge:*),Bash(git add:*),Bash(git commit:*),Read,Write,Edit,Glob,Grep';
export const INTERNAL_MEMBER_TOOLS = 'Bash(curl:*),Bash(npx:*),Bash(npm:*),Bash(git status:*),Bash(git diff:*),Bash(git merge:*),Bash(git add:*),Bash(git commit:*),Read,Write,Edit,Glob,Grep';

export const INTERNAL_OWNER_PROFILE: CapabilityProfile = {
  kind: 'ownerInternal',
  tools: INTERNAL_OWNER_TOOLS,
  repoRoot: TASK_TRACKER_ROOT,
};

export const INTERNAL_MEMBER_PROFILE: CapabilityProfile = {
  kind: 'memberInternal',
  tools: INTERNAL_MEMBER_TOOLS,
  repoRoot: resolve(TASK_TRACKER_ROOT, 'sim-work'),
};

export function assertCapabilityPath(profile: CapabilityProfile, path: string): void {
  if (!profile.repoRoot) throw new Error(`capability path 不允許：${profile.kind} 沒有 repo root`);
  const root = resolve(profile.repoRoot);
  const target = resolve(path);
  const escaped = relative(root, target);
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || resolve(root, escaped) !== target) {
    throw new Error(`capability path 超出 ${profile.kind} root：${path}`);
  }
}

export function writeActorCookieJar(path: string, cookie: string): void {
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/u);
  const value = match?.[1];
  if (!value || /[\r\n\t]/u.test(value)) throw new Error('只接受有效的 session cookie');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    '# Netscape HTTP Cookie File',
    'localhost\tFALSE\t/\tFALSE\t0\tsession\t' + value,
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(path, 0o600);
}
