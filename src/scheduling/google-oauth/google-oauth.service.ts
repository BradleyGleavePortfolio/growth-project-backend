import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { KmsService } from '../../common/kms/kms.service';

// GoogleOAuthService — minimal OAuth 2.0 code-exchange + refresh flow
// for Google Calendar. Concierge scheduling (PR #142) v1 only.
//
// What this ships today:
//   1. Configuration probe (`isConfigured()`) so callers can short-circuit
//      to a 503 envelope rather than crash when the GCP project is not
//      yet wired.
//   2. `buildAuthorizeUrl()` — pure URL builder for the OAuth consent
//      screen (no network call).
//   3. `exchangeCode()` — exchanges an authorization `code` for the
//      refresh+access token pair via Google's token endpoint.
//   4. `refreshAccessToken()` — exchanges a stored refresh token for a
//      fresh access token.
//   5. `persistConnection()` — writes a CalendarConnection row marking
//      the user as linked. The refresh token itself is stored in the
//      secret store referenced by `credentials_secret_ref`; this PR
//      ships the pointer-and-row shape but defers the secret-store
//      write to the next iteration (which will reuse the KMS helper
//      shipped by Bloodwork PR #141). For now, the refresh token is
//      held in process memory only via `_devTokenStash` so a
//      same-process flow can be exercised end-to-end in dev without
//      writing tokens to disk.
//
// What is deliberately deferred:
//   - Secret store integration (KMS-wrapped refresh token at rest).
//   - Google Calendar Push Notification (webhook) registration.
//   - Granular scope downgrade / revocation handling.
//
// All of the deferred items have a single, clean integration point
// (the `credentials_secret_ref` column + a single KMS helper call) so
// they will land in a follow-up PR without re-architecting this
// service.

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  // In-process holding pen for refresh tokens until the KMS-backed
  // secret store wiring lands. Per-user_id. Cleared on process
  // restart by design — the next iteration replaces this with the
  // shared secret-store helper introduced by Bloodwork PR #141.
  private readonly _devTokenStash = new Map<
    string,
    { refresh_token: string; obtained_at: number; scopes: string[] }
  >();

  // Test seam — overridable so the spec can swap a stub fetch.
  protected fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kms: KmsService,
  ) {}

  isConfigured(): boolean {
    // FEATURE_GOOGLE_CALENDAR_SYNC — Phase 2 master switch. Defaults
    // to false; until product flips it on per environment, every
    // configuration probe returns false regardless of which secrets
    // are set. This keeps Google calendar code paths inert in
    // Phase 1 (TGP-exclusive scheduling). See RFC 142 addendum.
    if (process.env.FEATURE_GOOGLE_CALENDAR_SYNC?.toLowerCase() !== 'true') {
      return false;
    }
    return (
      !!process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() &&
      !!process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() &&
      !!process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim()
    );
  }

  // Probe for whether the feature flag is set, independent of
  // OAuth secret configuration. Controllers use this to return 404
  // (feature not available) vs 503 (configured but degraded).
  static isFeatureFlagOn(): boolean {
    return process.env.FEATURE_GOOGLE_CALENDAR_SYNC?.toLowerCase() === 'true';
  }

  buildAuthorizeUrl(args: { userId: string; state: string }): string {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException({
        error:
          'Google Calendar OAuth is not configured on this deployment. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI in Fly secrets.',
        code: 'GOOGLE_OAUTH_DISABLED',
      });
    }
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID as string;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI as string;
    const scopes =
      (process.env.GOOGLE_OAUTH_SCOPES?.trim() ||
        'https://www.googleapis.com/auth/calendar.events')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ');
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // 'offline' is required to receive a refresh_token at all.
      access_type: 'offline',
      // 'consent' forces the consent screen even on re-link, which is
      // what we want to guarantee a refresh_token is issued on the
      // very first link AND on a re-link after revocation.
      prompt: 'consent',
      include_granted_scopes: 'true',
      scope: scopes,
      // The `state` parameter MUST be a per-request random nonce signed
      // with a server-side secret in production. The controller wraps
      // the user id + a nonce; we surface a string here and let the
      // controller decide the encoding.
      state: args.state,
    });
    return `${GOOGLE_AUTHORIZE_ENDPOINT}?${params.toString()}`;
  }

  async exchangeCode(args: {
    code: string;
    userId: string;
  }): Promise<GoogleTokenResponse> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException({
        error: 'Google OAuth is not configured',
        code: 'GOOGLE_OAUTH_DISABLED',
      });
    }
    const form = new URLSearchParams({
      code: args.code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET as string,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI as string,
      grant_type: 'authorization_code',
    });
    const res = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(
        `Google token exchange failed status=${res.status} userId=${args.userId} detail=${detail.slice(0, 200)}`,
      );
      throw new UnauthorizedException({
        error: 'Google rejected the authorization code',
        code: 'GOOGLE_OAUTH_EXCHANGE_FAILED',
      });
    }
    const json = (await res.json()) as GoogleTokenResponse;
    // Stash the refresh token in-process (kept as a same-process fallback
    // for test environments and dev runs that have not yet applied the
    // 20260516000000_kms_wrap migration). Production reads/writes go
    // through CalendarConnection.encrypted_refresh_token via KmsService —
    // see persistRefreshToken / loadRefreshToken below.
    if (json.refresh_token) {
      this._devTokenStash.set(args.userId, {
        refresh_token: json.refresh_token,
        obtained_at: Date.now(),
        scopes: (json.scope ?? '').split(' ').filter(Boolean),
      });
      await this.persistRefreshToken(args.userId, json.refresh_token);
    }
    return json;
  }

  // KMS-wrapped refresh-token persistence on CalendarConnection.
  // Safe to call before persistConnection — it will skip if there is
  // no row yet (the controller calls persistConnection before
  // exchangeCode in some flows and after in others; both orderings
  // are tolerated because the dev stash is always populated first).
  private async persistRefreshToken(
    userId: string,
    refreshToken: string,
  ): Promise<void> {
    const encrypted = this.kms.encrypt(refreshToken);
    const updated = await this.prisma.calendarConnection.updateMany({
      where: { user_id: userId, provider: 'google_calendar' },
      data: { encrypted_refresh_token: encrypted },
    });
    if (updated.count === 0) {
      this.logger.debug(
        `No CalendarConnection row yet for userId=${userId}; refresh token kept in process stash for this run.`,
      );
    }
  }

  private async loadRefreshToken(userId: string): Promise<string | null> {
    // DB-backed path: read the encrypted column from the most recently
    // updated active CalendarConnection.
    const row = await this.prisma.calendarConnection.findFirst({
      where: {
        user_id: userId,
        provider: 'google_calendar',
        disconnected_at: null,
      },
      orderBy: { updated_at: 'desc' },
      select: { encrypted_refresh_token: true },
    });
    if (row?.encrypted_refresh_token) {
      return this.kms.decrypt(row.encrypted_refresh_token);
    }
    // Fallback: in-process stash. Cleared on process restart by design.
    const stash = this._devTokenStash.get(userId);
    return stash?.refresh_token ?? null;
  }

  async refreshAccessToken(args: { userId: string }): Promise<GoogleTokenResponse> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException({
        error: 'Google OAuth is not configured',
        code: 'GOOGLE_OAUTH_DISABLED',
      });
    }
    const refreshToken = await this.loadRefreshToken(args.userId);
    if (!refreshToken) {
      throw new UnauthorizedException({
        error: 'No refresh token stored for this user. The user must re-link Google Calendar.',
        code: 'GOOGLE_OAUTH_REFRESH_MISSING',
      });
    }
    const form = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET as string,
      grant_type: 'refresh_token',
    });
    const res = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) {
      throw new UnauthorizedException({
        error: 'Google rejected the refresh token',
        code: 'GOOGLE_OAUTH_REFRESH_FAILED',
      });
    }
    return (await res.json()) as GoogleTokenResponse;
  }

  async persistConnection(args: {
    userId: string;
    googleAccountEmail: string;
    scopes: string[];
  }): Promise<{ id: string }> {
    // Stub credentials_secret_ref for now — the next PR routes the
    // refresh token through the KMS helper introduced by Bloodwork.
    const row = await this.prisma.calendarConnection.upsert({
      where: {
        CalendarConnection_user_provider_account_key: {
          user_id: args.userId,
          provider: 'google_calendar',
          external_account_id: args.googleAccountEmail,
        },
      },
      create: {
        user_id: args.userId,
        provider: 'google_calendar',
        external_account_id: args.googleAccountEmail,
        credentials_secret_ref: `dev:in-process:${args.userId}`,
      },
      update: {
        disconnected_at: null,
        credentials_secret_ref: `dev:in-process:${args.userId}`,
      },
      select: { id: true },
    });
    return row;
  }
}
