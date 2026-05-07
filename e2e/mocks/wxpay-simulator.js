#!/usr/bin/env node
// WeChat Pay v3 webhook simulator for the YC TECH 丁元英 Chat e2e harness (P3b).
// Encrypts a TRANSACTION.SUCCESS payload with AEAD-AES-256-GCM under the
// merchant APIv3 key, signs the HTTP body with the platform private key
// (fixture key, paired with WXPAY_PLATFORM_PUBLIC_KEY on the server side),
// and POSTs.
//
// Usage:
//   node wxpay-simulator.js --user <id> --amount <cents> [--ref <transaction_id>] \
//     [--key-pem <path>] [--url http://...]
//
// Env:
//   WXPAY_API_V3_KEY                   — 32-byte APIv3 key (must match server)
//   WXPAY_PLATFORM_PRIVATE_KEY_PEM     — RSA private key (alternative to --key-pem)
//
// Server expects WXPAY_PLATFORM_PUBLIC_KEY (PEM) — pair with the private
// key used here at fixture-generation time.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function buildPlaintext({ user, amount, ref }) {
  const transactionId = ref || `42000${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  return {
    mchid: '1900_test',
    appid: 'wx_test',
    out_trade_no: `u_${user}_${Date.now()}`,
    transaction_id: transactionId,
    trade_type: 'NATIVE',
    trade_state: 'SUCCESS',
    trade_state_desc: '支付成功',
    bank_type: 'TEST_BANK',
    success_time: new Date().toISOString(),
    payer: { openid: 'test_openid_' + Math.random().toString(36).slice(2) },
    amount: { total: Number(amount), payer_total: Number(amount), currency: 'CNY', payer_currency: 'CNY' },
    attach: user,
  };
}

function encryptResource(plain, apiV3Key) {
  if (Buffer.byteLength(apiV3Key, 'utf8') !== 32) throw new Error('apiV3Key must be 32 bytes');
  const nonce = crypto.randomBytes(6).toString('hex');
  const aad = 'transaction';
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    algorithm: 'AEAD_AES_256_GCM',
    ciphertext: Buffer.concat([data, tag]).toString('base64'),
    associated_data: aad,
    nonce,
    original_type: 'transaction',
  };
}

function signHttp({ rawBody, timestamp, nonce, privateKeyPem }) {
  const signed = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signed, 'utf8');
  return signer.sign(privateKeyPem, 'base64');
}

function postJson(targetUrl, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const apiV3Key = process.env.WXPAY_API_V3_KEY;
  const keyPath = args['key-pem'];
  const privateKey = keyPath
    ? fs.readFileSync(keyPath, 'utf8')
    : process.env.WXPAY_PLATFORM_PRIVATE_KEY_PEM;
  if (!apiV3Key) {
    console.error('WXPAY_API_V3_KEY not set');
    process.exit(1);
  }
  if (!privateKey) {
    console.error('WXPAY_PLATFORM_PRIVATE_KEY_PEM not set and --key-pem not provided');
    process.exit(1);
  }
  if (!args.user || !args.amount) {
    console.error('--user and --amount are required');
    process.exit(2);
  }
  const url = args.url || 'http://localhost:3080/api/payment/wxpay/webhook';
  const plain = buildPlaintext({ user: args.user, amount: args.amount, ref: args.ref });
  const resource = encryptResource(plain, apiV3Key);
  const event = {
    id: crypto.randomBytes(16).toString('hex'),
    create_time: new Date().toISOString(),
    resource_type: 'encrypt-resource',
    event_type: 'TRANSACTION.SUCCESS',
    summary: '支付成功',
    resource,
  };
  const rawBody = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signHttp({ rawBody, timestamp, nonce, privateKeyPem: privateKey });
  const result = await postJson(url, rawBody, {
    'Wechatpay-Timestamp': timestamp,
    'Wechatpay-Nonce': nonce,
    'Wechatpay-Signature': signature,
    'Wechatpay-Serial': 'test_serial_no',
  });
  console.log(
    JSON.stringify({ transaction_id: plain.transaction_id, status: result.status, body: result.body }),
  );
  process.exit(result.status === 200 ? 0 : 1);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('simulator failed:', err);
    process.exit(1);
  });
}

module.exports = { buildPlaintext, encryptResource, signHttp, postJson };
