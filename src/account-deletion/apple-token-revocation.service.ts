import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Sign in with Apple token revocation for account deletion (Apple App Review
 * 5.1.1(v) and "Offering account deletion in your app").
 *
 * The backend never stores Apple refresh tokens: Sign in with Apple is
 * verified through the identity token only (AppleVerifierService + Supabase
 * signInWithIdToken). Apple's documented path for that case is to obtain a
 * fresh `authorization_code` from the device at deletion time, exchange it at
 * `POST https://appleid.apple.com/auth/token`, and revoke the resulting
 * refresh token (or access token) at `POST https://appleid.apple.com/auth/revoke`.
 *
 * The mobile delete flow re-authenticates Apple users with Sign in with Apple
 * immediately before requesting deletion, so it has that code and sends it as
 * `apple_authorization_code`.
 *
 * Best effort by design: a revocation failure is recorded in the deletion
 * audit trail and logged, but never blocks the user's deletion request.
 * The authorization code, client secret and tokens are never logged.
 *
 * Configuration (all required for revocation; otherwise outcome is
 * `not_configured`):
 *   APPLE_TEAM_ID              Apple Developer Team ID (already used by AASA)
 *   APPLE_SIGNIN_KEY_ID        Key ID of the Sign in with Apple private key
 *   APPLE_SIGNIN_PRIVATE_KEY   The .p8 private key (PEM; literal "\n" allowed)
 *   APPLE_SIGNIN_CLIENT_ID     Optional. The client id the device's
 *                              authorization code was issued to: the iOS
 *                              bundle id. Defaults to
 *                              DEFAULT_APPLE_SIGNIN_CLIENT_ID. It is NOT read
 *                              from APPLE_AUDIENCES, whose order is not a
 *                              contract (it also lists Expo Go).
 */
export type AppleRevocationOutcome =
  'revoked' | 'not_requested' | 'not_configured' | 'exchange_failed' | 'revoke_failed';

export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const APPLE_AUDIENCE = 'https://appleid.apple.com';
/** iOS bundle id (mobile app.json `ios.bundleIdentifier`). */
export const DEFAULT_APPLE_SIGNIN_CLIENT_ID = 'com.growthproject.app';
const REQUEST_TIMEOUT_MS = 8_000;

interface AppleRevocationConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  clientId: string;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

@Injectable()
export class AppleTokenRevocationService {
  private readonly logger = new Logger(AppleTokenRevocationService.name);

  /** Overridable in tests; defaults to the Node 20 global fetch. */
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  readConfig(env: NodeJS.ProcessEnv = process.env): AppleRevocationConfig | null {
    const teamId = (env.APPLE_TEAM_ID ?? '').trim();
    const keyId = (env.APPLE_SIGNIN_KEY_ID ?? '').trim();
    const privateKey = (env.APPLE_SIGNIN_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
    const clientId = (env.APPLE_SIGNIN_CLIENT_ID ?? '').trim() || DEFAULT_APPLE_SIGNIN_CLIENT_ID;
    if (!teamId || !keyId || !privateKey || !clientId) return null;
    return { teamId, keyId, privateKey, clientId };
  }

  /** ES256 client secret JWT, valid for five minutes. */
  buildClientSecret(cfg: AppleRevocationConfig, nowSec = Math.floor(Date.now() / 1000)): string {
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        iss: cfg.teamId,
        iat: nowSec,
        exp: nowSec + 300,
        aud: APPLE_AUDIENCE,
        sub: cfg.clientId,
      }),
    );
    const signingInput = `${header}.${payload}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput), {
      key: cfg.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${signingInput}.${base64url(signature)}`;
  }

  private async postForm(url: string, fields: Record<string, string>) {
    return this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * Exchange a fresh authorization code and revoke the resulting token.
   * Never throws.
   */
  async revokeWithAuthorizationCode(
    authorizationCode: string | undefined | null,
    userIdForLog: string,
  ): Promise<AppleRevocationOutcome> {
    if (!authorizationCode) return 'not_requested';
    const cfg = this.readConfig();
    if (!cfg) {
      this.logger.warn(
        `Apple token revocation skipped for user=${userIdForLog}: Sign in with Apple key not configured`,
      );
      return 'not_configured';
    }

    let clientSecret: string;
    try {
      clientSecret = this.buildClientSecret(cfg);
    } catch (err) {
      this.logger.error(
        `Apple token revocation: client secret could not be signed for user=${userIdForLog}: ${(err as Error).message}`,
      );
      return 'not_configured';
    }

    let token: string | null = null;
    let tokenTypeHint: 'refresh_token' | 'access_token' = 'refresh_token';
    try {
      const res = await this.postForm(APPLE_TOKEN_URL, {
        client_id: cfg.clientId,
        client_secret: clientSecret,
        code: authorizationCode,
        grant_type: 'authorization_code',
      });
      if (!res.ok) {
        this.logger.warn(
          `Apple token exchange failed for user=${userIdForLog}: HTTP ${res.status}`,
        );
        return 'exchange_failed';
      }
      const body = (await res.json()) as { refresh_token?: unknown; access_token?: unknown };
      if (typeof body.refresh_token === 'string' && body.refresh_token) {
        token = body.refresh_token;
      } else if (typeof body.access_token === 'string' && body.access_token) {
        token = body.access_token;
        tokenTypeHint = 'access_token';
      }
    } catch (err) {
      this.logger.warn(
        `Apple token exchange error for user=${userIdForLog}: ${(err as Error).message}`,
      );
      return 'exchange_failed';
    }
    if (!token) return 'exchange_failed';

    try {
      const res = await this.postForm(APPLE_REVOKE_URL, {
        client_id: cfg.clientId,
        client_secret: clientSecret,
        token,
        token_type_hint: tokenTypeHint,
      });
      if (!res.ok) {
        this.logger.warn(`Apple token revoke failed for user=${userIdForLog}: HTTP ${res.status}`);
        return 'revoke_failed';
      }
    } catch (err) {
      this.logger.warn(
        `Apple token revoke error for user=${userIdForLog}: ${(err as Error).message}`,
      );
      return 'revoke_failed';
    }
    return 'revoked';
  }
}
