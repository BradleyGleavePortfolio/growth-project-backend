import { createHmac, timingSafeEqual } from 'crypto';
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
import { normalizeOura, OuraRawPayload } from './oura.normalizer';
import {
  OuraCollection,
  OuraListResponse,
  OuraTokenResponse,
  OuraWebhookEvent,
} from './oura.types';

/**
 * PR-HK-2.k — Oura Cloud API v2 connector (OAuth2 + webhook + backfill).
 *
 * Implements the PR-HK-0 {@link WearableConnector} contract. All cloud calls
 * route through {@link ProviderHttpClient} so timeout + capped jittered
 * backoff are applied uniformly (#35/#50). OAuth client credentials are read
 * from env (`OURA_CLIENT_ID` / `OURA_CLIENT_SECRET`) — never hardcoded,
 * never logged (#1/#12).
 *
 * Endpoints (verified against https://cloud.ouraring.com/v2/docs, May 2026):
 *  - authorize  https://cloud.ouraring.com/oauth/authorize
 *  - token      https://api.ouraring.com/oauth/token
 *  - data       https://api.ouraring.com/v2/usercollection/<collection>
 *
 * Webhook signature: Oura sends `x-oura-signature` (UPPERCASE hex HMAC-SHA256)
 * and `x-oura-timestamp`. The signed message is `timestamp + rawBody` keyed by
 * the app `client_secret`. We verify on the UNPARSED bytes with a constant-
 * time compare (`crypto.timingSafeEqual`) — re-serialising JSON would break
 * the signature and is never attempted (Stripe-pattern raw-body HMAC).
 */

const OURA_AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const OURA_API_BASE = 'https://api.ouraring.com/v2/usercollection';

/** Scopes requested at connect time (Agent 2 §3 Oura row). */
const OURA_SCOPES = [
  'daily',
  'heartrate',
  'workout',
  'session',
  'spo2',
  'personal',
] as const;

/** Provider TOS backfill ceiling — Oura ≤ 30 days (Agent 2 §3.1). */
const OURA_MAX_BACKFILL_DAYS = 30;

/**
 * Strip token-like secrets from an error message before it is persisted to
 * `WearableConnection.last_error` or logged (R2 fix — Finding 3 / #1/#12).
 * Defined and exported INSIDE the oura module only (kept connector-scoped — no
 * cross-file changes); exported solely so the connector spec can unit-test the
 * redaction directly. Redacts common credential patterns that can leak into
 * upstream HTTP error strings
 * (`token=`, `code=`, `client_secret=`, `refresh_token=`, `access_token=`,
 * `Authorization: Bearer ...`, and bare `Bearer <token>`), then caps length.
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
    // key=value secrets (query string or form body), value runs to a
    // delimiter (&, whitespace, quote, comma, end).
    .replace(
      /\b(access_token|refresh_token|client_secret|client_id|token|code)=[^&\s"',]+/gi,
      '$1=[REDACTED]',
    )
    // `Authorization: <scheme> <token>` header — redact the credential while
    // keeping the scheme word so the message stays diagnostic. Run BEFORE the
    // bare-scheme rule so the two never double-process the same span.
    .replace(
      /(authorization\s*[:=]\s*)(Bearer|Basic)\s+[^\s"',]+/gi,
      '$1$2 [REDACTED]',
    )
    // Bare `Bearer <token>` / `Basic <token>` not preceded by a header label.
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/g, 'Basic [REDACTED]')
    // Any remaining `authorization: <value>` credential that is NOT a scheme
    // word already handled above (negative lookahead keeps "Bearer [REDACTED]"
    // intact instead of re-redacting the scheme).
    .replace(
      /\b(authorization)(\s*[:=]\s*)(?!Bearer\b|Basic\b|\[REDACTED\])[^\s"',]+/gi,
      '$1$2[REDACTED]',
    );

  return redacted.slice(0, 500) || 'unknown';
}

/** Daily collections use `start_date`/`end_date` (YYYY-MM-DD). */
const DAILY_COLLECTIONS: OuraCollection[] = [
  'daily_sleep',
  'daily_readiness',
  'daily_activity',
  'daily_spo2',
];

