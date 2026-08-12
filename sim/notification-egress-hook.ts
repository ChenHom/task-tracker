import { readFileSync, writeFileSync } from 'node:fs';
import {
  validateAttachmentReadPath,
  validateEgressCall,
  type AttachmentReadPolicy,
  type EgressPolicy,
} from './notificationSecurity';

interface HookInput {
  tool_name?: string;
  tool_input?: { query?: string; url?: string; path?: string; file_path?: string; filePath?: string };
  name?: string;
  input?: { query?: string; url?: string; path?: string; file_path?: string; filePath?: string };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { value += chunk; });
    process.stdin.on('end', () => resolve(value));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const policyPath = process.env.NOTIFICATION_EGRESS_POLICY_FILE;
  if (!policyPath) {
    process.exitCode = 2;
    return;
  }
  let policy: EgressPolicy;
  let input: HookInput;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8')) as EgressPolicy;
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    process.exitCode = 2;
    return;
  }
  const type = input.tool_name ?? input.name ?? '';
  const toolInput = input.tool_input ?? input.input ?? {};
  if (type === 'Read') {
    const path = toolInput.path ?? toolInput.file_path ?? toolInput.filePath;
    if (typeof path !== 'string') {
      process.exitCode = 2;
      return;
    }
    if (!('cwd' in policy) || !('allowedReadPaths' in policy)) {
      process.exitCode = 2;
      return;
    }
    const decision = validateAttachmentReadPath(path, policy as AttachmentReadPolicy);
    if (!decision.ok) {
      process.exitCode = 2;
      return;
    }
    process.exitCode = 0;
    return;
  }
  const decision = validateEgressCall({ type, query: toolInput.query, url: toolInput.url }, policy);
  if (!decision.ok) {
    process.exitCode = 2;
    return;
  }
  if (type === 'WebSearch') {
    const nextPolicy = { ...policy, searchCount: (policy.searchCount ?? 0) + 1 };
    writeFileSync(policyPath, JSON.stringify(nextPolicy), { mode: 0o600 });
  }
  process.exitCode = 0;
}

void main().catch(() => { process.exitCode = 2; });
