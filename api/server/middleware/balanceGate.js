// BALANCE_GATE_HOOK — YC TECH 丁元英 Chat (P3b, criterion 4.3).
//
// Reject chat requests with 402 BEFORE we decrypt the user's upstream
// sub-key (attachSubkey) and BEFORE the request can spend any compute.
// LibreChat's existing checkBalance runs *inside* the agent client at
// generation time — it does throw on zero balance, but it does so after
// the request has already been auth'd, scaffolded, and partially routed.
// 4.3 wants a literal pre-flight 402, so we add this gate on the chat
// router specifically.
//
// Behavior:
//   - Reads Balance.tokenCredits for req.user._id.
//   - If the row is missing OR tokenCredits ≤ 0 → 402 with body
//     `{error:"insufficient balance", balance: <num>}`.
//   - Otherwise pass through.
//
// Disable in tests / dev by setting env BALANCE_GATE_DISABLED=true; this
// keeps tests that don't care about billing from having to seed Balance
// rows. Production never sets that flag.

'use strict';

const mongoose = require('mongoose');

async function balanceGate(req, res, next) {
  if (process.env.BALANCE_GATE_DISABLED === 'true') return next();
  const userId = req && req.user && (req.user._id || req.user.id);
  if (!userId) return next();

  try {
    const Balance = mongoose.connection.model('Balance');
    const record = await Balance.findOne({ user: userId }).select('tokenCredits').lean();
    const credits = record && Number.isFinite(record.tokenCredits) ? record.tokenCredits : 0;
    if (credits <= 0) {
      return res.status(402).json({
        error: 'insufficient balance',
        balance: credits,
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = balanceGate;
module.exports.balanceGate = balanceGate;
