# P2a Verification — yc-tech-dingyuanying-chat

> P2a 阶段的可机判证据汇总。Master agent 校验时直接读这里。

## TL;DR

| Item | Status |
|---|---|
| Branch | `p2a/newapi-provisioning` (built on P1.5 `ad7e0318e`) |
| New-API admin client | DONE — `packages/api/src/newapi/client.ts` |
| Provisioning orchestrator | DONE — `packages/api/src/newapi/provisioning.ts` |
| AES-256-GCM sub-key crypto | DONE — `packages/api/src/crypto/subkey.ts` |
| Mongoose schema fields | DONE — `newapi_subkey_encrypted: String (select:false)` + `newapi_user_id: Number` in `packages/data-schemas/src/schema/user.ts` |
| Registration hook (NEWAPI_PROVISIONING_HOOK) | DONE — `api/server/services/AuthService.js#registerUser` |
| Failure rollback | DONE — reuses existing catch-block `deleteUserById(newUserId)` (no new code path; provisioning throws → existing rollback fires) |
| Chat-side decrypt + override | DONE — `api/server/middleware/attachSubkey.js` + `packages/api/src/endpoints/custom/initialize.ts` |
| Criterion 4.1 happy-path | PASS — `api/server/services/__tests__/newapi-provisioning.spec.js:228` |
| Criterion 4.1 rollback (HTTP 500 on POST /api/user/) | PASS — `…:286` |
| Criterion 4.1 rollback (empty token list) | PASS — `…:309` |
| Crypto round-trip (100 IVs unique) | PASS — `…:333` |
| Tamper detection (GCM authTag) | PASS — `…:347` |
| `attachSubkey` middleware unit tests | PASS — 4/4, `api/server/middleware/__tests__/attachSubkey.spec.js` |
| P1+P1.5 regression | **23 / 23 PASS** unchanged |
| Combined own-test count | **32 / 32 PASS** |
| Lint of changed files | EXIT 0 |
| Typecheck of `packages/api` + `packages/data-schemas` | EXIT 0 |

## 1. New-API admin API 契约

