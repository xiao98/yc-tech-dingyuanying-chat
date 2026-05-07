# system-lock-proxy

YC TECH 丁元英 Chat 的 sidecar 反向代理（P2b）。

每次 OpenAI-compatible chat-completion 请求转发到 YCAPI 之前，**强制覆盖** `messages[0]` 为 `{role: 'system', content: <SKILL.md trim>}`，并删除请求里其他所有 `role === 'system'` 项。客户端传什么 system prompt 都不能覆盖人格锁。

非 chat 路径（`/v1/embeddings`、`/v1/models` 等）byte-passthrough，不解析、不缓冲。

## 设计要点

- **零依赖**：只用 Node.js 标准库。dev 依赖只有 jest。
- **流式响应**：用 `res.pipe()` 而不是 `await response.text()`，SSE chunks 实时透传。
- **fail-fast**：启动时同步读 SKILL.md，失败 / 空内容 → `process.exit(1)`，明确日志。
- **运行时挂载**：SKILL.md 不烧进镜像，从 `SKILL_MD_PATH` 读，更新 SKILL.md 只需重启容器。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `UPSTREAM_BASE_URL` | yes | — | 实际 YCAPI 地址，如 `https://ycapi.example.com` |
| `SKILL_MD_PATH` | no | `/etc/system-lock-proxy/skill.md` | SKILL.md 文件路径 |
| `LISTEN_PORT` | no | `8080` | 监听端口 |

## 运行

```bash
# 本地
UPSTREAM_BASE_URL=https://ycapi.example.com \
SKILL_MD_PATH=./test/fixtures/skill.md \
LISTEN_PORT=8080 \
node src/index.js

# Docker
docker build -t system-lock-proxy .
docker run --rm -p 8080:8080 \
  -e UPSTREAM_BASE_URL=https://ycapi.example.com \
  -v /path/to/skill.md:/etc/system-lock-proxy/skill.md:ro \
  system-lock-proxy
```

## 测试

```bash
npm install
npm test
```

8 个黑盒用例，覆盖：

1. 单 system 被覆盖（断言 SHA256）
2. 多 system 全部剔除 + 一条锁定 system
3. 完全无 system → 在 messages[0] 插入锁定 system
4. `/v1/embeddings` 字节级透传
5. SSE streaming 实时 chunks（断言 chunk 时间分布）
6. 非法 JSON body → 400
7. 上游不可达 → 502
8. fixture SHA256 = 真实 SKILL.md（防止 placeholder）

## 与 LibreChat 集成

把 `librechat.yaml` 里 ding-yuanying endpoint 的 `baseURL` 指向本 sidecar：

```yaml
endpoints:
  custom:
    - name: 'ding-yuanying'
      baseURL: 'http://system-lock-proxy:8080/v1'   # 不再直连 YCAPI
      apiKey: '${YCAPI_KEY}'
      models: ...
```

sidecar 内部转发到 `UPSTREAM_BASE_URL`（真实 YCAPI）。

## 与 P1.5 LibreChat-side lock 的关系

**深度防御**：
- 第一道：LibreChat 内部 `addControllerEndpointHook` 在 input 侧改 messages[]（P1.5）
- 第二道：本 sidecar 在 outbound HTTP 边界再覆盖一次（P2b）

任一独立工作。即使 P1.5 被绕过（比如有人改 librechat 代码、走私 API 调用），sidecar 仍守住 OpenAI 协议出口。

## 文件

- `src/index.js` — 实现（grep keyword: `SYSTEM_LOCK_PROXY_HOOK`）
- `test/proxy.spec.js` — 黑盒测试
- `test/fixtures/skill.md` — 测试用 SKILL.md（真实 ding-yuanying skill 副本，SHA256 = `1a185d6f...`）
- `Dockerfile` — node:22-alpine 镜像
