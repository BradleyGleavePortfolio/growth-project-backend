import { Logger } from '@nestjs/common';
import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../../normalization/normalizer.types';
import {
  ProviderHttpClient,
  ProviderHttpError,
} from '../../http/provider-http-client';
import { WearableAuthModel, WearableConnector } from '../connector.interface';
import { normalizeStravaActivities } from './strava.normalizer';
import {
  STRAVA_SCOPES,
  StravaActivity,
  StravaTokenResponse,
} from './strava.types';

/**
 * PR-HK-2.f — Strava API v3 cloud connector (OAuth2 + backfill + refresh).
 *
 * Provider matrix (AGENT_2_CODING_PLAN §3 PROVIDER_MATRIX):
 *  - Bucket:    H&F only.
 *  - Auth:      OAuth2 (authorization-code), scopes
 *               `activity:read_all,profile:read_all`.
 *  - API base:  https://www.strava.com/api/v3
 *  - Rate:      200 requests / 15 min and 2000 / day. Strava returns the
 *               current usage in `X-RateLimit-Limit` / `X-RateLimit-Usage`
 *               (each is "fifteenMin,daily"). We respect those HEADER values
 *               (header-driven throttle) rather than guessing.
 *  - Backfill:  full history, paged via `athlete/activities?per_page=200&page=N`.
 *  - Webhook:   push subscription (handled by StravaWebhookController).
 *
 * Refresh-token ROTATION: Strava issues a NEW refresh token on every refresh
 * (and on the initial code exchange). The returned `refresh_token` MUST be
 * persisted or the next refresh 400s (50-Failures #1/#12). Both
 * {@link exchangeCode} and {@link refresh} return the rotated token in the
 * {@link TokenSet}; the connection layer (PR-HK-1) KMS-wraps + persists it.
 *
 * All network I/O goes through {@link ProviderHttpClient} (mandatory timeout
 * + capped jittered backoff on 429/5xx, fail-loud on permanent error —
 * #35/#50/#36). Secrets come from env (#18 config over hardcode) and are
 * NEVER logged.
 */

const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API_BASE = 'https://www.strava.com/api/v3';

/** Page size for the activities list — Strava's documented max is 200. */
const BACKFILL_PER_PAGE = 200;
/** Hard cap on pages so a runaway loop can never wedge a worker (#50). */
const BACKFILL_MAX_PAGES = 100;

/**
 * Header-driven throttle thresholds. Strava sends comma-joined
 * "fifteenMinute,daily" pairs in `X-RateLimit-Limit` (e.g. "200,2000") and
 * `X-RateLimit-Usage` (e.g. "150,1200"). When usage is within this fraction
 * of either limit we PAUSE paging (yield the budget to other users) rather
 * than risk a 429 storm. 0.9 ⇒ stop at 90% of either window.
 */
const RATE_LIMIT_PAUSE_FRACTION = 0.9;

/** Env var names (read lazily so a missing secret fails at call time, loud). */
const ENV = {
  clientId: 'STRAVA_CLIENT_ID',
  clientSecret: 'STRAVA_CLIENT_SECRET',
  redirectUri: 'STRAVA_REDIRECT_URI',
} as const;

/** Internal seam so tests can supply env + http without real network/process. */
export interface StravaConnectorDeps {
  http: ProviderHttpClient;
  /** Resolve an env var; defaults to process.env. */
  getEnv: (key: string) => string | undefined;
}

export class StravaConnector implements WearableConnector {
  readonly provider: WearableProvider = WearableProvider.STRAVA;
  readonly authModel: WearableAuthModel = 'oauth2';

  private readonly logger = new Logger(StravaConnector.name);
  private readonly http: ProviderHttpClient;
  private readonly getEnv: (key: string) => string | undefined;

  constructor(deps?: Partial<StravaConnectorDeps>) {
    this.http = deps?.http ?? new ProviderHttpClient();
    this.getEnv = deps?.getEnv ?? ((k) => process.env[k]);
  }

