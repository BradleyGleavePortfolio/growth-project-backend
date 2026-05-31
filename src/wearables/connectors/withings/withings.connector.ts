import { timingSafeEqual } from 'crypto';
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
import {
  normalizeWithings,
  WithingsRawPayload,
} from './withings.normalizer';
import {
  WITHINGS_APPLI_SLEEP,
  WITHINGS_APPLI_WEIGHT,
  WITHINGS_SCOPES,
  WITHINGS_STATUS_OK,
  WithingsCollection,
  WithingsEnvelope,
  WithingsMeasureBody,
  WithingsMeasureGroup,
  WithingsNotifyEvent,
  WithingsSleepSummaryBody,
  WithingsSleepSummarySeries,
  WithingsTokenBody,
} from './withings.types';

/**
 * PR-HK-2.i — Withings API connector (OAuth2 + notify webhook + backfill).
 *
 * Implements the PR-HK-0 {@link WearableConnector} contract. All cloud calls
 * route through {@link ProviderHttpClient} so timeout + capped jittered backoff
 * are applied uniformly (#35/#50). OAuth client credentials are read from env
 * (`WITHINGS_CLIENT_ID` / `WITHINGS_CLIENT_SECRET`) — never hardcoded, never
 * logged (#1/#12).
 *
 * Endpoints (verified against https://developer.withings.com, May 2026):
 *  - authorize  https://account.withings.com/oauth2_user/authorize2
 *  - token      https://wbsapi.withings.net/v2/oauth2     (action=requesttoken / refresh_token)
 *  - measures   https://wbsapi.withings.net/measure       (action=getmeas)
 *  - sleep      https://wbsapi.withings.net/v2/sleep       (action=getsummary)
 *
 * Withings wraps every response in `{ status, body }`; a non-zero `status` is an
 * application-level error even on an HTTP 200, so the connector inspects it and
 * fails loud (#36). OAuth token data also lives under `body` (not at the top
 * level) — unwrapped by {@link unwrap}.
 *
 * Webhook security: Withings Health Data notify callbacks are plain
 * form-encoded HTTP POSTs (`userid`, `startdate`, `enddate`, `appli`) that
 * carry NO provider-issued signature header or body HMAC — the documented
 * Withings spec only uses `signature`/`nonce` on the *subscribe* request we
 * send to Withings (server→provider), never on the callback Withings sends to
 * us (provider→server). Authenticity is therefore established the way Withings
 * actually supports it: the callback is delivered to the exact secret URL we
 * registered via `notify subscribe`. We register a `callbackurl` whose path/
 * query carries an unguessable server-minted secret token
 * (`?secret=<WITHINGS_WEBHOOK_SECRET>`); only Withings (and us) know that URL,
 * so a genuine callback always presents the matching secret. `verifyWebhook`
 * compares the presented callback secret against `WITHINGS_WEBHOOK_SECRET`
 * constant-time (`crypto.timingSafeEqual`). It FAILS CLOSED when the secret is
 * unset, missing on the request, or mismatched (audit pattern #5). No
 * synthetic HMAC header/body signature is required of Withings.
 */

const WITHINGS_AUTHORIZE_URL =
  'https://account.withings.com/oauth2_user/authorize2';
const WITHINGS_TOKEN_URL = 'https://wbsapi.withings.net/v2/oauth2';
const WITHINGS_MEASURE_URL = 'https://wbsapi.withings.net/measure';
const WITHINGS_SLEEP_URL = 'https://wbsapi.withings.net/v2/sleep';

/** Provider TOS backfill ceiling — Withings ≤ 90 days (Agent 2 §3.1). */
const WITHINGS_MAX_BACKFILL_DAYS = 90;

/** Body measure types pulled at backfill (weight, fat ratio, BP dia/sys). §3.1 */
const WITHINGS_MEASURE_TYPES = '1,6,9,10';

