#!/usr/bin/env bash
# apply-patches.sh — restore all hot patches after a docker compose
# force-recreate of librechat-api. Idempotent: safe to run twice.
#
# Patches (numbered same as previous chat history):
#   1. reducer.cjs filter(Boolean) ×2  (defensive against null AIMessage)
#   2. dingYuanyingLock.js messages bypass  (LibreChat doc-shape ≠ OpenAI)
#   3. chat.js attachSubkey disable  (sub-key broken: New-API masks key)
#   4. dist/index.js loginAsUser two-step  (cookie + /api/user/token)
#   5. dist/index.js username + display_name → yc-<email-prefix>
#   6. OCR text menu item delete from client bundle
#
# Sidecar patches (cache_control + protocol translation) are in source +
# baked into image — no hot patch needed.

set -euo pipefail

echo '==1. reducer filter(Boolean)=='
docker cp ycchat-api:/app/node_modules/@librechat/agents/dist/cjs/messages/reducer.cjs /tmp/r.cjs
python3 - <<'PY'
src = open('/tmp/r.cjs').read()
src = src.replace('const leftMessages = leftArray.map(messages.coerceMessageLikeToMessage);',
                  'const leftMessages = leftArray.filter(Boolean).map(messages.coerceMessageLikeToMessage);')
src = src.replace('const rightMessages = rightArray.map(messages.coerceMessageLikeToMessage);',
                  'const rightMessages = rightArray.filter(Boolean).map(messages.coerceMessageLikeToMessage);')
open('/tmp/r.cjs','w').write(src)
PY
docker cp /tmp/r.cjs ycchat-api:/app/node_modules/@librechat/agents/dist/cjs/messages/reducer.cjs

echo '==2. dingYuanyingLock messages bypass + spec gate=='
docker exec ycchat-api sh -c '
if ! grep -q "false && Array.isArray(req.body.messages)" /app/api/server/middleware/dingYuanyingLock.js; then
  sed -i "s|^    if (Array.isArray(req.body.messages)) {|    if (false \&\& Array.isArray(req.body.messages)) {|" /app/api/server/middleware/dingYuanyingLock.js
fi
'
# Gate promptPrefix injection on spec === "ding-yuanying" so non-丁元英 specs (Opus etc) dont inherit SKILL.md
docker cp ycchat-api:/app/api/server/middleware/dingYuanyingLock.js /tmp/dyl.js
python3 - <<'PY'
src = open('/tmp/dyl.js').read()
old = '    req.body.promptPrefix = SKILL_TEXT;'
new = '    if ((req.body.spec || "") === "ding-yuanying") { req.body.promptPrefix = SKILL_TEXT; }'
if old in src:
    src = src.replace(old, new, 1)
    open('/tmp/dyl.js','w').write(src)
    print('  spec gate applied')
else:
    print('  spec gate already applied or pattern missing')
PY
docker cp /tmp/dyl.js ycchat-api:/app/api/server/middleware/dingYuanyingLock.js

echo '==3. attachSubkey disable=='
docker exec ycchat-api sh -c '
if ! grep -q "// TEMP: router.use(attachSubkey)" /app/api/server/routes/agents/chat.js; then
  sed -i "s|^router.use(attachSubkey);|// TEMP: router.use(attachSubkey);|" /app/api/server/routes/agents/chat.js
fi
'

echo '==4+5. dist/index.js loginAsUser + yc-username + yc-display_name=='
docker cp ycchat-api:/app/packages/api/dist/index.js /tmp/api.js
python3 - <<'PY'
import re
src = open('/tmp/api.js').read()

# 4. loginAsUser two-step (cookie + /api/user/token)
new_login = '''    loginAsUser(input) {
        return __awaiter(this, void 0, void 0, function* () {
            const r1 = yield this.fetchImpl(`${this.baseURL}/api/user/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: input.username, password: input.password }),
            });
            const setCookie = r1.headers.get("set-cookie") || "";
            const sessionMatch = setCookie.match(/session=[^;]+/);
            const j1 = yield r1.json();
            if (!j1 || !j1.success || !j1.data || typeof j1.data.id !== "number" || !sessionMatch) {
                throw new Error("New-API loginAsUser failed: " + JSON.stringify(j1).slice(0, 200));
            }
            const userId = j1.data.id;
            const r2 = yield this.fetchImpl(`${this.baseURL}/api/user/token`, {
                headers: { "Cookie": sessionMatch[0], "New-Api-User": String(userId) },
            });
            const j2 = yield r2.json();
            if (!j2 || !j2.success || typeof j2.data !== "string") {
                throw new Error("New-API token gen failed: " + JSON.stringify(j2).slice(0, 200));
            }
            return { accessToken: j2.data, userId };
        });
    }'''
pattern = r'    loginAsUser\(input\) \{\n        return __awaiter\(this, void 0, void 0, function\* \(\) \{\n            const envelope = yield this\.request\(.POST., ./api/user/login.,.*?\n        \}\);\n    \}'
src, n = re.subn(pattern, new_login, src, count=1, flags=re.DOTALL)
print('  loginAsUser:', n)

# 5. yc-username
old_un = '        const username = buildNewApiUsername(input.librechatUserId);'
new_un = '        const username = ("yc" + (input.email||"").split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "")).slice(0, 12);'
if old_un in src:
    src = src.replace(old_un, new_un, 1)
    print('  username: 1')

# 5. yc-display_name
old_dn = '            display_name: input.email,'
new_dn = '            display_name: "yc-" + input.email.split("@")[0].slice(0, 17),'
if old_dn in src:
    src = src.replace(old_dn, new_dn, 1)
    print('  display_name: 1')

open('/tmp/api.js','w').write(src)
PY
docker cp /tmp/api.js ycchat-api:/app/packages/api/dist/index.js

echo '==6. delete OCR text menu item from client bundle=='
BUNDLE=$(docker exec ycchat-api sh -c 'ls /app/client/dist/assets/index.*.js | head -1')
docker cp ycchat-api:$BUNDLE /tmp/bundle.js
python3 - <<'PY'
import re
src = open('/tmp/bundle.js').read()
pattern = r'\b\w+\.contextEnabled&&\w+\.push\(\{label:\w+\("com_ui_upload_ocr_text"\)[^{}]*?(?:\{[^{}]*\}[^{}]*?)*\}\),?'
src, n = re.subn(pattern, '', src)
print('  ocr_text deletions:', n)
open('/tmp/bundle.js','w').write(src)
PY
docker cp /tmp/bundle.js ycchat-api:$BUNDLE

echo '==7. provisioning re-enable check (AuthService.js)=='
docker exec ycchat-api sh -c '
if grep -q "if (process.env.NEWAPI_ADMIN_BASE_URL && process.env.NEWAPI_ADMIN_KEY) {" /app/api/server/services/AuthService.js; then
  echo "  already enabled"
else
  echo "  WARNING: provisioning block missing or mangled — check manually"
fi
'

echo '==restart api=='
cd /opt/dingyuanying-chat
docker compose restart librechat-api 2>&1 | tail -2
sleep 10
echo '==verify=='
docker exec ycchat-api grep -c filter\(Boolean\) /app/node_modules/@librechat/agents/dist/cjs/messages/reducer.cjs
docker exec ycchat-api grep -c '/api/user/token' /app/packages/api/dist/index.js
curl -sk -o /dev/null -w 'final health=%{http_code}\n' https://dyy.youchun.tech/api/config
echo '==DONE=='