  /**
   * Build the Strava OAuth authorization URL. `state` is the server-minted
   * CSRF/PKCE state (PR-HK-1 owns generation/validation). `approval_prompt=auto`
   * so a returning athlete is not re-prompted unnecessarily.
   */
  buildAuthUrl(_userId: string, state: string): string {
    const clientId = this.requireEnv(ENV.clientId);
    const redirectUri = this.requireEnv(ENV.redirectUri);
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      approval_prompt: 'auto',
      scope: STRAVA_SCOPES.join(','),
      state,
    });
    return `${STRAVA_AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Exchange an authorization code for a {@link TokenSet} (rotates refresh). */
  async exchangeCode(code: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      client_id: this.requireEnv(ENV.clientId),
      client_secret: this.requireEnv(ENV.clientSecret),
      code,
      grant_type: 'authorization_code',
    });
    const token = await this.postToken(body, 'strava.exchangeCode');
    return this.toTokenSet(token);
  }

  /**
   * Refresh an expiring access token. Strava ROTATES the refresh token, so the
   * returned {@link TokenSet.refreshToken} may differ from the one we sent and
   * MUST be persisted (else the next refresh fails). Reads the connection's
   * decrypted refresh token via {@link decryptRefreshToken} (PR-HK-1 supplies
   * the KMS unwrap; here we accept the value off the connection for the unit
   * boundary and never log it).
   */
  async refresh(conn: WearableConnection): Promise<TokenSet> {
    const refreshToken = this.decryptRefreshToken(conn);
    if (!refreshToken) {
      throw new Error(
        `strava.refresh: connection ${conn.id} has no refresh token`,
      );
    }
    return this.refreshAccessToken(refreshToken);
  }

  /**
   * Refresh directly from a refresh-token string. Exposed so PR-HK-1's token
   * service (which owns KMS unwrap) can call it, and so the unit test can
   * assert ROTATION without a connection row.
   */
  async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      client_id: this.requireEnv(ENV.clientId),
      client_secret: this.requireEnv(ENV.clientSecret),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const token = await this.postToken(body, 'strava.refresh');
    return this.toTokenSet(token);
  }

  /**
   * Pull activity history since `since`, paging the athlete activities list.
   * Strava's `after` filter is UNIX seconds. Pages until a short page (< per
   * page) is returned, the page cap is hit, or the header-driven throttle says
   * we are about to exhaust a window. Returns raw records for the normalizer —
   * never N+1s the ingestion lane (#21): one HTTP call per page, all records
   * batched.
   *
   * Auth: uses the connection's CURRENT access token. The caller (sync worker)
   * is responsible for refreshing first if it is expired; backfill itself does
   * not refresh to keep the seam single-purpose.
   */
  async backfill(conn: WearableConnection, since: Date): Promise<RawRecord[]> {
    const accessToken = this.accessTokenFor(conn);
    const afterUnix = Math.floor(since.getTime() / 1000);
    const records: RawRecord[] = [];

    for (let page = 1; page <= BACKFILL_MAX_PAGES; page++) {
      const url =
        `${STRAVA_API_BASE}/athlete/activities` +
        `?per_page=${BACKFILL_PER_PAGE}&page=${page}&after=${afterUnix}`;

      const res = await this.http.request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        label: 'strava.backfill',
      });

      const activities = (await res.json()) as StravaActivity[];
      if (!Array.isArray(activities) || activities.length === 0) {
        break; // no more history
      }

      for (const a of activities) {
        records.push({
          id: a?.id !== undefined ? String(a.id) : undefined,
          provider: WearableProvider.STRAVA,
          payload: a,
        });
      }

      // A short page means we have reached the end of history.
      if (activities.length < BACKFILL_PER_PAGE) break;

      // Header-driven throttle: if we are near either rate window, stop early
      // and let a later sync resume. We do NOT spin-wait (no worker wedge).
      if (this.shouldPauseForRateLimit(res)) {
        this.logger.warn(
          `strava.backfill: pausing at page ${page} — approaching rate limit`,
        );
        break;
      }
    }

    return records;
  }

  /** Map Strava raw records to canonical samples (delegates to normalizer). */
  normalize(raw: RawRecord[]): NormalizedSample[] {
    // The connector-level normalize() needs the subject user + connection to
    // build samples. Strava raw records do not carry them, so the sync worker
    // calls normalizeStravaActivities(userId, connectionId, raw) directly with
    // the connection context. This interface method is kept for contract
    // completeness and throws if used without that context, rather than
    // silently emitting orphaned samples (#36 fail-loud, #8 validation).
    if (raw.length === 0) return [];
    throw new Error(
      'strava.normalize: call normalizeStravaActivities(userId, connectionId, raw) ' +
        'with the connection context — Strava raw records carry no subject user id',
    );
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Decide whether to pause paging based on Strava's rate-limit headers. Reads
   * `X-RateLimit-Limit` ("fifteenMin,daily") and `X-RateLimit-Usage`
   * ("usedFifteen,usedDaily"); pauses if EITHER window is ≥
   * {@link RATE_LIMIT_PAUSE_FRACTION} of its limit. Missing/malformed headers
   * are treated as "do not pause" (the HTTP client's 429 backoff is the
   * backstop).
   */
  shouldPauseForRateLimit(res: Response): boolean {
    const limit = this.parsePair(res.headers.get('x-ratelimit-limit'));
    const usage = this.parsePair(res.headers.get('x-ratelimit-usage'));
    if (!limit || !usage) return false;

    const nearWindow = (used: number, max: number): boolean =>
      max > 0 && used / max >= RATE_LIMIT_PAUSE_FRACTION;

    return (
      nearWindow(usage.short, limit.short) || nearWindow(usage.long, limit.long)
    );
  }

  /** Parse a "a,b" header pair into {short:a, long:b}; null if malformed. */
  private parsePair(
    raw: string | null,
  ): { short: number; long: number } | null {
    if (!raw) return null;
    const parts = raw.split(',').map((p) => Number(p.trim()));
    if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
    return { short: parts[0], long: parts[1] };
  }

  /** POST the token endpoint and parse the JSON token response (loud on error). */
  private async postToken(
    body: URLSearchParams,
    label: string,
  ): Promise<StravaTokenResponse> {
    let res: Response;
    try {
      res = await this.http.request(STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        label,
      });
    } catch (err) {
      // ProviderHttpError already classified (permanent vs exhausted); we add
      // the connector label and rethrow — never swallow (#36). No secret is in
      // the message (body is not interpolated).
      if (err instanceof ProviderHttpError) {
        throw new Error(`${label}: token request failed (status=${err.status})`);
      }
      throw err;
    }
    const json = (await res.json()) as StravaTokenResponse;
    if (!json?.access_token || !json?.refresh_token) {
      throw new Error(`${label}: token response missing access/refresh token`);
    }
    return json;
  }

  /** Build a {@link TokenSet} from a Strava token response (rotated refresh). */
  private toTokenSet(token: StravaTokenResponse): TokenSet {
    return {
      refreshToken: token.refresh_token,
      accessToken: token.access_token,
      accessTokenExpiresAt:
        typeof token.expires_at === 'number'
          ? new Date(token.expires_at * 1000)
          : undefined,
      scopes: [...STRAVA_SCOPES],
      externalAccountId:
        token.athlete?.id !== undefined ? String(token.athlete.id) : undefined,
    };
  }

  /**
   * Read the connection's decrypted refresh token. PR-HK-1 owns the KMS unwrap
   * and passes the connection with a transient decrypted field; in this build
   * boundary we accept whatever the connection exposes. Never logged.
   */
  private decryptRefreshToken(conn: WearableConnection): string | null {
    // The transient decrypted token (if PR-HK-1's token service attached one)
    // or, in tests, a plain value on the row. We deliberately do NOT decrypt
    // here (no KMS dependency in the connector) — the sync layer supplies it.
    const transient = (conn as { decryptedRefreshToken?: string })
      .decryptedRefreshToken;
    return transient ?? null;
  }

  /** Read the connection's current access token for an API call. */
  private accessTokenFor(conn: WearableConnection): string {
    const token = (conn as { decryptedAccessToken?: string })
      .decryptedAccessToken;
    if (!token) {
      throw new Error(
        `strava.backfill: connection ${conn.id} has no access token`,
      );
    }
    return token;
  }

  /** Read a required env var, failing loud (with the var NAME, not value). */
  private requireEnv(key: string): string {
    const value = this.getEnv(key);
    if (!value) {
      throw new Error(`strava: required env var ${key} is not set`);
    }
    return value;
  }
}
