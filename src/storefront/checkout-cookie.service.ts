import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Response } from 'express';

// r48 #11 — signed cookie fallback for guest sessions.
//
// After a successful guest checkout we set a 7-day signed JWT cookie
// `tgp_guest_session` containing { email, guest_checkout_id }.  The
// cookie is HttpOnly + SameSite=Lax + Secure, signed with
// CHECKOUT_RECOVERY_SECRET (reused — same threat model, same key
// hygiene).  Downstream public routes can read req.cookies and
// resolve a `req.guest` context for "your recent purchases" surfaces
// even if the guest comes back without converting to a User.
//
// Cookie verification middleware is intentionally a separate file
// from the writer to keep the read-only / write-only halves
// composable.

const COOKIE_NAME = 'tgp_guest_session';
const COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_TYPE = 'guest_session';

interface GuestSessionClaims extends JWTPayload {
  em: string;
  gid: string;
  type: typeof COOKIE_TYPE;
}

export interface GuestSession {
  email: string;
  guest_checkout_id: string;
}

@Injectable()
export class CheckoutCookieService {
  private readonly logger = new Logger(CheckoutCookieService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Mint + attach the cookie to the response.  Best-effort: a missing
   * or weak secret skips the write rather than throwing so a
   * successful checkout doesn't fail because of cookie hygiene.
   */
  async setSessionCookie(
    res: Response,
    session: GuestSession,
  ): Promise<void> {
    const secret = this.resolveSecret();
    if (!secret) {
      this.logger.debug('CheckoutCookieService: secret not configured; skipping');
      return;
    }
    const key = new TextEncoder().encode(secret);
    let jwt: string;
    try {
      jwt = await new SignJWT({
        em: session.email.toLowerCase(),
        gid: session.guest_checkout_id,
        type: COOKIE_TYPE,
      } satisfies GuestSessionClaims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(`${COOKIE_TTL_SECONDS}s`)
        .sign(key);
    } catch (err) {
      this.logger.warn(
        `setSessionCookie sign failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return;
    }
    // Use res.cookie (express extension) — Nest's @Res passthrough
    // exposes the express response when controllers use { passthrough }.
    // Production runs behind a TLS-terminating proxy so Secure is
    // always safe to set; SameSite=Lax lets the storefront re-attach
    // on a normal top-level navigation back to our domain.
    res.cookie(COOKIE_NAME, jwt, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_TTL_SECONDS * 1000,
    });
  }

  /**
   * Verify a cookie value and return the underlying session.  Returns
   * null on any failure (tampered, expired, wrong type).  Used by the
   * cookie-read middleware (next file).
   */
  async readSessionCookie(raw: string | undefined): Promise<GuestSession | null> {
    if (!raw) return null;
    const secret = this.resolveSecret();
    if (!secret) return null;
    const key = new TextEncoder().encode(secret);
    try {
      const { payload } = await jwtVerify(raw, key, { algorithms: ['HS256'] });
      const c = payload as GuestSessionClaims;
      if (c.type !== COOKIE_TYPE) return null;
      if (typeof c.em !== 'string' || typeof c.gid !== 'string') return null;
      return { email: c.em, guest_checkout_id: c.gid };
    } catch {
      return null;
    }
  }

  cookieName(): string {
    return COOKIE_NAME;
  }

  private resolveSecret(): string | null {
    const secret =
      this.config.get<string>('CHECKOUT_RECOVERY_SECRET') ??
      process.env.CHECKOUT_RECOVERY_SECRET ??
      '';
    return secret.length >= 32 ? secret : null;
  }
}
