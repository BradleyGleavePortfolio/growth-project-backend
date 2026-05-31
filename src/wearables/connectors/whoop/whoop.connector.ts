import { createHmac, timingSafeEqual } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { WearableConnection, WearableProvider } from '@prisma/client';
import { KmsService } from '../../../common/kms/kms.service';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../../normalization/normalizer.types';
import { ProviderHttpClient } from '../../http/provider-http-client';
import {
  ProviderEvent,
  RawWebhookRequest,
  WearableAuthModel,
  WearableConnector,
} from '../connector.interface';
import { normalizeWhoop } from './whoop.normalizer';
import {
  WhoopPaginatedResponse,
  WhoopRawPayload,
  WhoopRecordKind,
  WhoopWebhookPayload,
  WHOOP_SIGNATURE_HEADER,
  WHOOP_SIGNATURE_TIMESTAMP_HEADER,
} from './whoop.types';

/**
 * PR-HK-2.l — WHOOP API v2 cloud connector (OAuth + backfill + refresh +
 * webhook verification).
 *
 * Mirrors the Oura connector (PR-HK-2.k) pattern, adapted to WHOOP v2:
 *  - OAuth2 with the `offline` scope so WHOOP returns a (rotating) refresh
 *    token — every refresh yields a NEW refresh token which the connection
 *    layer re-persists (KMS-wrapped).
 *  - All cloud calls route through the shared {@link ProviderHttpClient}
 *    (mandatory timeout + capped jittered backoff, #35/#50). No bespoke fetch.
 *  - Backfill pages each collection with `limit=25` + `next_token`, bounded
 *    to a ≤30-day window (TOS-bounded — the connector NEVER exceeds its own
 *    window, #21 no N+1 / no runaway paging).
 *  - Webhook signature is verified against the RAW bytes with a constant-time
 *    compare (`X-WHOOP-Signature` = base64 HMAC-SHA256 of
 *    `timestamp + rawBody`, keyed by the app client secret), before any
 *    parse — the Stripe-pattern raw-body HMAC.
 *
 * Secrets: `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI`,
 * `WHOOP_WEBHOOK_SECRET` (defaults to the client secret if unset — WHOOP signs
 * with the app secret). Tokens are NEVER logged (#1/#12).
 *
 * Source (verified May 2026): WHOOP API v2 — https://developer.whoop.com/api/
 *  (UUID ids, offline scope, v2 webhooks, `api.prod.whoop.com`).
 */

const WHOOP_API_BASE = 'https://api.prod.whoop.com';
const WHOOP_AUTH_URL = `${WHOOP_API_BASE}/oauth/oauth2/auth`;
const WHOOP_TOKEN_URL = `${WHOOP_API_BASE}/oauth/oauth2/token`;
const WHOOP_DEV_V2 = `${WHOOP_API_BASE}/developer/v2`;

/** Granted scopes (AGENT_2_CODING_PLAN §3 PROVIDER_MATRIX — WHOOP row). */
const WHOOP_SCOPES = [
  'read:recovery',
  'read:cycles',
  'read:workout',
  'read:sleep',
  'read:profile',
  'read:body_measurement',
  'offline',
] as const;

/** Per-page record cap (WHOOP v2 max is 25). */
const PAGE_LIMIT = 25;
/** Default backfill window (days). The connector never exceeds this. */
const DEFAULT_SINCE_DAYS = 30;
/** Hard ceiling on pages per collection — defence against a runaway cursor. */
const MAX_PAGES_PER_COLLECTION = 50;
/** Signature freshness tolerance (seconds) — rejects stale replays. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Maps a webhook event type prefix to the v2 fetch path + record kind. */
const WEBHOOK_FETCH: Record<
  string,
  { kind: WhoopRecordKind; path: (id: string) => string }
> = {
  recovery: {
    kind: 'recovery',
    // recovery is keyed by cycle in WHOOP; v2 exposes /recovery/{cycleId}
    path: (id) => `${WHOOP_DEV_V2}/cycle/${id}/recovery`,
  },
  cycle: { kind: 'cycle', path: (id) => `${WHOOP_DEV_V2}/cycle/${id}` },
  sleep: {
    kind: 'sleep',
    path: (id) => `${WHOOP_DEV_V2}/activity/sleep/${id}`,
  },
  workout: {
    kind: 'workout',
    path: (id) => `${WHOOP_DEV_V2}/activity/workout/${id}`,
  },
};

@Injectable()
export class WhoopConnector implements WearableConnector {
  private readonly logger = new Logger(WhoopConnector.name);

  readonly provider: WearableProvider = WearableProvider.WHOOP;
  readonly authModel: WearableAuthModel = 'oauth2';

