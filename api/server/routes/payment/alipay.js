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
//   stripe (cents) and wxpay (cents) representations and giving the
//   credit helper a uniform unit.

'use strict';

const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { creditUserBalance } = require('@librechat/api');
const mongoose = require('mongoose');
const { verifyAlipayNotify } = require('./signatures');
const { resolveTopupRatio } = require('./ratio');
const { resolveUserId } = require('./userlookup');

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

module.exports = router;
