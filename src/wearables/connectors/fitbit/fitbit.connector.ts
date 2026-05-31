import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
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
import { ProviderHttpClient } from '../../http/provider-http-client';
import { PrismaService } from '../../../prisma.service';
import { normalizeFitbit, FitbitRawPayload } from './fitbit.normalizer';
import {
  FITBIT_SCOPES,
  FitbitCollection,
  FitbitNotification,
  FitbitTokenResponse,
} from './fitbit.types';

/**
 * PR-HK-2.e — Fitbit Web API connector (OAuth2 PKCE + subscriptions + backfill).
 *
 * Implements the PR-HK-0 {@link WearableConnector} contract. All cloud calls
 * route through {@link ProviderHttpClient} so timeout + capped jittered backoff
 * are applied uniformly (#35/#50). OAuth client credentials are read from env
 * (`FITBIT_CLIENT_ID` / `FITBIT_CLIENT_SECRET`) — never hardcoded, never logged
 * (#1/#12).
 *
 * Endpoints (verified against https://dev.fitbit.com/build/reference/web-api/,
 * May 2026):
 *  - authorize  https://www.fitbit.com/oauth2/authorize
 *  - token      https://api.fitbit.com/oauth2/token
 *  - data       https://api.fitbit.com/1/user/-/<collection>/date/<s>/<e>.json
 *
 * Auth model: OAuth2 authorization-code with PKCE (S256). PKCE is the Fitbit
 * recommended flow (AGENT_2_CODING_PLAN §3): {@link buildAuthUrl} derives an
 * S256 `code_challenge` from a server-minted `code_verifier`. PR-HK-1 owns the
 * verifier's storage/round-trip; the connector exposes a static PKCE helper so
 * the OAuth lane and the connector agree on the derivation.
 *
 * Token endpoint auth: Fitbit requires HTTP Basic auth with the app
 * `client_id:client_secret` on `POST /oauth2/token` (in addition to the PKCE
 * `code_verifier` in the body). The Basic header is built per-call and never
 * logged.
 *
 * Webhook signature: Fitbit signs subscription notifications with
 * `X-Fitbit-Signature` = base64( HMAC-SHA1( rawBody, key ) ) where the HMAC key
 * is the app `client_secret` followed by an ampersand (`<client_secret>&`) —
 * the OAuth1.0a signing-key form Fitbit reuses. We verify on the UNPARSED bytes
 * with a constant-time compare; re-serialising JSON would break the signature
 * and is never attempted (Stripe-pattern raw-body HMAC).
 *
 * Backfill: Fitbit time-series endpoints accept a `date/<start>/<end>` window.
 * Fitbit's TOS caps a single time-series request at ~1 year for most series,
 * but AGENT_2_CODING_PLAN §3 sets the connect-time backfill at ~30 days; we
 * clamp to {@link FITBIT_MAX_BACKFILL_DAYS} and never exceed it.
 */

const FITBIT_AUTHORIZE_URL = 'https://www.fitbit.com/oauth2/authorize';
const FITBIT_TOKEN_URL = 'https://api.fitbit.com/oauth2/token';
const FITBIT_API_BASE = 'https://api.fitbit.com/1/user/-';

/** Provider TOS backfill ceiling — Fitbit connect-time ≤ 30 days (§3). */
const FITBIT_MAX_BACKFILL_DAYS = 30;

/**
 * Collections fetched on backfill / referenced by subscription notifications.
 * Each maps to a Fitbit time-series or log endpoint (see {@link endpointFor}).
 */
const BACKFILL_COLLECTIONS: FitbitCollection[] = [
  'activities/steps',
  'activities/heart',
  'sleep',
  'body/weight',
  'br',
  'spo2',
];

/**
 * Map a subscription `collectionType` (Fitbit's notification vocabulary) to the
 * connector collection(s) to re-fetch. Fitbit groups several metrics under one
 * subscription collection ("activities" covers steps + heart; "body" covers
 * weight). Returns [] for unknown / userRevokedAccess (handled by other lanes).
 */
const NOTIFICATION_COLLECTIONS: Record<string, FitbitCollection[]> = {
  activities: ['activities/steps', 'activities/heart'],
  heart: ['activities/heart'],
  sleep: ['sleep'],
  body: ['body/weight'],
  br: ['br'],
  spo2: ['spo2'],
};

/**
 * Strip token-like secrets from an error message before it is persisted to
 * `WearableConnection.last_error` or logged (#1/#12). Connector-scoped (no
 * cross-file changes); exported solely so the spec can unit-test the redaction.
 * Redacts common credential patterns that can leak into upstream HTTP error
 * strings, then caps length.
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
      /\b(access_token|refresh_token|client_secret|client_id|token|code|code_verifier)=[^&\s"',]+/gi,
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

/**
 * PKCE helper (S256). Exported so PR-HK-1's OAuth-state service derives the
 * challenge identically to the connector. `code_verifier` is a 43–128 char
 * URL-safe random string; `code_challenge` = base64url(sha256(verifier)).
 */
