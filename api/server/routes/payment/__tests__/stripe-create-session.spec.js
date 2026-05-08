// PAYMENT_STRIPE_CREATE_SESSION_SPEC (P4, criterion C1).
//
// Exercises the two authenticated initiation endpoints
//   - POST /api/payment/stripe/create-checkout-session
//   - POST /api/payment/stripe/create-portal-session
// against a real Express app + supertest. The Stripe HTTPS API is
// stubbed by a local raw http.createServer mock and the route's
// fetch() is pointed at it via STRIPE_API_BASE — same approach the
// system-lock-proxy spec uses for upstream YCAPI.
//
// Auth: the production middleware (requireJwtAuth → passport jwt) is
// dependency-injected away by mounting the router under a shim that
// pre-populates req.user with a deterministic mock, *and* by wiring
// the very same shim before the router so any unauthenticated path
// (no shim user) returns 401. This mirrors balance-gate.e2e.spec.js.
//
// Why we don't use real passport here:
//   - Passport requires loading the global @librechat/api strategies
//     and a configured JWT secret. That couples this spec to startup
//     wiring out of scope for P4.
//   - The shim is the same conceptual contract the user has in prod:
//     after passport completes, req.user is set; otherwise the route
//     handler is never reached. We test the handler.

'use strict';

const http = require('node:http');
const express = require('express');
const request = require('supertest');

let mockUpstream;
let app;
const TEST_USER_ID = '6650abcdef0123456789abcd';

function startMockStripe(handler) {
  return new Promise((resolve) => {
    const records = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const record = { method: req.method, url: req.url, headers: req.headers, rawBody };
        records.push(record);
        try {
          handler(record, req, res);
        } catch (err) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(String(err && err.message));
          }
        }
      });
      req.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        records,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function buildApp({ user, withAuthShim = true } = {}) {
  // Use jest.isolateModules + jest.doMock so the route file resolves
  // its `require('../../middleware/requireJwtAuth')` call to a
  // controllable middleware shim. This is more robust than direct
  // require.cache injection because Jest maintains its own module
  // registry that doesn't always honor the global require.cache.
  jest.resetModules();
  jest.doMock(
    '../../../middleware/requireJwtAuth',
    () =>
      function requireJwtAuthShim(req, res, next) {
        if (!withAuthShim) return res.status(401).json({ error: 'unauthorized' });
        const u = typeof user === 'function' ? user() : user;
        if (!u) return res.status(401).json({ error: 'unauthorized' });
        req.user = u;
        next();
      },
  );
  const stripeRoute = require('../stripe');

  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use('/api/payment/stripe', stripeRoute);
  return a;
}

beforeAll(async () => {
  mockUpstream = await startMockStripe((rec, _req, res) => {
    if (rec.url === '/v1/checkout/sessions') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'cs_test_p4_session_123',
          url: 'https://checkout.stripe.com/c/pay/cs_test_p4_session_123',
        }),
      );
      return;
    }
    if (rec.url === '/v1/billing_portal/sessions') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          url: 'https://billing.stripe.com/p/session/test_portal_p4_456',
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  process.env.STRIPE_SECRET_KEY = 'sk_test_p4_dummy';
  process.env.STRIPE_API_BASE = mockUpstream.baseUrl;
  process.env.DOMAIN = 'dyy.test.local';
});

afterAll(async () => {
  if (mockUpstream) await mockUpstream.close();
});

describe('Stripe initiation endpoints (P4 / criterion C1)', () => {
  test('POST /create-checkout-session → 200 + Stripe Checkout url', async () => {
    app = buildApp({ user: { _id: TEST_USER_ID, id: TEST_USER_ID } });

    const res = await request(app)
      .post('/api/payment/stripe/create-checkout-session')
      .send({ priceId: 'price_test_p4' });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    expect(res.body.id).toBe('cs_test_p4_session_123');

    const lastReq = mockUpstream.records[mockUpstream.records.length - 1];
    expect(lastReq.method).toBe('POST');
    expect(lastReq.url).toBe('/v1/checkout/sessions');
    expect(lastReq.headers.authorization).toBe('Bearer sk_test_p4_dummy');
    expect(lastReq.rawBody).toContain('mode=subscription');
    expect(lastReq.rawBody).toContain('line_items%5B0%5D%5Bprice%5D=price_test_p4');
    expect(lastReq.rawBody).toContain(`client_reference_id=${TEST_USER_ID}`);
    expect(lastReq.rawBody).toContain(`metadata%5Buser_id%5D=${TEST_USER_ID}`);
  });

  test('POST /create-portal-session → 200 + Stripe Portal url (when user has stripe_customer_id)', async () => {
    app = buildApp({
      user: { _id: TEST_USER_ID, id: TEST_USER_ID, stripe_customer_id: 'cus_test_p4_xyz' },
    });

    const res = await request(app).post('/api/payment/stripe/create-portal-session').send({});

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/billing\.stripe\.com\/p\/session\//);

    const lastReq = mockUpstream.records[mockUpstream.records.length - 1];
    expect(lastReq.url).toBe('/v1/billing_portal/sessions');
    expect(lastReq.rawBody).toContain('customer=cus_test_p4_xyz');
    expect(lastReq.rawBody).toContain('return_url=');
  });

  test('POST /create-portal-session → 409 when no stripe_customer_id', async () => {
    app = buildApp({ user: { _id: TEST_USER_ID, id: TEST_USER_ID } });

    const res = await request(app).post('/api/payment/stripe/create-portal-session').send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no stripe customer/i);
  });

  test('POST /create-checkout-session → 400 when priceId missing', async () => {
    app = buildApp({ user: { _id: TEST_USER_ID, id: TEST_USER_ID } });

    const res = await request(app).post('/api/payment/stripe/create-checkout-session').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/priceId/i);
  });

  test('POST /create-checkout-session → 401 when unauthenticated', async () => {
    app = buildApp({ withAuthShim: false });

    const res = await request(app)
      .post('/api/payment/stripe/create-checkout-session')
      .send({ priceId: 'price_test_p4' });

    expect(res.status).toBe(401);
  });
});
