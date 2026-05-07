// PAYMENT_WXPAY_HOOK
// YC TECH 丁元英 Chat — P3a stub.
// Webhook handler implementation deferred to P3b (APIv3 AEAD-AES-256-GCM
// resource decrypt, channel_ref idempotency, Payment doc upsert).
// File exists in P3a so `git ls-tree -r HEAD` covers Goal criterion 1
// and so `api/server/index.js` can mount the route at boot without ENOENT.

'use strict';

const express = require('express');

const router = express.Router();

router.post('/webhook', (_req, res) => {
  res.status(501).json({ error: 'not implemented (P3a stub)', channel: 'wxpay' });
});

module.exports = router;
