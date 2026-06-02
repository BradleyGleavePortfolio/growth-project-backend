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
import { normalizePolar, PolarRawPayload } from './polar.normalizer';
import {
  PolarExercise,
  PolarNightlyRecharge,
  PolarResource,
  PolarSleep,
  PolarTokenResponse,
  PolarWebhookEvent,
} from './polar.types';

/**
 * PR-HK-2.g — Polar AccessLink API v3 connector (OAuth2 + webhook + backfill).
 *
 * Implements the PR-HK-0 {@link WearableConnector} contract. All cloud calls
 * route through {@link ProviderHttpClient} so timeout + capped jittered
 * backoff are applied uniformly (#35/#50). OAuth client credentials are read
 * from env (`POLAR_CLIENT_ID` / `POLAR_CLIENT_SECRET`) — never hardcoded,
 * never logged (#1/#12).
 *
 * Endpoints (verified against https://www.polar.com/accesslink-api/, May 2026):
 *  - authorize  https://flow.polar.com/oauth2/authorization
 *  - token      https://polarremote.com/v2/oauth2/token  (HTTP Basic auth)
 *  - data       https://www.polaraccesslink.com/v3/...
 *
 * Token endpoint: Polar authenticates the token exchange with HTTP Basic
 * (`Authorization: Basic base64(client_id:client_secret)`), NOT form-body
 * client credentials. Polar access tokens are long-lived and the endpoint
 * does not issue a refresh token; the access token itself is the durable
 * credential, so {@link refresh} re-presents the stored token (no rotation).
 *
 * Webhook signature: Polar sends `Polar-Webhook-Signature` — the LOWERCASE
 * hex HMAC-SHA256 of the raw request body keyed by the webhook signing secret
 * (`POLAR_WEBHOOK_SECRET`, returned when the webhook is created). We verify on
 * the UNPARSED bytes with a constant-time compare (`crypto.timingSafeEqual`).
 * Unlike Oura, no timestamp is prepended — the body alone is signed.
 */

const POLAR_AUTHORIZE_URL = 'https://flow.polar.com/oauth2/authorization';
const POLAR_TOKEN_URL = 'https://polarremote.com/v2/oauth2/token';
const POLAR_API_BASE = 'https://www.polaraccesslink.com/v3';

/** Scope requested at connect time (Agent 2 §3 Polar row). */
const POLAR_SCOPE = 'accesslink.read_all';

/** Provider TOS backfill ceiling — Polar transactional model, ≤28 days. */
const POLAR_MAX_BACKFILL_DAYS = 28;

/** Only the Polar resources §3.1 maps are allowed to host any URL prefix. */
const ALLOWED_HOST = 'www.polaraccesslink.com';

/**
 * Strip token-like secrets from an error message before it is persisted to
 * `WearableConnection.last_error` or logged (audit pattern 7 / #1/#12).
 * Connector-scoped (no cross-file changes); exported solely so the connector
 * spec can unit-test the redaction. Redacts common credential patterns that
 * can leak into upstream HTTP error strings, then caps length.
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

/** Stable sha256 user hash for log lines (audit pattern 3 — never raw ids). */
function userHash(userId: string): string {
  return createHmac('sha256', 'polar-log-salt')
    .update(userId)
    .digest('hex')
    .slice(0, 16);
}

@Injectable()
export class PolarConnector implements WearableConnector {
  readonly provider: WearableProvider = WearableProvider.POLAR;
  readonly authModel: WearableAuthModel = 'oauth2';

  private readonly logger = new Logger(PolarConnector.name);

  /**
   * `prisma` is optional so the pure OAuth/normalize/verify unit tests can
   * construct the connector with just an HTTP client. When present (the DI
   * path under {@link PolarModule}), backfill/refresh provider outages mark
   * the connection `status='error'` with a REDACTED `last_error` before
   * rethrowing (fail-loud + fail-explicit). When absent, the failure still
   * rethrows — we simply skip the status write.
   */
  constructor(
    private readonly http: ProviderHttpClient,
    private readonly prisma?: PrismaService,
  ) {}

  // ── OAuth ────────────────────────────────────────────────────────────────

