// PAYMENT_STRIPE_HOOK
// YC TECH 丁元英 Chat — P3a stub.
// Webhook handler implementation deferred to P3b (Stripe-Signature header
// verification with STRIPE_WEBHOOK_SECRET, channel_ref idempotency on
// event.id, Payment doc upsert).
// File exists in P3a so `git ls-tree -r HEAD` covers Goal criterion 1
// and so `api/server/index.js` can mount the route at boot without ENOENT.

'use strict';

const express = require('express');

const router = express.Router();

router.post('/webhook', (_req, res) => {
  res.status(501).json({ error: 'not implemented (P3a stub)', channel: 'stripe' });
});

module.exports = router;
