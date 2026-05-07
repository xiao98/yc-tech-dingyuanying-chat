// BALANCE_GATE_E2E (P3b, criterion 4.3).
//
// Verifies the literal contract:
//   1. balance == 0 → POST chat returns 402 with body containing
//      "insufficient balance".
//   2. After topup (via the stripe webhook simulator) → balance > 0 →
//      same chat request now passes the gate (200 from a stub upstream
//      mock, since the production controller would need a full agent
//      stack).
//
// Endpoint path note (decision documented in P3b.md): the original
// spec referenced /api/ask/ycapi-claude. LibreChat agent flow runs at
// /api/agents/chat (no /api/ask route exists in this branch). We mount
// the balanceGate middleware on /api/agents/chat (see api/server/
// routes/agents/chat.js) and the test exercises the same middleware
// directly; the route is real, the request shape is identical, and
// the failure-mode contract is identical.

'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const balanceGate = require('../../middleware/balanceGate');
const stripeSim = require('../../../../e2e/mocks/stripe-simulator');

let mongoServer;
let app;
const STRIPE_SECRET = 'whsec_test_secret_p3b_gate';

function buildApp(currentUser) {
  const a = express();
  const captureRawBody = (req, _res, buf) => {
    if (buf && buf.length) req.rawBody = buf;
  };
  a.use(express.json({ limit: '3mb', verify: captureRawBody }));
  a.use(express.urlencoded({ extended: true, limit: '3mb', verify: captureRawBody }));

  // Stripe webhook is unauth'd (signature-based) — mount as in prod.
  a.use('/api/payment/stripe', require('../payment/stripe'));

  // Synthetic protected chat route: mimic the real /api/agents/chat
  // chain just well enough to test the gate. We attach req.user from
  // a closure (mock JWT) and run the actual balanceGate middleware on
  // it — same code path as production.
  a.post(
    '/api/agents/chat',
    (req, _res, next) => {
      req.user = currentUser();
      next();
    },
    balanceGate,
    (_req, res) => res.status(200).json({ ok: true, sent: 'mock-upstream' }),
  );
  return a;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const { createModels } = require('@librechat/data-schemas');
  createModels(mongoose);

  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
  process.env.PAYMENT_RATIO = '1';
  process.env.CONFIG_PATH = path.join(__dirname, 'no-such-config.yaml');
  process.env.BALANCE_GATE_DISABLED = 'false';
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const Payment = mongoose.connection.model('Payment');
  const Balance = mongoose.connection.model('Balance');
  await Payment.deleteMany({});
  await Balance.deleteMany({});
  await Payment.syncIndexes();
});

describe('Balance gate e2e (criterion 4.3)', () => {
  test('case 1: balance=0 → POST chat returns 402 with "insufficient balance"', async () => {
    const uid = new mongoose.Types.ObjectId();
    const user = { _id: uid.toString(), id: uid.toString() };
    const a = buildApp(() => user);

    const res = await request(a).post('/api/agents/chat').send({ message: 'hi' });

    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/insufficient balance/i);
  });

  test('case 1b: missing balance row treated as zero → 402', async () => {
    const uid = new mongoose.Types.ObjectId().toString();
    const a = buildApp(() => ({ _id: uid, id: uid }));
    const res = await request(a).post('/api/agents/chat').send({ message: 'hi' });
    expect(res.status).toBe(402);
  });

  test('case 2: after stripe topup, same chat request returns 200', async () => {
    const uid = new mongoose.Types.ObjectId().toString();
    const user = { _id: uid, id: uid };
    const a = buildApp(() => user);

    // Verify gate fires first.
    const before = await request(a).post('/api/agents/chat').send({ message: 'hi' });
    expect(before.status).toBe(402);

    // Topup via stripe webhook — production code path, no shortcut.
    const event = stripeSim.buildEvent({ user: uid, amount: 5000, currency: 'usd' });
    const rawBody = JSON.stringify(event);
    const sig = stripeSim.signStripe(rawBody, STRIPE_SECRET);
    const topup = await request(a)
      .post('/api/payment/stripe/webhook')
      .set('Stripe-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(rawBody);
    expect(topup.status).toBe(200);

    const Balance = mongoose.connection.model('Balance');
    const bal = await Balance.findOne({ user: uid }).lean();
    expect(bal.tokenCredits).toBe(5000);

    // Same request now passes the gate.
    const after = await request(a).post('/api/agents/chat').send({ message: 'hi' });
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ ok: true, sent: 'mock-upstream' });
  });
});
