// 隔離 fixture：重現 openclaw-clone extensions/googlechat/src/auth.ts (project-number 分支)
// 委派驗證的 google-auth-library@10.6.1 OAuth2Client#verifySignedJwtWithCertsAsync 行為。
// 全程只用本機生成的 RSA 假金鑰＋記憶體假 JWKS，不連線任何服務、不使用真實 token。
//
// 執行：node verify.mjs   （需先 npm install，見同目錄 package.json）
// 預期輸出：8 個案例逐一列出 PASS，違反任一行為即印出 FAIL 並以非 0 結束。

import { generateKeyPairSync, createSign } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

function b64url(input) {
  return Buffer.from(JSON.stringify(input)).toString('base64url');
}

function signJwt(header, payload, privateKey) {
  const signed = `${b64url(header)}.${b64url(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signed);
  signer.end();
  const signature = signer.sign(privateKey, 'base64url');
  return `${signed}.${signature}`;
}

const { publicKey: pub1, privateKey: priv1 } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { publicKey: pub2, privateKey: priv2 } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem1 = pub1.export({ type: 'spki', format: 'pem' });
const pem2 = pub2.export({ type: 'spki', format: 'pem' });

const ISSUER = 'chat@system.gserviceaccount.com';
const AUDIENCE = 'https://example.invalid/webhook';
const certsKid1Only = { kid1: pem1 };

const client = new OAuth2Client();
const now = () => Math.floor(Date.now() / 1000);

function basePayload(overrides = {}) {
  const t = now();
  return { iss: ISSUER, aud: AUDIENCE, iat: t, exp: t + 3600, ...overrides };
}

let failures = 0;
async function expectOk(name, jwt, certs = certsKid1Only) {
  try {
    await client.verifySignedJwtWithCertsAsync(jwt, certs, AUDIENCE, [ISSUER]);
    console.log(`PASS [${name}] -> 接受（符合預期）`);
  } catch (err) {
    failures++;
    console.log(`FAIL [${name}] -> 預期接受，實際拒絕：${err.message}`);
  }
}

async function expectReject(name, jwt, expectedSubstring, certs = certsKid1Only) {
  try {
    await client.verifySignedJwtWithCertsAsync(jwt, certs, AUDIENCE, [ISSUER]);
    failures++;
    console.log(`FAIL [${name}] -> 預期拒絕，實際接受`);
  } catch (err) {
    if (expectedSubstring && !err.message.includes(expectedSubstring)) {
      failures++;
      console.log(`FAIL [${name}] -> 拒絕理由不符，預期含「${expectedSubstring}」，實際：${err.message}`);
    } else {
      console.log(`PASS [${name}] -> 拒絕（符合預期）：${err.message}`);
    }
  }
}

async function main() {
  // 1. 合法 token（正確 iss/aud/exp、已知 kid）
  await expectOk(
    '合法 token',
    signJwt({ alg: 'RS256', typ: 'JWT', kid: 'kid1' }, basePayload(), priv1)
  );

  // 2. 錯 issuer
  await expectReject(
    '錯 issuer',
    signJwt({ alg: 'RS256', typ: 'JWT', kid: 'kid1' }, basePayload({ iss: 'not-google@evil.example' }), priv1),
    'Invalid issuer'
  );

  // 3. 錯 audience
  await expectReject(
    '錯 audience',
    signJwt({ alg: 'RS256', typ: 'JWT', kid: 'kid1' }, basePayload({ aud: 'https://attacker.invalid' }), priv1),
    'Wrong recipient'
  );

  // 4. 過期 token（超出 300 秒 clock skew）
  await expectReject(
    '過期 token',
    signJwt({ alg: 'RS256', typ: 'JWT', kid: 'kid1' }, basePayload({ iat: now() - 4000, exp: now() - 400 }), priv1),
    'Token used too late'
  );

  // 5. 未知 kid
  await expectReject(
    '未知 kid',
    signJwt({ alg: 'RS256', typ: 'JWT', kid: 'kid-does-not-exist' }, basePayload(), priv1),
    'No pem found for envelope'
  );

  // 6. typ 造假（設成 NOT-A-JWT，其餘合法）：驗證 typ 完全未被檢查
  await expectOk(
    'typ 造假仍被接受（typ 未檢查缺口）',
    signJwt({ alg: 'RS256', typ: 'NOT-A-JWT', kid: 'kid1' }, basePayload(), priv1)
  );

  // 7. alg:none 偽造＋空簽章：不應被接受（驗證不依賴 alg 宣告，走固定 RSA-SHA256）
  {
    const header = { alg: 'none', typ: 'JWT', kid: 'kid1' };
    const payload = basePayload();
    const forged = `${b64url(header)}.${b64url(payload)}.`;
    await expectReject('alg:none 偽造＋空簽章', forged, 'Invalid token signature');
  }

  // 8. 模擬金鑰輪替：provider 已換發 kid2，但驗證端快取仍只有 kid1
  await expectReject(
    '金鑰輪替期間新 kid 未在快取中',
    signJwt({ alg: 'RS256', typ: 'JWT', kid: 'kid2' }, basePayload(), priv2),
    'No pem found for envelope',
    certsKid1Only // 刻意不放入 pem2，重現 10 分鐘快取視窗內無法識別新 kid 的情境
  );

  console.log('---');
  if (failures > 0) {
    console.log(`結果：${failures} 個案例與預期不符`);
    process.exit(1);
  }
  console.log('結果：全部 8 個案例皆符合預期');
}

main();
