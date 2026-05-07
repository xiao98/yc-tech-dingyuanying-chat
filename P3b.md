# P3b Verification — payments + balance gate

> P3b 是把 P3a 留下的三家支付 stub（`alipay.js` / `wxpay.js` / `stripe.js` 都返 501）替换成**真签名验证 + 真余额扣减 + 真重放防护**的实现版。Master agent 校验时直接读这里。

## TL;DR

| Item | Status |
|---|---|
| Worktree | `C:\Users\肖浩\yc-tech-dingyuanying-chat`（主 worktree） |
| Branch | `p3b/payments`（基线 `ae8ebee2e` = P3a） |
| Webhook handlers | `api/server/routes/payment/{stripe,alipay,wxpay}.js`（实现版，非 stub） |
| 签名/加解密原语 | `api/server/routes/payment/signatures.js`（纯 Node `crypto`，0 SDK 依赖） |
| Credit 原子写 | `packages/api/src/payments/credit.ts`（mongoose session/transaction，幂等返回） |
| Balance 闸门 | `api/server/middleware/balanceGate.js`（402 if balance≤0） |
| Mock 模拟器 | `e2e/mocks/{stripe,alipay,wxpay}-simulator.js` |
| 测试 | criterion 4.2 e2e: **7/7 PASS**；criterion 4.3 e2e: **3/3 PASS**；P1+P1.5+P2a regression: **32/32 PASS**；sidecar regression: **8/8 PASS** |

## 1. 三家协议对照（最重要的一节）

| 维度 | Stripe | Alipay (PC 网站支付) | WeChat Pay v3 |
|---|---|---|---|
| 路径 | `POST /api/payment/stripe/webhook` | `POST /api/payment/alipay/webhook` | `POST /api/payment/wxpay/webhook` |
| 内容类型 | `application/json` | `application/x-www-form-urlencoded` | `application/json` |
| 签名位置 | header `Stripe-Signature` | body 字段 `sign` | headers `Wechatpay-{Timestamp,Nonce,Signature}` |
| 签名算法 | HMAC-SHA256 over `${t}.${rawBody}` | RSA-SHA256 (RSA2) over canonicalized form | RSA-SHA256 over `${ts}\n${nonce}\n${rawBody}\n` |
| 签名 secret 类型 | `STRIPE_WEBHOOK_SECRET`（whsec_）共享密钥 | Alipay 公钥（验证）/ 商户私钥（签发） | WeChat 平台公钥（验证）/ 商户上行需 API 证书 |
| 资源加密 | 无 | 无 | `resource.ciphertext` AEAD-AES-256-GCM (key=APIv3 32 bytes, iv=`resource.nonce`) |
| 时间戳防重放 | header `t` ±300s 窗口 | 无（依赖 trade_no 幂等） | 无（依赖 transaction_id 幂等） |
| 成功响应 | `200 {received:true}` | **纯文本** `success`（任何 JSON 都会被判定为失败重发！） | `200 {"code":"SUCCESS","message":"成功"}` |
| 失败响应 | 4xx 任意 JSON | `failure`（纯文本） | `200` 但 body 含错误 code，或 4xx |
| 重试策略 | 自动指数退避，最多 3 天 | 25 小时内 8 次（间隔 4m / 10m / 10m / 1h / 2h / 6h / 15h） | 24 小时内最多 15 次 |
| 关键 channel_ref | `event.id`（`evt_xxx`） | `params.trade_no`（支付宝订单号） | 解密 `resource` 后的 `transaction_id`（微信支付订单号） |
| Amount 字段 | `data.object.amount_total`（cents） | `params.total_amount`（元，**字符串**，需 ×100 转 cents） | 解密 `resource` 后的 `amount.total`（cents） |
| Currency | `data.object.currency` | 固定 `cny`（隐含） | 解密 `resource` 后的 `amount.currency` |

### channel_ref 选型理由

`payments.channel_ref` 字段是 P3a 在 schema 上加 `unique: true` 的物理重放防护键。每家选什么作为 channel_ref 不能随意，必须满足：**(a) 同一笔真实支付重发必产生相同值；(b) 不同支付必不同**。

| 渠道 | 选 | 弃 | 原因 |
|---|---|---|---|
| Stripe | `event.id` | `data.object.id`（session id） | 一笔订阅续费可能产生 `checkout.session.completed` + `invoice.payment_succeeded` 两个 event，二者应分别记账。session id 会冲突。 |
| Alipay | `trade_no`（支付宝侧） | `out_trade_no`（商户侧） | trade_no 是支付宝**结算成功后**发的唯一号；out_trade_no 是我们传给支付宝的，存在并发场景下被复用导致冲突的极小概率。trade_no 的语义是"支付宝确认这笔钱到账了"，比商户单号强。 |
| WeChat Pay | 解密后的 `transaction_id` | `out_trade_no` | 同 Alipay。注意是**解密后**的字段——加密前从外层 `resource` 摸不到。 |

