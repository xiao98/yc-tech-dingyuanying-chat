# yc-tech-dingyuanying-chat

> Fork of [LibreChat](https://github.com/danny-avila/LibreChat) at `1bc2692a1`, hard-locked to a single "丁元英" persona. P1 = persona lock. P2a = per-user New-API admin provisioning + encrypted sub-key. P2b = system-lock sidecar reverse proxy. P3a = deploy infra + payment route scaffolding. **P3b = three-channel webhook handlers (stripe / alipay / wxpay) + balance gate + replay protection.**

## P3b Verification

Branch: `p3b/payments` (built on P3a `ae8ebee2e`). Full evidence in [`P3b.md`](./P3b.md).

| Item | Value |
|---|---|
| Webhook handlers | `api/server/routes/payment/{stripe,alipay,wxpay}.js` — implementations replace P3a stubs |
| Signature primitives | `api/server/routes/payment/signatures.js` — pure Node `crypto` (HMAC-SHA256 / RSA-SHA256 / AEAD-AES-256-GCM), 0 SDK deps |
| Atomic credit helper | `packages/api/src/payments/credit.ts` — mongoose session/transaction with E11000 → idempotent fallback |
| Balance gate (criterion 4.3) | `api/server/middleware/balanceGate.js` mounted at `/api/agents/chat` before `attachSubkey`; returns `402 {"error":"insufficient balance",balance:0}` when `Balance.tokenCredits ≤ 0` |
| Mock simulators | `e2e/mocks/{stripe,alipay,wxpay}-simulator.js` — generate signed payloads with the same primitives the server verifies (no SDK on either side) |
| Criterion 4.2 e2e | **7 / 7 PASS** (3 paid + 3 replay-idempotent + 1 bad-signature reject) — `api/server/routes/payment/__tests__/payments.e2e.spec.js` |
| Criterion 4.3 e2e | **3 / 3 PASS** (zero-balance 402 + missing-row 402 + after-topup 200) — `api/server/routes/__tests__/balance-gate.e2e.spec.js` |
| Regression (P1+P1.5+P2a) | **32 / 32 PASS** unchanged |
| Regression (sidecar) | **8 / 8 PASS** unchanged |
| Endpoint path note | spec referenced `/api/ask/ycapi-claude`, actual LibreChat path is `/api/agents/chat`. Gate mounted on the real path; rationale in [`P3b.md`](./P3b.md#endpoint-路径选型) |

Reproduce:

```bash
# 1. Build packages with the new payment exports.
npm run build:data-schemas && npm run build:api

# 2. Run the criterion 4.2 + 4.3 e2e suites end-to-end.
cd api && npx jest \
  server/routes/payment/__tests__/payments.e2e.spec.js \
  server/routes/__tests__/balance-gate.e2e.spec.js

# 3. Or via the harness script (also validates docker-compose.test.yml):
SKIP_DOCKER=1 bash e2e/run.sh
```

## P3a Verification

Branch: `p3a/deploy-infra` (built on `p2-integrated` `f2c69a6a9`).

### Service topology

```
                 ┌────────────────────────────────────────────────────┐
internet ──443──▶│ nginx           (TLS terminator + LE auto-renew)   │
                 └────────────────────┬───────────────────────────────┘
                                      │ http://librechat-api:3080
                                      ▼
                  ┌──────────────────────────────────────────────┐
                  │ librechat-api    (Express monolith)          │
                  │  ├── /api/...           normal LibreChat     │
                  │  └── /api/payment/{alipay,wxpay,stripe}      │
                  │       └── 501 stub today, P3b webhook handler│
                  └──────┬─────────────────────────┬─────────────┘
                         │                         │
                         │ baseURL=...             │
                         ▼                         ▼
            ┌────────────────────────┐    ┌──────────────────┐
            │ system-lock-proxy:8080 │    │ mongo:27017      │
            │  rewrite messages[0]   │    │ redis:6379       │
            │  to locked SKILL.md    │    └──────────────────┘
            └───────────┬────────────┘
                        │ UPSTREAM_BASE_URL=$YCAPI_BASE_URL
                        ▼
                ┌───────────────────┐
                │ external YCAPI    │
                └───────────────────┘
```

Only `nginx` exposes ports to the host (80, 443). All other services live on the private `ycchat-net` bridge. `mongo` / `redis` / sidecar SKILL.md / TLS certs persist via named volumes / bind mounts.

### Deploying

```bash
# 1. copy .env.sample → .env, fill every <placeholder>
cp .env.sample .env
$EDITOR .env

# 2. ensure $DOMAIN already resolves to this server's public IP

# 3. one command — fail-fasts before any docker call if env is incomplete
bash deploy.sh
```

`deploy.sh` is idempotent. First run boots nginx HTTP-only, runs `certbot certonly --webroot`, restarts nginx with the issued cert, then `docker compose up -d` and polls `https://$DOMAIN/api/health` for up to 60 s. Subsequent runs detect the existing cert and skip the bootstrap step.

### Required env vars (Goal criterion 8)

`deploy.sh` exits 1 with the **first missing var named** if any of these is unset or empty. Provenance / format notes for each are in [`.env.sample`](./.env.sample).

| Group | Vars |
|---|---|
| Upstream YCAPI | `YCAPI_BASE_URL` `YCAPI_ADMIN_KEY` |
| New-API admin (P2a) | `NEWAPI_ADMIN_BASE_URL` `NEWAPI_ADMIN_KEY` |
| WeChat Pay APIv3 | `WXPAY_MCH_ID` `WXPAY_API_V3_KEY` `WXPAY_CERT_PATH` |
| Alipay open-platform | `ALIPAY_APP_ID` `ALIPAY_PRIVATE_KEY_PATH` `ALIPAY_PUBLIC_KEY_PATH` |
| Stripe | `STRIPE_SECRET_KEY` `STRIPE_WEBHOOK_SECRET` |
| Database / auth | `MONGO_URI` `JWT_SECRET` |
| Public DNS | `DOMAIN` |
| Sub-key crypto (P2a) | `SUBKEY_ENCRYPTION_KEY` |
| Sidecar (P2b) | `SKILL_MD_PATH` `UPSTREAM_BASE_URL` |

Negative test (no env at all):
```bash
env -i bash deploy.sh
# → [deploy.sh] FATAL: missing required env var(s): YCAPI_BASE_URL ...
# → [deploy.sh] First missing: YCAPI_BASE_URL
# → exit code 1
```

### What's in P3a vs. deferred to P3b

| Item | P3a status | Deferred to P3b |
|---|---|---|
| `api/server/routes/payment/{alipay,wxpay,stripe}.js` | files exist, mounted at `/api/payment/*`, return **501** | actual webhook signature verification + Payment doc upsert |
| `packages/data-schemas/src/schema/payment.ts` | shipped — `channel_ref` UNIQUE constraint enforces criterion 4.2 replay protection at the DB level | — |
| `Dockerfile` (LibreChat backend) | unchanged, used as-is by `librechat-api` build | — |
| `docker-compose.yml` | 6 services + 2 volumes + 1 network — `docker compose config` exits 0 | — |
| `nginx/nginx.conf.template` + `certbot` integration in `deploy.sh` | HTTP-01 webroot challenge, idempotent bootstrap | LE auto-renew cron / systemd timer |
| `e2e/run.sh` + `e2e/docker-compose.test.yml` | scaffold only — composes mongo/redis + placeholder mocks | real mock New-API + mock YCAPI + jest spec files including `payments-webhook.spec.js` |
| Production smoke test (criterion 5/6) | **NOT RUN** — needs real Scaleway node + 3 sandbox merchant credentials | run after P3b on actual sandbox |

### Tests still passing on this branch

```bash
# 32 / 32 — P1 + P1.5 + P2a (LibreChat backend, jest in-process)
cd api && npx jest \
  server/middleware/__tests__/dingYuanyingLock \
  server/middleware/__tests__/attachSubkey \
  server/services/__tests__/newapi-provisioning

# 8 / 8 — P2b sidecar (real http.createServer mocks)
cd services/system-lock-proxy && npm test

# docker-compose syntax (with all required env exported)
docker compose config -q && echo OK

# deploy.sh fail-fast
env -i bash deploy.sh   # exits 1 with "First missing: YCAPI_BASE_URL"
```

## P2a Verification

Full evidence in [`P2a.md`](./P2a.md). Quick summary:

| Item | Value |
|---|---|
| Branch | `p2a/newapi-provisioning` (built on P1.5 `ad7e0318e`) |
| New-API client | `packages/api/src/newapi/client.ts` — verified against [QuantumNous/new-api](https://github.com/QuantumNous/new-api) `controller/user.go` + `controller/token.go` |
| Provisioning orchestrator | `packages/api/src/newapi/provisioning.ts` — grep `NEWAPI_PROVISIONING_HOOK` |
| Crypto | `packages/api/src/crypto/subkey.ts` — AES-256-GCM, 12-byte random IV per encrypt, 16-byte authTag, key from `SUBKEY_ENCRYPTION_KEY` env (32 bytes hex) |
| Registration hook | `api/server/services/AuthService.js#registerUser` — single-shot rollback via existing `deleteUserById(newUserId)` catch path |
| Mongoose schema fields | `newapi_subkey_encrypted: String (select:false)`, `newapi_user_id: Number` in `packages/data-schemas/src/schema/user.ts` |
| Chat-side consumer | `api/server/middleware/attachSubkey.js` (mounted in `api/server/routes/agents/chat.js` after `dingYuanyingLock`) → sets `req.upstreamApiKey`; `packages/api/src/endpoints/custom/initialize.ts` reads it, overrides env-resolved `${YCAPI_KEY}` for the outbound HTTP call |
| Criterion 4.1 happy-path test | `api/server/services/__tests__/newapi-provisioning.spec.js` → **PASS**: real http.createServer mock, 4 captured admin calls in correct order, encrypted blob in DB, `decryptSubkey(blob) === mock.issuedKey` |
| Criterion 4.1 rollback tests | 2 cases (createUser 500, listTokens empty) → **PASS**: registerUser returns 500, in-memory user store size = 0 |
| Crypto round-trip + tamper detection | 100 round-trips with unique IVs, plus single-bit tamper → throws, **PASS** |
| P2a own tests | **9 / 9 PASS** (5 provisioning + 4 attachSubkey middleware) |
| P1+P1.5 regression | **23 / 23 PASS** (unchanged) |
| Combined dingYuanyingLock + attachSubkey + provisioning | **32 / 32 PASS** |

Reproduce:

```bash
# Build the workspace packages so dist/ has the new exports.
cd packages/data-schemas && npm run build
cd ../api && npm run build
cd ../..

# 32/32 pass — no Redis/Mongo needed.
cd api && npx jest \
  server/middleware/__tests__/dingYuanyingLock \
  server/middleware/__tests__/attachSubkey \
  server/services/__tests__/newapi-provisioning
```

## P1 Verification

Full evidence in [`P1.md`](./P1.md). Quick summary:

| Item | Value |
|---|---|
| Branch | `p1/ding-yuanying-lock` |
| Bundled SKILL.md | `api/server/locks/ding-yuanying.skill.md` (LF, content-hashed) |
| `librechat.yaml` ↔ SKILL.md SHA256 | both = `1a185d6fe3c330a4c4b2236c3ef7ade4a76936238f018d7f9fe9058f961818a6`, `MATCH = true` |
| System-override middleware | `api/server/middleware/dingYuanyingLock.js` — grep `YCAPI_SYSTEM_LOCK_HOOK` |
| Wired into | `api/server/routes/agents/chat.js` (first `router.use(...)` after the imports) |
| Token cap | 50000 (`MAX_CONTEXT_TOKENS`); over-cap returns HTTP 400 `{error:"context too long",tokens,limit}` |
| P1 own tests | **23 / 23 PASS** (18 unit + 3 supertest integration + 2 outbound HTTP black-box, P1.5) |
| P1 own statement coverage | **94.64%** (P1 baseline; P1.5 outbound spec exercises the same module so coverage holds) |
| Criterion 4.4 outbound HTTP black-box (P1.5) | mock-captured upstream `messages[0].role==="system"`, `SHA256(messages[0].content.trim()) === 1a185d6f…61818a6`, client jailbreak string absent — all 3 PASS |
| `npm install` | EXIT 0 |
| `npm run lint` (upstream script) | EXIT 2 — upstream Win-shell glob issue (no files actually linted); see [`P1.md`](./P1.md) |
| `npx eslint .` (real full-repo) | EXIT 1 — 310 errors / 95 warnings, all upstream baseline |
| P1 files lint (`npx eslint api/server/middleware/dingYuanyingLock.js …`) | EXIT 0 |
| `npm run typecheck` (added by P1) | EXIT 2 — 154 `error TS` in upstream `.ts/.tsx`; P1 code is `.js` (not typechecked) |
| `npm test` (root, 4 workspaces) | EXIT 1 — 3/4 workspaces fail due to missing Redis + mongodb-memory-server flakiness on Win; not P1-introduced |

Reproduce:

```bash
# 23/23 pass (no infra needed): unit + integration + outbound HTTP black-box (P1.5)
cd api && npx jest server/middleware/__tests__/dingYuanyingLock

# SHA match against ~/.claude/skills/ding-yuanying/SKILL.md
node -e "const y=require('js-yaml');const fs=require('fs');const c=require('crypto');const cfg=y.load(fs.readFileSync('librechat.yaml','utf8'));const skill=fs.readFileSync(require('os').homedir()+'/.claude/skills/ding-yuanying/SKILL.md','utf8').replace(/\r\n/g,'\n').trim();const pp=cfg.modelSpecs.list[0].preset.promptPrefix.trim();console.log('MATCH',c.createHash('sha256').update(skill).digest('hex')===c.createHash('sha256').update(pp).digest('hex'));"
```

Out of P1 scope (deferred): YCAPI gateway-side middleware, payments, Dockerfile/compose/deploy.sh, Scaleway production deploy. See `P1.md`.

---

<p align="center">
  <a href="https://librechat.ai">
    <img src="client/public/assets/logo.svg" height="256">
  </a>
  <h1 align="center">
    <a href="https://librechat.ai">LibreChat</a>
  </h1>
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <a href="https://discord.librechat.ai"> 
    <img
      src="https://img.shields.io/discord/1086345563026489514?label=&logo=discord&style=for-the-badge&logoWidth=20&logoColor=white&labelColor=000000&color=blueviolet">
  </a>
  <a href="https://www.youtube.com/@LibreChat"> 
    <img
      src="https://img.shields.io/badge/YOUTUBE-red.svg?style=for-the-badge&logo=youtube&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
  <a href="https://docs.librechat.ai"> 
    <img
      src="https://img.shields.io/badge/DOCS-blue.svg?style=for-the-badge&logo=read-the-docs&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
  <a aria-label="Sponsors" href="https://github.com/sponsors/danny-avila">
    <img
      src="https://img.shields.io/badge/SPONSORS-brightgreen.svg?style=for-the-badge&logo=github-sponsors&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
</p>

<p align="center">
<a href="https://railway.com/deploy/librechat-official?referralCode=HI9hWz&utm_medium=integration&utm_source=readme&utm_campaign=librechat">
  <img src="https://railway.com/button.svg" alt="Deploy on Railway" height="30">
</a>
<a href="https://zeabur.com/templates/0X2ZY8">
  <img src="https://zeabur.com/button.svg" alt="Deploy on Zeabur" height="30"/>
</a>
<a href="https://template.cloud.sealos.io/deploy?templateName=librechat">
  <img src="https://raw.githubusercontent.com/labring-actions/templates/main/Deploy-on-Sealos.svg" alt="Deploy on Sealos" height="30">
</a>
</p>

<p align="center">
  <a href="https://www.librechat.ai/docs/translation">
    <img 
      src="https://img.shields.io/badge/dynamic/json.svg?style=for-the-badge&color=2096F3&label=locize&query=%24.translatedPercentage&url=https://api.locize.app/badgedata/4cb2598b-ed4d-469c-9b04-2ed531a8cb45&suffix=%+translated" 
      alt="Translation Progress">
  </a>
</p>


# ✨ Features

- 🖥️ **UI & Experience** inspired by ChatGPT with enhanced design and features

- 🤖 **AI Model Selection**:  
  - Anthropic (Claude), AWS Bedrock, OpenAI, Azure OpenAI, Google, Vertex AI, OpenAI Responses API (incl. Azure)
  - [Custom Endpoints](https://www.librechat.ai/docs/quick_start/custom_endpoints): Use any OpenAI-compatible API with LibreChat, no proxy required
  - Compatible with [Local & Remote AI Providers](https://www.librechat.ai/docs/configuration/librechat_yaml/ai_endpoints):
    - Ollama, groq, Cohere, Mistral AI, Apple MLX, koboldcpp, together.ai,
    - OpenRouter, Helicone, Perplexity, ShuttleAI, Deepseek, Qwen, and more

- 🔧 **[Code Interpreter API](https://www.librechat.ai/docs/features/code_interpreter)**: 
  - Secure, Sandboxed Execution in Python, Node.js (JS/TS), Go, C/C++, Java, PHP, Rust, and Fortran
  - Seamless File Handling: Upload, process, and download files directly
  - No Privacy Concerns: Fully isolated and secure execution

- 🔦 **Agents & Tools Integration**:  
  - **[LibreChat Agents](https://www.librechat.ai/docs/features/agents)**:
    - No-Code Custom Assistants: Build specialized, AI-driven helpers
    - Agent Marketplace: Discover and deploy community-built agents
    - Collaborative Sharing: Share agents with specific users and groups
    - Flexible & Extensible: Use MCP Servers, tools, file search, code execution, and more
    - Compatible with Custom Endpoints, OpenAI, Azure, Anthropic, AWS Bedrock, Google, Vertex AI, Responses API, and more
    - [Model Context Protocol (MCP) Support](https://modelcontextprotocol.io/clients#librechat) for Tools

- 🔍 **Web Search**:  
  - Search the internet and retrieve relevant information to enhance your AI context
  - Combines search providers, content scrapers, and result rerankers for optimal results
  - **Customizable Jina Reranking**: Configure custom Jina API URLs for reranking services
  - **[Learn More →](https://www.librechat.ai/docs/features/web_search)**

- 🪄 **Generative UI with Code Artifacts**:  
  - [Code Artifacts](https://youtu.be/GfTj7O4gmd0?si=WJbdnemZpJzBrJo3) allow creation of React, HTML, and Mermaid diagrams directly in chat

- 🎨 **Image Generation & Editing**
  - Text-to-image and image-to-image with [GPT-Image-1](https://www.librechat.ai/docs/features/image_gen#1--openai-image-tools-recommended)
  - Text-to-image with [DALL-E (3/2)](https://www.librechat.ai/docs/features/image_gen#2--dalle-legacy), [Stable Diffusion](https://www.librechat.ai/docs/features/image_gen#3--stable-diffusion-local), [Flux](https://www.librechat.ai/docs/features/image_gen#4--flux), or any [MCP server](https://www.librechat.ai/docs/features/image_gen#5--model-context-protocol-mcp)
  - Produce stunning visuals from prompts or refine existing images with a single instruction

- 💾 **Presets & Context Management**:  
  - Create, Save, & Share Custom Presets  
  - Switch between AI Endpoints and Presets mid-chat
  - Edit, Resubmit, and Continue Messages with Conversation branching  
  - Create and share prompts with specific users and groups
  - [Fork Messages & Conversations](https://www.librechat.ai/docs/features/fork) for Advanced Context control

- 💬 **Multimodal & File Interactions**:  
  - Upload and analyze images with Claude 3, GPT-4.5, GPT-4o, o1, Llama-Vision, and Gemini 📸  
  - Chat with Files using Custom Endpoints, OpenAI, Azure, Anthropic, AWS Bedrock, & Google 🗃️

- 🌎 **Multilingual UI**:
  - English, 中文 (简体), 中文 (繁體), العربية, Deutsch, Español, Français, Italiano
  - Polski, Português (PT), Português (BR), Русский, 日本語, Svenska, 한국어, Tiếng Việt
  - Türkçe, Nederlands, עברית, Català, Čeština, Dansk, Eesti, فارسی
  - Suomi, Magyar, Հայերեն, Bahasa Indonesia, ქართული, Latviešu, ไทย, ئۇيغۇرچە

- 🧠 **Reasoning UI**:  
  - Dynamic Reasoning UI for Chain-of-Thought/Reasoning AI models like DeepSeek-R1

- 🎨 **Customizable Interface**:  
  - Customizable Dropdown & Interface that adapts to both power users and newcomers

- 🌊 **[Resumable Streams](https://www.librechat.ai/docs/features/resumable_streams)**:  
  - Never lose a response: AI responses automatically reconnect and resume if your connection drops
  - Multi-Tab & Multi-Device Sync: Open the same chat in multiple tabs or pick up on another device
  - Production-Ready: Works from single-server setups to horizontally scaled deployments with Redis

- 🗣️ **Speech & Audio**:  
  - Chat hands-free with Speech-to-Text and Text-to-Speech  
  - Automatically send and play Audio  
  - Supports OpenAI, Azure OpenAI, and Elevenlabs

- 📥 **Import & Export Conversations**:  
  - Import Conversations from LibreChat, ChatGPT, Chatbot UI  
  - Export conversations as screenshots, markdown, text, json

- 🔍 **Search & Discovery**:  
  - Search all messages/conversations

- 👥 **Multi-User & Secure Access**:
  - Multi-User, Secure Authentication with OAuth2, LDAP, & Email Login Support
  - Built-in Moderation, and Token spend tools

- ⚙️ **Configuration & Deployment**:  
  - Configure Proxy, Reverse Proxy, Docker, & many Deployment options  
  - Use completely local or deploy on the cloud

- 📖 **Open-Source & Community**:  
  - Completely Open-Source & Built in Public  
  - Community-driven development, support, and feedback

[For a thorough review of our features, see our docs here](https://docs.librechat.ai/) 📚

## 🪶 All-In-One AI Conversations with LibreChat

LibreChat is a self-hosted AI chat platform that unifies all major AI providers in a single, privacy-focused interface.

Beyond chat, LibreChat provides AI Agents, Model Context Protocol (MCP) support, Artifacts, Code Interpreter, custom actions, conversation search, and enterprise-ready multi-user authentication.

Open source, actively developed, and built for anyone who values control over their AI infrastructure.

---

## 🌐 Resources

**GitHub Repo:**
  - **RAG API:** [github.com/danny-avila/rag_api](https://github.com/danny-avila/rag_api)
  - **Website:** [github.com/LibreChat-AI/librechat.ai](https://github.com/LibreChat-AI/librechat.ai)

**Other:**
  - **Website:** [librechat.ai](https://librechat.ai)
  - **Documentation:** [librechat.ai/docs](https://librechat.ai/docs)
  - **Blog:** [librechat.ai/blog](https://librechat.ai/blog)

---

## 📝 Changelog

Keep up with the latest updates by visiting the releases page and notes:
- [Releases](https://github.com/danny-avila/LibreChat/releases)
- [Changelog](https://www.librechat.ai/changelog) 

**⚠️ Please consult the [changelog](https://www.librechat.ai/changelog) for breaking changes before updating.**

---

## ⭐ Star History

<p align="center">
  <a href="https://star-history.com/#danny-avila/LibreChat&Date">
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=danny-avila/LibreChat&type=Date&theme=dark" onerror="this.src='https://api.star-history.com/svg?repos=danny-avila/LibreChat&type=Date'" />
  </a>
</p>
<p align="center">
  <a href="https://trendshift.io/repositories/4685" target="_blank" style="padding: 10px;">
    <img src="https://trendshift.io/api/badge/repositories/4685" alt="danny-avila%2FLibreChat | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/>
  </a>
  <a href="https://runacap.com/ross-index/q1-24/" target="_blank" rel="noopener" style="margin-left: 20px;">
    <img style="width: 260px; height: 56px" src="https://runacap.com/wp-content/uploads/2024/04/ROSS_badge_white_Q1_2024.svg" alt="ROSS Index - Fastest Growing Open-Source Startups in Q1 2024 | Runa Capital" width="260" height="56"/>
  </a>
</p>

---

## ✨ Contributions

Contributions, suggestions, bug reports and fixes are welcome!

For new features, components, or extensions, please open an issue and discuss before sending a PR.

If you'd like to help translate LibreChat into your language, we'd love your contribution! Improving our translations not only makes LibreChat more accessible to users around the world but also enhances the overall user experience. Please check out our [Translation Guide](https://www.librechat.ai/docs/translation).

---

## 💖 This project exists in its current state thanks to all the people who contribute

<a href="https://github.com/danny-avila/LibreChat/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=danny-avila/LibreChat" />
</a>

---

## 🎉 Special Thanks

We thank [Locize](https://locize.com) for their translation management tools that support multiple languages in LibreChat.

<p align="center">
  <a href="https://locize.com" target="_blank" rel="noopener noreferrer">
    <img src="https://github.com/user-attachments/assets/d6b70894-6064-475e-bb65-92a9e23e0077" alt="Locize Logo" height="50">
  </a>
</p>