来源：[QuantumNous/new-api](https://github.com/QuantumNous/new-api) `controller/user.go` + `controller/token.go`，仓库 P2a 实施日期：2026-05-07。

| Endpoint | Auth | Body | Response |
|---|---|---|---|
| `POST /api/user/` | `Authorization: <NEWAPI_ADMIN_KEY>` (AdminAuth) | `{ username, password, display_name }` | `{ success, message }` —**没有** id |
| `POST /api/user/login` | none (turnstile/rate-limited in prod, plain in self-host) | `{ username, password }` | `{ success, message, data: { id, username, access_token, ... } }` |
| `POST /api/token/` | `Authorization: <user.access_token>` + `New-Api-User: <user.id>` (UserAuth) | `{ name, remain_quota, unlimited_quota, model_limits_enabled, expired_time }` | `{ success, message }` —**没有** key（安全设计：原 UI 创建后用 list 拿 key） |
| `GET /api/token/?p=0&size=N` | UserAuth + `New-Api-User` | — | `{ success, data: { items: [{ id, name, key, remain_quota, ... }] } }` |

**契约偏离原始 P2a spec 提示的两处**：

1. `POST /api/user/` 的响应不返回 user_id —— 这是上游硬编码的（参见 [`controller/user.go`](https://github.com/QuantumNous/new-api/blob/main/controller/user.go) 的 `Register`/`CreateUser`）。我们用 `POST /api/user/login` 拿到 access_token 同时带回 `id`，绕过这个限制。
2. `POST /api/token/` 也不返回 key —— 同样的上游设计（[`controller/token.go`](https://github.com/QuantumNous/new-api/blob/main/controller/token.go) 的 `AddToken`），原意是 UI 在 `success` 后调一次 `GET /api/token/` 拉 list。我们 headless 端复刻这个流程。

如果未来切到 fork 行为不同的 New-API 实例，client.ts 最上方的注释把契约和绕过手段一起写了，可单点修改。

## 2. 加密机制

| Field | Value |
|---|---|
| Algorithm | `aes-256-gcm` (Node `crypto.createCipheriv`) |
| IV | 12 bytes (NIST GCM 推荐长度), `crypto.randomBytes(12)` 每次加密都重新生成 |
| Auth tag | 16 bytes |
| Format | `gcm:v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>` |
| Key source | `process.env.SUBKEY_ENCRYPTION_KEY`，64-char hex (32 字节)，懒加载（每次 encrypt/decrypt 都从 env 重读，方便测试 + 未来 key rotation） |
| Encrypt fn | `packages/api/src/crypto/subkey.ts:48` — `encryptSubkey(plain) -> string` |
| Decrypt fn | `packages/api/src/crypto/subkey.ts:62` — `decryptSubkey(payload) -> string`，authTag 不匹配时 throw |

**为什么不复用现有 `encryptV3` (AES-256-CTR)**：CTR 没有 MAC，密文翻一位明文翻一位。对于会被原样塞进 outgoing `Authorization` header 的 credential，损坏的 DB 记录必须**在解密时 fail 响亮**，而不是默默生成一个畸形 bearer。GCM 的 authTag 提供 AEAD 完整性保证。

**生成 SUBKEY_ENCRYPTION_KEY**：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. 注册 hook

| Field | Value |
|---|---|
| File | `api/server/services/AuthService.js` |
| Grep keyword | `NEWAPI_PROVISIONING_HOOK` (出现在该文件 + `provisioning.ts` + `attachSubkey.js` + `chat.js` 路由 + 本文档) |
| 触发位置 | `registerUser`，在 `createUser` 持久化之后、邮件发送之前（line 240 附近） |
| 启用条件 | `process.env.NEWAPI_ADMIN_BASE_URL && process.env.NEWAPI_ADMIN_KEY` —— 两个 env 任一缺失则整段 skip，dev 环境无 New-API 时不会被这一锁死掉 |

### 失败回滚路径

不引入新的 try/catch。利用 `registerUser` 已有的外层 catch：
```js
} catch (err) {
  logger.error('[registerUser] Error in registering user:', err);
  if (newUserId) {
    const result = await deleteUserById(newUserId);   // ← 已存在
    ...
  }
  return { status: 500, message: 'Something went wrong' };
}
```

provisioning 抛错的任何点（createUser HTTP 500、loginAsUser 失败、createToken 失败、listTokens 找不到刚建的 token）都会冒泡到这个 catch，`newUserId` 因为是在 try block 顶部赋值的，所以 rollback 必然命中。**测试 4.1 第 2/3 case 验证了这条路径**。

## 4. Sub-key 链路（注册→存储→消费）

```
┌──────────────────────────┐
│ POST /api/auth/register  │
└───────────┬──────────────┘
            ▼
   AuthService.registerUser
            │
            ▼
   createUser(LibreChat User) ─────► newUserId
            │
            ▼
   if NEWAPI_ADMIN_BASE_URL+KEY:
       provisionUserAndSubkey(...)   ◄── packages/api/src/newapi/provisioning.ts
         ├─ POST /api/user/         (admin)
         ├─ POST /api/user/login    (returns access_token + id)
         ├─ POST /api/token/        (user)
         └─ GET  /api/token/        (user) → key
       ▼
       encryptSubkey(key)          ◄── packages/api/src/crypto/subkey.ts
       ▼
       updateUser(newUserId, {
         newapi_subkey_encrypted: <gcm:v1:...>,
         newapi_user_id: <number>,
       })

──────────  user later sends a chat  ──────────

POST /api/agents/chat
   ├─ dingYuanyingLock         (P1.5, persona + 50k token cap)
   ├─ attachSubkey             ◄── api/server/middleware/attachSubkey.js
   │     1) getUserById(_id, 'newapi_subkey_encrypted')
   │     2) decryptSubkey(...) → req.upstreamApiKey
   ├─ moderateText / checkAgentAccess / validateConvoAccess
   └─ buildEndpointOption
         ▼
   AgentController → initializeClient(custom, ycapi)
         ▼
   initializeCustom (packages/api/src/endpoints/custom/initialize.ts)
         │
         │  apiKey = req.upstreamApiKey ?? userValues?.apiKey ?? CUSTOM_API_KEY
         ▼
   getOpenAIConfig(apiKey, ...) → ChatOpenAI
         ▼
   outbound HTTP: Authorization: Bearer <decrypted user sub-key>
```

| Stage | File:line |
|---|---|
| 加密 + 存储 | `api/server/services/AuthService.js:236-258`（hook 在 createUser 之后到 emailEnabled 检查之前） |
| 解密 hook（middleware） | `api/server/middleware/attachSubkey.js:25` |
| 消费点（覆盖 apiKey） | `packages/api/src/endpoints/custom/initialize.ts:103-110` |

## 5. Mongoose schema

```ts
// packages/data-schemas/src/schema/user.ts
newapi_subkey_encrypted: {
  type: String,
  select: false,    // ← 不出现在默认 findOne projection
},
newapi_user_id: {
  type: Number,
},
```

`select: false` 是关键：默认查询永远不返回密文，只有明确 `select('newapi_subkey_encrypted')` 才会取出。`attachSubkey` middleware 显式 select 这一字段，其它代码路径都拿不到。

IUser 类型同步更新于 `packages/data-schemas/src/types/user.ts`。

## 6. 测试结果

### 6.1 P2a own tests (criterion 4.1)

```
$ cd api && npx jest server/services/__tests__/newapi-provisioning \
                     server/middleware/__tests__/attachSubkey

PASS server/services/__tests__/newapi-provisioning.spec.js (5 tests)
  √ happy path: registerUser provisions New-API account, encrypts sub-key, persists on user
  √ rollback: New-API createUser failure → registerUser 500, no LibreChat user residue
  √ rollback: token-list missing the freshly-created token → 500, no residue
  √ crypto round-trip: encryptSubkey/decryptSubkey is deterministic (100 unique IVs)
  √ tamper detection: flipping a byte in ciphertext → decryptSubkey throws

PASS server/middleware/__tests__/attachSubkey.spec.js (4 tests)
  √ hit: attaches decrypted sub-key to req.upstreamApiKey
  √ miss: no req.user → no-op
  √ legacy user with no encrypted sub-key → no-op
  √ tampered ciphertext → next(err)

Test Suites: 2 passed, 2 total
Tests:       9 passed, 9 total
```

### 6.2 P1+P1.5 regression — unchanged

```
$ cd api && npx jest server/middleware/__tests__/dingYuanyingLock

PASS server/middleware/__tests__/dingYuanyingLock.spec.js          (18)
PASS server/middleware/__tests__/dingYuanyingLock.integration.spec.js (3)
PASS server/middleware/__tests__/dingYuanyingLock.outbound.spec.js  (2)

Test Suites: 3 passed, 3 total
Tests:       23 passed, 23 total
```

### 6.3 关键断言（happy path 实测）

测试代码块：`api/server/services/__tests__/newapi-provisioning.spec.js:228-282`。

| 断言 | 结果 |
|---|---|
| `result.status === 200` | PASS |
| Mock 收到序列：`POST /api/user/` → `POST /api/user/login` → `POST /api/token/` → `GET /api/token/` | PASS（顺序+次数严格相等） |
| `POST /api/user/` 携带 `Authorization: mock-admin-key` 且 body.username 形如 `lc<24位>` | PASS |
| `POST /api/token/` 携带 `New-Api-User: 4242` 和 `Authorization: mock-user-access-token` | PASS |
| `POST /api/token/` body.name 形如 `librechat-<librechat-user-id>` | PASS |
| 内存 user store 中 `newapi_subkey_encrypted` 形如 `gcm:v1:<hex>:<hex>:<hex>` | PASS |
| `decryptSubkey(stored.newapi_subkey_encrypted) === mock.issuedKey` | PASS |
| `stored.newapi_user_id === 4242` | PASS |

### 6.4 Mock New-API server（真实 HTTP，零 jest.mock）

测试 spec 的 `startMockNewApiWithState()` 起一个 `http.createServer` 监听 `127.0.0.1:0`（随机端口），用闭包跟踪 lastTokenName，按 QuantumNous 形状回包。**provisioning 内部走真实 `fetch`**，不 jest.mock 任何 HTTP 层。这与 P1.5 outbound spec 同一思路：mock 在 wire 上，code 是 prod path。

## 7. Lint / Typecheck

```bash
# Typecheck（packages/api + packages/data-schemas）
cd packages/api          && npx tsc --noEmit -p tsconfig.json   # EXIT 0
cd packages/data-schemas && npx tsc --noEmit -p tsconfig.json   # EXIT 0

# Lint of all P2a-touched files
npx eslint \
  api/server/middleware/attachSubkey.js \
  api/server/middleware/__tests__/attachSubkey.spec.js \
  api/server/services/__tests__/newapi-provisioning.spec.js \
  api/server/services/AuthService.js \
  api/server/routes/agents/chat.js \
  packages/api/src/newapi/{client,provisioning,index}.ts \
  packages/api/src/crypto/{subkey,index}.ts \
  packages/api/src/endpoints/custom/initialize.ts \
  packages/api/src/index.ts \
  packages/data-schemas/src/schema/user.ts \
  packages/data-schemas/src/types/user.ts
# EXIT 0
```

P1 时记录的 154 个上游 TS 错误 / 310 个 ESLint 错误**未变化**，P2a 没有触碰那些文件。

## 8. 已知遗留 / 出 P2a 范围

- 不带配额管理：`createToken` 默认 `remain_quota: 500_000, unlimited_quota: false`，没有 P2b 的余额联动。P2b 会接 LibreChat balance hooks。
- 不带 key rotation：当前 schema 有一个 sub-key 字段；rotation 需要支持双 key 滑窗。P3 范围。
- `loginAsUser` 在 New-API 启用 turnstile 时会失败。生产部署需要 New-API 端 `TurnstileCheckEnabled=false` 或者改走 admin-only 路径（QuantumNous 的 `/api/user/manage` 可能是更干净的方案，待 P3 评估）。
- `attachSubkey` 在用户没有 `newapi_subkey_encrypted` 时是 no-op，回退到 env 级 `${YCAPI_KEY}`。这对 dev/CI 友好，但生产部署应该通过迁移把所有旧用户都 provision 一遍，避免回退路径成为长期安全口子。迁移脚本 P2b。
- 支付 / Dockerfile / Scaleway 部署 — 仍是 P3。
