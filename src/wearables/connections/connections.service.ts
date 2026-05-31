import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { KmsService } from '../../common/kms/kms.service';
import { ConnectorRegistry } from '../connector-registry';
import { OauthStateService } from '../oauth/oauth-state.service';
import {
  DisconnectResult,
  OauthCallbackResult,
  SafeWearableConnection,
  SAFE_CONNECTION_SELECT,
  StartOauthResult,
  WearableConnectionStatus,
} from './types';

/**
 * PR-HK-1 — generic OAuth connect/callback + connection management service.
 *
 * Provider-agnostic: every per-provider detail (authorization URL, code
 * exchange, scopes, account id) comes from the {@link ConnectorRegistry}
 * lookup — this service owns only the cross-cutting concerns that are the
 * same for ALL cloud providers:
 *  - CSRF state + PKCE issuance/consumption (via {@link OauthStateService}).
 *  - KMS-wrapping of refresh/access tokens before they ever touch the DB
 *    (via {@link KmsService}) — plaintext tokens are NEVER persisted/logged
 *    (50-Failures #1/#12).
 *  - Upsert into `WearableConnection` keyed on (user, provider, account).
 *  - User-scoped reads (token-free `WearableConnectionSafe` projection) and
 *    soft-disconnect with an IDOR ownership check (#5).
 *
 * ON-DEVICE providers (HEALTHKIT, HEALTH_CONNECT, SAMSUNG_HEALTH) do NOT use
 * this OAuth API. They have no server token: the mobile app reads device data
 * and POSTs samples to `POST /v1/wearables/ingest` (PR-HK-2.a). Their
 * "connection" status is tracked by that ingest path, not here. This service
 * rejects connect/callback for on-device providers (and `disconnect` is a
 * no-op-safe soft clear if a row somehow exists).
 */