不在应用层 `find then insert` 检查代替 UNIQUE 约束的理由：在并发回调下两个 worker 都通过 find（都没找到），都进入 insert，第二个才会被 Mongo 拒。让 Mongo 来做唯一裁决（E11000）是单点强一致的设计；handler 把 E11000 翻译成幂等 200。

## 2. Credit 流程

`packages/api/src/payments/credit.ts` 是三家 webhook 共用的"原子记账"原语：

```
creditUserBalance({userId, amount, currency, channel, channelRef, rawPayload, ratio}, {connection})
  ├─ try transaction (replica set / sharded mongo only):
  │    1. Payment.create({status:'paid', channel, channel_ref, amount, ...}) [session]
  │    2. Balance.findOneAndUpdate({user}, {$inc: {tokenCredits: amount*ratio}}, {upsert:true, session})
  │    3. commit
  ├─ if E11000 on step 1 → look up existing payment by channel_ref → return {idempotent:true, alreadyPaid:...}
  └─ fallback (standalone mongo / mongodb-memory-server):
       same two ops without session — single-node mongo guarantees ordering, transaction
       is just defensive in case future deployment uses replica set
```

**Atomic**：用 mongoose `session.withTransaction(...)` 包起来；探测当前连接是否支持事务（`hello.setName` 检测 replica set / mongos），不支持就 fallback 到无 session 模式。生产 MongoDB Atlas / replica set 上跑事务路径，本地 / mongodb-memory-server 跑 fallback。

**Ratio source**：`librechat.yaml.balance.topup.{defaultRatio | channels.{stripe,alipay,wxpay}.{usd,cny,...}}`，由 `api/server/routes/payment/ratio.js` 解析（30s 内存缓存）。如果 YAML 没配 `topup` 块，回退到 `process.env.PAYMENT_RATIO`，再回退到 `1`。**ratio 不固化在代码里**——是部署旋钮。

## 3. Balance 闸门 (criterion 4.3)

`api/server/middleware/balanceGate.js`：

```
if user.balance <= 0:
    return 402 {error: "insufficient balance", balance: <num>}
```

**挂载点**：`api/server/routes/agents/chat.js:38-42`，**在 `attachSubkey` 之前**。意图是：余额不够的请求**根本不应该解密用户的 sub-key**（攻击面最小化原则——既省一次 AES-256-GCM 解密，也避免上游 New-API 看到这个 user 的 token）。

### Endpoint 路径选型

原始 spec 提到 `/api/ask/ycapi-claude`。**LibreChat 这条分支不存在 `/api/ask/...` 路径**——所有 chat 流量走 `/api/agents/chat`（agents/v1.js controller）。我们：

1. 把 `balanceGate` middleware 接到 **`/api/agents/chat`**（即真实生产路径）
2. e2e spec `balance-gate.e2e.spec.js` 直接 POST 到 `/api/agents/chat`

不补一个薄 wrapper `/api/ask/ycapi-claude` 转给 `/api/agents/chat`——会引入第二条路径维护负担、造成监控/auth 配置的事实双轨，且 spec 的真实意图（"chat 请求被余额闸门挡住"）已经在 `/api/agents/chat` 上覆盖到了。**形式 vs 事实**：spec 里的路径是形式，闸门生效是事实，事实满足。

