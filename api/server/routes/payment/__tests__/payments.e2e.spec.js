// PAYMENT_WEBHOOK_E2E (P3b, criterion 4.2).
//
// Drives the three webhook handlers (alipay / wxpay / stripe) end-to-
// end against a real Express app + mongodb-memory-server. For each
// channel:
//   - Case A/B/C: a fresh signed payload posts → 200 + Payment(paid)
//     row + Balance.tokenCredits incremented.
//   - Case D: same channel_ref re-posted → 200 (idempotent), Payment
//     count unchanged, Balance unchanged.
//
// Mocks are limited to (a) the JWT layer (we don't go through auth at
// all — webhooks are unauth'd by design and rely on signature) and
// (b) librechat.yaml ratio (we override via env). The signature
// verification, body parsing, channel_ref idempotency, and
// Balance/Payment writes all use the real production code paths.

'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const stripeSim = require('../../../../../e2e/mocks/stripe-simulator');
const alipaySim = require('../../../../../e2e/mocks/alipay-simulator');
const wxpaySim = require('../../../../../e2e/mocks/wxpay-simulator');

let mongoServer;
let app;
let alipayKeyPair;
let wxpayKeyPair;

const STRIPE_SECRET = 'whsec_test_secret_p3b';
const WXPAY_API_V3_KEY = '0123456789abcdef0123456789abcdef'; // 32 bytes

function makeRsaKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function buildApp() {
  const a = express();
  const captureRawBody = (req, _res, buf) => {
    if (buf && buf.length) req.rawBody = buf;
  };
  a.use(express.json({ limit: '3mb', verify: captureRawBody }));
  a.use(express.urlencoded({ extended: true, limit: '3mb', verify: captureRawBody }));
  a.use('/api/payment/stripe', require('../stripe'));
  a.use('/api/payment/alipay', require('../alipay'));
  a.use('/api/payment/wxpay', require('../wxpay'));
  return a;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  // Load and register all data-schemas models on the active mongoose
  // connection. Required because credit.ts looks up Payment / Balance
  // via mongoose.connection.model('Payment').
  const { createModels } = require('@librechat/data-schemas');
  createModels(mongoose);

  alipayKeyPair = makeRsaKeyPair();
  wxpayKeyPair = makeRsaKeyPair();

  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
  process.env.ALIPAY_PUBLIC_KEY = alipayKeyPair.publicKey;
  process.env.WXPAY_PLATFORM_PUBLIC_KEY = wxpayKeyPair.publicKey;
  process.env.WXPAY_API_V3_KEY = WXPAY_API_V3_KEY;
  process.env.PAYMENT_RATIO = '1';
  process.env.CONFIG_PATH = path.join(__dirname, 'no-such-config.yaml');

  app = buildApp();
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
  // Drop indexes we care about then re-sync so the unique constraint is
  // reliably present on the in-memory collection across test files.
  await Payment.syncIndexes();
});

const userId = () => new mongoose.Types.ObjectId().toString();

