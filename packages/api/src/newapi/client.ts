/**
 * Thin HTTP client for New-API admin + per-user provisioning.
 *
 * Why this lives in a single file (vs split into endpoints/auth/etc.):
 *   the only consumer is `provisionUserAndSubkey` on the registration hook;
 *   each call site here is a single request. Splitting would scatter the
 *   New-API contract across files for no maintenance benefit.
 *
 * Real-world New-API contract notes (verified against
 * https://github.com/QuantumNous/new-api as of P2a):
 *   - POST /api/user/                  AdminAuth, body {username, password,
 *                                                       display_name, role},
 *                                      response {success, message}  (NO id)
 *   - GET  /api/user/search?keyword=…  AdminAuth,
 *                                      response paginated user list. We
 *                                      use this to look up the freshly-
 *                                      created user's numeric `id`.
 *   - POST /api/user/login             public-ish (rate limited / turnstile),
 *                                      response {success, data: {access_token,
 *                                                                id,
 *                                                                ...}}.
 *                                      Provides the per-user access_token
 *                                      we need for the token endpoints
 *                                      (which require UserAuth, not Admin).
 *   - POST /api/token/                 UserAuth + `New-Api-User: <user.id>`,
 *                                      body {name, remain_quota,
 *                                            unlimited_quota,
 *                                            model_limits_enabled,
 *                                            expired_time},
 *                                      response {success, message} (NO key).
 *   - GET  /api/token/                 UserAuth + `New-Api-User: <user.id>`,
 *                                      response {success, data: {items: [
 *                                            {id, name, key, ...}, …]}}.
 *                                      We list and find by name to extract
 *                                      the freshly-generated `key`.
 *
 * AddToken's response intentionally omits the key (security hardening: the
 * key is meant to be displayed in the UI's create-success modal which
 * subsequently fetches the list). For headless provisioning we work
 * around this by listing immediately after creation.
 */

export interface NewApiClientConfig {
  /** Base URL of the New-API admin API, e.g. https://api.example.com */
  baseURL: string;
  /** Admin access token used for /api/user/ + /api/user/search calls. */
  adminToken: string;
  /** Optional fetch override (used by tests; defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
}

export interface NewApiUser {
  id: number;
  username: string;
  display_name?: string;
  access_token?: string | null;
}

export interface NewApiTokenItem {
  id: number;
  name: string;
  key: string;
  remain_quota?: number;
  unlimited_quota?: boolean;
}

interface NewApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function ensureSuccess<T>(envelope: NewApiEnvelope<T>, what: string): T {
  if (!envelope || envelope.success !== true) {
    const msg = envelope && envelope.message ? envelope.message : 'no message';
    throw new Error(`New-API ${what} failed: ${msg}`);
  }
  return envelope.data as T;
}

export class NewApiClient {
  private readonly baseURL: string;
  private readonly adminToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: NewApiClientConfig) {
    if (!config.baseURL) throw new Error('NewApiClient: baseURL required');
    if (!config.adminToken) throw new Error('NewApiClient: adminToken required');
    this.baseURL = config.baseURL.replace(/\/$/, '');
    this.adminToken = config.adminToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<NewApiEnvelope<T>> {
    const url = `${this.baseURL}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: NewApiEnvelope<T>;
      try {
        parsed =
          text.length > 0
            ? (JSON.parse(text) as NewApiEnvelope<T>)
            : ({ success: false, message: 'empty body' } as NewApiEnvelope<T>);
      } catch {
        throw new Error(
          `New-API ${method} ${path} returned non-JSON body (status ${res.status}): ${text.slice(0, 200)}`,
        );
      }
      if (!res.ok) {
        const msg = parsed?.message ?? `HTTP ${res.status}`;
        throw new Error(`New-API ${method} ${path} HTTP ${res.status}: ${msg}`);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /api/user/ — admin creates a user. Response is {success, message}. */
  async createUser(input: {
    username: string;
    password: string;
    display_name?: string;
  }): Promise<void> {
    const envelope = await this.request<unknown>('POST', '/api/user/', {
      headers: { Authorization: this.adminToken },
      body: {
        username: input.username,
        password: input.password,
        display_name: input.display_name ?? input.username,
      },
    });
    ensureSuccess(envelope, 'createUser');
  }