### 失败响应

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{"error":"insufficient balance","balance":0}
```

`error` 字段含字面量 `"insufficient balance"`（小写、空格分隔），匹配 spec 的"body 含 'insufficient balance'"要求。

## 4. 测试结果

### Criterion 4.2 e2e（`api/server/routes/payment/__tests__/payments.e2e.spec.js`）

| Case | 描述 | 结果 |
|---|---|---|
| A | stripe checkout.session.completed 充值 | PASS — Payment(channel='stripe',status='paid')×1 + Balance.tokenCredits=1999 |
| B | alipay TRADE_SUCCESS 充值 | PASS — Payment(channel='alipay',status='paid')×1 + Balance.tokenCredits=1234（元→cents 转换正确） |
| C | wxpay TRANSACTION.SUCCESS 充值 | PASS — Payment(channel='wxpay',status='paid')×1 + Balance.tokenCredits=5000 |
| D-stripe | 同 event.id 重发 | PASS — 200 idempotent，Payment 仍 1 行，Balance 仍 100 |
| D-alipay | 同 trade_no 重发 | PASS — 200 success，Payment 仍 1 行，Balance 仍 750 |
| D-wxpay | 同 transaction_id 重发 | PASS — 200，Payment 仍 1 行，Balance 仍 9999 |
| 反例 | 错误 stripe secret 签名 | PASS — 400，Payment 表无写入 |

### Criterion 4.3 e2e（`api/server/routes/__tests__/balance-gate.e2e.spec.js`）

| Case | 描述 | 结果 |
|---|---|---|
| 1 | balance=0 → POST `/api/agents/chat` | PASS — 402 + body.error 含 "insufficient balance" |
| 1b | 没有 Balance 行（new user）→ POST chat | PASS — 402（视为 0） |
| 2 | stripe 充值 5000 → 同请求重试 | PASS — 200 + ok=true（mock 上游返回成功） |

### Regression

| 套件 | tests | 结果 |
|---|---|---|
| dingYuanyingLock + integration + outbound | 23 | 23/23 PASS |
| attachSubkey + newapi-provisioning | 9 | 9/9 PASS |
| **P1 + P1.5 + P2a 合计** | **32** | **32/32 PASS** |
| services/system-lock-proxy | 8 | 8/8 PASS |
| api/server/index.spec.js（整服务 boot） | 8 | 8/8 PASS（确认全局 raw-body verify 钩子未影响现有路由） |

## 5. 凭据对照

| 变量 | 测试值 | 生产值 | 备注 |
|---|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | `whsec_test_secret_p3b` | Stripe Dashboard → Webhook endpoint signing secret | 32 字节 ASCII shared secret |
| `ALIPAY_PUBLIC_KEY` | 测试时 `crypto.generateKeyPairSync('rsa', {modulusLength: 2048})` 现场生成的公钥 | 支付宝开放平台 → 应用页 → 支付宝公钥（PEM） | 验证 alipay 异步通知签名 |
| `ALIPAY_MERCHANT_PRIVATE_KEY_PEM` | （仅 simulator 用）现场生成的私钥 | 商户自己持有，不上服务器 webhook 路径 | webhook 端不需要 |
| `WXPAY_API_V3_KEY` | `0123456789abcdef0123456789abcdef`（32 bytes） | 微信支付商户后台 → APIv3 密钥 | 用于 `resource.ciphertext` AEAD 解密 |
| `WXPAY_PLATFORM_PUBLIC_KEY` | 测试时现场生成的 RSA 2048 公钥 | 微信支付平台证书的公钥（PEM） | 验证 webhook HTTP 签名 |
| `WXPAY_PLATFORM_PRIVATE_KEY_PEM` | （仅 simulator 用）现场生成的 RSA 2048 私钥 | 微信持有，不上 webhook | webhook 端不需要 |
| `PAYMENT_RATIO` | `1`（cents 1:1 → tokenCredits） | 由 `librechat.yaml.balance.topup` 决定，env 仅作 fallback | 业务定价旋钮 |

**测试 fixture 在 jest setup 现场生成**——不写盘，不入库；进程退出即丢弃。这避免把任何长期凭据 commit 到仓库。

## 6. 物理事实

```bash
git ls-tree -r HEAD --name-only | grep -E "(payment|balance|credit)" | sort
```

应包含：

```
api/server/middleware/balanceGate.js                 # 402 闸门
api/server/routes/__tests__/balance-gate.e2e.spec.js # criterion 4.3 e2e
api/server/routes/payment/__tests__/payments.e2e.spec.js # criterion 4.2 e2e
api/server/routes/payment/alipay.js                  # 实现版
api/server/routes/payment/ratio.js                   # YAML topup 解析
api/server/routes/payment/signatures.js              # 三家共用 crypto
api/server/routes/payment/stripe.js                  # 实现版
api/server/routes/payment/userlookup.js              # webhook→user_id 映射
api/server/routes/payment/wxpay.js                   # 实现版
e2e/mocks/alipay-simulator.js
e2e/mocks/stripe-simulator.js
e2e/mocks/wxpay-simulator.js
e2e/run.sh                                           # 跑 jest 4.2 + 4.3
packages/api/src/payments/credit.ts                  # 原子记账 + 幂等
packages/api/src/payments/index.ts
packages/data-schemas/src/models/payment.ts          # 模型工厂（新加）
packages/data-schemas/src/schema/payment.ts          # P3a 已加
packages/data-schemas/src/types/payment.ts           # P3a 已加
```

## 7. 已知留白（不属于 P3b 范围）

- **Checkout creation endpoint**：用户怎么发起一笔充值（拿 stripe checkout url / alipay 二维码 / wx native code_url）。这是 P3c 的事；P3b 只覆盖 webhook 入账。
- **Stripe customer 持久化**：webhook 里只有 metadata.user_id 这一条路径走通；customer 持久化（关联 stripe customer ⇄ User）留给 P3c。
- **Refund webhook**：`charge.refunded` / 退款流。P3b schema 已有 `status: 'refunded'` 枚举但 handler 不处理（P3c）。
- **Generation-time balance check**：本 P3b 加的 balanceGate 是请求入口的预检 402；真实"按 token 扣费"在 LibreChat 自带的 BaseClient.checkBalance 里（已存在）。两层不冲突，预检快速拒，BaseClient 兜底精算。
- **生产烟测**：criterion 5/6 需要真凭据 + Scaleway 节点，超出 P3b 范围（spec 明确）。
