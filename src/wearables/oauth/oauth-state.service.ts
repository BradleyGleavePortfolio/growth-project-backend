import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { WearableProvider } from '@prisma/client';
import { generatePkcePair, PKCE_CHALLENGE_METHOD } from './pkce.util';

/**
 * PR-HK-1 — OAuth CSRF state + PKCE issuer/consumer for the generic wearable
 * connect flow.
 *
 * Threat model (50-Failures #5/#11 — IDOR / auth-flow integrity):
 *  - The OAuth `state` parameter is a 256-bit cryptographic random token. It
 *    is minted server-side on `oauth/start`, returned to the client opaquely,
 *    echoed by the provider on the callback, and validated BEFORE any token
 *    exchange. This binds the callback to the user who started the flow and
 *    defeats CSRF / login-fixation on the OAuth redirect.
 *  - State is SINGLE-USE: {@link consume} deletes the entry atomically, so a
 *    replayed callback (or a leaked state in a referer header) cannot be used
 *    twice (50-Failures #29 — replay).
 *  - State EXPIRES after a short TTL (default 10 min) — a stale authorization
 *    that the user abandoned cannot be completed later.
 *  - For PKCE-capable providers we also mint a `code_verifier` and store it
 *    next to the state; the verifier never leaves the server and is returned
 *    only to the internal callback handler (never to the client).
 *
 * ## Storage decision: Redis (with in-memory dev/test fallback)
 *
 * The natural store for short-lived, single-use, TTL'd CSRF tokens is a
 * key/value store with native expiry — Redis. The backend already ships
 * `ioredis` (a `package.json` dependency) and uses `REDIS_URL` for the shared
 * throttler store. A Postgres table was rejected on purpose: it would require
 * a `schema.prisma` migration, and `schema.prisma` is under a hard mutex owned
 * by PR-HK-0 (Agent 2 §5) — adding a table here would collide. Redis also
 * gives us native single-key TTL + atomic GETDEL semantics, which is exactly
 * the single-use contract we need.
 *
 * When `REDIS_URL` is unset (local dev / unit tests / CI without Redis) we
 * fall back to a process-local in-memory store with the SAME single-use +
 * expiry semantics, mirroring the throttler's "Redis when configured, memory
 * otherwise" posture. The in-memory store is correct on a single process;
 * production runs with `REDIS_URL` so state is shared across Fly machines.
 */

/** Per-record TTL for an issued OAuth state (ms). 10 minutes (Agent 2 §6). */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Entropy for the opaque state token: 32 bytes → 256 bits. */
const STATE_ENTROPY_BYTES = 32;

/** Redis key namespace so wearable OAuth state never collides with other keys. */
const REDIS_KEY_PREFIX = 'wearables:oauth:state:';

/**
 * The server-side record bound to an issued `state`. Persisted opaquely; the
 * `pkceVerifier` is the secret half of PKCE and is NEVER returned to the
 * client — only the internal callback handler consumes it.
 */
export interface OauthStateRecord {
  userId: string;
  provider: WearableProvider;
  redirectUri: string;
  /** PKCE code_verifier (present only for PKCE-capable providers). */
  pkceVerifier?: string;
}

/** Result of {@link OauthStateService.issue}. */
export interface IssuedOauthState {
  /** Opaque CSRF state token to embed in the provider authorization URL. */
  state: string;
  /** PKCE code_challenge (S256), present only when a verifier was minted. */
  pkceChallenge?: string;
  /** PKCE method, always 'S256' when a challenge is present. */
  pkceMethod?: typeof PKCE_CHALLENGE_METHOD;
}

/**
 * Minimal pluggable backing store. Implemented by an in-memory store (dev/test)
 * and a Redis store (production). `consume` MUST be single-use: it returns the
 * value AND deletes it atomically so a concurrent second consume yields null.
 */
export interface OauthStateStore {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Atomically read-and-delete. Returns null if absent/expired. */
  consume(key: string): Promise<string | null>;
  /** Release any underlying resources (e.g. a Redis connection). */
  dispose?(): Promise<void>;
}

/**
 * Process-local store with TTL + single-use semantics. Correct on one process;
 * used in dev/test and as the no-REDIS_URL fallback.
 */
export class InMemoryOauthStateStore implements OauthStateStore {
  private readonly map = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async consume(key: string): Promise<string | null> {
    const entry = this.map.get(key);
    // Delete first so even an expired hit is single-use and cleaned up.
    this.map.delete(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      return null;
    }
    return entry.value;
  }
}

/** Narrow shape of the ioredis client we depend on (keeps typing local). */
interface MinimalRedis {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
  ): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
}

/**
 * Redis-backed store using native PX (millisecond) TTL and GETDEL for atomic
 * single-use consume. Shared across all app machines via `REDIS_URL`.
 */
