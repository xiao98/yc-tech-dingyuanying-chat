// Unit test for NEWAPI_PROVISIONING_HOOK chat-side consumer (P2a).
//
// Verifies that the middleware:
//   1. Attaches the decrypted New-API sub-key to req.upstreamApiKey on hit.
//   2. Is a silent no-op when the user has no encrypted sub-key (legacy
//      pre-P2a accounts → fall back to env-level YCAPI_KEY in
//      initializeCustom).
//   3. Forwards crypto errors via next(err) (e.g., tampered ciphertext or
//      missing SUBKEY_ENCRYPTION_KEY).

const crypto = require('crypto');
const { encryptSubkey } = require('@librechat/api');

process.env.SUBKEY_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

jest.mock('~/models', () => ({
  getUserById: jest.fn(),
}));

const { getUserById } = require('~/models');
const attachSubkey = require('../attachSubkey');

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('attachSubkey (NEWAPI_PROVISIONING_HOOK consumer)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('hit: attaches decrypted sub-key to req.upstreamApiKey', async () => {
    const plain = 'sk-real-newapi-token-AAA';
    getUserById.mockResolvedValue({
      _id: 'u1',
      newapi_subkey_encrypted: encryptSubkey(plain),
    });

    const req = { user: { _id: 'u1' } };
    const res = makeRes();
    const next = jest.fn();

    await attachSubkey(req, res, next);

    expect(getUserById).toHaveBeenCalledWith('u1', 'newapi_subkey_encrypted');
    expect(req.upstreamApiKey).toBe(plain);
    expect(next).toHaveBeenCalledWith();
  });

  test('miss: no req.user → no-op (next() with no error, no DB call)', async () => {
    const req = {};
    const res = makeRes();
    const next = jest.fn();

    await attachSubkey(req, res, next);

    expect(getUserById).not.toHaveBeenCalled();
    expect(req.upstreamApiKey).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  test('legacy user with no encrypted sub-key → no-op, no req.upstreamApiKey', async () => {
    getUserById.mockResolvedValue({ _id: 'u1' });

    const req = { user: { _id: 'u1' } };
    const res = makeRes();
    const next = jest.fn();

    await attachSubkey(req, res, next);

    expect(req.upstreamApiKey).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  test('tampered ciphertext → next(err)', async () => {
    getUserById.mockResolvedValue({
      _id: 'u1',
      newapi_subkey_encrypted:
        'gcm:v1:00112233445566778899aabb:ffffffffffffffffffffffffffffffff:deadbeef',
    });

    const req = { user: { _id: 'u1' } };
    const res = makeRes();
    const next = jest.fn();

    await attachSubkey(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    // Cross-realm: the Error originates inside the rolled-up @librechat/api
    // bundle and may not pass `instanceof Error` here. Match on shape instead.
    expect(err).toBeTruthy();
    expect(err.constructor.name).toBe('Error');
    expect(typeof err.message).toBe('string');
    expect(req.upstreamApiKey).toBeUndefined();
  });
});