  constructor(
    private readonly http: ProviderHttpClient,
    private readonly kms: KmsService,
  ) {}

  // ── Config (env) ──────────────────────────────────────────────────────

  private get clientId(): string {
    return process.env.WHOOP_CLIENT_ID ?? '';
  }
  private get clientSecret(): string {
    return process.env.WHOOP_CLIENT_SECRET ?? '';
  }
  private get redirectUri(): string {
    return process.env.WHOOP_REDIRECT_URI ?? '';
  }
  /** WHOOP signs webhooks with the app client secret unless overridden. */
  private get webhookSecret(): string {
    return process.env.WHOOP_WEBHOOK_SECRET ?? this.clientSecret;
  }

  // ── OAuth ─────────────────────────────────────────────────────────────

  /**
   * Build the WHOOP v2 authorization URL. `state` is the server-minted CSRF
   * token (PR-HK-1 owns generation/validation). Scopes are space-delimited
   * and URL-encoded; `offline` is required to receive a refresh token.
   */
  buildAuthUrl(_userId: string, state: string): string | null {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: WHOOP_SCOPES.join(' '),
      state,
    });
    return `${WHOOP_AUTH_URL}?${params.toString()}`;
  }

  /** Exchange an OAuth authorization code for a {@link TokenSet}. */
  async exchangeCode(code: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
    });
    return this.tokenRequest(body, 'whoop.exchangeCode');
  }

  /**
   * Refresh an expiring access token. WHOOP's `offline` scope returns a
   * refresh token that ROTATES — the response carries a new refresh token
   * which the connection layer must persist (the old one is invalidated).
   * `scope=offline` is re-requested so the rotated token keeps refresh power.
   *
   * Token handoff contract (symmetric with PR-HK-1 connection persistence):
   *  - The real {@link WearableConnection} stores `encrypted_refresh_token`
   *    (KMS-wrapped via {@link KmsService}, base64(JSON({v,iv,tag,ct}))). We
   *    UNWRAP it here before calling WHOOP — the connector NEVER sees a
   *    plaintext token on the row (#1/#12, schema service-role-only columns).
   *  - WHOOP rotates the refresh token; we RE-WRAP the new refresh + access
   *    tokens via `KmsService.encrypt` BEFORE returning, so the caller can
   *    persist the returned {@link TokenSet} fields straight into the
   *    `encrypted_*` columns without re-encrypting (TokenSet.refreshToken is
   *    documented "KMS-wrapped at rest"). Plaintext rotated tokens never
   *    leave this method.
   */
  async refresh(conn: WearableConnection): Promise<TokenSet> {
    if (!conn.encrypted_refresh_token) {
      throw new Error(
        'whoop.refresh: connection has no refresh token (re-consent required)',
      );
    }
    // Unwrap the KMS-wrapped refresh token (symmetric with the connection
    // layer's encrypt-on-persist).
    const refreshToken = await this.kms.decrypt(conn.encrypted_refresh_token);
    const rotated = await this.refreshAccessToken(refreshToken);
    // Re-wrap the rotated tokens before handing them back to the caller.
    return this.encryptTokenSet(rotated);
  }

  /**
   * KMS-wrap the token-bearing fields of a {@link TokenSet} so the returned
   * shape can be persisted directly into the connection's `encrypted_*`
   * columns. `KmsService.encrypt` is synchronous; we await defensively in
   * case a future async provider (AWS/GCP KMS) is swapped in behind the same
   * interface.
   */
  private async encryptTokenSet(tokens: TokenSet): Promise<TokenSet> {
    return {
      ...tokens,
      refreshToken: await this.kms.encrypt(tokens.refreshToken),
      accessToken:
        tokens.accessToken != null
          ? await this.kms.encrypt(tokens.accessToken)
          : tokens.accessToken,
    };
  }

  /**
   * Low-level refresh by raw (plaintext) refresh token (also used directly in
   * tests and by {@link backfill} when the cached access token is
   * stale/absent). Rotates: the returned {@link TokenSet.refreshToken} is the
   * NEW plaintext token — callers that persist it MUST KMS-wrap it first
   * (see {@link refresh}).
   */
  async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'offline',
    });
    return this.tokenRequest(body, 'whoop.refresh');
  }

  /** Shared OAuth token endpoint call → {@link TokenSet}. */
  private async tokenRequest(
    body: URLSearchParams,
    label: string,
  ): Promise<TokenSet> {
    const res = await this.http.request(WHOOP_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      label,
    });
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      // WHOOP returns the account id inside the access token; some flows also
      // echo it. We thread it through when present.
      user_id?: number;
    };
    if (!json.refresh_token) {
      // `offline` scope MUST yield a refresh token; its absence is a config
      // error (missing scope / wrong client) and must fail loud (#36).
      throw new Error(
        `${label}: token response missing refresh_token (offline scope required)`,
      );
    }
    return {
      refreshToken: json.refresh_token,
      accessToken: json.access_token,
      accessTokenExpiresAt: json.expires_in
        ? new Date(Date.now() + json.expires_in * 1000)
        : undefined,
      scopes: json.scope ? json.scope.split(' ').filter(Boolean) : undefined,
      externalAccountId:
        json.user_id != null ? String(json.user_id) : undefined,
    };
  }

  // ── Backfill ──────────────────────────────────────────────────────────

  /**
   * Pull WHOOP history since `since` (the connection layer passes the
   * resolved Date; default window is 30 days). Pages each of the four
   * collections — recovery, cycle, sleep, workout — via `next_token`, never
   * exceeding {@link MAX_PAGES_PER_COLLECTION}. Returns RawRecords tagged with
   * the subject + connection ids so the normalizer can build samples without
   * re-resolving the connection.
   */
  async backfill(conn: WearableConnection, since: Date): Promise<RawRecord[]> {
    const accessToken = await this.resolveAccessToken(conn);
    // Clamp the window: never reach further back than DEFAULT_SINCE_DAYS, even
    // if a caller passes an older `since` (TOS-bounded backfill).
    const floor = new Date(
      Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000,
    );
    const start = since && since > floor ? since : floor;
    const end = new Date();
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    const ctx = { userId: conn.user_id, connectionId: conn.id };

    const [recovery, cycle, sleep, workout] = await Promise.all([
      this.page('recovery', `${WHOOP_DEV_V2}/recovery`, accessToken, startIso, endIso, ctx),
      this.page('cycle', `${WHOOP_DEV_V2}/cycle`, accessToken, startIso, endIso, ctx),
      this.page('sleep', `${WHOOP_DEV_V2}/activity/sleep`, accessToken, startIso, endIso, ctx),
      this.page('workout', `${WHOOP_DEV_V2}/activity/workout`, accessToken, startIso, endIso, ctx),
    ]);

    return [...recovery, ...cycle, ...sleep, ...workout];
  }

  /**
   * Resolve a usable PLAINTEXT access token for a backfill call from the real
   * {@link WearableConnection} shape:
   *  - If `encrypted_access_token` is present and not past
   *    `access_token_expires_at`, KMS-unwrap and use it (cache hit).
   *  - Otherwise fall back to the refresh token: KMS-unwrap
   *    `encrypted_refresh_token` and run a (rotating) refresh to mint a fresh
   *    access token. The rotated tokens are NOT persisted here — the
   *    connection layer persists via `refresh()`; backfill only needs a live
   *    access token for the duration of the pull.
   *  - If neither column is present, re-consent is required — fail loud.
   *
   * The plaintext token lives only on the stack for the request; it is never
   * logged (#1/#12).
   */
  private async resolveAccessToken(conn: WearableConnection): Promise<string> {
    const expired =
      conn.access_token_expires_at != null &&
      conn.access_token_expires_at.getTime() <= Date.now();
    if (conn.encrypted_access_token && !expired) {
      return this.kms.decrypt(conn.encrypted_access_token);
    }
    if (conn.encrypted_refresh_token) {
      const refreshToken = await this.kms.decrypt(
        conn.encrypted_refresh_token,
      );
      const rotated = await this.refreshAccessToken(refreshToken);
      if (!rotated.accessToken) {
        throw new Error(
          'whoop.backfill: refresh returned no access token',
        );
      }
      return rotated.accessToken;
    }
    throw new Error(
      'whoop.backfill: connection has no access or refresh token (re-consent required)',
    );
  }

  /**
   * Page one WHOOP collection. Each page requests `limit=25` and follows
   * `next_token` until it is empty/absent or the page cap is hit. Records are
   * wrapped as {@link RawRecord} with the kind discriminator + ctx threaded
   * onto the payload.
   */
  private async page(
    kind: WhoopRecordKind,
    url: string,
    accessToken: string,
    startIso: string,
    endIso: string,
    ctx: { userId: string; connectionId: string },
  ): Promise<RawRecord[]> {
    const out: RawRecord[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const params = new URLSearchParams({
        start: startIso,
        end: endIso,
        limit: String(PAGE_LIMIT),
      });
      if (nextToken) {
        params.set('nextToken', nextToken);
      }
      const res = await this.http.request(`${url}?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        label: `whoop.backfill.${kind}`,
      });
      const json = (await res.json()) as WhoopPaginatedResponse<{ id: string }>;
      const records = Array.isArray(json.records) ? json.records : [];
      for (const rec of records) {
        const payload: WhoopRawPayload = {
          kind,
          data: rec as WhoopRawPayload['data'],
          userId: ctx.userId,
          connectionId: ctx.connectionId,
        };
        out.push({
          id: rec.id,
          provider: this.provider,
          payload,
        });
      }
      nextToken =
        json.next_token && json.next_token.length > 0
          ? json.next_token
          : undefined;
      pages += 1;
    } while (nextToken && pages < MAX_PAGES_PER_COLLECTION);

    return out;
  }

  // ── Normalize ─────────────────────────────────────────────────────────

  normalize(raw: RawRecord[]): NormalizedSample[] {
    // ctx is carried per-record on the payload (set in backfill / webhook
    // fetch); normalizeWhoop reads it there.
    return normalizeWhoop(raw);
  }

  // ── Webhook ───────────────────────────────────────────────────────────

  /**
   * Verify a WHOOP v2 webhook. WHOOP signs with `X-WHOOP-Signature` —
   * base64(HMAC-SHA256(`X-WHOOP-Signature-Timestamp` + rawBody, clientSecret)).
   * The signed message is the timestamp string CONCATENATED with the raw
   * body bytes. Comparison is constant-time (timingSafeEqual); a malformed,
   * stale, or mismatched signature returns false → the controller maps that
   * to 401 and NEVER parses the body.
   */
  verifyWebhook(req: RawWebhookRequest): boolean {
    const secret = this.webhookSecret;
    if (!secret) {
      this.logger.error(
        'whoop.verifyWebhook: no webhook/client secret configured — rejecting',
      );
      return false;
    }
    const signature = headerValue(req.headers, WHOOP_SIGNATURE_HEADER);
    const timestamp = headerValue(
      req.headers,
      WHOOP_SIGNATURE_TIMESTAMP_HEADER,
    );
    if (!signature || !timestamp) {
      return false;
    }
    // Reject stale signatures (replay window). WHOOP timestamps are epoch ms.
    const tsMs = Number(timestamp);
    if (!Number.isFinite(tsMs)) {
      return false;
    }
    const ageSec = Math.abs(Date.now() - tsMs) / 1000;
    if (ageSec > SIGNATURE_TOLERANCE_SECONDS) {
      return false;
    }

    const expected = createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(timestamp, 'utf8'), req.rawBody]))
      .digest('base64');

    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(signature, 'utf8');
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, providedBuf);
  }

  /**
   * Parse a (already-verified) WHOOP webhook into provider events. WHOOP
   * delivers a lean event (record id + user_id + type); the records are
   * fetched lazily downstream. We surface ONE event with the UUID `id` as the
   * providerEventId (dedup key segment) and the native type, carrying the
   * minimal reference RawRecord (no payload fetched here — the worker fetches
   * the full record by id when it processes the event).
   */
  parseWebhook(req: RawWebhookRequest): ProviderEvent[] {
    let payload: WhoopWebhookPayload;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8')) as WhoopWebhookPayload;
    } catch {
      return [];
    }
    if (!payload || !payload.id || !payload.type) {
      return [];
    }
    return [
      {
        providerEventId: payload.id,
        type: payload.type,
        records: [
          {
            id: payload.id,
            provider: this.provider,
            payload,
          },
        ],
      },
    ];
  }

  /**
   * Whether a webhook event signals that the user de-authorized the WHOOP
   * app. The webhook controller uses this to flip the connection to
   * `status='disconnected'` (revocation stops further deliveries).
   */
  isRevocationEvent(type: string): boolean {
    return type === 'user.deauthorized';
  }

  /** Resolve the v2 fetch descriptor for a webhook event type (or null). */
  fetchDescriptorFor(
    type: string,
  ): { kind: WhoopRecordKind; path: (id: string) => string } | null {
    const prefix = type.split('.')[0];
    return WEBHOOK_FETCH[prefix] ?? null;
  }
}

/** Read a header case-insensitively from a lower-cased map (first value). */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Test/utility helper: produce a valid `X-WHOOP-Signature` for a raw body +
 * timestamp under a secret. Lives next to the verifier so the signing contract
 * stays in one place; not exported from the module index.
 */
export function signWhoopWebhook(opts: {
  rawBody: Buffer | string;
  timestamp: string | number;
  secret: string;
}): string {
  const ts = String(opts.timestamp);
  const body =
    typeof opts.rawBody === 'string'
      ? Buffer.from(opts.rawBody, 'utf8')
      : opts.rawBody;
  return createHmac('sha256', opts.secret)
    .update(Buffer.concat([Buffer.from(ts, 'utf8'), body]))
    .digest('base64');
}
