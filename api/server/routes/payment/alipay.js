// PAYMENT_ALIPAY_HOOK
// YC TECH 丁元英 Chat — P3a stub.
// Webhook handler implementation deferred to P3b (signature verification,
// channel_ref idempotency, Payment doc upsert + status transition).
// File exists in P3a so `git ls-tree -r HEAD` covers Goal criterion 1
// and so `api/server/index.js` can mount the route at boot without ENOENT.

'use strict';

const express = require('express');

const router = express.Router();

router.post('/webhook', (_req, res) => {
  res.status(501).json({ error: 'not implemented (P3a stub)', channel: 'alipay' });
});

module.exports = router;