export function generateCodeVerifier(): string {
  // 32 random bytes → 43-char base64url, within the RFC 7636 length bounds.
  return base64Url(randomBytes(32));
}

export function deriveCodeChallenge(codeVerifier: string): string {
  return base64Url(createHash('sha256').update(codeVerifier, 'ascii').digest());
}

function base64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

@Injectable()
export class FitbitConnector implements WearableConnector {
  readonly provider: WearableProvider = WearableProvider.FITBIT;
  readonly authModel: WearableAuthModel = 'oauth2';

  private readonly logger = new Logger(FitbitConnector.name);

  /**
   * `prisma` is optional so the pure OAuth/normalize/verify unit tests can
   * construct the connector with just an HTTP client. When present (the DI path
   * under {@link FitbitModule}), backfill/refresh provider outages mark the
   * connection `status='error'` with a REDACTED `last_error` before rethrowing
   * (fail-loud + fail-explicit). When absent, the failure still rethrows — we
   * simply skip the status write.
   */
  constructor(
    private readonly http: ProviderHttpClient,
    private readonly prisma?: PrismaService,
  ) {}

  // ── OAuth (PKCE) ───────────────────────────────────────────────────────────

  /**
   * Build the Fitbit authorization URL for a connect flow. `state` is the
   * server-minted CSRF state (PR-HK-1 owns generation/validation). PKCE: the
   * caller (PR-HK-1) generates+persists the `code_verifier` and passes its
   * derived `code_challenge` as the second positional via the optional
   * `codeChallenge` arg; for contract simplicity the interface signature stays
   * `(userId, state)`, so when no challenge is supplied we omit PKCE params
   * (PR-HK-1 will call {@link buildAuthUrlPkce} for the PKCE-enabled flow).
   */
  buildAuthUrl(_userId: string, state: string): string {
    return this.buildAuthUrlPkce(_userId, state);
  }

