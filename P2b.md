# P2b Verification — system-lock-proxy sidecar

> P2b 是"YCAPI 网关层 middleware 在每次上游请求前强制覆盖 messages[0].system"的 sidecar 实现版。Master agent 校验时直接读这里，与 [P1.md](./P1.md) 对照。

## TL;DR

| Item | Status |
|---|---|
| Worktree | `C:\Users\肖浩\yc-tech-dingyuanying-chat-p2b`（与主 worktree 物理隔离的 git worktree） |
| Branch | `p2b/system-lock-proxy` （基线 `ad7e0318e` = P1.5） |
| 服务位置 | `services/system-lock-proxy/` |
| 实现 | `services/system-lock-proxy/src/index.js`（grep keyword: `SYSTEM_LOCK_PROXY_HOOK`） |
| 流式响应 | `res.pipe()`，不缓冲 |
| 依赖 | 0 runtime（纯 Node 标准库），1 dev (`jest`) |
| 测试 | **8 / 8 PASS** |
| Dockerfile | `services/system-lock-proxy/Dockerfile`（node:22-alpine） |

## 1. 设计契约

### 服务边界

独立 Node.js HTTP 反向代理，部署在 LibreChat 与 YCAPI 之间。**所有 OpenAI-compatible chat 请求**强制覆盖 `messages[0]`，无论客户端传什么。

`services/system-lock-proxy/` 是独立 npm 项目，**不**接入 LibreChat 的 Turborepo workspace —— 避免依赖纠缠，sidecar 可以独立 build / deploy。

### 配置（环境变量）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `UPSTREAM_BASE_URL` | yes | — | 实际 YCAPI 地址 |
| `SKILL_MD_PATH` | no | `/etc/system-lock-proxy/skill.md` | 运行时读 SKILL.md |
| `LISTEN_PORT` | no | `8080` | 监听端口 |

启动时 sync 读 SKILL.md → trim → 缓存到内存。**fail-fast**：文件缺失 / 空 → `process.exit(1)` + 明确 `console.error`。

### 转发逻辑

**`POST /v1/chat/completions`**（rewrite 路径）：

1. Read request body → `JSON.parse`
2. Filter掉 messages 中所有 `role === 'system'` 项
3. `unshift({role:'system', content: <cached SKILL.md trim>})`
4. 序列化新 body，转发到 `UPSTREAM_BASE_URL/v1/chat/completions`
5. 透传 Authorization 等 header（除 hop-by-hop）
6. 响应通过 `upstreamRes.pipe(res)` 流回 client，**保留 SSE chunked transfer 实时性**

**其他路径**（含 `/v1/embeddings`、`/v1/models`，含非 POST）：byte-passthrough，`req.pipe(upstreamReq)`，**不**解析 body。

### 错误处理

| 场景 | HTTP status | 响应 |
|---|---|---|
| 客户端 body 不是合法 JSON（仅 chat 路径） | 400 | `{"error":"invalid json body"}` |
| 上游 connect 失败 | 502 | `{"error":"upstream connection failed"}` |
| 上游超时 | 504 | `{"error":"upstream timeout"}` |
| body 超过 10 MB | 413 | `{"error":"payload too large"}` |
| SKILL.md 启动时缺失 / 空 | exit 1 | console.error 明确原因 |

### 流式响应（关键）

LibreChat 多数情况下用 streaming SSE。实现选择：

- **不**用 `await response.text()` → buffer 整个响应
- **用** `http.request` + `upstreamRes.pipe(res)`，每个 SSE chunk 写到 upstream socket 后立刻被 Node pipe 回客户端

骨架（`src/index.js:175-185`）：

```js
const upstreamReq = transport.request(options, (upstreamRes) => {
  res.statusCode = upstreamRes.statusCode || 502;
  // ... copy headers ...
  upstreamRes.pipe(res);
});
upstreamReq.on('error', (err) => { /* 502 / 504 */ });
upstreamReq.write(rewrittenBody);
upstreamReq.end();
```

## 2. 文件清单

| File | Purpose |
|---|---|
| `services/system-lock-proxy/package.json` | 项目元数据（zero runtime deps） |
| `services/system-lock-proxy/src/index.js` | proxy 实现（grep: `SYSTEM_LOCK_PROXY_HOOK`） |
| `services/system-lock-proxy/test/proxy.spec.js` | 8 个黑盒测试用例 |
| `services/system-lock-proxy/test/fixtures/skill.md` | SKILL.md 副本（SHA256 = `1a185d6f...`） |
| `services/system-lock-proxy/Dockerfile` | node:22-alpine 镜像（不烧 SKILL.md） |
| `services/system-lock-proxy/.dockerignore` | 排除 node_modules / test 等 |
| `services/system-lock-proxy/.gitignore` | 排除 node_modules 等 |
| `services/system-lock-proxy/README.md` | 运行 / 集成说明 |
| `P2b.md` | 本文件 |

## 3. 测试结果（8 / 8 PASS）

跑法：

```bash
cd services/system-lock-proxy
npm install   # 装 jest（dev only）
npm test
```

