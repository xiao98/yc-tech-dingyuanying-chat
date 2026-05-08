// PAYMENT_ALIPAY_CREATE_TRADE_SPEC (P4, criterion D1).
//
// Exercises POST /api/payment/alipay/create-trade end-to-end via
// supertest against the real route module. We:
//   1. Generate a fresh RSA-2048 keypair at setup.
//   2. Write the private key to a temp file and point
//      ALIPAY_PRIVATE_KEY_PATH at it (the route reads PEM from disk).
//   3. Issue a POST and assert the response contains the expected
//      gateway URL, a valid `sign=` query parameter, and that the
//      signature verifies against the matching public key with the
//      same canonical algorithm used in production
//      (signatures.canonicalAlipayString).
//
// Auth boundary: same shim pattern as stripe-create-session.spec.js
// — replaces requireJwtAuth in the require cache so the route module
// resolves to a controllable middleware. See that file for rationale.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');

const { canonicalAlipayString } = require('../signatures');

const TEST_USER_ID = '6650abcdef0123456789beef';
let tmpKeyPath;
let publicKeyPem;

function buildApp({ user, withAuthShim = true } = {}) {
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
  const alipayRoute = require('../alipay');
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use('/api/payment/alipay', alipayRoute);
  return a;
}

function parseQuery(qs) {
  const out = {};
  for (const seg of qs.split('&')) {
    const idx = seg.indexOf('=');
    if (idx <= 0) continue;
    out[seg.slice(0, idx)] = decodeURIComponent(seg.slice(idx + 1));
  }
  return out;
}

beforeAll(() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKeyPem = publicKey;
  tmpKeyPath = path.join(os.tmpdir(), `p4-alipay-key-${Date.now()}.pem`);
  fs.writeFileSync(tmpKeyPath, privateKey, { mode: 0o600 });

  process.env.ALIPAY_APP_ID = '2025_test_p4_app';
  process.env.ALIPAY_PRIVATE_KEY_PATH = tmpKeyPath;
  process.env.ALIPAY_GATEWAY = 'https://openapi.alipaydev.test/gateway.do';
  process.env.DOMAIN = 'dyy.test.local';
});

afterAll(() => {
  if (tmpKeyPath && fs.existsSync(tmpKeyPath)) fs.unlinkSync(tmpKeyPath);
});

describe('Alipay create-trade endpoint (P4 / criterion D1)', () => {
  test('returns gateway URL with required fields and outTradeNo encoding user', async () => {
    const app = buildApp({ user: { _id: TEST_USER_ID, id: TEST_USER_ID } });

    const res = await request(app)
      .post('/api/payment/alipay/create-trade')
      .send({ amount: '9.99' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBeTruthy();
    expect(res.body.outTradeNo).toMatch(new RegExp(`^u_${TEST_USER_ID}_\\d+$`));

    const u = new URL(res.body.url);
    expect(u.origin + u.pathname).toBe('https://openapi.alipaydev.test/gateway.do');

    const params = parseQuery(u.search.slice(1));
    expect(params.app_id).toBe('2025_test_p4_app');
    expect(params.method).toBe('alipay.trade.page.pay');
    expect(params.sign_type).toBe('RSA2');
    expect(params.charset).toBe('utf-8');
    expect(params.format).toBe('JSON');
    expect(params.version).toBe('1.0');
    expect(params.notify_url).toBe('https://dyy.test.local/api/payment/alipay/webhook');
    expect(params.return_url).toMatch(/alipay_trade=u_/);
    expect(typeof params.sign).toBe('string');
    expect(params.sign.length).toBeGreaterThan(40);

    const biz = JSON.parse(params.biz_content);
    expect(biz.total_amount).toBe('9.99');
    expect(biz.out_trade_no).toBe(res.body.outTradeNo);
    expect(biz.product_code).toBe('FAST_INSTANT_TRADE_PAY');
    expect(biz.subject).toBe('丁元英 Chat 充值');
  });

  test('sign verifies against the matching public key (RSA-SHA256 over canonical params)', async () => {
    const app = buildApp({ user: { _id: TEST_USER_ID, id: TEST_USER_ID } });

    const res = await request(app)
      .post('/api/payment/alipay/create-trade')
      .send({ amount: '12.50' });

    expect(res.status).toBe(200);
    const u = new URL(res.body.url);
    const params = parseQuery(u.search.slice(1));

    const canonical = canonicalAlipayString(params);
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(canonical, 'utf8');
    const ok = verifier.verify(publicKeyPem, Buffer.from(params.sign, 'base64'));
    expect(ok).toBe(true);
  });

  test('rejects missing or non-numeric amount with 400', async () => {
    const app = buildApp({ user: { _id: TEST_USER_ID, id: TEST_USER_ID } });

    const r1 = await request(app).post('/api/payment/alipay/create-trade').send({});
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .post('/api/payment/alipay/create-trade')
      .send({ amount: 'abc' });
    expect(r2.status).toBe(400);

    const r3 = await request(app)
      .post('/api/payment/alipay/create-trade')
      .send({ amount: '1.234' });
    expect(r3.status).toBe(400);
  });

  test('returns 401 when unauthenticated', async () => {
    const app = buildApp({ withAuthShim: false });

    const res = await request(app)
      .post('/api/payment/alipay/create-trade')
      .send({ amount: '9.99' });

    expect(res.status).toBe(401);
  });
});