/**
 * Strip token-like secrets from an error message before it is persisted to
 * `WearableConnection.last_error` or logged (audit pattern #7 / #1/#12).
 * Defined and exported INSIDE the withings module only (connector-scoped — no
 * cross-file changes); exported solely so the connector spec can unit-test the
 * redaction directly. Redacts common credential patterns that can leak into
 * upstream HTTP error strings (`token=`, `code=`, `client_secret=`,
 * `refresh_token=`, `access_token=`, `signature=`, `Authorization: Bearer …`,
 * and bare `Bearer <token>`), then caps length.
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
      /\b(access_token|refresh_token|client_secret|client_id|token|code|signature)=[^&\s"',]+/gi,
      '$1=[REDACTED]',
    )
    // `Authorization: <scheme> <token>` header — redact the credential while
    // keeping the scheme word so the message stays diagnostic.
    .replace(
      /(authorization\s*[:=]\s*)(Bearer|Basic)\s+[^\s"',]+/gi,
      '$1$2 [REDACTED]',
    )
    // Bare `Bearer <token>` / `Basic <token>` not preceded by a header label.
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/g, 'Basic [REDACTED]')
    // Any remaining `authorization: <value>` credential not already handled.
    .replace(
      /\b(authorization)(\s*[:=]\s*)(?!Bearer\b|Basic\b|\[REDACTED\])[^\s"',]+/gi,
      '$1$2[REDACTED]',
    );

  return redacted.slice(0, 500) || 'unknown';
}

@Injectable()
export class WithingsConnector implements WearableConnector {
  readonly provider: WearableProvider = WearableProvider.WITHINGS;
  readonly authModel: WearableAuthModel = 'oauth2';

  private readonly logger = new Logger(WithingsConnector.name);

  /**
   * `prisma` is optional so the pure OAuth/normalize/verify unit tests can
   * construct the connector with just an HTTP client. When present (the DI path
   * under {@link WithingsModule}), backfill/refresh provider outages mark the
   * connection `status='error'` with a REDACTED `last_error` before rethrowing
   * (fail-loud + fail-explicit). When absent, the failure still rethrows — we
   * simply skip the status write.
   */
  constructor(
    private readonly http: ProviderHttpClient,
    private readonly prisma?: PrismaService,
  ) {}

  // ── OAuth ────────────────────────────────────────────────────────────────

  /**
   * Build the Withings authorization URL for a connect flow. `state` is the
   * server-minted CSRF state (PR-HK-1 owns generation/validation). The
   * `redirect_uri` is read from env so it is environment-correct without a code
   * change.
   */
  buildAuthUrl(_userId: string, state: string): string {
    const clientId = this.requireEnv('WITHINGS_CLIENT_ID');
    const redirectUri = this.requireEnv('WITHINGS_REDIRECT_URI');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: WITHINGS_SCOPES.join(','),
      state,
    });
    return `${WITHINGS_AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Exchange an authorization `code` for a {@link TokenSet}. */
  async exchangeCode(code: string): Promise<TokenSet> {
    const clientId = this.requireEnv('WITHINGS_CLIENT_ID');
    const clientSecret = this.requireEnv('WITHINGS_CLIENT_SECRET');
    const redirectUri = this.requireEnv('WITHINGS_REDIRECT_URI');

    const body = new URLSearchParams({
      action: 'requesttoken',
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const token = await this.postToken(body, 'withings.exchangeCode');
    return this.toTokenSet(token);
  }

  /** Refresh an expiring access token using the connection's refresh token. */
  async refresh(conn: WearableConnection): Promise<TokenSet> {
    try {
      return await this.refreshInner(conn);
    } catch (err) {
      // Fail-explicit: a provider outage (or invalid_grant) during refresh
      // marks the connection in error with a redacted message, then rethrows so
      // PR-HK-1's token lane can react (re-consent / disable).
      await this.markConnectionError(conn, err, 'withings.refresh');
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
      throw new Error('withings.refresh: connection has no refresh token');
    }
    const clientId = this.requireEnv('WITHINGS_CLIENT_ID');
    const clientSecret = this.requireEnv('WITHINGS_CLIENT_SECRET');

    const body = new URLSearchParams({
      action: 'requesttoken',
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const token = await this.postToken(body, 'withings.refresh');
    // Withings always rotates the refresh token, but fall back to the existing
    // one defensively so the connection layer never persists an empty token.
    return this.toTokenSet(token, rt);
  }

  // ── Backfill ───────────────────────────────────────────────────────────────

  /**
   * Pull provider history since `since`, clamped to the Withings ≤90d TOS
   * window. Fetches body measures (weight, fat, BP) and sleep summaries, paging
   * each internally (Withings `more`/`offset`), and returns wrapped
   * {@link RawRecord}s for the normalizer — never N+1 against the ingestion lane
   * (#21): the caller batch-ingests the returned array once.
   */
  async backfill(conn: WearableConnection, since: Date): Promise<RawRecord[]> {
    try {
      return await this.backfillInner(conn, since);
    } catch (err) {
      // Fail-explicit: a provider outage during backfill marks the connection
      // in error with a redacted message, then rethrows so the caller (sync
      // job) sees the failure (no silent swallow, #36/#50).
      await this.markConnectionError(conn, err, 'withings.backfill');
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
      throw new Error('withings.backfill: connection has no access token');
    }

    const now = new Date();
    const floor = new Date(
      now.getTime() - WITHINGS_MAX_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
    );
    const effectiveSince = since.getTime() < floor.getTime() ? floor : since;
    const startEpoch = Math.floor(effectiveSince.getTime() / 1000);
    const endEpoch = Math.floor(now.getTime() / 1000);

    const ctxBase = {
      userId: conn.user_id,
      connectionId: conn.id,
      sourceTz: null as string | null,
    };

    const records: RawRecord[] = [];

    const measureGroups = await this.fetchMeasures(
      accessToken,
      startEpoch,
      endEpoch,
    );
    for (const group of measureGroups) {
      records.push(this.wrap('measure', ctxBase, group));
    }

    const sleepSeries = await this.fetchSleepSummaries(
      accessToken,
      effectiveSince,
      now,
    );
    for (const series of sleepSeries) {
      records.push(this.wrap('sleep', ctxBase, series));
    }

    return records;
  }

  // ── Normalize ──────────────────────────────────────────────────────────────

  /** Delegate to the pure normalizer (Agent 2 §3.1). */
  normalize(raw: RawRecord[]): NormalizedSample[] {
    return normalizeWithings(raw);
  }

  // ── Webhook ────────────────────────────────────────────────────────────────

  /**
   * Verify a Withings notify callback's authenticity.
   *
   * Withings Health Data notify callbacks do NOT carry a provider HMAC header
   * or body signature — per the Withings API reference, `signature`/`nonce` are
   * parameters of the *subscribe* request we send to Withings, and the docs
   * explicitly say not to use them for Health Data API subscriptions; the
   * inbound callback is a plain form-encoded POST. The provider-supported way
   * to authenticate the callback is to register an unguessable secret callback
   * URL: Withings delivers to the exact `callbackurl` we registered, so a
   * genuine callback always presents the secret token embedded in that URL.
   *
   * `presentedSecret` is the secret the controller extracted from the inbound
   * request URL (the `?secret=` query param of our registered callback URL; an
   * `X-Webhook-Secret` header is also accepted for proxy setups that move the
   * token out of the URL). We compare it constant-time against the configured
   * `WITHINGS_WEBHOOK_SECRET`. FAILS CLOSED (returns false) when the secret is
   * unset, absent on the request, or mismatched — the controller maps a false
   * to a single 401 (audit pattern #5). No synthetic header/body HMAC over the
   * payload bytes is required.
   */
  verifyWebhook(req: RawWebhookRequest): boolean {
    const secret = process.env.WITHINGS_WEBHOOK_SECRET;
    if (!secret) {
      // Fail closed: an unconfigured secret can never authenticate a request.
      this.logger.error(
        'withings.verifyWebhook: WITHINGS_WEBHOOK_SECRET not configured',
      );
      return false;
    }
    if (!Buffer.isBuffer(req.rawBody)) return false;

    // The callback secret may arrive either as the `secret` query param of our
    // registered callback URL (default; carried into the headers map as
    // `x-webhook-secret` by the controller) or as an `X-Webhook-Secret` header
    // when an upstream proxy strips it from the URL. Both resolve to the same
    // server-minted token.
    const presented = this.header(req.headers, 'x-webhook-secret');
    if (!presented) return false;

    return this.constantTimeEquals(secret, presented);
  }

  /**
   * Parse a verified notify callback into provider events. Each callback
   * references one changed window for one `appli` category; the controller
   * fetches + normalizes the referenced records. Assumes the controller
   * Zod-validated the body first.
   */
  parseWebhook(req: RawWebhookRequest): ProviderEvent[] {
    const event = this.parseNotifyBody(req.rawBody);
    if (!event) return [];
    return [
      {
        providerEventId: this.eventId(event),
        type: `withings.appli.${event.appli}`,
        records: [],
      },
    ];
  }

  /**
   * Fetch the records referenced by a notify callback and return them wrapped
   * for the normalizer. Public so the webhook controller can pull just the
   * just-changed window without re-running a full backfill (#21). Maps the
   * `appli` category to the correct Withings data endpoint over the
   * `[startdate, enddate]` window the callback referenced.
   */
  async fetchChangedRecord(
    conn: WearableConnection,
    event: WithingsNotifyEvent,
  ): Promise<RawRecord[]> {
    const accessToken = (conn as unknown as { decryptedAccessToken?: string })
      .decryptedAccessToken;
    if (!accessToken) {
      throw new Error(
        'withings.fetchChangedRecord: connection has no access token',
      );
    }
    const appli = Number(event.appli);
    const startEpoch = Number(event.startdate);
    const endEpoch = Number(event.enddate);
    const ctxBase = {
      userId: conn.user_id,
      connectionId: conn.id,
      sourceTz: null as string | null,
    };

    if (appli === WITHINGS_APPLI_WEIGHT) {
      const groups = await this.fetchMeasures(
        accessToken,
        startEpoch,
        endEpoch,
      );
      return groups.map((g) => this.wrap('measure', ctxBase, g));
    }
    if (appli === WITHINGS_APPLI_SLEEP) {
      const series = await this.fetchSleepSummaries(
        accessToken,
        new Date(startEpoch * 1000),
        new Date(endEpoch * 1000),
      );
      return series.map((s) => this.wrap('sleep', ctxBase, s));
    }
    // Unknown/unhandled appli category — nothing to fetch.
    return [];
  }

  /** Stable provider-native event id for {@link WearableProcessedEvent}. */
  eventId(event: WithingsNotifyEvent): string {
    // Withings callbacks carry no single id; the (userid, appli, startdate,
    // enddate) tuple is unique per delivered change and stable across
    // redeliveries of the SAME notification.
    return `${event.userid}:${event.appli}:${event.startdate}:${event.enddate}`;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Fetch + page all body measure groups in `[startEpoch, endEpoch]`. */
  private async fetchMeasures(
    accessToken: string,
    startEpoch: number,
    endEpoch: number,
  ): Promise<WithingsMeasureGroup[]> {
    const out: WithingsMeasureGroup[] = [];
    let offset: number | undefined;
    do {
      const params = new URLSearchParams({
        action: 'getmeas',
        meastypes: WITHINGS_MEASURE_TYPES,
        category: '1',
        startdate: String(startEpoch),
        enddate: String(endEpoch),
      });
      if (offset != null) params.set('offset', String(offset));
      const body = await this.postData<WithingsMeasureBody>(
        WITHINGS_MEASURE_URL,
        params,
        accessToken,
        'withings.backfill.measure',
      );
      if (Array.isArray(body?.measuregrps)) out.push(...body.measuregrps);
      offset = body?.more === 1 ? body.offset : undefined;
    } while (offset != null);
    return out;
  }

  /** Fetch + page all sleep summaries over the `[from, to]` day span. */
  private async fetchSleepSummaries(
    accessToken: string,
    from: Date,
    to: Date,
  ): Promise<WithingsSleepSummarySeries[]> {
    const out: WithingsSleepSummarySeries[] = [];
    let offset: number | undefined;
    do {
      const params = new URLSearchParams({
        action: 'getsummary',
        startdateymd: this.toDateString(from),
        enddateymd: this.toDateString(to),
      });
      if (offset != null) params.set('offset', String(offset));
      const body = await this.postData<WithingsSleepSummaryBody>(
        WITHINGS_SLEEP_URL,
        params,
        accessToken,
        'withings.backfill.sleep',
      );
      if (Array.isArray(body?.series)) out.push(...body.series);
      offset = body?.more === 1 ? body.offset : undefined;
    } while (offset != null);
    return out;
  }

  private wrap(
    collection: WithingsCollection,
    ctx: { userId: string; connectionId: string; sourceTz: string | null },
    record: WithingsMeasureGroup | WithingsSleepSummarySeries,
  ): RawRecord {
    const payload: WithingsRawPayload = {
      collection,
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      sourceTz: ctx.sourceTz,
      record,
    };
    const id =
      collection === 'measure'
        ? (record as WithingsMeasureGroup).grpid
        : (record as WithingsSleepSummarySeries).id;
    return {
      id: id != null ? String(id) : undefined,
      provider: WearableProvider.WITHINGS,
      payload,
    };
  }

  /**
   * POST a Withings data request (form-encoded, bearer auth) and return the
   * unwrapped `body`. Throws on a non-zero application `status` so a provider
   * application error fails loud (#36) rather than yielding empty data.
   */
  private async postData<T>(
    url: string,
    params: URLSearchParams,
    accessToken: string,
    label: string,
  ): Promise<T> {
    const res = await this.http.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      label,
    });
    const env = (await res.json()) as WithingsEnvelope<T>;
    return this.unwrap(env, label);
  }

  private async postToken(
    body: URLSearchParams,
    label: string,
  ): Promise<WithingsTokenBody> {
    const res = await this.http.request(WITHINGS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      label,
    });
    const env = (await res.json()) as WithingsEnvelope<WithingsTokenBody>;
    return this.unwrap(env, label);
  }

  /** Unwrap a Withings `{ status, body }` envelope; non-zero status → throw. */
  private unwrap<T>(env: WithingsEnvelope<T>, label: string): T {
    if (!env || env.status !== WITHINGS_STATUS_OK) {
      // The provider error string is short + non-secret, but redact defensively.
      throw new Error(
        `${label}: Withings status ${env?.status ?? 'unknown'} ${redactErrorMessage(env?.error ?? '')}`,
      );
    }
    if (env.body === undefined || env.body === null) {
      throw new Error(`${label}: Withings response missing body`);
    }
    return env.body;
  }

  private toTokenSet(
    token: WithingsTokenBody,
    fallbackRefresh?: string,
  ): TokenSet {
    const refreshToken = token.refresh_token ?? fallbackRefresh;
    if (!refreshToken) {
      throw new Error('withings: token response missing refresh_token');
    }
    return {
      refreshToken,
      accessToken: token.access_token,
      accessTokenExpiresAt:
        typeof token.expires_in === 'number'
          ? new Date(Date.now() + token.expires_in * 1000)
          : undefined,
      scopes: token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : undefined,
      externalAccountId:
        token.userid != null ? String(token.userid) : undefined,
    };
  }

  /** Parse a form-encoded notify body into the typed event, or null. */
  private parseNotifyBody(rawBody: Buffer): WithingsNotifyEvent | null {
    if (!Buffer.isBuffer(rawBody)) return null;
    const params = new URLSearchParams(rawBody.toString('utf8'));
    const userid = params.get('userid');
    const startdate = params.get('startdate');
    const enddate = params.get('enddate');
    const appli = params.get('appli');
    if (!userid || !startdate || !enddate || !appli) return null;
    return { userid, startdate, enddate, appli };
  }

  /**
   * Case-insensitive header lookup. Express lower-cases inbound header names,
   * but we scan case-insensitively so the verifier is robust regardless of how
   * the controller or an upstream proxy populated the map.
   */
  private header(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | null {
    const lower = name.toLowerCase();
    let v = headers[name] ?? headers[lower];
    if (v === undefined) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lower) {
          v = headers[key];
          break;
        }
      }
    }
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
      msg: 'wearables.withings.connection_error',
      op,
      provider: 'WITHINGS',
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
      throw new Error(`withings: ${name} is not configured`);
    }
    return v;
  }
}

/** Singleton-friendly factory used by the connector definition export. */
export function createWithingsConnector(
  http: ProviderHttpClient,
  prisma?: PrismaService,
): WithingsConnector {
  return new WithingsConnector(http, prisma);
}
