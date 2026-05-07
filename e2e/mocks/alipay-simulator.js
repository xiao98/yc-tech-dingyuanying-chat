#!/usr/bin/env node
// Alipay async-notify simulator for the YC TECH 丁元英 Chat e2e harness (P3b).
// Builds form-urlencoded TRADE_SUCCESS notify body, signs with RSA2 using a
// merchant private key (test fixture generated at setup time), and POSTs.
//
// Usage:
//   node alipay-simulator.js --user <id> --amount <yuan> [--ref <trade_no>] \
//     [--key-pem <path>] [--url http://...]
//
// Env:
//   ALIPAY_MERCHANT_PRIVATE_KEY_PEM — PEM-encoded RSA private key
//     (alternative to --key-pem)
//
// Note: production uses Alipay's *public* key on the verifier side and the
// merchant's *private* key on the signer side. For tests we generate a
// fresh keypair at setup, then configure the verifier (server env
// ALIPAY_PUBLIC_KEY) with the public half and this simulator with the
// private half.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const querystring = require('querystring');
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

function buildParams({ user, amount, ref }) {
  const tradeNo = ref || `2025${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  return {
    notify_time: new Date().toISOString().replace('T', ' ').slice(0, 19),
    notify_type: 'trade_status_sync',
    notify_id: crypto.randomBytes(16).toString('hex'),
    app_id: '2025_test',
    charset: 'utf-8',
    version: '1.0',
    sign_type: 'RSA2',
    trade_no: tradeNo,
    out_trade_no: `u_${user}_${Date.now()}`,
    trade_status: 'TRADE_SUCCESS',
    total_amount: String(Number(amount).toFixed(2)),
    receipt_amount: String(Number(amount).toFixed(2)),
    buyer_id: '2088_test_buyer',
    buyer_logon_id: 'test***@example.com',
    passback_params: user,
  };
}

function canonicalAlipayString(params) {
  const keys = Object.keys(params).filter(
    (k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null,
  );
  keys.sort();
  return keys.map((k) => `${k}=${params[k]}`).join('&');
}

function signParams(params, privateKeyPem) {
  const signed = canonicalAlipayString(params);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signed, 'utf8');
  return signer.sign(privateKeyPem, 'base64');
}

function postForm(targetUrl, formBody) {
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
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(formBody),
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
    req.write(formBody);
    req.end();
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const keyPath = args['key-pem'];
  const privateKey = keyPath
    ? fs.readFileSync(keyPath, 'utf8')
    : process.env.ALIPAY_MERCHANT_PRIVATE_KEY_PEM;
  if (!privateKey) {
    console.error('ALIPAY_MERCHANT_PRIVATE_KEY_PEM not set and --key-pem not provided');
    process.exit(1);
  }
  if (!args.user || !args.amount) {
    console.error('--user and --amount are required');
    process.exit(2);
  }

  const url = args.url || 'http://localhost:3080/api/payment/alipay/webhook';
  const params = buildParams({ user: args.user, amount: args.amount, ref: args.ref });
  params.sign = signParams(params, privateKey);
  const formBody = querystring.stringify(params);
  const result = await postForm(url, formBody);
  console.log(
    JSON.stringify({ trade_no: params.trade_no, status: result.status, body: result.body }),
  );
  process.exit(result.status === 200 && result.body === 'success' ? 0 : 1);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('simulator failed:', err);
    process.exit(1);
  });
}

module.exports = { buildParams, signParams, canonicalAlipayString, postForm };
