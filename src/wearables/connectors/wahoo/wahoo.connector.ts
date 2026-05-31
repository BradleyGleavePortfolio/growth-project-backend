import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../../normalization/normalizer.types';
import {
  ProviderEvent,
  RawWebhookRequest,
  WearableAuthModel,
  WearableConnector,
} from '../connector.interface';
import {
  ProviderHttpClient,
  ProviderHttpError,
} from '../../http/provider-http-client';
import { PrismaService } from '../../../prisma.service';
import { normalizeWahoo, WahooRawPayload } from './wahoo.normalizer';
import {
  WAHOO_SCOPES,
  WahooTokenResponse,
  WahooWebhookEvent,
  WahooWorkout,
  WahooWorkoutsListResponse,
} from './wahoo.types';

/**
 * PR-HK-2.h — Wahoo Cloud API connector (OAuth2 + webhook + backfill).
 *
 * Implements the PR-HK-0 {@link WearableConnector} contract. All cloud calls
 * route through {@link ProviderHttpClient} so timeout + capped jittered
 * backoff apply uniformly (#35/#50). OAuth client credentials are read from
 * env (`WAHOO_CLIENT_ID` / `WAHOO_CLIENT_SECRET` / `WAHOO_REDIRECT_URI`) —
 * never hardcoded, never logged (#1/#12).
 *
 * Endpoints (verified against https://cloud-api.wahooligan.com, May 2026):
 *  - authorize  https://api.wahooligan.com/oauth/authorize
 *  - token      https://api.wahooligan.com/oauth/token
 *  - data       https://api.wahooligan.com/v1/workouts
 *
 * Refresh-token ROTATION: Wahoo issues a NEW refresh token on every refresh
 * (and on the initial code exchange) and revokes the prior pair once the new
 * access token is used. The returned `refresh_token` MUST be persisted or the
 * next refresh fails (50-Failures #1/#12). Both {@link exchangeCode} and
 * {@link refresh} return the rotated token in the {@link TokenSet}.
 *
 * Bucket: HEALTH & FITNESS only (workout duration / distance / avg HR).
 *
 * Webhook signature: Wahoo's public docs use a shared `webhook_token` field as
 * the authenticity control. The binding PR brief ALSO mandates an HMAC-SHA256
 * signature, so {@link verifyWebhook} requires BOTH: a constant-time
 * HMAC-SHA256 over (`timestamp` + rawBody) keyed by the webhook secret AND a
 * matching `webhook_token`. It fails CLOSED if the secret/token are not
 * configured (audit pattern #5) and verifies on the UNPARSED bytes
 * (Stripe-pattern raw-body HMAC) so re-serialising JSON can never break it.
 */

const WAHOO_AUTHORIZE_URL = 'https://api.wahooligan.com/oauth/authorize';
const WAHOO_TOKEN_URL = 'https://api.wahooligan.com/oauth/token';
const WAHOO_API_BASE = 'https://api.wahooligan.com/v1';

/** Page size for the workouts list. */
const BACKFILL_PER_PAGE = 100;
/** Hard cap on pages so a runaway loop can never wedge a worker (#50). */
const BACKFILL_MAX_PAGES = 100;

/** Env var names (read lazily so a missing secret fails at call time, loud). */
const ENV = {
  clientId: 'WAHOO_CLIENT_ID',
  clientSecret: 'WAHOO_CLIENT_SECRET',
  redirectUri: 'WAHOO_REDIRECT_URI',
  /** Dedicated webhook HMAC secret; falls back to the client secret. */
  webhookSecret: 'WAHOO_WEBHOOK_SECRET',
  /** Shared `webhook_token` Wahoo echoes on every delivery. */
  webhookToken: 'WAHOO_WEBHOOK_TOKEN',
} as const;

/**
 * Hash a value to a short, non-reversible token for structured logs. Used so
 * we never log a raw `user_id` / `external_account_id` (audit pattern #3).
 */
