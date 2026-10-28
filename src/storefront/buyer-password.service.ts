import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

// WEB-BUYER-FLOW (owner #172-7 op 1) — a new web buyer sets the password on
// the confirm page, right after the confirm link. Only the holder of that
// link can: the page sends the access token Supabase put in the link's
// #fragment, and this service takes it only if
//   - Supabase still accepts it (GET /user: signature, expiry, and the
//     session still exists — a revoked session is refused),
//   - it came from an email link (amr method "otp": Supabase's implicit-flow
//     invite verify issues that method; a password or app session is refused),
//   - the account was made by guest checkout (user_metadata.source).
// Single use: the session id is claimed in this process while the request
// runs, and after the password is saved the link's session is revoked
// (admin.signOut(jwt, 'local')), so the same token can never pass GET /user
// again on any machine. Every refusal is the same LINK_INVALID answer, so the
// route never says whether an email or account exists.

export const PASSWORD_RULE_MESSAGE =
  'Password must be at least 8 characters with one uppercase letter, one number, and one special character.';

/** The app's password rule (auth.service.ts signup; the app's ResetPasswordScreen). */
export function meetsPasswordRule(pw: unknown): pw is string {
  return (
    typeof pw === 'string' &&
    pw.length >= 8 &&
    pw.length <= 72 &&
    /[A-Z]/.test(pw) &&
    /[0-9]/.test(pw) &&
    /[^A-Za-z0-9]/.test(pw)
  );
}

const LINK_INVALID = {
  error: 'LINK_INVALID',
  message: 'This link has run out',
} as const;

const CLAIM_TTL_MS = 60 * 60 * 1000;

interface TokenClaims {
  session_id?: unknown;
  amr?: unknown;
}

function readClaims(jwt: string): TokenClaims | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part, 'base64url').toString('utf8');
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? (v as TokenClaims) : null;
  } catch {
    return null;
  }
}

function fromEmailLink(amr: unknown): boolean {
  return Array.isArray(amr) && amr.some((e) => e && typeof e === 'object' && (e as { method?: unknown }).method === 'otp');
}

@Injectable()
export class BuyerPasswordService {
  private readonly logger = new Logger(BuyerPasswordService.name);
  /** session id -> claim expiry (ms). Blocks a second use while the first runs and after it. */
  private readonly claims = new Map<string, number>();

  constructor(private readonly supabase: SupabaseService) {}

  async setPassword(accessToken: unknown, password: unknown): Promise<{ saved: true }> {
    if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4096) {
      throw this.linkInvalid();
    }
    if (!meetsPasswordRule(password)) {
      throw new BadRequestException({ error: 'PASSWORD_WEAK', message: PASSWORD_RULE_MESSAGE });
    }
    const client = this.supabase.getClient();
    let userId: string;
    let source: unknown;
    try {
      const { data, error } = await client.auth.getUser(accessToken);
      if (error) {
        // 4xx: bad, expired or revoked token. No status / 5xx: Supabase unreachable.
        const status = (error as { status?: number }).status ?? 0;
        throw status >= 400 && status < 500 ? this.linkInvalid() : this.unavailable();
      }
      if (!data?.user?.id) throw this.linkInvalid();
      userId = data.user.id;
      source = (data.user.user_metadata as Record<string, unknown> | undefined)?.source;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn('set-password: token check failed');
      throw this.unavailable();
    }
    const claims = readClaims(accessToken);
    const sid = typeof claims?.session_id === 'string' ? claims.session_id : '';
    if (!sid || !fromEmailLink(claims?.amr) || source !== 'guest_checkout') throw this.linkInvalid();

    const now = Date.now();
    for (const [k, exp] of this.claims) if (exp <= now) this.claims.delete(k);
    if (this.claims.has(sid)) throw this.linkInvalid();
    this.claims.set(sid, now + CLAIM_TTL_MS);

    try {
      const { error } = await client.auth.admin.updateUserById(userId, { password });
      if (error) {
        this.claims.delete(sid);
        const status = (error as { status?: number }).status;
        // Supabase's own strength / leaked-password check: show the app's rule.
        if (status === 422 || status === 400) {
          throw new BadRequestException({ error: 'PASSWORD_WEAK', message: PASSWORD_RULE_MESSAGE });
        }
        this.logger.warn(`set-password: update failed (status=${status ?? 'none'})`);
        throw this.unavailable();
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.claims.delete(sid);
      this.logger.warn('set-password: update crashed');
      throw this.unavailable();
    }

    // The link is spent: end its session so the token is refused everywhere.
    try {
      const { error } = await client.auth.admin.signOut(accessToken, 'local');
      if (error) this.logger.warn('set-password: revoking the link session failed');
    } catch {
      this.logger.warn('set-password: revoking the link session crashed');
    }
    return { saved: true };
  }

  private linkInvalid(): HttpException {
    return new HttpException(LINK_INVALID, HttpStatus.UNAUTHORIZED);
  }

  private unavailable(): HttpException {
    return new HttpException(
      { error: 'SET_PASSWORD_UNAVAILABLE', message: "We couldn't save your password. Check your connection, then try again." },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  resetForTests(): void {
    this.claims.clear();
  }
}
