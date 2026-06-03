import { createHash, timingSafeEqual } from 'crypto';
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
import { normalizeGarmin } from './garmin.normalizer';
import {
  GARMIN_PUSH_TOKEN_HEADER,
  GARMIN_SUMMARY_KINDS,
  GarminRawPayload,
  GarminSummary,
  GarminSummaryKind,
  GarminTokenResponse,
  GarminWebhookEnvelope,
  GarminWebhookEnvelopeSchema,
} from './garmin.types';

/**
 * PR-HK-2.d — Garmin Health API connector (partner OAuth + push + backfill).
 *
 * Implements the PR-HK-0 {@link WearableConnector} contract. Garmin differs
 * from the OAuth2 reference connectors (Oura / WHOOP / Strava) in its AUTH and
 * DELIVERY model — documented inline so the divergences are explicit:
 *
 *  1. AUTH — Garmin uses the partner OAuth model. The legacy Health API used
 *     OAuth1.0a (signed requests); the modern Health API offers OAuth2, and
 *     PKCE is on Garmin's roadmap for new partners. This connector implements
 *     the OAuth2 authorization-code flow with a confidential client
 *     (`client_secret`) and does NOT yet emit a PKCE `code_challenge`, so the
 *     registry advertises `supportsPkce: false` and the generic OAuth state
 *     service threads only CSRF state (no PKCE challenge) for Garmin. PKCE is
 *     TBD pending Garmin's client_secret rotation policy; flip the registry
 *     flag to true and add `code_challenge` here together when it lands. It
 *     reads `GARMIN_CLIENT_ID` / `GARMIN_CLIENT_SECRET` / `GARMIN_REDIRECT_URI`
 *     from env — never hardcoded, never logged (#1/#12).
 *     The `WearableAuthModel` enum in the foundation interface is
 *     (`oauth2` | `sdk-native` | `on-device`); the Garmin partner-signed push
 *     is an OAuth2-family flow, so `authModel = 'oauth2'`. The partner-signed
 *     PUSH delivery security is handled in the webhook controller (token +
 *     fail-closed), NOT via the auth model tag.
 *
 *  2. DELIVERY — Garmin pushes the ACTUAL summary payload (NOT a lean
 *     reference like WHOOP) to a pre-registered HTTPS callback as
 *     `{ "<kind>": [ …records… ] }`. There is NO per-event HMAC signature in
 *     the Garmin Health push spec, so `verifyWebhook` checks a partner-
 *     configured push token (`GARMIN_PUSH_TOKEN`) delivered on the
 *     `X-Garmin-Push-Token` header with a constant-time compare. If the token
 *     is unconfigured the verifier FAILS CLOSED (returns false) — Garmin pushes
 *     are never trusted under misconfiguration (#36 fail-loud).
 *
 *  3. BACKFILL — on connect Garmin supports up to a 90-day historical
 *     window. We clamp to {@link DEFAULT_SINCE_DAYS} and page each summary
 *     collection by ≤24h time windows (Garmin's per-request span cap),
 *     bounded by {@link MAX_WINDOWS_PER_COLLECTION} so a runaway range can
 *     never wedge a worker (#21 no N+1 / no runaway paging). All calls route
 *     through the shared {@link ProviderHttpClient} (timeout + capped jittered
 *     backoff, #35/#50).
 *
 * Token handoff is symmetric with PR-HK-1 / the WHOOP connector: refresh +
 * access tokens are stored KMS-wrapped via {@link KmsService}; this connector
 * UNWRAPS before a provider call and RE-WRAPS rotated tokens before returning
 * a {@link TokenSet} (plaintext tokens never leave a method, never logged).
 *
 * Source (verified May 2026): Garmin Health API — Summary + Backfill + Push,
 *   https://developer.garmin.com/gc-developer-program/health-api/
 */

const GARMIN_API_BASE = 'https://apis.garmin.com';
const GARMIN_WELLNESS_BASE = `${GARMIN_API_BASE}/wellness-api/rest`;
const GARMIN_AUTH_URL = 'https://connect.garmin.com/oauth2Confirm';
const GARMIN_TOKEN_URL = `${GARMIN_API_BASE}/oauth-service/oauth/token`;

