/**
 * NEWAPI_PROVISIONING_HOOK
 * Per-LibreChat-user New-API provisioning orchestrator (P2a, criterion 4.1).
 *
 * Called from `api/server/services/AuthService.js#registerUser` after the
 * LibreChat user record is persisted. End state on success: a freshly-created
 * New-API user + a per-user token whose `key` is encrypted and returned to
 * the caller for storage on the LibreChat user document
 * (`newapi_subkey_encrypted`).
 *
 * Why orchestrated here vs at the chat call site:
 *   - One per-user provisioning call vs one per-message call. Lazy
 *     provisioning would re-run the network round-trips (and worse, retry
 *     them under chat latency) on every cold user.
 *   - Failure semantics: if provisioning fails the LibreChat registration
 *     must roll back. Doing this at chat time leaves the user in a half-
 *     baked state — registration "succeeds" but every chat 500s.
 *
 * Flow:
 *   1. Generate a strong random password for the New-API account. The
 *      LibreChat user never sees or uses this password — it only exists
 *      so we can `loginAsUser` to obtain an access_token.
 *   2. POST /api/user/                       (admin) — create the account.
 *   3. POST /api/user/login                  (public) — obtain access_token + id.
 *   4. POST /api/token/                      (user)  — create the sub-key.
 *   5. GET  /api/token/                      (user)  — list and find by name.
 *   6. Encrypt the key and return.
 *
 * Step (3) bypasses the admin-token-only assumption from the original P2a
 * spec — see `client.ts` header for the full contract pivot.
 */

import * as crypto from 'node:crypto';
import { encryptSubkey } from '~/crypto/subkey';
import { NewApiClient } from './client';
import type { NewApiClientConfig } from './client';

export interface ProvisionInput {
  /** LibreChat-side user identifier; used to namespace the New-API username
   *  and the token name so collisions on the New-API side are impossible. */
  librechatUserId: string;
  /** LibreChat user's email; used as display_name on the New-API account
   *  for human-friendly identification in the New-API admin UI. */
  email: string;
}

export interface ProvisionOutput {
  /** AES-256-GCM encrypted New-API token key, ready to write into
   *  `user.newapi_subkey_encrypted`. */
  encryptedSubkey: string;
  /** New-API numeric user id; written to user.newapi_user_id for future
   *  admin operations (quota top-ups, suspend, etc.). */
  newApiUserId: number;
  /** Token name used on the New-API side (so we can find/rotate later). */
  tokenName: string;
}

const PASSWORD_BYTES = 24;
const TOKEN_NAME_PREFIX = 'librechat-';

/**
 * Build a stable, unique-per-LibreChat-user New-API username. We encode
 * the LibreChat user id directly so cleanup tooling can reverse-map.
 * Lowercase + alphanumeric to satisfy New-API username validators.
 */
function buildNewApiUsername(librechatUserId: string): string {
  const sanitized = librechatUserId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return `lc${sanitized.slice(-24)}`;
}

function buildTokenName(librechatUserId: string): string {
  return `${TOKEN_NAME_PREFIX}${librechatUserId}`;
}

function generatePassword(): string {
  return crypto.randomBytes(PASSWORD_BYTES).toString('base64url');
}

export interface ProvisionerDeps {
  /** Allows tests to inject a configured client; production caller passes
   *  a fresh client built from env. */
  client: NewApiClient;
}

export async function provisionUserAndSubkey(
  input: ProvisionInput,
  deps: ProvisionerDeps,
): Promise<ProvisionOutput> {
  const username = buildNewApiUsername(input.librechatUserId);
  const password = generatePassword();
  const tokenName = buildTokenName(input.librechatUserId);
  const { client } = deps;

  await client.createUser({
    username,
    password,
    display_name: input.email,
  });

  const session = await client.loginAsUser({ username, password });

  await client.createToken({
    userAccessToken: session.accessToken,
    userId: session.userId,
    name: tokenName,
  });

  const tokens = await client.listTokens({
    userAccessToken: session.accessToken,
    userId: session.userId,
  });
  const created = tokens.find((t) => t.name === tokenName);
  if (!created || !created.key) {
    throw new Error(
      `NEWAPI_PROVISIONING_HOOK: token "${tokenName}" not found after creation (listed ${tokens.length} tokens)`,
    );
  }

  return {
    encryptedSubkey: encryptSubkey(created.key),
    newApiUserId: session.userId,
    tokenName,
  };
}

export function buildClientFromEnv(overrides?: Partial<NewApiClientConfig>): NewApiClient {
  const baseURL = overrides?.baseURL ?? process.env.NEWAPI_ADMIN_BASE_URL;
  const adminToken = overrides?.adminToken ?? process.env.NEWAPI_ADMIN_KEY;
  if (!baseURL) {
    throw new Error('NEWAPI_ADMIN_BASE_URL is not set');
  }
  if (!adminToken) {
    throw new Error('NEWAPI_ADMIN_KEY is not set');
  }
  return new NewApiClient({
    baseURL,
    adminToken,
    fetchImpl: overrides?.fetchImpl,
    timeoutMs: overrides?.timeoutMs,
  });
}

export const NEWAPI_PROVISIONING_HOOK = 'NEWAPI_PROVISIONING_HOOK';
