// PAYMENT_WXPAY_HOOK — YC TECH 丁元英 Chat (P3b).
//
// WeChat Pay v3 (Native / JSAPI) webhook. Two-stage verification:
//   1. HTTP signature: RSA-SHA256 over `${timestamp}\n${nonce}\n${rawBody}\n`
//      with WeChat Pay's platform public key (configured by env).
//   2. Resource decryption: AEAD-AES-256-GCM with the merchant's APIv3
//      key (32 bytes), nonce from the resource block, ciphertext +
//      auth tag concatenated and base64-encoded by WeChat.
//
// channel_ref selection: decrypted `transaction_id` (微信支付订单号).
//   - Globally unique on WeChat's side per settled order.
//   - Stable across retries of the same order.
//   - `out_trade_no` is set by us, so transaction_id is the canonical
//     "WeChat closed this order" identifier — same logic as Alipay.
//
// Success response per WeChat docs: HTTP 200 with body
//   {"code":"SUCCESS","message":"成功"}
// Anything else (including default Express error) triggers retries.

'use strict';

const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { creditUserBalance } = require('@librechat/api');
const mongoose = require('mongoose');
const {
  verifyWxpayHttpSignature,
  decryptWxpayResource,
} = require('./signatures');
const { resolveTopupRatio } = require('./ratio');
const { resolveUserId } = require('./userlookup');

const router = express.Router();

router.post('/webhook', async (req, res) => {
  const platformPublicKey = process.env.WXPAY_PLATFORM_PUBLIC_KEY;
  const apiV3Key = process.env.WXPAY_API_V3_KEY;
  if (!platformPublicKey || !apiV3Key) {
    return wxFailure(res, 503, 'CONFIG_ERROR', 'wxpay webhook not configured');
  }

  const timestamp = req.header('Wechatpay-Timestamp');
  const nonce = req.header('Wechatpay-Nonce');
  const signature = req.header('Wechatpay-Signature');
  const rawBody = req.rawBody;
  if (!rawBody) {
    return wxFailure(res, 400, 'NO_BODY', 'missing raw body');
  }

  const verifyResult = verifyWxpayHttpSignature({
    rawBody,
    timestamp,
    nonce,
    signature,
    wxPayPublicKeyPem: platformPublicKey,
  });
  if (!verifyResult.ok) {
    logger.warn(`[wxpay webhook] signature rejected: ${verifyResult.reason}`);
    return wxFailure(res, 400, 'SIGN_ERROR', verifyResult.reason);
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return wxFailure(res, 400, 'INVALID_JSON', err.message);
  }

  if (event.event_type !== 'TRANSACTION.SUCCESS') {
    return wxSuccess(res);
  }

  let plain;
  try {
    plain = decryptWxpayResource(event.resource, apiV3Key);
  } catch (err) {
    logger.warn(`[wxpay webhook] resource decrypt failed: ${err.message}`);
    return wxFailure(res, 400, 'DECRYPT_ERROR', err.message);
  }

  if (plain.trade_state !== 'SUCCESS') {
    return wxSuccess(res);
  }

  const transactionId = plain.transaction_id;
  if (!transactionId) {
    return wxFailure(res, 400, 'PARAM_ERROR', 'missing transaction_id');
  }

  const cents = plain.amount && Number(plain.amount.total);
  if (!Number.isFinite(cents) || cents <= 0) {
    return wxFailure(res, 400, 'PARAM_ERROR', 'invalid amount');
  }
  const currency = (plain.amount && plain.amount.currency && String(plain.amount.currency).toLowerCase()) || 'cny';

  const userId = await resolveUserId({
    explicit: plain.attach || extractUserFromOutTradeNo(plain.out_trade_no),
    channel: 'wxpay',
    customerRef: plain.payer && plain.payer.openid,
  });
  if (!userId) {
    logger.warn(`[wxpay webhook] cannot resolve user_id for transaction ${transactionId}`);
    return wxFailure(res, 400, 'USER_UNRESOLVED', 'cannot resolve user');
  }

  const ratio = resolveTopupRatio('wxpay', currency);
  try {
    const result = await creditUserBalance(
      {
        userId,
        amount: cents,
        currency,
        channel: 'wxpay',
        channelRef: transactionId,
        rawPayload: { event, plain },
        ratio,
      },
      { connection: mongoose.connection },
    );
    if (result.idempotent) {
      logger.info(`[wxpay webhook] replay for transaction ${transactionId} — already paid`);
    }
    return wxSuccess(res);
  } catch (err) {
    logger.error(`[wxpay webhook] credit failed for ${transactionId}: ${err.message}`);
    return wxFailure(res, 500, 'CREDIT_ERROR', err.message);
  }
});

function wxSuccess(res) {
  return res.status(200).json({ code: 'SUCCESS', message: '成功' });
}

function wxFailure(res, status, code, message) {
  return res.status(status).json({ code, message });
}

function extractUserFromOutTradeNo(outTradeNo) {
  if (!outTradeNo || typeof outTradeNo !== 'string') return null;
  const m = /^u_([a-f0-9]{24})_/.exec(outTradeNo);
  return m ? m[1] : null;
}

module.exports = router;
