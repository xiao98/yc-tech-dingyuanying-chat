// NEWAPI_PROVISIONING_HOOK end-to-end test (P2a, criterion 4.1).
//
// Strategy:
//   1. Stand up a real http.createServer mock pretending to be the New-API
//      admin endpoint. It captures every request and answers with the
//      QuantumNous/new-api shape (success envelope, login returning
//      access_token + id, list returning items[]).
//   2. Mock only `~/models` (in-memory User store), `~/server/services/Config`
//      (returns minimal AppConfig), and side-effect-free helpers. Crypto,
//      provisioning, and HTTP go through the real code path under test.
//   3. Drive `registerUser(...)` directly. Assert:
//        • response is the success envelope
//        • mock saw the expected POST sequence
//        • the in-memory user has `newapi_subkey_encrypted` populated
//        • decryptSubkey() recovers the *exact* token key the mock issued
//   4. Rollback case: mock returns failure on POST /api/user/. Assert
//      registerUser returns status 500 AND the in-memory user store is
//      empty (deleteUserById was triggered).
//
// What is NOT mocked:
//   • node:crypto, the AES-256-GCM round-trip
//   • NewApiClient HTTP calls (real fetch against 127.0.0.1 mock)
//   • provisionUserAndSubkey orchestrator
//   • AuthService.registerUser

const http = require('http');
const crypto = require('crypto');

// ── 1. Test-fixed encryption key. Must be set BEFORE requiring the
// AuthService module so that any eager `loadKey()` calls succeed.
process.env.SUBKEY_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

// ── 2. Module mocks. Keep them as thin as possible.
//
// We avoid mocking @librechat/data-schemas / librechat-data-provider /
// @librechat/api wholesale: the real packages bring transitive constants
// (EModelEndpoint, maxTokensMap, …) that registerUser indirectly needs.
// Mocking them out partially hides bugs and breaks tokens.ts at load time.
// Instead, we only mock the behavioral collaborators (~/models,
// ~/server/services/Config, validators, mailer) and let the real crypto +
// HTTP code paths run.

// In-memory user "table" — provisioning hook calls createUser then updateUser
// then (on failure) deleteUserById. We need all three to round-trip.
// Variable name MUST start with `mock` so Jest's hoisting allowlist accepts
// the cross-reference from inside the jest.mock factory below.
const mockUserStore = new Map();
const mockState = { nextId: 1 };

jest.mock('~/models', () => ({
  findUser: jest.fn(async () => null),
  findToken: jest.fn(),
  countUsers: jest.fn(async () => mockUserStore.size),
  getUserById: jest.fn(),
  findSession: jest.fn(),
  createToken: jest.fn(),
  deleteTokens: jest.fn(),
  deleteSession: jest.fn(),
  createSession: jest.fn(),
  generateToken: jest.fn(),
  generateRefreshToken: jest.fn(),
  // The functions provisioning + AuthService actually exercise:
  createUser: jest.fn(async (userData) => {
    const id = `user-${mockState.nextId++}`;
    const doc = { _id: id, emailVerified: true, ...userData };
    mockUserStore.set(id, doc);
    return doc;
  }),
  updateUser: jest.fn(async (userId, patch) => {
    const existing = mockUserStore.get(userId);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    mockUserStore.set(userId, merged);
    return merged;
  }),
  deleteUserById: jest.fn(async (userId) => {
    const existed = mockUserStore.delete(userId);
    return { deletedCount: existed ? 1 : 0 };
  }),
}));

jest.mock('~/strategies/validators', () => ({
  registerSchema: { safeParse: jest.fn(() => ({ success: true })) },
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(async () => ({
    registration: { allowedDomains: null },
    balance: { enabled: false },
  })),
}));

jest.mock('~/server/utils', () => ({ sendEmail: jest.fn() }));

// We allow the real `@librechat/api` to be required (provisionUserAndSubkey,
// buildClientFromEnv, encryptSubkey, decryptSubkey). The other helpers
// AuthService imports from there are referenced only on the cookie path,
// not on the registration path, so we don't need to stub them.

