/* Generates librechat.yaml from api/server/locks/ding-yuanying.skill.md.
   Run: node scripts/gen-yaml.js
   The promptPrefix block embeds the SKILL.md content verbatim (after .trim())
   inside a YAML literal block scalar (|-) so SHA256(trim(promptPrefix)) ===
   SHA256(trim(SKILL.md)).
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const skillPath = path.join(repoRoot, 'api', 'server', 'locks', 'ding-yuanying.skill.md');
const yamlPath = path.join(repoRoot, 'librechat.yaml');

// Normalize line endings so SHA256 of the embedded promptPrefix matches the
// runtime SHA256 (middleware also normalizes CRLF -> LF before hashing).
const skillRaw = fs.readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
const skillTrim = skillRaw.trim();

// promptPrefix: line is at column 8. YAML literal block content must be
// indented strictly more than that — use 10 spaces.
const INDENT = '          '; // 10 spaces
const indented = skillTrim
  .split('\n')
  .map((l) => (l.length === 0 ? '' : INDENT + l))
  .join('\n');

const yaml = `# librechat.yaml — yc-tech-dingyuanying-chat (P1: ding-yuanying lock)
# Single-spec, locked UI. Do NOT add other modelSpecs/endpoints here.
version: 1.2.8
cache: true

interface:
  parameters: false
  presets: false
  modelSelect: false
  endpointsMenu: false
  sidePanel: true
  privacyPolicy:
    externalUrl: 'https://yctech.example/privacy'
    openNewTab: true
  termsOfService:
    externalUrl: 'https://yctech.example/terms'
    openNewTab: true

balance:
  enabled: true
  startBalance: 0
  autoRefillEnabled: false

modelSpecs:
  enforce: true
  prioritize: true
  list:
    - name: ding-yuanying
      label: 丁元英 Chat
      description: 以《遥远的救世主》中丁元英的思维框架回答问题
      default: true
      preset:
        endpoint: ycapi
        model: gpt-5
        temperature: 0.7
        promptPrefix: |-
${indented}

endpoints:
  custom:
    - name: ycapi
      apiKey: '\${YCAPI_KEY}'
      baseURL: '\${YCAPI_BASE_URL}'
      models:
        default: ['gpt-5']
        fetch: false
      titleConvo: true
      titleModel: gpt-5
      modelDisplayLabel: 丁元英
`;

fs.writeFileSync(yamlPath, yaml, 'utf8');

const sha = crypto.createHash('sha256').update(skillTrim).digest('hex');
console.log('SKILL_TRIM_SHA256:', sha);
console.log('YAML written:', yamlPath, fs.statSync(yamlPath).size, 'bytes');
