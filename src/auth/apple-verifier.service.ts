import { Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';

/**
 * Apple identity-token verifier. Defense-in-depth alongside Supabase's own
 * verification of `signInWithIdToken({ provider: 'apple', ... })`.
 *
 * Why verify locally too:
 *
 *   - Supabase will reject a forged or expired Apple token, so the upstream
 *     `signInWithIdToken` is the primary security boundary.
 *   - But Apple's `aud` claim is the iOS bundle id / Services ID issuing the
 *     token, NOT a Supabase value. Without our own audience check, a token
 *     issued for an UNRELATED Apple client (e.g. a different team's app) that
 *     happens to share an Apple sub with one of our users could in principle
 *     be accepted upstream. Pinning `aud` to our APPLE_AUDIENCES allow-list
 *     closes that.
 *   - The same allow-list also lets us roll out Sign in with Apple per-bundle
 *     (e.g. enable for the iOS app first, web later) without code changes.
 *
 * If `APPLE_AUDIENCES` is unset, the route is treated as not configured and
 * returns 503 at request time — see AuthService.appleAuth. This mirrors how
 * the rest of the feature-tier env vars degrade.
 */
@Injectable()
export class AppleVerifierService {
  private readonly logger = new Logger(AppleVerifierService.name);
  private readonly issuer = 'https://appleid.apple.com';
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  private getJwks(): ReturnType<typeof createRemoteJWKSet> {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(
        new URL('https://appleid.apple.com/auth/keys'),
        {
          timeoutDuration: 5_000,
          cooldownDuration: 30_000,
          cacheMaxAge: 10 * 60_000,
        },
      );
    }
    return this.jwks;
  }

  /**
   * Returns the configured Apple audience allow-list. Empty array ⇒ feature
   * not configured (the controller/service returns 503 in that case rather
   * than verifying with no audience pin).
   */
  getAudiences(): string[] {
    const raw = (process.env.APPLE_AUDIENCES || '').trim();
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  isConfigured(): boolean {
    return this.getAudiences().length > 0;
  }

  /**
   * Verify an Apple identity token. Returns the decoded payload on success;
   * throws on any failure (signature, expiry, issuer mismatch, audience not
   * in allow-list, JWKS outage). Callers (AuthService.appleAuth) convert
   * thrown errors into a 401.
   */
  async verify(token: string): Promise<JWTPayload> {
    const audiences = this.getAudiences();
    if (audiences.length === 0) {
      throw new Error('APPLE_AUDIENCES not configured');
    }
    const { payload } = await jwtVerify(token, this.getJwks(), {
      issuer: this.issuer,
      audience: audiences,
      // Apple signs identity tokens with RS256.
      algorithms: ['RS256'],
      clockTolerance: '5s',
    });
    return payload;
  }
}
