import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTPayload, errors as joseErrors } from 'jose';

/**
 * JWKS-backed Supabase ES256 token verifier.
 *
 * Replaces the prior pattern of calling `supabase.auth.getUser(token)` on every
 * authenticated request, which performed a network round-trip to Supabase
 * (~100–200ms) for *every* API call. Under any non-trivial load that became
 * the dominant bottleneck and turned every dependent endpoint into a fan-out
 * to Supabase Auth.
 *
 * `jose.createRemoteJWKSet` fetches Supabase's public JWK set from
 * `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` and verifies tokens
 * locally. The library handles:
 *
 *   - Caching keys with a TTL (default ~10 min) so the JWKS endpoint is hit
 *     at most a handful of times per process per hour.
 *   - Cooldown + auto-refresh on `kid` miss (covers Supabase rotating signing
 *     keys without requiring a redeploy).
 *   - ES256 signature verification, exp/nbf/iat enforcement, audience and
 *     issuer pinning.
 *
 * If JWKS retrieval is failing (Supabase outage, misconfigured URL),
 * verification will throw and the JwtAuthGuard converts that into a 401 —
 * which is the correct behavior. We do NOT fall back to anon-key validation
 * or `getUser()` because either would re-introduce the per-request RTT we're
 * trying to eliminate, and a global Auth outage already breaks login itself.
 */
@Injectable()
export class JwksVerifierService implements OnModuleInit {
  private readonly logger = new Logger(JwksVerifierService.name);
  private jwks!: ReturnType<typeof createRemoteJWKSet>;
  private issuer!: string;
  private projectRef!: string;

  onModuleInit() {
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      // assertRequiredEnv() in main.ts already enforces this; keeping the
      // guard here means a misconfigured test harness fails loudly instead
      // of silently returning "valid" tokens.
      throw new Error('SUPABASE_URL not set — JWKS verifier cannot initialize');
    }

    const baseUrl = supabaseUrl.replace(/\/+$/, '');
    this.issuer = `${baseUrl}/auth/v1`;
    this.projectRef = (() => {
      try {
        return new URL(baseUrl).hostname.split('.')[0];
      } catch {
        return '';
      }
    })();

    const jwksUrl = new URL(`${baseUrl}/auth/v1/.well-known/jwks.json`);
    this.jwks = createRemoteJWKSet(jwksUrl, {
      // Conservative timeouts so an upstream JWKS hiccup doesn't cascade
      // into hung requests across the API.
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000, // 10 minutes
    });

    this.logger.log(`JWKS verifier initialized: issuer=${this.issuer}`);
  }

  /**
   * Verify a Supabase access token. Returns the decoded payload on success;
   * throws on any failure (signature, expiry, issuer mismatch, JWKS outage).
   * Callers (the JwtAuthGuard) convert thrown errors into a 401.
   */
  async verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        // Supabase issues access tokens with `iss = ${SUPABASE_URL}/auth/v1`
        // and `aud = "authenticated"`. Pinning both so a token issued for a
        // different Supabase project (or a non-user token) cannot satisfy
        // this guard.
        issuer: this.issuer,
        audience: 'authenticated',
        algorithms: ['ES256'],
        // Small clock tolerance so a few seconds of drift between Supabase
        // and our app server doesn't cause spurious 401s right around token
        // refresh time.
        clockTolerance: '5s',
      });
      return payload;
    } catch (err) {
      // Surface a concise reason in logs so production triage doesn't have to
      // guess between expired vs. malformed vs. wrong-project tokens. We
      // intentionally do NOT include the token itself.
      if (err instanceof joseErrors.JWTExpired) {
        this.logger.debug('JWT verification failed: token expired');
      } else if (err instanceof joseErrors.JWTClaimValidationFailed) {
        this.logger.warn(`JWT verification failed: claim ${err.claim} invalid`);
      } else if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
        this.logger.warn('JWT verification failed: signature mismatch');
      } else if (err instanceof joseErrors.JWKSNoMatchingKey) {
        this.logger.warn('JWT verification failed: kid not in JWKS (key rotated?)');
      } else {
        this.logger.warn(`JWT verification failed: ${(err as Error).message}`);
      }
      throw err;
    }
  }
}
