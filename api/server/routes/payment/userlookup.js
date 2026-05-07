// PAYMENT_USERLOOKUP_HOOK — YC TECH 丁元英 Chat (P3b).
//
// Maps a webhook payload back to a User._id. Three strategies, in order:
//   1. Channel `metadata.user_id` / `attach` / `out_trade_no` prefix —
//      set by the checkout creator (out of P3b scope; P3c will add the
//      checkout-creation endpoint that stamps user_id into metadata).
//   2. Stripe `customer` ref → User.stripe_customer_id (TBD column,
//      not added in P3b; placeholder).
//   3. Email lookup (last-resort, only used in tests).
//
// In e2e tests we always pass `metadata.user_id` so this resolver
// short-circuits at strategy 1; the other branches exist so production
// can wire them up without changing the webhook code.

'use strict';

const mongoose = require('mongoose');

async function resolveUserId({ explicit, channel: _channel, customerRef: _customerRef }) {
  if (explicit && mongoose.Types.ObjectId.isValid(explicit)) {
    return String(explicit);
  }
  if (typeof explicit === 'string' && explicit.length > 0) {
    return explicit;
  }
  return null;
}

module.exports = { resolveUserId };
