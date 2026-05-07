/**
 * Per-user New-API sub-key encryption (P2a).
 *
 * Why a new module instead of reusing `encryptV3` (AES-256-CTR) from
 * `@librechat/data-schemas/crypto`:
 *   - CTR has no integrity / authentication tag. A flipped ciphertext bit
 *     decrypts to a flipped plaintext bit. For a credential we round-trip
 *     into an outgoing Authorization header, MAC integrity matters: a
 *     corrupted DB record must fail loud at decrypt time, not silently
 *     produce a malformed bearer token.
 *   - GCM provides AEAD (Authenticated Encryption with Associated Data).
 *     Tag mismatch -> `decryptSubkey` throws.
 *
 * Format: `gcm:v1:<iv hex>:<authTag hex>:<ciphertext hex>`
 *   - iv: 12 bytes (NIST-recommended GCM IV size)
 *   - authTag: 16 bytes
 *   - ciphertext: variable
 *
 * Key source: `process.env.SUBKEY_ENCRYPTION_KEY` — 64-char hex (32 bytes).
 * The key is read lazily on every call so test setups (and key rotation
 * down the road) can swap it via `process.env` without re-importing.
 */

import * as crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'gcm:v1';

function loadKey(): Buffer {
  const hex = process.env.SUBKEY_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'SUBKEY_ENCRYPTION_KEY is not set. Generate one with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `SUBKEY_ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${buf.length} bytes`,
    );
  }
  return buf;
}

export function encryptSubkey(plain: string): string {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('encryptSubkey: plain must be a non-empty string');
  }
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [PREFIX, iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(
    ':',
  );
}

export function decryptSubkey(payload: string): string {
  if (typeof payload !== 'string') {
    throw new Error('decryptSubkey: payload must be a string');
  }
  const parts = payload.split(':');
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== PREFIX) {
    throw new Error(`decryptSubkey: not a ${PREFIX} payload`);
  }
  const iv = Buffer.from(parts[2], 'hex');
  const authTag = Buffer.from(parts[3], 'hex');
  const ciphertext = Buffer.from(parts[4], 'hex');
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('decryptSubkey: malformed iv or authTag length');
  }
  const key = loadKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

export const SUBKEY_ENCRYPTION = {
  algorithm: ALGORITHM,
  ivLength: IV_LENGTH,
  authTagLength: AUTH_TAG_LENGTH,
  prefix: PREFIX,
} as const;