/** Datetime-windowed collections use `start_datetime`/`end_datetime`. */
const DATETIME_COLLECTIONS: OuraCollection[] = ['heartrate'];

/** Date-windowed long-form collections (fetched, mapped to no rows today). */
const DATE_LONGFORM_COLLECTIONS: OuraCollection[] = [
  'sleep',
  'workout',
  'session',
];

@Injectable()
export class OuraConnector implements WearableConnector {
  readonly provider: WearableProvider = WearableProvider.OURA;
  readonly authModel: WearableAuthModel = 'oauth2';

  private readonly logger = new Logger(OuraConnector.name);

  /**
   * `prisma` is optional so the pure OAuth/normalize/verify unit tests can
   * construct the connector with just an HTTP client. When present (the DI
   * path under {@link OuraModule}), backfill/refresh provider outages mark the
   * connection `status='error'` with a REDACTED `last_error` before rethrowing
   * (fail-loud + fail-explicit, R2 fix — Finding 3). When absent, the failure
   * still rethrows — we simply skip the status write.
   */
  constructor(
    private readonly http: ProviderHttpClient,
    private readonly prisma?: PrismaService,
  ) {}

  // ── OAuth ────────────────────────────────────────────────────────────────

  /**
   * Build the Oura authorization URL for a connect flow. `state` is the
   * server-minted CSRF state (PR-HK-1 owns generation/validation). The
   * `redirect_uri` is read from env so it is environment-correct without a
   * code change.
   */
  buildAuthUrl(_userId: string, state: string): string {
    const clientId = this.requireEnv('OURA_CLIENT_ID');
    const redirectUri = this.requireEnv('OURA_REDIRECT_URI');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: OURA_SCOPES.join(' '),
      state,
    });
    return `${OURA_AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Exchange an authorization `code` for a {@link TokenSet}. */
  async exchangeCode(code: string): Promise<TokenSet> {
    const clientId = this.requireEnv('OURA_CLIENT_ID');
    const clientSecret = this.requireEnv('OURA_CLIENT_SECRET');
    const redirectUri = this.requireEnv('OURA_REDIRECT_URI');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const token = await this.postToken(body, 'oura.exchangeCode');
    return this.toTokenSet(token);
  }

  /** Refresh an expiring access token using the connection's refresh token. */
  async refresh(conn: WearableConnection): Promise<TokenSet> {
    try {
      return await this.refreshInner(conn);
    } catch (err) {
      // Fail-explicit: a provider outage (or invalid_grant) during refresh
      // marks the connection in error with a redacted message, then rethrows
      // so PR-HK-1's token lane can react (re-consent / disable). R2 —
      // Finding 3.
      await this.markConnectionError(conn, err, 'oura.refresh');
      throw err;
    }
  }

  private async refreshInner(conn: WearableConnection): Promise<TokenSet> {
    const refreshToken = (conn as { refresh_token?: string }).refresh_token;
    // PR-HK-1 KMS-unwraps the stored token before calling refresh; the
    // connection object carries the plaintext refresh token transiently. We
    // accept it via a narrow cast to avoid coupling to PR-HK-1's unwrap shape.
    const rt =
      refreshToken ??
      (conn as unknown as { decryptedRefreshToken?: string })
        .decryptedRefreshToken;
    if (!rt) {
      throw new Error('oura.refresh: connection has no refresh token');
    }
    const clientId = this.requireEnv('OURA_CLIENT_ID');
    const clientSecret = this.requireEnv('OURA_CLIENT_SECRET');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const token = await this.postToken(body, 'oura.refresh');
    // Oura may omit a rotated refresh token; fall back to the existing one so
    // the connection layer never persists an empty refresh token.
    return this.toTokenSet(token, rt);
  }

  // ── Backfill ───────────────────────────────────────────────────────────────

  /**
   * Pull provider history since `since`, clamped to the Oura ≤30d TOS window.
   * Pages each collection internally (`next_token`) and returns wrapped
   * {@link RawRecord}s for the normalizer — never N+1 against the ingestion
   * lane (#21): the caller batch-ingests the returned array once.
   */
  async backfill(conn: WearableConnection, since: Date): Promise<RawRecord[]> {
    try {
      return await this.backfillInner(conn, since);
    } catch (err) {
      // Fail-explicit: a provider outage during backfill marks the connection
      // in error with a redacted message, then rethrows so the caller (sync
      // job) sees the failure (no silent swallow, #36/#50). R2 — Finding 3.
      await this.markConnectionError(conn, err, 'oura.backfill');
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
      throw new Error('oura.backfill: connection has no access token');
    }

    const now = new Date();
    const floor = new Date(
      now.getTime() - OURA_MAX_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
    );
    const effectiveSince = since.getTime() < floor.getTime() ? floor : since;

    const startDate = this.toDateString(effectiveSince);
    const endDate = this.toDateString(now);
    const startDt = effectiveSince.toISOString();
    const endDt = now.toISOString();

    const ctxBase = {
      userId: conn.user_id,
      connectionId: conn.id,
      sourceTz: null as string | null,
    };

    const records: RawRecord[] = [];

    for (const collection of [
      ...DAILY_COLLECTIONS,
      ...DATE_LONGFORM_COLLECTIONS,
    ]) {
      const rows = await this.fetchCollection(
        accessToken,
        collection,
        { start_date: startDate, end_date: endDate },
        `oura.backfill.${collection}`,
      );
      for (const record of rows) {
        records.push(this.wrap(collection, ctxBase, record));
      }
    }

    for (const collection of DATETIME_COLLECTIONS) {
      const rows = await this.fetchCollection(
        accessToken,
        collection,
        { start_datetime: startDt, end_datetime: endDt },
        `oura.backfill.${collection}`,
      );
      for (const record of rows) {
        records.push(this.wrap(collection, ctxBase, record));
      }
    }

    return records;
  }

  // ── Normalize ──────────────────────────────────────────────────────────────

  /** Delegate to the pure normalizer (Agent 2 §3.1). */
  normalize(raw: RawRecord[]): NormalizedSample[] {
    return normalizeOura(raw);
  }

  // ── Webhook ────────────────────────────────────────────────────────────────

  /**
   * Verify an Oura webhook delivery. Computes the UPPERCASE hex HMAC-SHA256 of
   * (`x-oura-timestamp` + rawBody) with the app `client_secret` and compares
   * it against `x-oura-signature` in constant time. Returns false (never
   * throws) on any missing input or mismatch so the controller maps it to a
   * single 401.
   */
  verifyWebhook(req: RawWebhookRequest): boolean {
    const secret = process.env.OURA_CLIENT_SECRET;
    if (!secret) {
      // Fail closed: an unconfigured secret can never authenticate a request.
      this.logger.error('oura.verifyWebhook: OURA_CLIENT_SECRET not configured');
      return false;
    }
    const signature = this.header(req.headers, 'x-oura-signature');
    const timestamp = this.header(req.headers, 'x-oura-timestamp');
    if (!signature || !timestamp) return false;
    if (!Buffer.isBuffer(req.rawBody)) return false;

    const expected = createHmac('sha256', secret)
      .update(timestamp, 'utf8')
      .update(req.rawBody)
      .digest('hex')
      .toUpperCase();

    return this.constantTimeEquals(expected, signature.toUpperCase());
  }

  /**
   * Parse a verified webhook into provider events. Each Oura event references
   * one changed object; the controller fetches + normalizes the referenced
   * record. We do NOT trust the body shape until it is Zod-validated upstream
   * — this method assumes the controller validated it first.
   */
  parseWebhook(req: RawWebhookRequest): ProviderEvent[] {
    let parsed: OuraWebhookEvent;
    try {
      parsed = JSON.parse(req.rawBody.toString('utf8')) as OuraWebhookEvent;
    } catch {
      return [];
    }
    if (!parsed || !parsed.object_id || !parsed.data_type) return [];
    return [
      {
        providerEventId: this.eventId(parsed),
        type: `${parsed.data_type}.${parsed.event_type}`,
        records: [],
      },
    ];
  }

  /**
   * Fetch a single changed object referenced by a webhook event and return it
   * wrapped for the normalizer. Public so the webhook controller can pull
   * just-changed records without re-running a full backfill (#21).
   */
  async fetchChangedRecord(
    conn: WearableConnection,
    event: OuraWebhookEvent,
  ): Promise<RawRecord[]> {
    const accessToken = (conn as unknown as { decryptedAccessToken?: string })
      .decryptedAccessToken;
    if (!accessToken) {
      throw new Error('oura.fetchChangedRecord: connection has no access token');
    }
    const collection = this.dataTypeToCollection(event.data_type);
    if (!collection) return [];

    const res = await this.http.request(
      `${OURA_API_BASE}/${collection}/${encodeURIComponent(event.object_id)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        label: `oura.webhook.${collection}`,
      },
    );
    const record = (await res.json()) as unknown;
    return [
      this.wrap(
        collection,
        { userId: conn.user_id, connectionId: conn.id, sourceTz: null },
        record,
      ),
    ];
  }

  /** Stable provider-native event id for {@link WearableProcessedEvent}. */
  eventId(event: OuraWebhookEvent): string {
    // Oura events have no single id field; the (data_type, object_id,
    // event_type, event_time) tuple is unique per delivery and stable across
    // redeliveries of the SAME change.
    return `${event.data_type}:${event.object_id}:${event.event_type}:${event.event_time}`;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async fetchCollection(
    accessToken: string,
    collection: OuraCollection,
    window: Record<string, string>,
    label: string,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let nextToken: string | null | undefined;
    // Bounded page loop — Oura caps page size; the date window bounds it too.
    do {
      const params = new URLSearchParams(window);
      if (nextToken) params.set('next_token', nextToken);
      const url = `${OURA_API_BASE}/${collection}?${params.toString()}`;
      const res = await this.http.request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        label,
      });
      const page = (await res.json()) as OuraListResponse<unknown>;
      if (Array.isArray(page?.data)) out.push(...page.data);
      nextToken = page?.next_token ?? null;
    } while (nextToken);
    return out;
  }

  private wrap(
    collection: OuraCollection,
    ctx: { userId: string; connectionId: string; sourceTz: string | null },
    record: unknown,
  ): RawRecord {
    const payload: OuraRawPayload = {
      collection,
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      sourceTz: ctx.sourceTz,
      record,
    };
    const id = (record as { id?: string })?.id;
    return {
      id: typeof id === 'string' ? id : undefined,
      provider: WearableProvider.OURA,
      payload,
    };
  }

  private async postToken(
    body: URLSearchParams,
    label: string,
  ): Promise<OuraTokenResponse> {
    const res = await this.http.request(OURA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      label,
    });
    return (await res.json()) as OuraTokenResponse;
  }

  private toTokenSet(
    token: OuraTokenResponse,
    fallbackRefresh?: string,
  ): TokenSet {
    const refreshToken = token.refresh_token ?? fallbackRefresh;
    if (!refreshToken) {
      throw new Error('oura: token response missing refresh_token');
    }
    return {
      refreshToken,
      accessToken: token.access_token,
      accessTokenExpiresAt:
        typeof token.expires_in === 'number'
          ? new Date(Date.now() + token.expires_in * 1000)
          : undefined,
      scopes: token.scope ? token.scope.split(/\s+/).filter(Boolean) : undefined,
    };
  }

  private dataTypeToCollection(dataType: string): OuraCollection | null {
    switch (dataType) {
      case 'daily_sleep':
      case 'daily_readiness':
      case 'daily_activity':
      case 'daily_spo2':
      case 'sleep':
      case 'workout':
      case 'session':
        return dataType;
      default:
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
      msg: 'wearables.oura.connection_error',
      op,
      provider: 'OURA',
      // Already redacted — safe to log.
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
      throw new Error(`oura: ${name} is not configured`);
    }
    return v;
  }
}

/** Singleton-friendly factory used by the connector definition export. */
export function createOuraConnector(
  http: ProviderHttpClient,
  prisma?: PrismaService,
): OuraConnector {
  return new OuraConnector(http, prisma);
}