@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kms: KmsService,
    private readonly registry: ConnectorRegistry,
    private readonly oauthState: OauthStateService,
  ) {}

  /**
   * Begin a cloud-OAuth connect flow. Mints a single-use CSRF state (and PKCE
   * challenge when the provider supports it), then asks the provider's
   * connector to build the authorization URL. Returns the URL + opaque state
   * for the client to open. No DB write happens here — the connection row is
   * created on a successful callback.
   *
   * @throws BadRequestException for unknown providers or on-device providers
   *   (which have no OAuth flow).
   */
  async startOauth(
    userId: string,
    provider: WearableProvider,
  ): Promise<StartOauthResult> {
    const connector = this.resolveCloudConnector(provider);
    const redirectUri = this.callbackRedirectUri();

    const issued = await this.oauthState.issue(userId, provider, redirectUri, {
      pkce: connector.supportsPkce,
    });

    const authorizationUrl = connector.buildAuthorizationUrl(
      redirectUri,
      issued.state,
      issued.pkceChallenge,
    );
    if (!authorizationUrl) {
      // Defensive: a cloud connector must always return a URL. On-device
      // connectors are already filtered out by resolveCloudConnector.
      throw new BadRequestException(
        `Provider ${provider} does not support an OAuth authorization flow.`,
      );
    }

    return { authorizationUrl, state: issued.state };
  }

  /**
   * Complete an OAuth callback: validate+consume the CSRF state (single-use,
   * before any token exchange — #5), exchange the code via the connector
   * (passing the PKCE verifier), KMS-wrap the returned tokens, and upsert the
   * connection. NEVER returns tokens (#12).
   *
   * @throws BadRequestException on invalid/expired/replayed state or a failed
   *   exchange — with a GENERIC message (no token/secret leak).
   */
  async handleCallback(input: {
    code: string;
    state: string;
  }): Promise<OauthCallbackResult> {
    // 1) Validate + consume state BEFORE touching the provider. A bad state
    //    must never trigger a token exchange.
    let stateRecord;
    try {
      stateRecord = await this.oauthState.consume(input.state);
    } catch {
      // Opaque rejection — do not echo the (possibly attacker-chosen) state.
      throw new BadRequestException('Invalid or expired OAuth state.');
    }

    const { userId, provider, pkceVerifier } = stateRecord;
    const connector = this.resolveCloudConnector(provider);

    // 2) Exchange the authorization code for tokens.
    let tokens;
    try {
      tokens = await connector.exchangeCode(input.code, pkceVerifier);
    } catch (err) {
      // Log WITHOUT the code or any token material (#12). Surface a generic
      // error to the caller.
      this.logger.error(
        `OAuth code exchange failed for provider=${provider} user=${userId}: ${(err as Error).message}`,
      );
      throw new BadRequestException('OAuth code exchange failed.');
    }

    if (!tokens?.refreshToken) {
      throw new BadRequestException('Provider did not return a refresh token.');
    }

    // 3) KMS-wrap tokens before persistence. Empty access token stays empty.
    const encryptedRefresh = this.kms.encrypt(tokens.refreshToken);
    const encryptedAccess = tokens.accessToken
      ? this.kms.encrypt(tokens.accessToken)
      : null;

    // 4) Upsert the connection on the natural key
    //    (user_id, provider, external_account_id). A re-link of an existing
    //    connection updates tokens + clears any prior disconnect/error state.
    //
    //    NOTE: `external_account_id` is nullable, and Prisma's compound
    //    `whereUnique` does not accept null (SQL treats NULL as distinct), so
    //    we cannot use `upsert` on the compound key directly. We find-then-
    //    create/update, which also handles the null-account case correctly
    //    (a provider that returns no external account id).
    const externalAccountId = tokens.externalAccountId ?? null;
    const connectionData = {
      encrypted_refresh_token: encryptedRefresh,
      encrypted_access_token: encryptedAccess,
      access_token_expires_at: tokens.accessTokenExpiresAt ?? null,
      scopes: tokens.scopes ?? [],
      status: WearableConnectionStatus.CONNECTED,
      last_error: null,
      disconnected_at: null,
    };

    const existing = await this.prisma.wearableConnection.findFirst({
      where: {
        user_id: userId,
        provider,
        external_account_id: externalAccountId,
      },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.wearableConnection.update({
        where: { id: existing.id },
        data: connectionData,
      });
    } else {
      await this.prisma.wearableConnection.create({
        data: {
          user_id: userId,
          provider,
          external_account_id: externalAccountId,
          ...connectionData,
        },
      });
    }

    return { success: true, provider };
  }

  /**
   * List the caller's wearable connections, projected to the token-free
   * {@link SafeWearableConnection} shape (mirrors the `WearableConnectionSafe`
   * view from PR-HK-0). Scoped to `userId` — a user only ever sees their own
   * connections. The Prisma `select` excludes every `encrypted_*` /
   * `*_secret_ref` column (#12 defense-in-depth on top of the DB grant
   * revocation).
   */
  async list(userId: string): Promise<SafeWearableConnection[]> {
    return this.prisma.wearableConnection.findMany({
      where: { user_id: userId },
      select: SAFE_CONNECTION_SELECT,
      orderBy: { created_at: 'asc' },
    });
  }

  /**
   * Soft-disconnect the caller's connection for a provider: set
   * `status='disconnected'`, clear both encrypted tokens + the access-token
   * expiry, and stamp `disconnected_at`. The audit row survives a re-link
   * (Agent 2 §2.3). IDOR-safe: the update is scoped to `(user_id, provider)`,
   * so a user can only disconnect their OWN connection (#5).
   *
   * @throws NotFoundException when the caller has no (active) connection for
   *   the provider — never reveals whether some OTHER user has one.
   */
  async disconnect(
    userId: string,
    provider: WearableProvider,
  ): Promise<DisconnectResult> {
    // Ownership + existence check up front so a missing/foreign connection is
    // a clean 404 (not a silent no-op that the client mistakes for success).
    const existing = await this.prisma.wearableConnection.findFirst({
      where: { user_id: userId, provider },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw new NotFoundException(
        `No ${provider} connection found for this account.`,
      );
    }

    await this.prisma.wearableConnection.update({
      where: { id: existing.id },
      data: {
        status: WearableConnectionStatus.DISCONNECTED,
        encrypted_refresh_token: null,
        encrypted_access_token: null,
        access_token_expires_at: null,
        disconnected_at: new Date(),
      },
    });

    return { success: true, provider };
  }

  /**
   * Resolve a connector and assert it is a cloud-OAuth provider. On-device and
   * unregistered providers are rejected as 400s with generic messages.
   */
  private resolveCloudConnector(provider: WearableProvider) {
    if (!this.registry.has(provider)) {
      throw new BadRequestException(
        `Provider ${provider} is not available for connection.`,
      );
    }
    const connector = this.registry.get(provider);
    if (connector.authModel === 'on-device') {
      throw new BadRequestException(
        `Provider ${provider} is an on-device source and does not use the OAuth connect flow. Device data is sent via the ingest endpoint.`,
      );
    }
    return connector;
  }

  /**
   * The server-side OAuth callback redirect URI. Configurable via
   * `WEARABLES_OAUTH_REDIRECT_BASE_URL` (config over hardcode, #18). The full
   * URI is the base + the callback path; providers redirect here with
   * `?code&state`.
   */
  private callbackRedirectUri(): string {
    const base = process.env.WEARABLES_OAUTH_REDIRECT_BASE_URL?.trim();
    if (!base) {
      // Fail loud in production — a missing redirect base would silently send
      // providers to the wrong place.
      if (process.env.NODE_ENV === 'production') {
        throw new BadRequestException(
          'WEARABLES_OAUTH_REDIRECT_BASE_URL is not configured.',
        );
      }
      return 'http://localhost:3000/v1/wearables/connections/oauth/callback';
    }
    const trimmed = base.replace(/\/+$/, '');
    return `${trimmed}/v1/wearables/connections/oauth/callback`;
  }
}
