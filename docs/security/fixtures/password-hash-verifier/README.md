# password-hash-verifier fixture

僅用合成帳號（假 email／假密碼）在本機記憶體驗證 `src/auth.ts` 的
`hashPassword` / `verifyPassword` / `attemptLogin` 行為，不連任何正式 DB、
不讀取任何正式 `password_hash`。

重跑方式：

```bash
npx tsx docs/security/fixtures/password-hash-verifier/verify.mjs
```