const { decryptSubkey } = require('@librechat/api');

// ── 3. Mock New-API admin server.
//
// QuantumNous/new-api shape:
//   POST /api/user/      AdminAuth, body {username,password,display_name},
//                        response {success,message} (no id).
//   POST /api/user/login public, body {username,password},
//                        response {success,data:{id,access_token,...}}.
//   POST /api/token/     UserAuth + New-Api-User: <id>,
//                        body {name,remain_quota,...}, response {success,message}.
//   GET  /api/token/     UserAuth + New-Api-User: <id>,
//                        response {success,data:{items:[{name,key,...}]}}.
//
// listTokens has to find the just-created token by name, so we keep the
// most recent token name in closure between the createToken → listTokens
// pair.
function startMockNewApiWithState(opts = {}) {
  const issuedKey = opts.issuedKey ?? `sk-mock-${crypto.randomBytes(8).toString('hex')}`;
  const newApiUserId = opts.newApiUserId ?? 4242;
  const captured = [];
  let lastTokenName = null;
  const overrides = opts.overrides ?? {};

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = body.length ? JSON.parse(body) : null;
      } catch {
        parsed = { __unparsed__: body };
      }
      captured.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsed,
        rawBody: body,
      });

      const send = (status, json) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };

      const path = req.url.split('?')[0];
      const key = `${req.method} ${path}`;

      if (overrides[key]) {
        return overrides[key]({ send, parsed, captured });
      }

      if (req.method === 'POST' && path === '/api/user/') {
        return send(200, { success: true, message: '' });
      }
      if (req.method === 'POST' && path === '/api/user/login') {
        return send(200, {
          success: true,
          message: '',
          data: {
            id: newApiUserId,
            username: parsed?.username,
            access_token: 'mock-user-access-token',
          },
        });
      }
      if (req.method === 'POST' && path === '/api/token/') {
        lastTokenName = parsed?.name ?? null;
        return send(200, { success: true, message: '' });
      }
      if (req.method === 'GET' && path === '/api/token/') {
        return send(200, {
          success: true,
          message: '',
          data: {
            items: lastTokenName ? [{ id: 7, name: lastTokenName, key: issuedKey }] : [],
          },
        });
      }
      send(404, { success: false, message: `mock has no handler for ${key}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        captured,
        baseURL: `http://127.0.0.1:${port}`,
        issuedKey,
        newApiUserId,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('NEWAPI_PROVISIONING_HOOK (P2a, criterion 4.1)', () => {
  let mock;

  beforeEach(() => {
    mockUserStore.clear();
    mockState.nextId = 1;
    process.env.NEWAPI_ADMIN_KEY = 'mock-admin-key';
  });

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
    delete process.env.NEWAPI_ADMIN_BASE_URL;
    delete process.env.NEWAPI_ADMIN_KEY;
  });

  test('happy path: registerUser provisions New-API account, encrypts sub-key, persists on user', async () => {
    mock = await startMockNewApiWithState();
    process.env.NEWAPI_ADMIN_BASE_URL = mock.baseURL;

    // Fresh require so AuthService re-binds the mocked `~/models`.
    jest.resetModules();
    const { registerUser } = require('../AuthService');

    const result = await registerUser({
      email: 'alice@example.com',
      password: 'Hunter2hunter2',
      name: 'Alice',
      username: 'alice',
    });

    expect(result.status).toBe(200);

    // ── New-API mock saw the expected provisioning sequence.
    const calls = mock.captured.map((c) => `${c.method} ${c.url.split('?')[0]}`);
    expect(calls).toEqual([
      'POST /api/user/',
      'POST /api/user/login',
      'POST /api/token/',
      'GET /api/token/',
    ]);

    const createUserCall = mock.captured.find((c) => c.method === 'POST' && c.url === '/api/user/');
    expect(createUserCall.body.username).toMatch(/^lc/);
    expect(createUserCall.body.password.length).toBeGreaterThan(16);
    expect(createUserCall.body.display_name).toBe('yc-alice');
    expect(createUserCall.headers.authorization).toBe('mock-admin-key');

    const tokenCall = mock.captured.find((c) => c.method === 'POST' && c.url === '/api/token/');
    expect(tokenCall.body.name).toMatch(/^librechat-/);
    expect(tokenCall.headers['new-api-user']).toBe(String(mock.newApiUserId));
    expect(tokenCall.headers.authorization).toBe('mock-user-access-token');

    // ── In-memory user has the encrypted sub-key + numeric New-API user id.
    const stored = Array.from(mockUserStore.values()).find((u) => u.email === 'alice@example.com');
    expect(stored).toBeDefined();
    expect(stored.newapi_subkey_encrypted).toMatch(/^gcm:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(stored.newapi_user_id).toBe(mock.newApiUserId);

    // ── Decryption recovers the exact key the mock issued.
    const decrypted = decryptSubkey(stored.newapi_subkey_encrypted);
    expect(decrypted).toBe(mock.issuedKey);
  });

  test('rollback: New-API createUser failure → registerUser 500, no LibreChat user residue', async () => {
    mock = await startMockNewApiWithState({
      overrides: {
        'POST /api/user/': ({ send }) => {
          send(500, { success: false, message: 'simulated upstream error' });
        },
      },
    });
    process.env.NEWAPI_ADMIN_BASE_URL = mock.baseURL;

    jest.resetModules();
    const { registerUser } = require('../AuthService');

    const result = await registerUser({
      email: 'bob@example.com',
      password: 'Hunter2hunter2',
      name: 'Bob',
      username: 'bob',
    });

    expect(result.status).toBe(500);

    // The LibreChat-side createUser ran (we need newUserId for rollback),
    // but deleteUserById fired → store is empty.
    expect(mockUserStore.size).toBe(0);

    // Mock saw exactly one POST /api/user/ and nothing after it.
    const calls = mock.captured.map((c) => `${c.method} ${c.url.split('?')[0]}`);
    expect(calls).toEqual(['POST /api/user/']);
  });

  test('rollback: token-list missing the freshly-created token → 500, no residue', async () => {
    // Force GET /api/token/ to return an empty list. provisionUserAndSubkey
    // throws "token X not found after creation".
    mock = await startMockNewApiWithState({
      overrides: {
        'GET /api/token/': ({ send }) => {
          send(200, { success: true, message: '', data: { items: [] } });
        },
      },
    });
    process.env.NEWAPI_ADMIN_BASE_URL = mock.baseURL;

    jest.resetModules();
    const { registerUser } = require('../AuthService');

    const result = await registerUser({
      email: 'carol@example.com',
      password: 'Hunter2hunter2',
      name: 'Carol',
      username: 'carol',
    });

    expect(result.status).toBe(500);
    expect(mockUserStore.size).toBe(0);
  });

  test('crypto round-trip: encryptSubkey/decryptSubkey is deterministic for the same plaintext under different ivs', async () => {
    // Sanity: 100 round-trips, each with fresh IV, all decrypt to the same plaintext.
    const { encryptSubkey } = require('@librechat/api');
    const plain = 'sk-real-token-XYZ1234567890';
    const blobs = new Set();
    for (let i = 0; i < 100; i++) {
      const blob = encryptSubkey(plain);
      blobs.add(blob);
      expect(decryptSubkey(blob)).toBe(plain);
    }
    // Every encrypt produced a unique blob (proves IV is random).
    expect(blobs.size).toBe(100);
  });

  test('tamper detection: flipping a byte in ciphertext → decryptSubkey throws', async () => {
    const { encryptSubkey } = require('@librechat/api');
    const blob = encryptSubkey('sk-tamper-target');
    const parts = blob.split(':');
    // parts[4] is ciphertext-hex. Flip one nibble.
    const cipherHex = parts[4];
    const flipped = (parseInt(cipherHex[0], 16) ^ 0x1).toString(16) + cipherHex.slice(1);
    parts[4] = flipped;
    const tampered = parts.join(':');
    expect(() => decryptSubkey(tampered)).toThrow();
  });
});