export class RedisOauthStateStore implements OauthStateStore {
  constructor(private readonly redis: MinimalRedis) {}

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(key, value, 'PX', ttlMs);
  }

  async consume(key: string): Promise<string | null> {
    // GETDEL (Redis ≥ 6.2) is atomic read-and-delete — the single-use guarantee.
    return this.redis.getdel(key);
  }

  async dispose(): Promise<void> {
    await this.redis.quit();
  }
}

@Injectable()
export class OauthStateService implements OnModuleDestroy {
  private readonly logger = new Logger(OauthStateService.name);
  private readonly store: OauthStateStore;

  /**
   * @param store optional injected store (tests pass an in-memory or fake
   *   store). In production the constructor selects Redis when `REDIS_URL` is
   *   set, otherwise the in-memory fallback.
   */
  constructor(store?: OauthStateStore) {
    this.store = store ?? OauthStateService.resolveStore(this.logger);
  }

  /**
   * Pick a backing store from the environment. Redis when `REDIS_URL` is set
   * (production / shared), in-memory otherwise (dev/test). The `ioredis`
   * import is lazy so dev/test runs that never construct Redis don't pay for
   * it (mirrors the throttler config's lazy-import posture).
   */
  private static resolveStore(logger: Logger): OauthStateStore {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
      logger.warn(
        'REDIS_URL unset — OAuth state uses in-memory store (single-process only). Set REDIS_URL in production so state is shared across machines.',
      );
      return new InMemoryOauthStateStore();
    }
    try {
      // Lazy require so the dependency is only loaded when actually used.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const IORedis = require('ioredis');
      const client = new IORedis(url, {
        // Fail fast rather than queueing if Redis is unreachable — a missing
        // OAuth state must surface as an explicit error, never a silent hang.
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        lazyConnect: false,
      });
      logger.log('OAuth state store: Redis (shared across machines).');
      return new RedisOauthStateStore(client as MinimalRedis);
    } catch (err) {
      logger.error(
        `Failed to construct Redis OAuth state store (${(err as Error).message}); falling back to in-memory.`,
      );
      return new InMemoryOauthStateStore();
    }
  }

  /**
   * Mint a single-use CSRF state (and, when `pkce` is requested, a PKCE
   * verifier/challenge) bound to (userId, provider, redirectUri).
   *
   * @returns the opaque `state` (always) and a `pkceChallenge`/`pkceMethod`
   *   (only when `pkce` is true). The PKCE VERIFIER is intentionally NOT
   *   returned — it stays server-side and is revealed only to {@link consume}.
   */
  async issue(
    userId: string,
    provider: WearableProvider,
    redirectUri: string,
    options: { pkce?: boolean } = {},
  ): Promise<IssuedOauthState> {
    if (!userId) {
      throw new Error('OAuth state issue requires a userId.');
    }
    const state = base64url(randomBytes(STATE_ENTROPY_BYTES));
    const record: OauthStateRecord = { userId, provider, redirectUri };

    const result: IssuedOauthState = { state };
    if (options.pkce) {
      const pair = generatePkcePair();
      record.pkceVerifier = pair.verifier;
      result.pkceChallenge = pair.challenge;
      result.pkceMethod = pair.method;
    }

    await this.store.set(
      this.key(state),
      JSON.stringify(record),
      OAUTH_STATE_TTL_MS,
    );
    return result;
  }

  /**
   * Atomically validate and consume a state returned on the OAuth callback.
   * Single-use: a second consume of the same state (replay) throws. Expired
   * or unknown states throw. The returned record carries the PKCE verifier
   * (if any) for the token exchange.
   *
   * @throws Error with a GENERIC message (no token/secret leak, 50-Failures
   *   #12) when the state is missing, expired, or replayed.
   */
  async consume(state: string): Promise<OauthStateRecord> {
    if (!state || typeof state !== 'string') {
      throw new Error('Invalid OAuth state.');
    }
    const raw = await this.store.consume(this.key(state));
    if (raw === null) {
      // Covers unknown, expired, AND already-consumed (replayed) — all surface
      // as the same opaque rejection so an attacker cannot distinguish them.
      throw new Error('Invalid or expired OAuth state.');
    }
    let parsed: OauthStateRecord;
    try {
      parsed = JSON.parse(raw) as OauthStateRecord;
    } catch {
      throw new Error('Invalid or expired OAuth state.');
    }
    if (!parsed.userId || !parsed.provider) {
      throw new Error('Invalid or expired OAuth state.');
    }
    return parsed;
  }

  async onModuleDestroy(): Promise<void> {
    await this.store.dispose?.();
  }

  private key(state: string): string {
    return `${REDIS_KEY_PREFIX}${state}`;
  }
}

/** base64url(no padding) of a buffer — opaque, URL-safe state token. */
function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
