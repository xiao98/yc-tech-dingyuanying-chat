// PAYMENT_ALIPAY_HOOK — YC TECH 丁元英 Chat (P3b).
//
// Alipay PC-pay async-notify endpoint. Receives form-urlencoded body
// signed with the merchant's RSA2 (SHA256withRSA) and verified against
// Alipay's RSA public key (configured by env). On a verified TRADE_SUCCESS
// or TRADE_FINISHED notification we credit the user's balance and reply
// with the literal string "success" — Alipay treats any other response
// (including JSON) as a delivery failure and retries up to 8 times over
// 25 hours.
//
// channel_ref selection: `params.trade_no` (Alipay 订单号).
//   - Globally unique on Alipay's side per closed transaction.
//   - Same physical payment retried by Alipay produces the same trade_no.
//   - `out_trade_no` (merchant order id) is also unique but is set by
//     us, so trade_no is the safer choice for "did Alipay actually
//     close this transaction" idempotency.
//
// Amount: `params.total_amount` is in yuan (元) as a decimal string.
//   We convert to cents (×100, rounded) before persisting, matching the
//   stripe (cents) representation and giving the credit helper a uniform unit.

'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { creditUserBalance } = require('@librechat/api');
const mongoose = require('mongoose');
const { verifyAlipayNotify, canonicalAlipayString } = require('./signatures');
const { resolveTopupRatio } = require('./ratio');
const { resolveUserId } = require('./userlookup');
const requireJwtAuth = require('../../middleware/requireJwtAuth');

const router = express.Router();

router.post('/webhook', async (req, res) => {
  const publicKey = process.env.ALIPAY_PUBLIC_KEY;
  if (!publicKey) {
    res.status(503).type('text/plain').send('alipay webhook not configured');
    return;
  }

  const params = (req.body && typeof req.body === 'object') ? req.body : {};
  const verifyResult = verifyAlipayNotify(params, publicKey);
  if (!verifyResult.ok) {
    logger.warn(`[alipay webhook] signature rejected: ${verifyResult.reason}`);
    res.status(400).type('text/plain').send('failure');
    return;
  }

  const tradeStatus = params.trade_status;
  if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
    res.status(200).type('text/plain').send('success');
    return;
  }

  const tradeNo = params.trade_no;
  if (!tradeNo) {
    res.status(400).type('text/plain').send('failure');
    return;
  }

  const yuan = parseFloat(params.total_amount);
  if (!Number.isFinite(yuan) || yuan <= 0) {
    res.status(400).type('text/plain').send('failure');
    return;
  }
  const cents = Math.round(yuan * 100);

  const userId = await resolveUserId({
    explicit: params.passback_params || params.body || extractUserFromOutTradeNo(params.out_trade_no),
    channel: 'alipay',
    customerRef: params.buyer_id || params.buyer_logon_id,
  });
  if (!userId) {
    logger.warn(`[alipay webhook] cannot resolve user_id for trade_no ${tradeNo}`);
    res.status(400).type('text/plain').send('failure');
    return;
  }

  const ratio = resolveTopupRatio('alipay', 'cny');
  try {
    const result = await creditUserBalance(
      {
        userId,
        amount: cents,
        currency: 'cny',
        channel: 'alipay',
        channelRef: tradeNo,
        rawPayload: params,
        ratio,
      },
      { connection: mongoose.connection },
    );
    if (result.idempotent) {
      logger.info(`[alipay webhook] replay for trade_no ${tradeNo} — already paid`);
    }
    res.status(200).type('text/plain').send('success');
  } catch (err) {
    logger.error(`[alipay webhook] credit failed for trade_no ${tradeNo}: ${err.message}`);
    res.status(500).type('text/plain').send('failure');
  }
});

function extractUserFromOutTradeNo(outTradeNo) {
  if (!outTradeNo || typeof outTradeNo !== 'string') return null;
  const m = /^u_([a-f0-9]{24})_/.exec(outTradeNo);
  return m ? m[1] : null;
}

// PAYMENT_ALIPAY_INITIATION_HOOK — YC TECH 丁元英 Chat (P4).
//
// Authenticated POST endpoint that builds a signed Alipay PC pay
// gateway URL (alipay.trade.page.pay). The browser is then redirected
// to this URL where the user completes the trade. Upon success the
// webhook (PAYMENT_ALIPAY_HOOK above) credits the balance.
//
// Body: { amount: "<decimal yuan>" }, e.g. "9.99".
//
// out_trade_no encodes the LibreChat user id so the webhook's
// resolveUserId() helper falls back to it when buyer-side metadata
// is not enough. Format: `u_<userid>_<timestamp>` — matches the
// regex in extractUserFromOutTradeNo above.

function buildAlipayPageUrl({
  appId,
  privateKeyPem,
  outTradeNo,
  totalAmount,
  subject,
  notifyUrl,
  returnUrl,
  gateway,
}) {
  const bizContent = JSON.stringify({
    out_trade_no: outTradeNo,
    total_amount: totalAmount,
    subject,
    product_code: 'FAST_INSTANT_TRADE_PAY',
  });
  const params = {
    app_id: appId,
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    version: '1.0',
    notify_url: notifyUrl,
    return_url: returnUrl,
    biz_content: bizContent,
  };
  const canonical = canonicalAlipayString(params);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(canonical, 'utf8');
  const sign = signer.sign(privateKeyPem, 'base64');
  const finalParams = { ...params, sign };
  const qs = Object.entries(finalParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${gateway}?${qs}`;
}

router.post('/create-trade', requireJwtAuth, async (req, res) => {
  try {
    const { amount } = req.body || {};
    if (!amount || !/^\d+(\.\d{1,2})?$/.test(String(amount))) {
      return res.status(400).json({ error: 'amount required (decimal yuan)' });
    }
    const yuan = parseFloat(String(amount));
    if (!Number.isFinite(yuan) || yuan <= 0) {
      return res.status(400).json({ error: 'invalid amount' });
    }
    if (!process.env.ALIPAY_APP_ID || !process.env.ALIPAY_PRIVATE_KEY_PATH) {
      return res.status(503).json({ error: 'alipay not configured' });
    }
    let privateKeyPem;
    try {
      privateKeyPem = fs.readFileSync(process.env.ALIPAY_PRIVATE_KEY_PATH, 'utf8');
    } catch (err) {
      logger.error(`[alipay create-trade] private key read failed: ${err.message}`);
      return res.status(503).json({ error: 'alipay private key unavailable' });
    }

    const userId = req.user._id ? req.user._id.toString() : req.user.id;
    const outTradeNo = `u_${userId}_${Date.now()}`;
    const domain = process.env.DOMAIN || 'dyy.youchun.tech';
    const url = buildAlipayPageUrl({
      appId: process.env.ALIPAY_APP_ID,
      privateKeyPem,
      outTradeNo,
      totalAmount: yuan.toFixed(2),
      subject: '丁元英 Chat 充值',
      notifyUrl: `https://${domain}/api/payment/alipay/webhook`,
      returnUrl: `https://${domain}/?alipay_trade=${outTradeNo}`,
      gateway: process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do',
    });
    return res.status(200).json({ url, outTradeNo });
  } catch (err) {
    logger.error(`[alipay create-trade] failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.buildAlipayPageUrl = buildAlipayPageUrl;
