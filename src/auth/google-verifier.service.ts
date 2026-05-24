import { Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';

/**
 * Google ID-token verifier. Used by the recent-auth flow to prove the caller
 * just completed an interactive Google sign-in (not just that they hold a
 * valid Supabase session token).
 *
 * Why a dedicated verifier rather than `supabase.auth.getUser(token)`:
 *
 *   - `supabase.auth.getUser` accepts a Supabase session JWT, not a Google
 *     ID token. Since the caller's `Authorization` header is itself a
 *     Supabase session JWT, allowing the same value as `provider_token`
 *     would let any authenticated session pass the "fresh re-auth" gate
 *     without any real Google interaction.
 *   - Verifying a true Google-issued ID token against Google's JWKS, with
 *     issuer pin, audience pin (our GOOGLE_CLIENT_ID(s)), and a recent
 *     `iat`, mirrors the freshness guarantee the password and Apple paths
 *     provide.
 *
 * Audience configuration: `GOOGLE_CLIENT_IDS` (comma-separated) is the
 * canonical setting and supports multiple OAuth clients (iOS, Android,
 * Web). For backwards compatibility we also accept the singular
 * `GOOGLE_CLIENT_ID`. If neither is set, the service throws at verify
 * time — the recent-auth flow surfaces a generic 401 to the client.
 */
@Injectable()
export class GoogleVerifierService {
  private readonly logger = new Logger(GoogleVerifierService.name);
  // Google publishes tokens with `iss` = either of these two strings.
  private readonly issuers = ['https://accounts.google.com', 'accounts.google.com'];
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  private getJwks(): ReturnType<typeof createRemoteJWKSet> {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(
        new URL('https://www.googleapis.com/oauth2/v3/certs'),
        {
          timeoutDuration: 5_000,
          cooldownDuration: 30_000,
          cacheMaxAge: 10 * 60_000,
        },
      );
    }
    return this.jwks;
  }

  getAudiences(): string[] {
    const multi = (process.env.GOOGLE_CLIENT_IDS || '').trim();
    if (multi) {
      return multi
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    const single = (process.env.GOOGLE_CLIENT_ID || '').trim();
    return single ? [single] : [];
  }

  isConfigured(): boolean {
    return this.getAudiences().length > 0;
  }

  /**
   * Verify a Google ID token. Returns the decoded payload on success;
   * throws on any failure (signature, expiry, issuer/audience mismatch,
   * unsupported algorithm, JWKS outage). Callers convert thrown errors
   * into a generic 401 (R17).
   */
  async verify(token: string): Promise<JWTPayload> {
    const audiences = this.getAudiences();
    if (audiences.length === 0) {
      throw new Error('GOOGLE_CLIENT_ID(S) not configured');
    }
    const { payload } = await jwtVerify(token, this.getJwks(), {
      issuer: this.issuers,
      audience: audiences,
      // Google signs ID tokens with RS256.
      algorithms: ['RS256'],
      clockTolerance: '5s',
    });
    return payload;
  }
}
