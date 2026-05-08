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
const requireJwtAuth = require('../../middleware/requireJwtAuth');

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

// PAYMENT_STRIPE_INITIATION_HOOK — YC TECH 丁元英 Chat (P4).
//
// Two authenticated POST endpoints that initiate a Stripe Checkout
// flow or open the Customer Portal for self-serve subscription
// management. Both use Stripe's REST API directly (no SDK) — same
// rationale as the webhook signature verifier (see signatures.js).
//
// /create-checkout-session expects { priceId } in the JSON body and
// returns { url } pointing at Stripe's hosted Checkout. The session
// embeds the LibreChat user id as both `client_reference_id` and
// `metadata.user_id` so the existing webhook handler resolves the
// correct user when the payment fires.
//
// /create-portal-session is for users that already have a Stripe
// Customer record (req.user.stripe_customer_id, populated by the
// webhook on first payment). When that field is missing we return
// 409 — the caller should redirect them to Checkout first instead.

router.post('/create-checkout-session', requireJwtAuth, async (req, res) => {
  try {
    const { priceId } = req.body || {};
    if (!priceId || typeof priceId !== 'string') {
      return res.status(400).json({ error: 'priceId required' });
    }
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: 'stripe not configured' });
    }
    const userId = req.user._id ? req.user._id.toString() : req.user.id;
    const domain = process.env.DOMAIN || 'dyy.youchun.tech';
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', `https://${domain}/?stripe_success={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `https://${domain}/?stripe_cancel=1`);
    params.append('client_reference_id', userId);
    params.append('metadata[user_id]', userId);

    const stripeBase = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
    const r = await fetch(`${stripeBase}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      logger.warn(`[stripe checkout] upstream ${r.status}: ${data?.error?.message || ''}`);
      return res.status(502).json({ error: data?.error?.message || 'stripe_error' });
    }
    return res.status(200).json({ url: data.url, id: data.id });
  } catch (err) {
    logger.error(`[stripe checkout] failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/create-portal-session', requireJwtAuth, async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: 'stripe not configured' });
    }
    const customerId = req.user.stripe_customer_id;
    if (!customerId) {
      return res.status(409).json({ error: 'no stripe customer; complete checkout first' });
    }
    const domain = process.env.DOMAIN || 'dyy.youchun.tech';
    const params = new URLSearchParams();
    params.append('customer', customerId);
    params.append('return_url', `https://${domain}/`);

    const stripeBase = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
    const r = await fetch(`${stripeBase}/v1/billing_portal/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      logger.warn(`[stripe portal] upstream ${r.status}: ${data?.error?.message || ''}`);
      return res.status(502).json({ error: data?.error?.message || 'stripe_error' });
    }
    return res.status(200).json({ url: data.url });
  } catch (err) {
    logger.error(`[stripe portal] failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
