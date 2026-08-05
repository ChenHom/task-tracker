# Google Chat JWT 隔離驗證 fixture

重現 `openclaw-clone/extensions/googlechat/src/auth.ts`（project-number 分支）委派驗證的
`google-auth-library@10.6.1` `OAuth2Client#verifySignedJwtWithCertsAsync` 行為。

全程只用本機生成的 RSA 假金鑰＋記憶體假 JWKS，不連線任何服務、不使用真實 token／JWKS。
這個資料夾自帶獨立 `package.json`／lockfile，不影響 task-tracker 主專案的相依性。

## 重跑方式

```bash
cd docs/security/fixtures/google-chat-jwt
npm install
npx tsx verify.mjs
```

預期輸出：8 個案例逐一列出 `PASS`，最後一行「結果：全部 8 個案例皆符合預期」。
任一案例與預期不符會印出 `FAIL` 並以非 0 結束。

## 對應清冊

完整盤點與缺口說明見 [`../../jwt-oidc-inventory.md`](../../jwt-oidc-inventory.md)。