  /**
   * GET /api/user/search?keyword=… — admin lookup. Used to recover the
   * numeric user.id after createUser (which doesn't return it).
   */
  async findUserByUsername(username: string): Promise<NewApiUser> {
    const envelope = await this.request<{ items?: NewApiUser[] } | NewApiUser[]>(
      'GET',
      `/api/user/search?keyword=${encodeURIComponent(username)}`,
      { headers: { Authorization: this.adminToken } },
    );
    const data = ensureSuccess(envelope, 'findUserByUsername');
    const items = unwrapItems<NewApiUser>(data);
    const exact = items.find((u) => u && u.username === username);
    if (!exact) {
      throw new Error(`New-API findUserByUsername: ${username} not found in search results`);
    }
    return exact;
  }

  /**
   * POST /api/user/login — get an access_token for the freshly-created
   * user so we can call /api/token/ on their behalf (UserAuth).
   */
  async loginAsUser(input: {
    username: string;
    password: string;
  }): Promise<{ accessToken: string; userId: number }> {
    const envelope = await this.request<{ access_token?: string; id?: number } & NewApiUser>(
      'POST',
      '/api/user/login',
      { body: { username: input.username, password: input.password } },
    );
    const data = ensureSuccess(envelope, 'loginAsUser');
    if (!data?.access_token || typeof data.id !== 'number') {
      throw new Error(
        'New-API loginAsUser: response missing access_token or id (deployment may have access_token disabled — see model.User.AccessToken)',
      );
    }
    return { accessToken: data.access_token, userId: data.id };
  }

  /**
   * POST /api/token/ — create a token for the user identified by
   * `userId`. Auth is the user's access_token + `New-Api-User: <userId>`.
   * AddToken's response is {success, message} with no key, so we fetch
   * via listTokens immediately after.
   */
  async createToken(input: {
    userAccessToken: string;
    userId: number;
    name: string;
    remainQuota?: number;
    unlimitedQuota?: boolean;
    expiredTime?: number;
  }): Promise<void> {
    const envelope = await this.request<unknown>('POST', '/api/token/', {
      headers: {
        Authorization: input.userAccessToken,
        'New-Api-User': String(input.userId),
      },
      body: {
        name: input.name,
        remain_quota: input.remainQuota ?? 500_000,
        unlimited_quota: input.unlimitedQuota ?? false,
        model_limits_enabled: false,
        expired_time: input.expiredTime ?? -1,
      },
    });
    ensureSuccess(envelope, 'createToken');
  }

  /**
   * GET /api/token/?p=0&size=… — list the user's own tokens. Used to
   * extract the freshly-generated `key` for a just-created token.
   */
  async listTokens(input: { userAccessToken: string; userId: number }): Promise<NewApiTokenItem[]> {
    const envelope = await this.request<{ items?: NewApiTokenItem[] } | NewApiTokenItem[]>(
      'GET',
      '/api/token/?p=0&size=100',
      {
        headers: {
          Authorization: input.userAccessToken,
          'New-Api-User': String(input.userId),
        },
      },
    );
    const data = ensureSuccess(envelope, 'listTokens');
    return unwrapItems<NewApiTokenItem>(data);
  }
}

/**
 * New-API list endpoints sometimes return `data:[…]` and sometimes
 * `data:{items:[…], total:N}`. Normalize both shapes into a flat array.
 */
function unwrapItems<T>(data: { items?: T[] } | T[] | undefined | null): T[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray((data as { items?: T[] }).items)) {
    return (data as { items?: T[] }).items as T[];
  }
  return [];
}