  /**
   * Build the Polar authorization URL for a connect flow. `state` is the
   * server-minted CSRF state (PR-HK-1 owns generation/validation). The
   * `redirect_uri` is read from env so it is environment-correct without a
   * code change.
   */
  buildAuthUrl(_userId: string, state: string): string {
    const clientId = this.requireEnv('POLAR_CLIENT_ID');
    const redirectUri = this.requireEnv('POLAR_REDIRECT_URI');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: POLAR_SCOPE,
      state,
    });
    return `${POLAR_AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Exchange an authorization `code` for a {@link TokenSet}. */
  async exchangeCode(code: string): Promise<TokenSet> {
    const redirectUri = this.requireEnv('POLAR_REDIRECT_URI');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const token = await this.postToken(body, 'polar.exchangeCode');
    return this.toTokenSet(token);
  }

  /**
   * "Refresh" an access token. Polar access tokens are long-lived and the
   * token endpoint issues no refresh token, so there is nothing to rotate:
   * we re-present the stored credential as the current token set. Kept as a
   * method (not a no-op throw) so PR-HK-1's token lane has a uniform contract
   * across providers. On a missing token we fail explicit.
   */
  async refresh(conn: WearableConnection): Promise<TokenSet> {
    try {
      return await this.refreshInner(conn);
    } catch (err) {
      await this.markConnectionError(conn, err, 'polar.refresh');
      throw err;
    }
  }

  private refreshInner(conn: WearableConnection): Promise<TokenSet> {
    const stored =
      (conn as { refresh_token?: string }).refresh_token ??
      (conn as unknown as { decryptedRefreshToken?: string })
        .decryptedRefreshToken ??
      (conn as unknown as { decryptedAccessToken?: string })
        .decryptedAccessToken;
    if (!stored) {
      throw new Error('polar.refresh: connection has no stored token');
    }
    // Polar tokens do not rotate via a refresh grant. The durable credential
    // is re-presented unchanged; the access token equals the refresh token.
    return Promise.resolve({
      refreshToken: stored,
      accessToken: stored,
      scopes: [POLAR_SCOPE],
    });
  }

  // ── Backfill ───────────────────────────────────────────────────────────────

  /**
   * Pull provider history since `since`, clamped to the Polar ≤28d window.
   * Lists exercises and the per-date sleep + nightly-recharge resources, then
   * returns wrapped {@link RawRecord}s for the normalizer — never N+1 against
   * the ingestion lane (#21): the caller batch-ingests the returned array once.
   */
  async backfill(conn: WearableConnection, since: Date): Promise<RawRecord[]> {
    try {
      return await this.backfillInner(conn, since);
    } catch (err) {
      await this.markConnectionError(conn, err, 'polar.backfill');
      throw err;
    }
  }

  private async backfillInner(
    conn: WearableConnection,
    since: Date,
  ): Promise<RawRecord[]> {
    const accessToken = this.resolveAccessToken(conn, 'polar.backfill');

    const now = new Date();
    const floor = new Date(
      now.getTime() - POLAR_MAX_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
    );
    const effectiveSince = since.getTime() < floor.getTime() ? floor : since;

    const ctxBase = {
      userId: conn.user_id,
      connectionId: conn.id,
      sourceTz: null as string | null,
    };

    const records: RawRecord[] = [];

    // Exercises: a flat list of recent training sessions.
    const exercises = await this.fetchJson<PolarExercise[]>(
      accessToken,
      `${POLAR_API_BASE}/exercises`,
      'polar.backfill.exercises',
    );
    if (Array.isArray(exercises)) {
      for (const record of exercises) {
        records.push(this.wrap('exercises', ctxBase, record));
      }
    }

    // Sleep + nightly-recharge are date-keyed; iterate each day in the window.
    for (const date of this.datesInWindow(effectiveSince, now)) {
      const sleep = await this.fetchJsonOrNull<PolarSleep>(
        accessToken,
        `${POLAR_API_BASE}/users/sleep/${date}`,
        'polar.backfill.sleep',
      );
      if (sleep) records.push(this.wrap('sleep', ctxBase, sleep));

      const recharge = await this.fetchJsonOrNull<PolarNightlyRecharge>(
        accessToken,
        `${POLAR_API_BASE}/users/nightly-recharge/${date}`,
        'polar.backfill.nightly-recharge',
      );
      if (recharge) {
        records.push(this.wrap('nightly-recharge', ctxBase, recharge));
      }
    }

    return records;
  }

  // ── Normalize ──────────────────────────────────────────────────────────────

  /** Delegate to the pure normalizer (Agent 2 §3.1). */
  normalize(raw: RawRecord[]): NormalizedSample[] {
    return normalizePolar(raw);
  }

  // ── Webhook ────────────────────────────────────────────────────────────────

  /**
   * Verify a Polar webhook delivery. Computes the LOWERCASE hex HMAC-SHA256 of
   * the raw body keyed by `POLAR_WEBHOOK_SECRET` and compares it against the
   * `Polar-Webhook-Signature` header in constant time. Returns false (never
   * throws) on any missing input or mismatch so the controller maps it to a
   * single 401. Fails closed when the secret is unconfigured.
   */
  verifyWebhook(req: RawWebhookRequest): boolean {
    const secret = process.env.POLAR_WEBHOOK_SECRET;
    if (!secret) {
      // Fail closed: an unconfigured secret can never authenticate a request.
      this.logger.error('polar.verifyWebhook: POLAR_WEBHOOK_SECRET not configured');
      return false;
    }
    const signature = this.header(req.headers, 'polar-webhook-signature');
    if (!signature) return false;
    if (!Buffer.isBuffer(req.rawBody)) return false;

    const expected = createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('hex')
      .toLowerCase();

    return this.constantTimeEquals(expected, signature.toLowerCase());
  }

  /**
   * Parse a verified webhook into provider events. Assumes the controller
   * already Zod-validated the body. A `PING` event yields no records.
   */
  parseWebhook(req: RawWebhookRequest): ProviderEvent[] {
    let parsed: PolarWebhookEvent;
    try {
      parsed = JSON.parse(req.rawBody.toString('utf8')) as PolarWebhookEvent;
    } catch {
      return [];
    }
    if (!parsed || !parsed.event) return [];
    return [
      {
        providerEventId: this.eventId(parsed),
        type: parsed.event,
        records: [],
      },
    ];
  }

  /**
   * Fetch the single changed resource referenced by a webhook event and return
   * it wrapped for the normalizer. Public so the webhook controller can pull
   * just-changed records without re-running a full backfill (#21). A `PING`
   * (or any non-data) event returns no records.
   */
  async fetchChangedRecord(
    conn: WearableConnection,
    event: PolarWebhookEvent,
  ): Promise<RawRecord[]> {
    const resource = this.eventToResource(event.event);
    if (!resource) return [];

    const url = this.safeResourceUrl(event, resource);
    if (!url) return [];

    const accessToken = this.resolveAccessToken(
      conn,
      'polar.fetchChangedRecord',
    );

    const record = await this.fetchJson<unknown>(
      accessToken,
      url,
      `polar.webhook.${resource}`,
    );
    return [
      this.wrap(
        resource,
        { userId: conn.user_id, connectionId: conn.id, sourceTz: null },
        record,
      ),
    ];
  }

  /** Stable provider-native event id for {@link WearableProcessedEvent}. */
  eventId(event: PolarWebhookEvent): string {
    // Polar events have no single id field; the (event, user_id,
    // entity_id|date, timestamp) tuple is unique per delivery and stable
    // across redeliveries of the SAME change.
    const subject = event.entity_id ?? event.date ?? '';
    const user = event.user_id != null ? String(event.user_id) : '';
    return `${event.event}:${user}:${subject}:${event.timestamp}`;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Map a Polar webhook event type to a §3.1-mapped resource, or null. */
  private eventToResource(eventType: string): PolarResource | null {
    switch (eventType) {
      case 'EXERCISE':
        return 'exercises';
      case 'SLEEP':
        return 'sleep';
      case 'NIGHTLY_RECHARGE':
        return 'nightly-recharge';
      default:
        return null;
    }
  }

  /**
   * Resolve the resource URL to fetch for an event. Polar supplies an absolute
   * `url`; we trust it ONLY if its host is the AccessLink host (SSRF guard).
   * For date-keyed resources lacking a usable `url` we reconstruct the
   * documented path from `date`.
   */
  private safeResourceUrl(
    event: PolarWebhookEvent,
    resource: PolarResource,
  ): string | null {
    if (event.url) {
      try {
        const parsed = new URL(event.url);
        if (parsed.host === ALLOWED_HOST && parsed.protocol === 'https:') {
          return parsed.toString();
        }
      } catch {
        // fall through to reconstruction
      }
    }
    if (resource === 'exercises' && event.entity_id) {
      return `${POLAR_API_BASE}/exercises/${encodeURIComponent(event.entity_id)}`;
    }
    if (resource === 'sleep' && event.date) {
      return `${POLAR_API_BASE}/users/sleep/${encodeURIComponent(event.date)}`;
    }
    if (resource === 'nightly-recharge' && event.date) {
      return `${POLAR_API_BASE}/users/nightly-recharge/${encodeURIComponent(
        event.date,
      )}`;
    }
    return null;
  }

  /** Read the durable access credential off a (KMS-unwrapped) connection. */
  private resolveAccessToken(conn: WearableConnection, op: string): string {
    const token =
      (conn as unknown as { decryptedAccessToken?: string })
        .decryptedAccessToken ??
      (conn as unknown as { decryptedRefreshToken?: string })
        .decryptedRefreshToken;
    if (!token) {
      throw new Error(`${op}: connection has no access token`);
    }
    return token;
  }

  private async fetchJson<T>(
    accessToken: string,
    url: string,
    label: string,
  ): Promise<T> {
    const res = await this.http.request(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      label,
    });
    return (await res.json()) as T;
  }

  /**
   * Like {@link fetchJson} but treats a 204 No Content (Polar's "no data for
   * this date") as `null` instead of an error. The ProviderHttpClient only
   * returns on `ok` responses, so a 2xx with an empty body parses to null.
   */
  private async fetchJsonOrNull<T>(
    accessToken: string,
    url: string,
    label: string,
  ): Promise<T | null> {
    const res = await this.http.request(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      label,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private wrap(
    resource: PolarResource,
    ctx: { userId: string; connectionId: string; sourceTz: string | null },
    record: unknown,
  ): RawRecord {
    const payload: PolarRawPayload = {
      resource,
      userId: ctx.userId,
      connectionId: ctx.connectionId,
      sourceTz: ctx.sourceTz,
      record,
    };
    const id = (record as { id?: string | number })?.id;
    return {
      id: id != null ? String(id) : undefined,
      provider: WearableProvider.POLAR,
      payload,
    };
  }

  private async postToken(
    body: URLSearchParams,
    label: string,
  ): Promise<PolarTokenResponse> {
    const clientId = this.requireEnv('POLAR_CLIENT_ID');
    const clientSecret = this.requireEnv('POLAR_CLIENT_SECRET');
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await this.http.request(POLAR_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
      },
      body: body.toString(),
      label,
    });
    return (await res.json()) as PolarTokenResponse;
  }

  private toTokenSet(token: PolarTokenResponse): TokenSet {
    // Polar issues no refresh token; the access token is the durable
    // credential. Persist it as BOTH so PR-HK-1's token layer always has a
    // non-empty refresh token to KMS-wrap.
    const durable = token.refresh_token ?? token.access_token;
    if (!durable) {
      throw new Error('polar: token response missing access_token');
    }
    return {
      refreshToken: durable,
      accessToken: token.access_token,
      accessTokenExpiresAt:
        typeof token.expires_in === 'number'
          ? new Date(Date.now() + token.expires_in * 1000)
          : undefined,
      scopes: [POLAR_SCOPE],
      externalAccountId:
        token.x_user_id != null ? String(token.x_user_id) : undefined,
    };
  }

  /** Inclusive list of `YYYY-MM-DD` dates in [from, to], UTC. */
  private datesInWindow(from: Date, to: Date): string[] {
    const out: string[] = [];
    const cursor = new Date(
      Date.UTC(
        from.getUTCFullYear(),
        from.getUTCMonth(),
        from.getUTCDate(),
      ),
    );
    const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    // Bounded by the ≤28d clamp applied upstream.
    while (cursor.getTime() <= end) {
      out.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
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

  /**
   * Mark a connection `status='error'` with a redacted error message on a
   * provider-side failure, best-effort (never masks the original error). No-op
   * when `prisma` was not injected or the connection has no id. Logs only
   * redacted, PII-free metadata (audit patterns 3 + 7).
   */
  private async markConnectionError(
    conn: WearableConnection,
    err: unknown,
    op: string,
  ): Promise<void> {
    const message = redactErrorMessage(err);
    this.logger.error({
      msg: 'wearables.polar.connection_error',
      op,
      provider: 'POLAR',
      user_id_hash: conn?.user_id ? userHash(conn.user_id) : undefined,
      error_class: err instanceof Error ? err.name : 'unknown',
      // Already redacted — safe to log.
      error_message: message,
    });
    if (!this.prisma || !conn?.id) return;
    // Persist the error status — best-effort, but NEVER silent. If the write
    // itself fails we log it with structured, PII-free context so the failed
    // trust-indicator update is observable; the original provider error still
    // rethrows at the call site (audit patterns #34/#36).
    try {
      await this.prisma.wearableConnection.update({
        where: { id: conn.id },
        data: { status: 'error', last_error: message },
      });
    } catch (markErr) {
      this.logger.error({
        msg: 'wearables.polar.connection_error_persist_failed',
        op,
        provider: 'POLAR',
        user_id_hash: conn?.user_id ? userHash(conn.user_id) : undefined,
        error_class: markErr instanceof Error ? markErr.name : 'unknown',
        // Redacted — safe to log; never persisted nor surfaced to clients.
        error_message: redactErrorMessage(markErr),
      });
    }
  }

  private requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
      throw new Error(`polar: ${name} is not configured`);
    }
    return v;
  }
}

/** Singleton-friendly factory used by the connector definition export. */
export function createPolarConnector(
  http: ProviderHttpClient,
  prisma?: PrismaService,
): PolarConnector {
  return new PolarConnector(http, prisma);
}