  /**
   * PKCE-aware authorization URL builder. When `codeChallenge` is provided the
   * URL carries `code_challenge` + `code_challenge_method=S256` (the Fitbit
   * recommended flow). `redirect_uri` is read from env so it is
   * environment-correct without a code change.
   */
  buildAuthUrlPkce(
    _userId: string,
    state: string,
    codeChallenge?: string,
  ): string {
    const clientId = this.requireEnv('FITBIT_CLIENT_ID');
    const redirectUri = this.requireEnv('FITBIT_REDIRECT_URI');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: FITBIT_SCOPES.join(' '),
      state,
    });
    if (codeChallenge) {
      params.set('code_challenge', codeChallenge);
      params.set('code_challenge_method', 'S256');
    }
    return `${FITBIT_AUTHORIZE_URL}?${params.toString()}`;
  }

  /**
   * Exchange an authorization `code` for a {@link TokenSet}. Fitbit requires the
   * app Basic-auth header AND (for PKCE) the `code_verifier` in the body. The
   * optional `opts.codeVerifier` is supplied by PR-HK-1's OAuth lane when the
   * connect flow used PKCE.
   */
  async exchangeCode(
    code: string,
    opts?: { codeVerifier?: string },
  ): Promise<TokenSet> {
    const clientId = this.requireEnv('FITBIT_CLIENT_ID');
    const redirectUri = this.requireEnv('FITBIT_REDIRECT_URI');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
    });
    if (opts?.codeVerifier) {
      body.set('code_verifier', opts.codeVerifier);
    }

    const token = await this.postToken(body, 'fitbit.exchangeCode');
    return this.toTokenSet(token);
  }

  /** Refresh an expiring access token using the connection's refresh token. */
  async refresh(conn: WearableConnection): Promise<TokenSet> {
    try {
      return await this.refreshInner(conn);
    } catch (err) {
      // Fail-explicit: a provider outage (or invalid_grant) during refresh
      // marks the connection in error with a redacted message, then rethrows
      // so PR-HK-1's token lane can react (re-consent / disable).
      await this.markConnectionError(conn, err, 'fitbit.refresh');
      throw err;
    }
  }

  private async refreshInner(conn: WearableConnection): Promise<TokenSet> {
    const rt = (conn as unknown as { decryptedRefreshToken?: string })
      .decryptedRefreshToken;
    if (!rt) {
      throw new Error('fitbit.refresh: connection has no refresh token');
    }
    const clientId = this.requireEnv('FITBIT_CLIENT_ID');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: clientId,
    });

    const token = await this.postToken(body, 'fitbit.refresh');
    // Fitbit rotates the refresh token on refresh; if it is ever omitted, fall
    // back to the existing one so the connection layer never persists empty.
    return this.toTokenSet(token, rt);
  }

  // ── Backfill ─────────────────────────────────────────────────────────────

  /**
   * Pull provider history since `since`, clamped to the Fitbit ≤30d connect-time
   * window. Fetches each backfill collection once over the window and returns
   * wrapped {@link RawRecord}s for the normalizer — never N+1 against the
   * ingestion lane (#21): the caller batch-ingests the returned array once.
   */
  async backfill(conn: WearableConnection, since: Date): Promise<RawRecord[]> {
    try {
      return await this.backfillInner(conn, since);
    } catch (err) {
      await this.markConnectionError(conn, err, 'fitbit.backfill');
      throw err;
    }
  }

  private async backfillInner(
    conn: WearableConnection,
    since: Date,
  ): Promise<RawRecord[]> {
    const accessToken = (conn as unknown as { decryptedAccessToken?: string })
      .decryptedAccessToken;
    if (!accessToken) {
      throw new Error('fitbit.backfill: connection has no access token');
    }

    const now = new Date();
    const floor = new Date(
      now.getTime() - FITBIT_MAX_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
    );
    const effectiveSince = since.getTime() < floor.getTime() ? floor : since;

    const startDate = this.toDateString(effectiveSince);
    const endDate = this.toDateString(now);

    const ctxBase = {
      userId: conn.user_id,
      connectionId: conn.id,
      sourceTz: null as string | null,
    };

    const records: RawRecord[] = [];
    for (const collection of BACKFILL_COLLECTIONS) {
      const record = await this.fetchCollection(
        accessToken,
        collection,
        startDate,
        endDate,
      );
      records.push(this.wrap(collection, ctxBase, record));
    }
    return records;
  }

  // ── Normalize ──────────────────────────────────────────────────────────────

  /** Delegate to the pure normalizer (AGENT_2_CODING_PLAN §3.1). */
  normalize(raw: RawRecord[]): NormalizedSample[] {
    return normalizeFitbit(raw);
  }

  // ── Webhook ────────────────────────────────────────────────────────────────

  /**
   * Verify a Fitbit subscription notification. Computes base64(HMAC-SHA1(
   * rawBody, `<client_secret>&`)) and compares it against `X-Fitbit-Signature`
   * in constant time. Returns false (never throws) on any missing input or
   * mismatch so the controller maps it to a single 401. Fails CLOSED when the
   * secret is unconfigured.
   */
  verifyWebhook(req: RawWebhookRequest): boolean {
    const secret = process.env.FITBIT_CLIENT_SECRET;
    if (!secret) {
      this.logger.error(
        'fitbit.verifyWebhook: FITBIT_CLIENT_SECRET not configured',
      );
      return false;
    }
    const signature = this.header(req.headers, 'x-fitbit-signature');
    if (!signature) return false;
    if (!Buffer.isBuffer(req.rawBody)) return false;

    const expected = createHmac('sha1', `${secret}&`)
      .update(req.rawBody)
      .digest('base64');

    return this.constantTimeEquals(expected, signature);
  }

  /**
   * Parse a verified webhook into provider events. Fitbit POSTs a JSON ARRAY of
   * notifications; each becomes one {@link ProviderEvent}. The controller
   * fetches + normalizes the referenced records. Assumes the controller
   * Zod-validated the body first.
   */
  parseWebhook(req: RawWebhookRequest): ProviderEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      return [];
    }
    const list: FitbitNotification[] = Array.isArray(parsed)
      ? (parsed as FitbitNotification[])
      : [parsed as FitbitNotification];
    const events: ProviderEvent[] = [];
    for (const n of list) {
      if (!n || !n.collectionType || !n.ownerId) continue;
      events.push({
        providerEventId: this.eventId(n),
        type: `${n.collectionType}.updated`,
        records: [],
      });
    }
    return events;
  }

  /**
   * Fetch the records referenced by a single subscription notification and
   * return them wrapped for the normalizer. Public so the webhook controller
   * can pull just-changed data without a full backfill (#21). A notification
   * references a single calendar `date`; we fetch that one-day window for each
   * collection the notification's `collectionType` maps to.
   */
  async fetchNotificationRecords(
    conn: WearableConnection,
    notification: FitbitNotification,
  ): Promise<RawRecord[]> {
    const accessToken = (conn as unknown as { decryptedAccessToken?: string })
      .decryptedAccessToken;
    if (!accessToken) {
      throw new Error(
        'fitbit.fetchNotificationRecords: connection has no access token',
      );
    }
    const collections = NOTIFICATION_COLLECTIONS[notification.collectionType];
    if (!collections || !notification.date) return [];

    const ctxBase = {
      userId: conn.user_id,
      connectionId: conn.id,
      sourceTz: null as string | null,
    };

    const records: RawRecord[] = [];
    for (const collection of collections) {
      const record = await this.fetchCollection(
        accessToken,
        collection,
        notification.date,
        notification.date,
      );
      records.push(this.wrap(collection, ctxBase, record));
    }
    return records;
  }

  /** Stable provider-native event id for {@link WearableProcessedEvent}. */
  eventId(n: FitbitNotification): string {
    // The (collectionType, ownerId, date, subscriptionId) tuple is unique per
    // delivery and stable across redeliveries of the SAME change. `date` may be
    // absent (userRevokedAccess); fall back to a literal so the key is stable.
    return `${n.collectionType}:${n.ownerId}:${n.date ?? 'none'}:${n.subscriptionId}`;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Build the Fitbit time-series / log endpoint URL for a collection over a
   * `[start, end]` (YYYY-MM-DD) window. Most collections use the
   * `.../date/<start>/<end>.json` form; SpO2 and BR summaries use the same.
   */
  private endpointFor(
    collection: FitbitCollection,
    start: string,
    end: string,
  ): string {
    switch (collection) {
      case 'activities/steps':
        return `${FITBIT_API_BASE}/activities/steps/date/${start}/${end}.json`;
      case 'activities/heart':
        return `${FITBIT_API_BASE}/activities/heart/date/${start}/${end}.json`;
      case 'sleep':
        // Sleep API lives under the 1.2 namespace.
        return `https://api.fitbit.com/1.2/user/-/sleep/date/${start}/${end}.json`;
      case 'body/weight':
        return `${FITBIT_API_BASE}/body/log/weight/date/${start}/${end}.json`;
      case 'br':
        return `${FITBIT_API_BASE}/br/date/${start}/${end}.json`;
      case 'spo2':
        return `${FITBIT_API_BASE}/spo2/date/${start}/${end}.json`;
      default:
        return `${FITBIT_API_BASE}/${collection}/date/${start}/${end}.json`;
    }
  }

  private async fetchCollection(
    accessToken: string,
    collection: FitbitCollection,
    start: string,
    end: string,
  ): Promise<unknown> {
    const url = this.endpointFor(collection, start, end);
    const res = await this.http.request(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // Force metric units (kg) for weight regardless of account locale.
        'Accept-Language': 'en_GB',
      },
      label: `fitbit.fetch.${collection}`,
    });
    return (await res.json()) as unknown;
  }

  private wrap(
    collection: FitbitCollection,
    ctx: { userId: string; connectionId: string; sourceTz: string | null },
    record: unknown,
  ): RawRecord {
    const payload: FitbitRawPayload = {
      collection,
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      sourceTz: ctx.sourceTz,
      record,
    };
    return {
      provider: WearableProvider.FITBIT,
      payload,
    };
  }

  private async postToken(
    body: URLSearchParams,
    label: string,
  ): Promise<FitbitTokenResponse> {
    const clientId = this.requireEnv('FITBIT_CLIENT_ID');
    const clientSecret = this.requireEnv('FITBIT_CLIENT_SECRET');
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await this.http.request(FITBIT_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: body.toString(),
      label,
    });
    return (await res.json()) as FitbitTokenResponse;
  }

  private toTokenSet(
    token: FitbitTokenResponse,
    fallbackRefresh?: string,
  ): TokenSet {
    const refreshToken = token.refresh_token ?? fallbackRefresh;
    if (!refreshToken) {
      throw new Error('fitbit: token response missing refresh_token');
    }
    return {
      refreshToken,
      accessToken: token.access_token,
      accessTokenExpiresAt:
        typeof token.expires_in === 'number'
          ? new Date(Date.now() + token.expires_in * 1000)
          : undefined,
      scopes: token.scope ? token.scope.split(/\s+/).filter(Boolean) : undefined,
      externalAccountId: token.user_id,
    };
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
      timingSafeEqual(ab, ab);
      return false;
    }
    return timingSafeEqual(ab, bb);
  }

  private toDateString(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /**
   * Mark a connection `status='error'` with a redacted error message on a
   * provider-side failure, best-effort (never masks the original error). No-op
   * when `prisma` was not injected or the connection has no id.
   */
  private async markConnectionError(
    conn: WearableConnection,
    err: unknown,
    op: string,
  ): Promise<void> {
    const message = redactErrorMessage(err);
    this.logger.error({
      msg: 'wearables.fitbit.connection_error',
      op,
      provider: 'FITBIT',
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

  private requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
      throw new Error(`fitbit: ${name} is not configured`);
    }
    return v;
  }
}

/** Singleton-friendly factory used by the connector definition export. */
export function createFitbitConnector(
  http: ProviderHttpClient,
  prisma?: PrismaService,
): FitbitConnector {
  return new FitbitConnector(http, prisma);
}
