// PAYMENT_SIGNATURE_HOOK — YC TECH 丁元英 Chat (P3b).
//
// Pure-Node signature verifiers for the three payment channels. We
// deliberately avoid pulling each channel's official SDK because:
//   1. The verification algorithms are short, well-specified primitives
//      (HMAC-SHA256, RSA-PKCS1v1.5-SHA256, AEAD-AES-256-GCM) already in
//      Node's built-in `crypto`.
//   2. SDK installs balloon dependency surface and add another supply-
//      chain step that has to be audited for a 4-line check.
//   3. The mock simulators under `e2e/mocks/` use the same primitives,
//      so test coverage exercises the exact code path that runs in prod.
//
// This module is the single source of truth for crypto; route handlers
// must NOT roll their own.

'use strict';

const crypto = require('crypto');

/**
 * Stripe HMAC-SHA256 signature scheme.
 *
 * The Stripe-Signature header looks like:
 *   t=1614265330,v1=0123abc...,v1=def456...
 * The signed payload is `${t}.${rawBody}` and the secret is the webhook
 * endpoint secret (whsec_...). We accept the request if any v1 candidate
 * matches and the timestamp is within 5 minutes of now (replay window).
 *
 * @param {Buffer|string} rawBody
 * @param {string} signatureHeader
 * @param {string} secret
 * @param {{toleranceSeconds?: number, now?: number}} [opts]
 */
function verifyStripeSignature(rawBody, signatureHeader, secret, opts = {}) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { ok: false, reason: 'missing_header' };
  }
  if (!secret) {
    return { ok: false, reason: 'missing_secret' };
  }
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const parts = signatureHeader.split(',').reduce(
    (acc, segment) => {
      const idx = segment.indexOf('=');
      if (idx <= 0) return acc;
      const key = segment.slice(0, idx).trim();
      const value = segment.slice(idx + 1).trim();
      if (key === 't') acc.t = value;
      else if (key === 'v1') acc.v1.push(value);
      return acc;
    },
    { t: '', v1: [] },
  );
  if (!parts.t || parts.v1.length === 0) {
    return { ok: false, reason: 'malformed_header' };
  }
  const timestamp = parseInt(parts.t, 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  const bodyStr =
    typeof rawBody === 'string' ? rawBody : Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : '';
  const signedPayload = `${parts.t}.${bodyStr}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  for (const candidate of parts.v1) {
    let candidateBuf;
    try {
      candidateBuf = Buffer.from(candidate, 'hex');
    } catch {
      continue;
    }
    if (candidateBuf.length === expectedBuf.length && crypto.timingSafeEqual(candidateBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'signature_mismatch' };
}

function buildStripeSignatureHeader(rawBody, secret, timestamp) {
  const t = String(timestamp ?? Math.floor(Date.now() / 1000));
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signed = `${t}.${bodyStr}`;
  const v1 = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${t},v1=${v1}`;
}

/**
 * Alipay async-notify signature scheme (RSA2 = SHA256withRSA).
 *
 * Algorithm per Alipay docs:
 *   1. Drop `sign` and `sign_type` from params.
 *   2. Drop empty values.
 *   3. Sort keys ASCII-ascending and join as `k1=v1&k2=v2&...`
 *      — note: values are NOT URL-decoded again here because Express's
 *      `urlencoded` parser already decoded them once and Alipay signed
 *      the raw form-encoded representation, which equals the decoded
 *      string when joined this way.
 *   4. Verify the base64-decoded `sign` against the joined string with
 *      RSA public key (Alipay's public key, not the merchant's).
 *
 * @param {Record<string, string>} params  decoded form fields
 * @param {string} alipayPublicKeyPem      Alipay's RSA public key (PEM)
 */
function verifyAlipayNotify(params, alipayPublicKeyPem) {
  if (!params || typeof params !== 'object') {
    return { ok: false, reason: 'missing_params' };
  }
  if (!alipayPublicKeyPem) {
    return { ok: false, reason: 'missing_public_key' };
  }
  const sign = params.sign;
  const signType = params.sign_type || 'RSA2';
  if (!sign) return { ok: false, reason: 'missing_sign' };
  if (signType !== 'RSA2') return { ok: false, reason: `unsupported_sign_type:${signType}` };

  const signed = canonicalAlipayString(params);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signed, 'utf8');
  let signBuf;
  try {
    signBuf = Buffer.from(sign, 'base64');
  } catch {
    return { ok: false, reason: 'invalid_sign_b64' };
  }
  let ok;
  try {
    ok = verifier.verify(alipayPublicKeyPem, signBuf);
  } catch (err) {
    return { ok: false, reason: `verify_threw:${err.message}` };
  }
  return ok ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

function canonicalAlipayString(params) {
  const keys = Object.keys(params).filter(
    (k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null,
  );
  keys.sort();
  return keys.map((k) => `${k}=${params[k]}`).join('&');
}

function signAlipayNotify(params, privateKeyPem) {
  const signed = canonicalAlipayString(params);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signed, 'utf8');
  return signer.sign(privateKeyPem, 'base64');
}

module.exports = {
  verifyStripeSignature,
  buildStripeSignatureHeader,
  verifyAlipayNotify,
  canonicalAlipayString,
  signAlipayNotify,
};
