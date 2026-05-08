// PAYMENT_RATIO_HOOK — YC TECH 丁元英 Chat (P3b).
//
// Resolves the cents → tokenCredits multiplier for a given channel +
// currency. Read from `librechat.yaml.balance.topup` so the ratio is a
// deployment knob, not a constant in code.
//
// YAML shape (additive, optional — not required by P1/P2):
//   balance:
//     enabled: true
//     topup:
//       defaultRatio: 1
//       channels:
//         stripe:
//           usd: 1
//           cny: 0.14
//         alipay:
//           cny: 1
//
// If no `topup` block exists we fall back to `process.env.PAYMENT_RATIO`
// (single global) and finally 1. Tests override via env so they don't
// need to mutate the YAML file on disk.

'use strict';

const fs = require('fs');
const path = require('path');

let cachedRatios = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30000;

function loadRatios() {
  const envRatio = parseFloat(process.env.PAYMENT_RATIO || '');
  const fallback = Number.isFinite(envRatio) && envRatio > 0 ? envRatio : 1;

  const yamlPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'librechat.yaml');
  if (!fs.existsSync(yamlPath)) {
    return { defaultRatio: fallback, channels: {} };
  }
  let raw;
  try {
    raw = fs.readFileSync(yamlPath, 'utf8');
  } catch {
    return { defaultRatio: fallback, channels: {} };
  }
  return parseTopupBlock(raw, fallback);
}

function parseTopupBlock(yaml, fallback) {
  const balanceIdx = yaml.indexOf('\nbalance:');
  if (balanceIdx === -1 && !yaml.startsWith('balance:')) {
    return { defaultRatio: fallback, channels: {} };
  }
  const startIdx = balanceIdx === -1 ? 0 : balanceIdx + 1;
  const slice = yaml.slice(startIdx);
  const lines = slice.split(/\r?\n/);
  const indented = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) {
      indented.push(line);
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      indented.push(line);
    } else {
      break;
    }
  }
  const text = indented.join('\n');
  const topupHeaderRe = /^\s\stopup:\s*$/m;
  const m = topupHeaderRe.exec(text);
  if (!m) return { defaultRatio: fallback, channels: {} };
  const after = text.slice(m.index + m[0].length).split(/\r?\n/);
  let defaultRatio = fallback;
  const channels = {};
  let currentChannel = null;
  for (const rawLine of after) {
    if (/^\s{0,3}\S/.test(rawLine) && !/^\s{4}/.test(rawLine)) {
      break;
    }
    const drm = /^\s{4}defaultRatio:\s*([0-9.]+)/.exec(rawLine);
    if (drm) {
      const v = parseFloat(drm[1]);
      if (Number.isFinite(v) && v > 0) defaultRatio = v;
      continue;
    }
    const chHeader = /^\s{4}channels:\s*$/.exec(rawLine);
    if (chHeader) continue;
    const chName = /^\s{6}([a-z]+):\s*$/.exec(rawLine);
    if (chName) {
      currentChannel = chName[1];
      channels[currentChannel] = channels[currentChannel] || {};
      continue;
    }
    const cur = /^\s{8}([a-z]{3}):\s*([0-9.]+)/.exec(rawLine);
    if (cur && currentChannel) {
      const v = parseFloat(cur[2]);
      if (Number.isFinite(v) && v > 0) channels[currentChannel][cur[1]] = v;
    }
  }
  return { defaultRatio, channels };
}

function getRatios() {
  const now = Date.now();
  if (cachedRatios && now - cachedAt < CACHE_TTL_MS) return cachedRatios;
  cachedRatios = loadRatios();
  cachedAt = now;
  return cachedRatios;
}

function resolveTopupRatio(channel, currency) {
  const ratios = getRatios();
  const cur = (currency || '').toLowerCase();
  const channelMap = ratios.channels[channel];
  if (channelMap && cur && channelMap[cur] != null) return channelMap[cur];
  return ratios.defaultRatio;
}

function clearCache() {
  cachedRatios = null;
  cachedAt = 0;
}

module.exports = { resolveTopupRatio, clearCache };