describe('Payment webhook e2e (criterion 4.2)', () => {
  test('case A: stripe checkout.session.completed credits balance', async () => {
    const uid = userId();
    const event = stripeSim.buildEvent({ user: uid, amount: 1999, currency: 'usd' });
    const rawBody = JSON.stringify(event);
    const sig = stripeSim.signStripe(rawBody, STRIPE_SECRET);

    const res = await request(app)
      .post('/api/payment/stripe/webhook')
      .set('Stripe-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const Payment = mongoose.connection.model('Payment');
    const Balance = mongoose.connection.model('Balance');
    const rows = await Payment.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('stripe');
    expect(rows[0].channel_ref).toBe(event.id);
    expect(rows[0].status).toBe('paid');
    expect(rows[0].amount).toBe(1999);

    const bal = await Balance.findOne({ user: uid }).lean();
    expect(bal.tokenCredits).toBe(1999);
  });

  test('case B: alipay TRADE_SUCCESS credits balance', async () => {
    const uid = userId();
    const params = alipaySim.buildParams({ user: uid, amount: '12.34' });
    params.sign = alipaySim.signParams(params, alipayKeyPair.privateKey);

    const res = await request(app)
      .post('/api/payment/alipay/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(params);

    expect(res.status).toBe(200);
    expect(res.text).toBe('success');

    const Payment = mongoose.connection.model('Payment');
    const Balance = mongoose.connection.model('Balance');
    const rows = await Payment.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('alipay');
    expect(rows[0].channel_ref).toBe(params.trade_no);
    expect(rows[0].amount).toBe(1234);

    const bal = await Balance.findOne({ user: uid }).lean();
    expect(bal.tokenCredits).toBe(1234);
  });

  test('case C: wxpay TRANSACTION.SUCCESS credits balance', async () => {
    const uid = userId();
    const plain = wxpaySim.buildPlaintext({ user: uid, amount: 5000 });
    const resource = wxpaySim.encryptResource(plain, WXPAY_API_V3_KEY);
    const event = {
      id: crypto.randomBytes(16).toString('hex'),
      create_time: new Date().toISOString(),
      event_type: 'TRANSACTION.SUCCESS',
      summary: '支付成功',
      resource,
    };
    const rawBody = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(8).toString('hex');
    const signature = wxpaySim.signHttp({
      rawBody,
      timestamp,
      nonce,
      privateKeyPem: wxpayKeyPair.privateKey,
    });

    const res = await request(app)
      .post('/api/payment/wxpay/webhook')
      .set('Wechatpay-Timestamp', timestamp)
      .set('Wechatpay-Nonce', nonce)
      .set('Wechatpay-Signature', signature)
      .set('Wechatpay-Serial', 'test_serial')
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: 'SUCCESS', message: '成功' });

    const Payment = mongoose.connection.model('Payment');
    const Balance = mongoose.connection.model('Balance');
    const rows = await Payment.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('wxpay');
    expect(rows[0].channel_ref).toBe(plain.transaction_id);
    expect(rows[0].amount).toBe(5000);

    const bal = await Balance.findOne({ user: uid }).lean();
    expect(bal.tokenCredits).toBe(5000);
  });

  test('case D-stripe: replay with same event id is idempotent', async () => {
    const uid = userId();
    const event = stripeSim.buildEvent({ user: uid, amount: 100, currency: 'usd' });
    const rawBody = JSON.stringify(event);

    const post = () =>
      request(app)
        .post('/api/payment/stripe/webhook')
        .set('Stripe-Signature', stripeSim.signStripe(rawBody, STRIPE_SECRET))
        .set('Content-Type', 'application/json')
        .send(rawBody);

    const r1 = await post();
    expect(r1.status).toBe(200);
    const r2 = await post();
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent).toBe(true);

    const Payment = mongoose.connection.model('Payment');
    const Balance = mongoose.connection.model('Balance');
    const rows = await Payment.find({}).lean();
    expect(rows).toHaveLength(1);
    const bal = await Balance.findOne({ user: uid }).lean();
    expect(bal.tokenCredits).toBe(100);
  });

  test('case D-alipay: replay with same trade_no is idempotent', async () => {
    const uid = userId();
    const params = alipaySim.buildParams({ user: uid, amount: '7.50' });
    params.sign = alipaySim.signParams(params, alipayKeyPair.privateKey);

    const send = () =>
      request(app)
        .post('/api/payment/alipay/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(params);

    const r1 = await send();
    expect(r1.status).toBe(200);
    expect(r1.text).toBe('success');

    const r2 = await send();
    expect(r2.status).toBe(200);
    expect(r2.text).toBe('success');

    const Payment = mongoose.connection.model('Payment');
    const Balance = mongoose.connection.model('Balance');
    const rows = await Payment.find({}).lean();
    expect(rows).toHaveLength(1);
    const bal = await Balance.findOne({ user: uid }).lean();
    expect(bal.tokenCredits).toBe(750);
  });

  test('case D-wxpay: replay with same transaction_id is idempotent', async () => {
    const uid = userId();
    const plain = wxpaySim.buildPlaintext({ user: uid, amount: 9999 });

    const send = () => {
      const resource = wxpaySim.encryptResource(plain, WXPAY_API_V3_KEY);
      const event = {
        id: crypto.randomBytes(16).toString('hex'),
        create_time: new Date().toISOString(),
        event_type: 'TRANSACTION.SUCCESS',
        summary: '支付成功',
        resource,
      };
      const rawBody = JSON.stringify(event);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomBytes(8).toString('hex');
      const signature = wxpaySim.signHttp({
        rawBody,
        timestamp,
        nonce,
        privateKeyPem: wxpayKeyPair.privateKey,
      });
      return request(app)
        .post('/api/payment/wxpay/webhook')
        .set('Wechatpay-Timestamp', timestamp)
        .set('Wechatpay-Nonce', nonce)
        .set('Wechatpay-Signature', signature)
        .set('Wechatpay-Serial', 'test_serial')
        .set('Content-Type', 'application/json')
        .send(rawBody);
    };

    const r1 = await send();
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ code: 'SUCCESS', message: '成功' });

    const r2 = await send();
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ code: 'SUCCESS', message: '成功' });

    const Payment = mongoose.connection.model('Payment');
    const Balance = mongoose.connection.model('Balance');
    const rows = await Payment.find({}).lean();
    expect(rows).toHaveLength(1);
    const bal = await Balance.findOne({ user: uid }).lean();
    expect(bal.tokenCredits).toBe(9999);
  });

  test('rejects bad signature (stripe)', async () => {
    const uid = userId();
    const event = stripeSim.buildEvent({ user: uid, amount: 100, currency: 'usd' });
    const rawBody = JSON.stringify(event);

    const res = await request(app)
      .post('/api/payment/stripe/webhook')
      .set('Stripe-Signature', stripeSim.signStripe(rawBody, 'wrong_secret'))
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(400);
    const Payment = mongoose.connection.model('Payment');
    const rows = await Payment.find({}).lean();
    expect(rows).toHaveLength(0);
  });
});