/** Granted scopes (AGENT_2_CODING_PLAN §3 — Garmin row). */
const GARMIN_SCOPES = [
  'activities',
  'dailies',
  'sleeps',
  'hrv',
  'bodyComps',
] as const;

/** Default backfill window (days). Garmin allows up to 90 on connect. */
const DEFAULT_SINCE_DAYS = 90;
/** Garmin caps a single summary request to a 24h span; we page by day. */
const WINDOW_SECONDS = 24 * 60 * 60;
/** Hard ceiling on windows per collection — defence against a runaway range. */
const MAX_WINDOWS_PER_COLLECTION = 100;

/**
 * Maps a summary kind to its Garmin Health API summary endpoint. The query
 * params are `uploadStartTimeInSeconds` / `uploadEndTimeInSeconds` (epoch
 * seconds), the Garmin time-range contract for summary fetches.
 */
const SUMMARY_ENDPOINT: Record<GarminSummaryKind, string> = {
  dailies: `${GARMIN_WELLNESS_BASE}/dailies`,
  sleeps: `${GARMIN_WELLNESS_BASE}/sleeps`,
  hrv: `${GARMIN_WELLNESS_BASE}/hrv`,
  activities: `${GARMIN_WELLNESS_BASE}/activities`,
  bodyComps: `${GARMIN_WELLNESS_BASE}/bodyComps`,
};

@Injectable()
export class GarminConnector implements WearableConnector {
  private readonly logger = new Logger(GarminConnector.name);

  readonly provider: WearableProvider = WearableProvider.GARMIN;
  // Garmin partner-signed push is an OAuth2-family flow; the foundation
  // WearableAuthModel enum has no dedicated 'partner_signed' member, so we tag
  // the OAuth2 model and enforce the partner-signed PUSH security in the
  // webhook controller (token + fail-closed) — see class docstring (2).
  readonly authModel: WearableAuthModel = 'oauth2';

  constructor(
    private readonly http: ProviderHttpClient,
    private readonly kms: KmsService,
  ) {}

  // ── Config (env) ──────────────────────────────────────────────────────

  // OAuth config is fail-loud (matches the other six OAuth2 connectors, e.g.
  // wahoo/withings `requireEnv`): a missing client id / secret / redirect uri
  // must raise a clean server-side configuration error rather than emit a
  // malformed authorization URL with a blank client_id.
  private get clientId(): string {
    return this.requireEnv('GARMIN_CLIENT_ID');
  }
  private get clientSecret(): string {
    return this.requireEnv('GARMIN_CLIENT_SECRET');
  }
  private get redirectUri(): string {
    return this.requireEnv('GARMIN_REDIRECT_URI');
  }
  /**
   * Partner-configured push verification token (no per-event HMAC). Stays
   * fail-OPEN on read: when unset the webhook verifier treats every push as
   * untrusted and FAILS CLOSED (returns false), so a missing token never
   * throws at request time — see the webhook controller.
   */
  get pushToken(): string {
    return process.env.GARMIN_PUSH_TOKEN ?? '';
  }

