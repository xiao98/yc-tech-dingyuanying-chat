// PAYMENT_STRIPE_HOOK — YC TECH 丁元英 Chat (P3b).
//
// Verifies the Stripe-Signature HMAC over the raw request body, parses
// the event, and credits the user's balance. Repeated deliveries of the
// same `event.id` are rejected at the database layer (UNIQUE on
// `payment.channel_ref`) and surfaced as idempotent 200 successes so
// Stripe stops retrying.
//
// Supported event types:
//   - checkout.session.completed   (one-shot Checkout payment)
//   - invoice.payment_succeeded    (subscription renewal)
//
// channel_ref selection: `event.id` (`evt_xxx`).
//   - Globally unique per-event in Stripe.
//   - Same payment intent on retry produces the same event id.
//   - Different events for the same Checkout session (e.g. completed +
//     invoice.payment_succeeded for a subscription's first invoice) get
//     different event ids — both *should* credit if both fire, which is
//     the correct behavior for subscription products.

'use strict';

const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { creditUserBalance } = require('@librechat/api');
const mongoose = require('mongoose');
const { verifyStripeSignature } = require('./signatures');
const { resolveTopupRatio } = require('./ratio');
const { resolveUserId } = require('./userlookup');

const router = express.Router();

router.post('/webhook', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'stripe webhook not configured' });
  }
  const sigHeader = req.header('Stripe-Signature') || req.header('stripe-signature');
  const rawBody = req.rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'missing raw body' });
  }
  const verifyResult = verifyStripeSignature(rawBody, sigHeader, secret);
  if (!verifyResult.ok) {
    logger.warn(`[stripe webhook] signature rejected: ${verifyResult.reason}`);
    return res.status(400).json({ error: `signature_invalid:${verifyResult.reason}` });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'invalid_json', detail: err.message });
  }

  const supported = new Set(['checkout.session.completed', 'invoice.payment_succeeded']);
  if (!supported.has(event.type)) {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const obj = event.data && event.data.object;
  if (!obj) {
    return res.status(400).json({ error: 'missing data.object' });
  }
  const amount = pickAmount(event.type, obj);
  const currency = obj.currency || 'usd';
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'invalid_amount' });
  }

  const userId = await resolveUserId({
    explicit: obj.metadata && obj.metadata.user_id,
    channel: 'stripe',
    customerRef: obj.customer || (obj.customer_email && `email:${obj.customer_email}`),
  });
  if (!userId) {
    logger.warn(`[stripe webhook] cannot resolve user_id for event ${event.id}`);
    return res.status(400).json({ error: 'user_unresolved' });
  }

  const ratio = resolveTopupRatio('stripe', currency);
  try {
    const result = await creditUserBalance(
      {
        userId,
        amount,
        currency,
        channel: 'stripe',
        channelRef: event.id,
        rawPayload: event,
        ratio,
      },
      { connection: mongoose.connection },
    );
    if (result.idempotent) {
      logger.info(`[stripe webhook] replay for ${event.id} — already paid`);
      return res.status(200).json({ received: true, idempotent: true });
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    logger.error(`[stripe webhook] credit failed for ${event.id}: ${err.message}`);
    return res.status(500).json({ error: 'credit_failed' });
  }
});

function pickAmount(eventType, obj) {
  if (eventType === 'checkout.session.completed') {
    return Number(obj.amount_total);
  }
  if (eventType === 'invoice.payment_succeeded') {
    return Number(obj.amount_paid);
  }
  return 0;
}

module.exports = router;
