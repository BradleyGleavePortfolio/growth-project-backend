import type { ExecutionContext } from '@nestjs/common';
import { isWellFormedInviteCode } from '../invite-codes/invite-codes.service';

// Clinic launch C03 — signup burst allowance for invite-code holders.
//
// Problem: POST /auth/signup-with-code shares the `auth-signup` bucket
// (5/hour per IP). A clinic room of clients on one Wi-Fi / carrier NAT
// scanning the same QR code hits that ceiling on the 6th signup.
//
// Rule: keep the 5/hour per-IP baseline for CODELESS signups, but route
// requests that carry a WELL-FORMED invite code through a separate
// `auth-signup-with-code` bucket with a higher cap (AUTH_SIGNUP_WITH_CODE_PER_HOUR,
// default 100/hour per IP, sized for a 40+ patient clinic event on one Wi-Fi
// IP). Both buckets are per-IP and per-route, so a bad actor with a made-up
// code still gets at most AUTH_SIGNUP_WITH_CODE_PER_HOUR attempts/hour/IP, and the
// service validates the code in the DB before any account is created
// (AuthService.signupWithCode → previewCode) — a bogus code never mints a
// user. "Valid" at the throttler layer therefore means format-valid; DB
// validity stays where it is.
//
// Wiring: `skipIf` on the two named throttlers in THROTTLER_LIMITS. The
// NestJS throttler evaluates every named bucket on every route, so both
// predicates are scoped to the signup-with-code route; on any other route
// `auth-signup` behaves exactly as before and `auth-signup-with-code` is
// skipped entirely.

export const SIGNUP_WITH_CODE_ROUTE_SUFFIX = '/auth/signup-with-code';

type ThrottledRequest = {
  route?: { path?: unknown };
  url?: unknown;
  body?: unknown;
};

function requestOf(context: ExecutionContext): ThrottledRequest | undefined {
  try {
    return context.switchToHttp().getRequest<ThrottledRequest>();
  } catch {
    return undefined;
  }
}

export function isSignupWithCodeRequest(req: ThrottledRequest | undefined): boolean {
  if (!req) return false;
  const routePath = typeof req.route?.path === 'string' ? req.route.path : '';
  const url = typeof req.url === 'string' ? req.url.split('?')[0] : '';
  const path = routePath || url;
  return path.endsWith(SIGNUP_WITH_CODE_ROUTE_SUFFIX);
}

export function requestCarriesWellFormedInviteCode(req: ThrottledRequest | undefined): boolean {
  const body = req?.body;
  if (!body || typeof body !== 'object') return false;
  return isWellFormedInviteCode((body as { invite_code?: unknown }).invite_code);
}

/** `auth-signup` skipIf: on signup-with-code, a well-formed code moves the request to the burst bucket. */
export function skipSignupBaselineWhenCodePresent(context: ExecutionContext): boolean {
  const req = requestOf(context);
  return isSignupWithCodeRequest(req) && requestCarriesWellFormedInviteCode(req);
}

/** `auth-signup-with-code` skipIf: only signup-with-code requests WITH a well-formed code count here. */
export function skipSignupBurstUnlessCodePresent(context: ExecutionContext): boolean {
  const req = requestOf(context);
  return !(isSignupWithCodeRequest(req) && requestCarriesWellFormedInviteCode(req));
}
