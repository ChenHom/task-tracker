import assert from 'node:assert/strict';
import { ownerAcceptanceIsValid } from './agent';

assert.strictEqual(
  ownerAcceptanceIsValid({ action: 'accept', rationale: 'looks good', evidenceCommentIds: [] }, ''),
  false,
  'reviewedHeadSha 空字串時 accept 必須無效',
);

console.log('sim/production/agent.test.ts OK');