实测输出：

```
> system-lock-proxy@1.0.0 test
> jest --runInBand

Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
Snapshots:   0 total
Time:        0.779 s
```

每个 case 的目的：

| # | Case | 断言要点 |
|---|---|---|
| 1 | 单 system override | 客户端发 `[{role:'system',content:'evil'},{role:'user',content:'hi'}]` → mock 收到的 raw body 不含 `'evil'`；`messages[0].role==='system'`；SHA256(messages[0].content.trim()) === fixture trim SHA256 |
| 2 | 多 system 全部剔除 | 客户端塞 3 条 system + 用户/assistant 混合 → upstream 收到只剩 1 条锁定 system + 非 system 顺序保留 |
| 3 | 无 system → 插入 | 客户端只发 `[{role:'user',...}]` → upstream 收到 `[{role:'system', SKILL.md}, {role:'user',...}]` |
| 4 | `/v1/embeddings` 透传 | 含 `evil-payload-marker` 的原始 body 字节级到达 upstream（rec.rawBody === original），不含 `'丁元英'` 注入 |
| 5 | SSE streaming | upstream 用 80/160/240ms 时间间隔写出 3+1 个 SSE event；client 端断言 chunks ≥ 2 且首末 chunk 时间差 > 100ms（说明非 buffered） |
| 6 | 非法 JSON | 客户端发 `'{not valid json'` → 400 + `{"error":"invalid json body"}`；upstream 完全没被打到（records.length === 0） |
| 7 | 上游不可达 | 抓一个保证空闲的端口当 upstream → 502 + `{"error":"upstream connection failed"}` |
| 8 | fixture 真实性 | `SHA256(test/fixtures/skill.md trim) === '1a185d6fe3c330a4c4b2236c3ef7ade4a76936238f018d7f9fe9058f961818a6'` 且长度 > 500（防止 placeholder） |

case 8 的 SHA256 与 [P1.md §2 配置锁定](./P1.md) 中 `SKILL_SHA` 一致，证明 sidecar 用的是同一份人格定义文件。

### 复现关键检查

```bash
cd services/system-lock-proxy
node -e "const c=require('crypto'),f=require('fs');const t=f.readFileSync('test/fixtures/skill.md','utf8').trim();console.log('SHA256:', c.createHash('sha256').update(t).digest('hex'))"
# → SHA256: 1a185d6fe3c330a4c4b2236c3ef7ade4a76936238f018d7f9fe9058f961818a6
```

## 4. 与 P1.5 LibreChat-side lock 的关系（深度防御）

| 层 | 位置 | 强制点 | 来自 |
|---|---|---|---|
| 第一道 | LibreChat 内部 middleware `dingYuanyingLock` | 入站 `req.body.messages` + `promptPrefix` | P1 / P1.5 |
| 第二道 | 本 sidecar HTTP 反向代理 | OpenAI 协议出站 HTTP body `messages[0]` | P2b |

**任一独立工作**：

- 如果 LibreChat 那道被绕过（例如有人魔改 librechat 代码、或走私 raw OpenAI 调用），sidecar 仍守住 `messages[0]`。
- 如果 sidecar 配置错误（例如 `librechat.yaml` 没把 `baseURL` 切到 sidecar），LibreChat 内部 lock 仍然把 messages 改写正确，sidecar 只是没机会复检。

P1.5 已经验证 `ChatOpenAI` 在 OpenAI-compatible 模式下把 `SystemMessage` 序列化成 `messages[0]={role:"system", content:<instructions>}`（[P1.md §4.4](./P1.md)）—— 也就是说 sidecar 看到的 wire 格式与 P1.5 outbound spec 捕获到的格式**完全一致**，sidecar 的覆盖逻辑直接命中同一字段。

## 5. 与 LibreChat 集成（部署到 P3 时落地）

`librechat.yaml` 中 ding-yuanying endpoint 的 `baseURL` 改指 sidecar：

```yaml
endpoints:
  custom:
    - name: 'ding-yuanying'
      baseURL: 'http://system-lock-proxy:8080/v1'
      apiKey: '${YCAPI_KEY}'
      ...
```

sidecar 容器：

```yaml
# docker-compose 片段（P3 时合入）
services:
  system-lock-proxy:
    build: ./services/system-lock-proxy
    environment:
      UPSTREAM_BASE_URL: https://ycapi.example.com
      SKILL_MD_PATH: /etc/system-lock-proxy/skill.md
      LISTEN_PORT: 8080
    volumes:
      - ./api/server/locks/ding-yuanying.skill.md:/etc/system-lock-proxy/skill.md:ro
```

注意：**SKILL.md 不烧进镜像** —— 只读挂载，更新人格只需改文件 + restart 容器，不动镜像。

## 6. 出 P2b 范围（延迟到 P3）

- docker-compose 把 sidecar 与 LibreChat / Mongo / Redis 串起来
- librechat.yaml 把 ding-yuanying baseURL 切到 sidecar
- Scaleway 生产部署 + 端到端冒烟
- 监控（如 sidecar 收到 / 重写 / 透传 / 错误的计数）
