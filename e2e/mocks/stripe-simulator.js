#!/usr/bin/env node
// Stripe webhook simulator for the YC TECH 丁元英 Chat e2e harness (P3b).
// Constructs a checkout.session.completed event signed with HMAC-SHA256
// against STRIPE_WEBHOOK_SECRET (whatever is set, real or test) and POSTs
// it to a target URL. Replays the same event id for idempotency tests.
//
// Usage:
//   node stripe-simulator.js --user <id> --amount <cents> [--ref <evt_id>] \
//     [--currency usd] [--url http://localhost:3080/api/payment/stripe/webhook]
//
// Required env: STRIPE_WEBHOOK_SECRET
// Exit code: process exit code = HTTP status / 100 (200 → 2, 400 → 4, …)
//   so a parent shell can grep on `$?` quickly. Body printed to stdout.

'use strict';

const crypto = require('crypto');
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

function buildEvent({ user, amount, currency, ref }) {
  const eventId = ref || `evt_${crypto.randomBytes(12).toString('hex')}`;
  const sessionId = `cs_test_${crypto.randomBytes(12).toString('hex')}`;
  return {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        amount_total: Number(amount),
        currency,
        customer: null,
        customer_email: null,
        metadata: { user_id: user },
        payment_status: 'paid',
      },
    },
  };
}

function signStripe(rawBody, secret) {
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
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
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not set');
    process.exit(1);
  }
  if (!args.user || !args.amount) {
    console.error('--user and --amount are required');
    process.exit(2);
  }
  const url = args.url || 'http://localhost:3080/api/payment/stripe/webhook';
  const event = buildEvent({
    user: args.user,
    amount: args.amount,
    currency: args.currency || 'usd',
    ref: args.ref,
  });
  const rawBody = JSON.stringify(event);
  const sig = signStripe(rawBody, secret);
  const result = await postJson(url, rawBody, { 'Stripe-Signature': sig });
  console.log(JSON.stringify({ event_id: event.id, status: result.status, body: result.body }));
  process.exit(result.status === 200 ? 0 : 1);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('simulator failed:', err);
    process.exit(1);
  });
}

module.exports = { buildEvent, signStripe, postJson };