  /** Fail-loud env read for required OAuth configuration. */
  private requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
      throw new Error(`garmin: required env var ${name} is not set`);
    }
    return v;
  }

  // ── OAuth ─────────────────────────────────────────────────────────────

  /**
   * Build the Garmin OAuth2 authorization URL. `state` is the server-minted
   * CSRF/PKCE state (PR-HK-1 owns generation/validation). Scopes are
   * space-delimited.
   */
  buildAuthUrl(_userId: string, state: string): string | null {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: GARMIN_SCOPES.join(' '),
      state,
    });
    return `${GARMIN_AUTH_URL}?${params.toString()}`;
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
    const tokens = await this.tokenRequest(body, 'garmin.exchangeCode');
    return this.encryptTokenSet(tokens);
  }

  /**
   * Refresh an expiring access token using the connection's KMS-wrapped
   * refresh token. Garmin rotates refresh tokens on the OAuth2 flow, so the
   * response's new refresh token is re-wrapped and returned for the connection
   * layer to persist (the old one is invalidated). A 401 from Garmin surfaces
   * as a thrown {@link ProviderHttpError} so the connection layer flips
   * status='expired' (re-consent required) — never a silent success (#36).
   */
  async refresh(conn: WearableConnection): Promise<TokenSet> {
    if (!conn.encrypted_refresh_token) {
      throw new Error(
        'garmin.refresh: connection has no refresh token (re-consent required)',
      );
    }
    const refreshToken = await this.kms.decrypt(conn.encrypted_refresh_token);
    const rotated = await this.refreshAccessToken(refreshToken);
    return this.encryptTokenSet(rotated);
  }

  /**
   * Low-level refresh by raw (plaintext) refresh token (also used by
   * {@link backfill} when the cached access token is stale/absent). The
   * returned {@link TokenSet.refreshToken} is the NEW PLAINTEXT token —
   * callers that persist it MUST KMS-wrap it first (see {@link refresh}).
   */
  async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    return this.tokenRequest(body, 'garmin.refresh');
  }

  /**
   * KMS-wrap the token-bearing fields of a {@link TokenSet} so the returned
   * shape can be persisted directly into the connection's `encrypted_*`
   * columns. Mirrors the WHOOP connector contract.
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

  /** Shared OAuth token endpoint call → {@link TokenSet}. */
  private async tokenRequest(
    body: URLSearchParams,
    label: string,
  ): Promise<TokenSet> {
    const res = await this.http.request(GARMIN_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      label,
    });
    const json = (await res.json()) as GarminTokenResponse;
    if (!json.refresh_token) {
      // A Garmin OAuth2 token response MUST yield a refresh token; its absence
      // is a config error (wrong client / missing scope) — fail loud (#36).
      throw new Error(`${label}: token response missing refresh_token`);
    }
    return {
      refreshToken: json.refresh_token,
      accessToken: json.access_token,
      accessTokenExpiresAt: json.expires_in
        ? new Date(Date.now() + json.expires_in * 1000)
        : undefined,
      scopes: json.scope ? json.scope.split(' ').filter(Boolean) : undefined,
      externalAccountId: json.user_id != null ? String(json.user_id) : undefined,
    };
  }

  // ── Backfill ──────────────────────────────────────────────────────────

  /**
   * Pull Garmin history since `since` (clamped to {@link DEFAULT_SINCE_DAYS}).
   * Pages each of the five summary collections by ≤24h windows (Garmin's
   * per-request span cap), never exceeding {@link MAX_WINDOWS_PER_COLLECTION}.
   * Records are wrapped as {@link RawRecord} carrying the subject + connection
   * ids so the normalizer can build samples without re-resolving the
   * connection.
   */
  async backfill(conn: WearableConnection, since: Date): Promise<RawRecord[]> {
    const accessToken = await this.resolveAccessToken(conn);
    const floor = new Date(
      Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000,
    );
    const start = since && since > floor ? since : floor;
    const end = new Date();
    const ctx = { userId: conn.user_id, connectionId: conn.id };

    const startSec = Math.floor(start.getTime() / 1000);
    const endSec = Math.floor(end.getTime() / 1000);

    const results = await Promise.all(
      GARMIN_SUMMARY_KINDS.map((kind) =>
        this.pageCollection(kind, accessToken, startSec, endSec, ctx),
      ),
    );
    return results.flat();
  }

  /**
   * Resolve a usable PLAINTEXT access token for a backfill call:
   *  - If `encrypted_access_token` is present and not expired, KMS-unwrap it.
   *  - Else KMS-unwrap the refresh token and mint a fresh access token (NOT
   *    persisted here — the connection layer persists via `refresh()`).
   *  - Else re-consent is required → fail loud (#36).
   * The plaintext token lives only on the stack; it is never logged (#1/#12).
   */
  private async resolveAccessToken(conn: WearableConnection): Promise<string> {
    const expired =
      conn.access_token_expires_at != null &&
      conn.access_token_expires_at.getTime() <= Date.now();
    if (conn.encrypted_access_token && !expired) {
      return this.kms.decrypt(conn.encrypted_access_token);
    }
    if (conn.encrypted_refresh_token) {
      const refreshToken = await this.kms.decrypt(conn.encrypted_refresh_token);
      const rotated = await this.refreshAccessToken(refreshToken);
      if (!rotated.accessToken) {
        throw new Error('garmin.backfill: refresh returned no access token');
      }
      return rotated.accessToken;
    }
    throw new Error(
      'garmin.backfill: connection has no access or refresh token (re-consent required)',
    );
  }

  /**
   * Page one Garmin summary collection across the [startSec, endSec] range in
   * ≤24h windows. Each window is a single Garmin summary request; the records
   * are wrapped as {@link RawRecord} with the kind discriminator + ctx threaded
   * onto the payload. Bounded by {@link MAX_WINDOWS_PER_COLLECTION}.
   */
  private async pageCollection(
    kind: GarminSummaryKind,
    accessToken: string,
    startSec: number,
    endSec: number,
    ctx: { userId: string; connectionId: string },
  ): Promise<RawRecord[]> {
    const out: RawRecord[] = [];
    let windowStart = startSec;
    let windows = 0;

    while (windowStart < endSec && windows < MAX_WINDOWS_PER_COLLECTION) {
      const windowEnd = Math.min(windowStart + WINDOW_SECONDS, endSec);
      const params = new URLSearchParams({
        uploadStartTimeInSeconds: String(windowStart),
        uploadEndTimeInSeconds: String(windowEnd),
      });
      const res = await this.http.request(
        `${SUMMARY_ENDPOINT[kind]}?${params.toString()}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
          label: `garmin.backfill.${kind}`,
        },
      );
      const json = (await res.json()) as unknown;
      const records = Array.isArray(json) ? (json as GarminSummary[]) : [];
      for (const rec of records) {
        out.push(this.wrapRecord(kind, rec, ctx));
      }
      windowStart = windowEnd;
      windows += 1;
    }
    return out;
  }

  /** Wrap a Garmin summary record into a {@link RawRecord} with ctx + kind. */
  private wrapRecord(
    kind: GarminSummaryKind,
    rec: GarminSummary,
    ctx: { userId: string; connectionId: string },
  ): RawRecord {
    const payload: GarminRawPayload = {
      kind,
      data: rec,
      userId: ctx.userId,
      connectionId: ctx.connectionId,
    };
    return {
      id: rec.summaryId,
      provider: this.provider,
      payload,
    };
  }

  // ── Normalize ─────────────────────────────────────────────────────────

  normalize(raw: RawRecord[]): NormalizedSample[] {
    return normalizeGarmin(raw);
  }

  // ── Webhook (partner-signed push) ──────────────────────────────────────

  /**
   * Verify a Garmin push. Garmin Health push has NO per-event HMAC, so the
   * partner-signed contract is a static push token the receiver checks
   * constant-time. We require `GARMIN_PUSH_TOKEN` to be configured and the
   * inbound `X-Garmin-Push-Token` header to match it. Missing config → FAIL
   * CLOSED (return false) so a misconfigured receiver never trusts a push
   * (#36 fail-loud). A missing/mismatched header → false (controller → 401).
   */
  verifyWebhook(req: RawWebhookRequest): boolean {
    const expected = this.pushToken;
    if (!expected) {
      this.logger.error(
        'garmin.verifyWebhook: no GARMIN_PUSH_TOKEN configured — failing closed',
      );
      return false;
    }
    const provided = headerValue(req.headers, GARMIN_PUSH_TOKEN_HEADER);
    if (!provided) {
      return false;
    }
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, providedBuf);
  }

  /**
   * Parse a (already-token-verified) Garmin push into provider events. Garmin
   * pushes the actual summary payload keyed by collection; we Zod-validate the
   * envelope (`.strict()`), then emit ONE {@link ProviderEvent} per summary
   * record. The `providerEventId` is `garmin:<kind>:<summaryId>` (namespaced
   * so two collections sharing a summaryId never collide on the dedup PK), the
   * `type` is the kind, and each event carries the single wrapped
   * {@link RawRecord} — ready to normalize without a follow-up fetch.
   *
   * Returns `[]` on malformed JSON or a schema-rejected envelope (the
   * controller maps an empty parse on a verified-but-malformed body to 400).
   */
  parseWebhook(req: RawWebhookRequest): ProviderEvent[] {
    let envelope: GarminWebhookEnvelope;
    try {
      const json: unknown = JSON.parse(req.rawBody.toString('utf8'));
      envelope = GarminWebhookEnvelopeSchema.parse(json);
    } catch {
      return [];
    }
    const events: ProviderEvent[] = [];
    for (const kind of GARMIN_SUMMARY_KINDS) {
      const records = envelope[kind];
      if (!records) continue;
      for (const rec of records) {
        const summary = rec as unknown as GarminSummary;
        const payload: GarminRawPayload = { kind, data: summary };
        events.push({
          providerEventId: `garmin:${kind}:${summary.summaryId}`,
          type: kind,
          records: [
            {
              id: summary.summaryId,
              provider: this.provider,
              payload,
            },
          ],
        });
      }
    }
    return events;
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
 * Test/utility helper: derive the constant-time push-token comparison a Garmin
 * receiver expects. Kept next to the verifier so the contract lives in one
 * place; not exported from the module index. (Garmin's token is opaque — this
 * helper exists for symmetry with the other connectors' signing helpers and to
 * keep the header-name contract close to the verifier.)
 */
export function garminPushTokenHeader(token: string): {
  name: string;
  value: string;
} {
  return { name: GARMIN_PUSH_TOKEN_HEADER, value: token };
}

/**
 * Derive a NON-reversible, event-scoped correlation id from a Garmin user id
 * for logs (no PII in logs — Wave-2 audit pattern #3). SHA-256 of a salted
 * `garmin:<userId>:<salt>` truncated to 16 hex chars. Salt comes from
 * `GARMIN_WEBHOOK_SALT` (falls back to the push token / client secret).
 */
export function hashGarminUserId(userId: string): string {
  const salt =
    process.env.GARMIN_WEBHOOK_SALT ??
    process.env.GARMIN_PUSH_TOKEN ??
    process.env.GARMIN_CLIENT_SECRET ??
    '';
  return createHash('sha256')
    .update(`garmin:${userId}:${salt}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * A structured, log-safe descriptor of a failure on the Garmin ingest path.
 * NEVER carries raw provider PII (Garmin `userId`), OAuth/user-access tokens,
 * bearer fragments, or provider payload values — only an error class name and
 * a scrubbed, length-capped message. Persisted to `last_error` and emitted in
 * the `ingest_failure` log (Wave-2 audit pattern #3, PII/token redaction).
 */
export interface RedactedGarminError {
  /** Stable machine code for dashboards/alerting (e.g. `GARMIN_INGEST_FAILED`). */
  error_code: string;
  /** The error's constructor name (e.g. `PrismaClientKnownRequestError`). */
  error_class: string;
  /** Scrubbed, length-capped message safe for logs and DB. */
  redacted_message: string;
}

/**
 * Patterns for token/secret-like fragments that must never reach logs or the
 * `last_error` column. Order matters: the most specific (labelled) patterns run
 * first so their values are masked before the generic long-token sweep.
 */
const GARMIN_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // `Bearer <token>` / `bearer=<token>` style fragments.
  /\b[Bb]earer[\s=:]+[A-Za-z0-9._-]+/g,
  // Labelled token/secret/key/password fields (json or kv form).
  /\b(?:user[_-]?access[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|api[_-]?key|authorization)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._-]+/gi,
  // Generic long opaque tokens (>= 20 chars of token alphabet).
  /\b[A-Za-z0-9._-]{20,}\b/g,
];

/**
 * Build a {@link RedactedGarminError} from a thrown value and the in-scope
 * Garmin `userId`. Removes the literal user id, masks token/secret-like
 * fragments, collapses whitespace, and caps length. Returns a fully-populated
 * descriptor for every input (including non-`Error` throws) — never throws,
 * never returns the raw message.
 */
export function redactGarminError(
  err: unknown,
  userId: string | undefined,
  errorCode = 'GARMIN_INGEST_FAILED',
): RedactedGarminError {
  const error_class =
    err instanceof Error && typeof err.constructor?.name === 'string'
      ? err.constructor.name
      : typeof err;

  const rawMessage =
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

  let scrubbed = typeof rawMessage === 'string' ? rawMessage : String(rawMessage);

  // 1) Remove every occurrence of the literal Garmin user id (PII).
  if (userId && userId.length > 0) {
    scrubbed = scrubbed.split(userId).join('[redacted-user]');
  }
  // 2) Mask token/secret-like fragments.
  for (const pattern of GARMIN_SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[redacted]');
  }
  // 3) Collapse whitespace and cap length.
  scrubbed = scrubbed.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (scrubbed.length === 0) {
    scrubbed = 'unknown';
  }

  return { error_code: errorCode, error_class, redacted_message: scrubbed };
}
