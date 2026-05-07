// NEWAPI_PROVISIONING_HOOK — chat-side consumer (P2a).
//
// Reads the authenticated user's encrypted New-API sub-key from Mongo,
// decrypts it (AES-256-GCM via @librechat/api `decryptSubkey`), and
// attaches the plaintext to `req.upstreamApiKey`. The custom-endpoint
// initializer (`packages/api/src/endpoints/custom/initialize.ts`) reads
// `req.upstreamApiKey` and uses it as the upstream `Authorization` value
// in place of the env-resolved `${YCAPI_KEY}`.
//
// Mounting: chat router uses this AFTER dingYuanyingLock and BEFORE
// buildEndpointOption (which captures `endpoint` from req but does not
// yet resolve the apiKey — that happens in initializeCustom inside the
// agents controller).
//
// Failure mode: if the user has no sub-key (legacy user pre-P2a, or
// provisioning is disabled because env vars are unset), the middleware
// is a no-op and the chat path falls back to the env-level YCAPI_KEY.
// This keeps dev environments without a real New-API instance from
// being broken by the lock-down.

const { decryptSubkey } = require('@librechat/api');
const { getUserById } = require('~/models');

async function attachSubkey(req, _res, next) {
  try {
    const userId = req?.user?._id || req?.user?.id;
    if (!userId) return next();

    const user = await getUserById(userId, 'newapi_subkey_encrypted');
    if (!user || !user.newapi_subkey_encrypted) return next();

    req.upstreamApiKey = decryptSubkey(user.newapi_subkey_encrypted);
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = attachSubkey;
module.exports.attachSubkey = attachSubkey;