export function hashForLog(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Stable, deterministic dedup key for a normalized Wahoo sample, used for
 * rawRef provenance. `sha256("wahoo:" + user + metric + startAt + value)`.
 * The ingestion lane owns the authoritative sample `dedup_key`; this helper
 * gives the connector a consistent provenance fingerprint.
 */
export function computeWahooDedupKey(
  userId: string,
  metric: string,
  startAt: Date,
  value: number,
): string {
  return createHash('sha256')
    .update(`wahoo:${userId}:${metric}:${startAt.toISOString()}:${value}`)
    .digest('hex');
}

/**
 * Strip token-like secrets from an error message before it is persisted to
 * `WearableConnection.last_error` or logged (#1/#12, audit pattern #7).
 * Connector-scoped (no cross-file change); exported so the spec can unit-test
 * the redaction directly.
 */
export function redactErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();

  const redacted = (raw ?? '')
    .replace(
      /\b(access_token|refresh_token|client_secret|client_id|token|code)=[^&\s"',]+/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /(authorization\s*[:=]\s*)(Bearer|Basic)\s+[^\s"',]+/gi,
      '$1$2 [REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/g, 'Basic [REDACTED]')
    .replace(
      /\b(authorization)(\s*[:=]\s*)(?!Bearer\b|Basic\b|\[REDACTED\])[^\s"',]+/gi,
      '$1$2[REDACTED]',
    );

  return redacted.slice(0, 500) || 'unknown';
}

@Injectable()
export class WahooConnector implements WearableConnector {
  readonly provider: WearableProvider = WearableProvider.WAHOO;
  readonly authModel: WearableAuthModel = 'oauth2';

  private readonly logger = new Logger(WahooConnector.name);

  /**
   * `prisma` is optional so the pure OAuth/normalize/verify unit tests can
   * construct the connector with just an HTTP client. When present (the DI
   * path under {@link WahooModule}), backfill/refresh provider outages mark
   * the connection `status='error'` with a REDACTED `last_error` before
   * rethrowing (fail-loud + fail-explicit). When absent, the failure still
   * rethrows — we simply skip the status write.
   */
  constructor(
    private readonly http: ProviderHttpClient,
    private readonly prisma?: PrismaService,
  ) {}

  // ── OAuth ──────────────────────────────────────────────────────────────

  /**
   * Build the Wahoo OAuth authorization URL. `state` is the server-minted
   * CSRF state (PR-HK-1 owns generation/validation). `redirect_uri` is read
   * from env so it is environment-correct without a code change.
   */
  buildAuthUrl(_userId: string, state: string): string {
    const clientId = this.requireEnv(ENV.clientId);
    const redirectUri = this.requireEnv(ENV.redirectUri);
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: WAHOO_SCOPES.join(' '),
      state,
    });
    return `${WAHOO_AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Exchange an authorization `code` for a {@link TokenSet} (rotates refresh). */
  async exchangeCode(code: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      client_id: this.requireEnv(ENV.clientId),
      client_secret: this.requireEnv(ENV.clientSecret),
      redirect_uri: this.requireEnv(ENV.redirectUri),
      grant_type: 'authorization_code',
      code,
    });
    const token = await this.postToken(body, 'wahoo.exchangeCode');
    return this.toTokenSet(token);
  }

  /**
   * Refresh an expiring access token. Wahoo ROTATES the refresh token, so the
   * returned {@link TokenSet.refreshToken} may differ from the one we sent and
   * MUST be persisted (else the next refresh fails). On a provider outage /
   * invalid_grant the connection is marked in error (redacted) then the error
   * is rethrown so PR-HK-1's token lane can react (re-consent / disable).
   */
  async refresh(conn: WearableConnection): Promise<TokenSet> {
    try {
      return await this.refreshInner(conn);
    } catch (err) {
      await this.markConnectionError(conn, err, 'wahoo.refresh');
      throw err;
    }
  }

  private async refreshInner(conn: WearableConnection): Promise<TokenSet> {
    const refreshToken =
      (conn as { refresh_token?: string }).refresh_token ??
      (conn as unknown as { decryptedRefreshToken?: string })
        .decryptedRefreshToken;
    if (!refreshToken) {
      throw new Error('wahoo.refresh: connection has no refresh token');
    }
    const body = new URLSearchParams({
      client_id: this.requireEnv(ENV.clientId),
      client_secret: this.requireEnv(ENV.clientSecret),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const token = await this.postToken(body, 'wahoo.refresh');
    // Fail loud if Wahoo (which rotates) omitted the new refresh token rather
    // than silently persisting an empty one; fall back is intentional only if
    // present on the response.
    return this.toTokenSet(token, refreshToken);
  }

  // ── Backfill ─────────────────────────────────────────────────────────────

  /**
   * Pull workout history since `since`, paging the workouts list. Pages until
   * a short page (< per_page) is returned or the page cap is hit. Returns
   * wrapped {@link RawRecord}s for the normalizer — never N+1s the ingestion
   * lane (#21): one HTTP call per page, all records batched.
   *
   * Auth: uses the connection's CURRENT access token. The caller (sync worker)
   * refreshes first if it is expired; backfill itself does not refresh to keep
   * the seam single-purpose.
   */
  async backfill(conn: WearableConnection, since: Date): Promise<RawRecord[]> {
    try {
      return await this.backfillInner(conn, since);
    } catch (err) {
      await this.markConnectionError(conn, err, 'wahoo.backfill');
      throw err;
    }
  }

  private async backfillInner(
    conn: WearableConnection,
    since: Date,
  ): Promise<RawRecord[]> {
    const accessToken = this.accessTokenFor(conn);
    const sinceMs = since.getTime();
    const records: RawRecord[] = [];

    for (let page = 1; page <= BACKFILL_MAX_PAGES; page++) {
      const url =
        `${WAHOO_API_BASE}/workouts` +
        `?page=${page}&per_page=${BACKFILL_PER_PAGE}`;

      const res = await this.http.request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        label: 'wahoo.backfill',
      });

      const body = (await res.json()) as WahooWorkoutsListResponse;
      const workouts = Array.isArray(body?.workouts) ? body.workouts : [];
      if (workouts.length === 0) break;

      for (const w of workouts) {
        // Client-side `since` clamp: Wahoo lists newest-first; skip workouts
        // older than the requested window but keep paging in case the page
        // straddles the boundary.
        const startMs = Date.parse(w?.starts ?? '');
        if (Number.isFinite(startMs) && startMs < sinceMs) continue;
        records.push(this.wrap(conn, w));
      }

      // A short page means we have reached the end of history.
      if (workouts.length < BACKFILL_PER_PAGE) break;
    }

    return records;
  }

  // ── Normalize ──────────────────────────────────────────────────────────────

  /** Delegate to the pure normalizer (AGENT_2_CODING_PLAN §3.1). */
  normalize(raw: RawRecord[]): NormalizedSample[] {
    return normalizeWahoo(raw);
  }

  // ── Webhook ──────────────────────────────────────────────────────────────

  /**
   * Verify a Wahoo webhook delivery. Requires BOTH:
   *  1. a constant-time HMAC-SHA256 over (`x-wahoo-timestamp` + rawBody) keyed
   *     by `WAHOO_WEBHOOK_SECRET` (falls back to `WAHOO_CLIENT_SECRET`),
   *     matching the `x-wahoo-signature` header (hex), AND
   *  2. the `webhook_token` field equal to the configured `WAHOO_WEBHOOK_TOKEN`
   *     (Wahoo's documented shared-token control).
   * Fails CLOSED (returns false, never throws) on any missing secret/header,
   * length mismatch, or compare failure so the controller maps it to a single
   * 401 (audit pattern #5 fail-closed verification).
   */
  verifyWebhook(req: RawWebhookRequest): boolean {
    const secret =
      process.env[ENV.webhookSecret] ?? process.env[ENV.clientSecret];
    if (!secret) {
      this.logger.error(
        'wahoo.verifyWebhook: no WAHOO_WEBHOOK_SECRET/WAHOO_CLIENT_SECRET configured — failing closed',
      );
      return false;
    }
    if (!Buffer.isBuffer(req.rawBody)) return false;

    const signature = this.header(req.headers, 'x-wahoo-signature');
    const timestamp = this.header(req.headers, 'x-wahoo-timestamp');
    if (!signature || !timestamp) return false;

    const expected = createHmac('sha256', secret)
      .update(timestamp, 'utf8')
      .update(req.rawBody)
      .digest('hex');

    if (!this.constantTimeEquals(expected, signature.toLowerCase())) {
      return false;
    }

    // Shared-token control: only enforced when configured. Wahoo says "any
    // request that doesn't include this token should be ignored".
    const expectedToken = process.env[ENV.webhookToken];
    if (expectedToken) {
      const provided = this.extractWebhookToken(req.rawBody);
      if (!provided || !this.constantTimeEquals(expectedToken, provided)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Parse a verified webhook into provider events. Assumes the controller
   * already Zod-validated the body. Each Wahoo delivery references one changed
   * workout summary; the records are produced by {@link extractWorkoutRecords}
   * so the controller can normalize without a second API round-trip.
   */
  parseWebhook(req: RawWebhookRequest): ProviderEvent[] {
    let parsed: WahooWebhookEvent;
    try {
      parsed = JSON.parse(req.rawBody.toString('utf8')) as WahooWebhookEvent;
    } catch {
      return [];
    }
    if (!parsed || !parsed.event_type) return [];
    return [
      {
        providerEventId: this.eventId(parsed),
        type: parsed.event_type,
        records: [],
      },
    ];
  }

  /**
   * Stable provider-native event id for {@link WearableProcessedEvent}. Wahoo
   * deliveries do not carry a single event id, so we key on
   * (event_type, workout_summary.id || workout.id, updated_at) which is unique
   * per change and stable across redeliveries of the SAME change.
   */
  eventId(event: WahooWebhookEvent): string {
    const summary = event.workout_summary ?? {};
    const summaryId = summary.id !== undefined ? String(summary.id) : 'na';
    const workoutId =
      summary.workout?.id !== undefined ? String(summary.workout.id) : 'na';
    const updated = summary.workout?.updated_at ?? summary.updated_at ?? 'na';
    return `${event.event_type}:${summaryId}:${workoutId}:${updated}`;
  }

  /**
   * Extract the changed workout from a verified+validated webhook event and
   * wrap it for the normalizer. The webhook embeds the workout under
   * `workout_summary.workout`; if it is absent we return [] (delete/empty).
   */
  extractWorkoutRecords(
    conn: WearableConnection,
    event: WahooWebhookEvent,
  ): RawRecord[] {
    const workout = event.workout_summary?.workout;
    if (!workout) return [];
    // The webhook nests the summary fields alongside the workout; thread the
    // summary onto the workout so the normalizer sees distance/HR.
    const merged: WahooWorkout = {
      ...workout,
      workout_summary: workout.workout_summary ?? event.workout_summary ?? null,
    };
    return [this.wrap(conn, merged)];
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Wrap a Wahoo workout in a RawRecord carrying subject user/connection. */
  private wrap(conn: WearableConnection, workout: WahooWorkout): RawRecord {
    const payload: WahooRawPayload = {
      userId: conn.user_id,
      connectionId: conn.id,
      sourceTz: workout.workout_summary?.time_zone ?? null,
      workout,
    };
    return {
      id: workout.id !== undefined ? String(workout.id) : undefined,
      provider: WearableProvider.WAHOO,
      payload,
    };
  }

  /** POST the token endpoint and parse the JSON token response (loud on error). */
  private async postToken(
    body: URLSearchParams,
    label: string,
  ): Promise<WahooTokenResponse> {
    let res: Response;
    try {
      res = await this.http.request(WAHOO_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        label,
      });
    } catch (err) {
      // OAuth error log redaction (audit pattern #7): never log err.message /
      // err.response.data / token URLs. Only structured, redacted fields.
      if (err instanceof ProviderHttpError) {
        this.logger.error({
          msg: 'wahoo.oauth.token_request_failed',
          provider: 'WAHOO',
          op: label,
          error_code: err.status ?? 'none',
          error_class: err.name,
        });
        throw new Error(`${label}: token request failed (status=${err.status})`);
      }
      this.logger.error({
        msg: 'wahoo.oauth.token_request_failed',
        provider: 'WAHOO',
        op: label,
        error_class: (err as Error)?.name ?? 'Error',
      });
      throw err;
    }
    const json = (await res.json()) as WahooTokenResponse;
    if (!json?.access_token) {
      throw new Error(`${label}: token response missing access_token`);
    }
    return json;
  }

  /** Build a {@link TokenSet} from a Wahoo token response (rotated refresh). */
  private toTokenSet(
    token: WahooTokenResponse,
    fallbackRefresh?: string,
  ): TokenSet {
    const refreshToken = token.refresh_token ?? fallbackRefresh;
    if (!refreshToken) {
      throw new Error('wahoo: token response missing refresh_token');
    }
    return {
      refreshToken,
      accessToken: token.access_token,
      accessTokenExpiresAt:
        typeof token.expires_in === 'number'
          ? new Date(Date.now() + token.expires_in * 1000)
          : undefined,
      scopes: token.scope
        ? token.scope.split(/\s+/).filter(Boolean)
        : [...WAHOO_SCOPES],
      externalAccountId:
        token.user?.id !== undefined ? String(token.user.id) : undefined,
    };
  }

  /** Read the connection's current access token for an API call. */
  private accessTokenFor(conn: WearableConnection): string {
    const token = (conn as unknown as { decryptedAccessToken?: string })
      .decryptedAccessToken;
    if (!token) {
      throw new Error('wahoo.backfill: connection has no access token');
    }
    return token;
  }

  /** Pull `webhook_token` from the raw body without trusting its full shape. */
  private extractWebhookToken(rawBody: Buffer): string | null {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as {
        webhook_token?: unknown;
      };
      return typeof parsed?.webhook_token === 'string'
        ? parsed.webhook_token
        : null;
    } catch {
      return null;
    }
  }

  private header(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | null {
    const v = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(v)) return v[0] ?? null;
    return v ?? null;
  }

  /** Length-safe constant-time string compare. */
  private constantTimeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) {
      // Compare against self to keep timing uniform, then fail.
      timingSafeEqual(ab, ab);
      return false;
    }
    return timingSafeEqual(ab, bb);
  }

  /**
   * Mark a connection `status='error'` with a redacted error message on a
   * provider-side failure, best-effort (never masks the original error). No-op
   * when `prisma` was not injected or the connection has no id. The log line
   * carries only a hashed user id (audit pattern #3) — never raw PII.
   */
  private async markConnectionError(
    conn: WearableConnection,
    err: unknown,
    op: string,
  ): Promise<void> {
    const message = redactErrorMessage(err);
    this.logger.error({
      msg: 'wearables.wahoo.connection_error',
      op,
      provider: 'WAHOO',
      user_hash: conn?.user_id ? hashForLog(conn.user_id) : 'na',
      error_message: message,
    });
    if (!this.prisma || !conn?.id) return;
    await this.prisma.wearableConnection
      .update({
        where: { id: conn.id },
        data: { status: 'error', last_error: message },
      })
      .catch(() => undefined);
  }

  /** Read a required env var, failing loud (with the var NAME, not value). */
  private requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
      throw new Error(`wahoo: required env var ${name} is not set`);
    }
    return v;
  }
}

/** Singleton-friendly factory used by the connector definition export. */
export function createWahooConnector(
  http: ProviderHttpClient,
  prisma?: PrismaService,
): WahooConnector {
  return new WahooConnector(http, prisma);
}
