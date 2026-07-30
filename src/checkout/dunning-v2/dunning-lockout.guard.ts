import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import type { AuthedRequest } from '../../auth/auth-request';
import { isDunningV2Enabled } from './dunning-v2.feature';
import { LOCKED_DUNNING_CODE } from './dunning-v2.cadence';
import { VoicePolicyService } from '../../roman/voice/voice-policy.service';

/**
 * B3 Smart Dunning v2 — Day-10 hard-lockout guard (spec §3 / §8.1).
 *
 * Backend enforcement of the hard lockout: when the signed-in client has a
 * DunningState in lockout (`locked_out_at != null` AND `entitlement_active ===
 * false`), every NON-allowed route returns `403 LOCKED_DUNNING`. Login then
 * collapses to the payment-update screen only; community, workouts, programs,
 * generic chat are all 403.
 *
 * Allowed while LOCKED (brief §3, confirmed against the spec's "Roman explains
 * the lockout" carve-out):
 *   - /billing/*  and /checkout/* and /payment-recovery/* (update the card)
 *   - the two coach-scoped billing surfaces, /coach/billing/* (mobile) and
 *     /v1/coach/me/billing* (v1) — both open the same Stripe portal
 *   - /auth/*     (sign-in, /auth/me, /auth/extension/refresh, password reset —
 *     recovery must never be locked). Note there is no mounted /auth/logout or
 *     /auth/refresh; the mounted refresh route is /auth/extension/refresh.
 *   - health checks (health, healthz, readyz)
 *   - Roman chat: /roman/* (RomanController) — the dedicated Roman assistant
 *     surface, so Roman can explain the lockout. This is the ONLY AI-adjacent
 *     carve-out. The entitlement-gated student AI assistant (/ai/*, AiController)
 *     is a paid VALUE surface and stays LOCKED; the internal /ai/gateway
 *     provider-routing surface is never a client explanation route. (Roman chat
 *     is itself dark behind FEATURE_ROMAN_CHAT_ENABLED — a 404 while OFF — so
 *     allow-listing it is only meaningful once that flag is also ON.)
 *
 * Posture: this guard is a HARD no-op while FEATURE_DUNNING_V2 is OFF — it
 * returns `true` immediately and reads no state, so v1 deployments are
 * completely unaffected. It also fails OPEN on any lookup error (never lock a
 * user out because of an infra hiccup) — the only path that locks is an
 * explicit `locked_out_at` row.
 */

/** First-segment heads (post-/api prefix) always reachable while locked. */
const ALLOWED_PREFIXES: readonly string[] = [
  'billing',
  'checkout',
  'payment-recovery',
  'recover',
  'auth',
  'health',
  'healthz',
  'readyz',
] as const;

/**
 * Coach-scoped billing surfaces, matched as FULL normalized route prefixes
 * rather than by segment position. Both entries reach the same
 * `BillingService.createCoachPortalSession` capability — the Stripe portal a
 * locked coach needs in order to cure the delinquency — so both must stay
 * reachable while locked.
 *
 * Positional matching is deliberately not used here: matching an allow-list
 * token in any segment admitted `scheduling/auth/google/*` (a paid Google
 * Calendar integration surface) purely because its second segment was `auth`,
 * and would have admitted every future controller with a colliding segment.
 */
const ALLOWED_ROUTE_PREFIXES: readonly string[] = [
  'coach/billing', // MobileCoachBillingController — status, portal-session
  'coach/me/billing', // CoachBillingController (v1) — billing, billing/portal-session
] as const;

/**
 * The dedicated Roman chat surface (`/roman/*`, RomanController) the locked
 * client may reach so the Roman assistant can explain the lockout. Deliberately
 * NOT `/ai/*`: that is the entitlement-gated student AI assistant (AiController),
 * a paid value surface that must stay locked, and `/ai/gateway` is internal
 * provider routing, never a client explanation route.
 */
const ROMAN_CHAT_PREFIXES: readonly string[] = ['roman'] as const;

@Injectable()
export class DunningLockoutGuard implements CanActivate {
  private readonly logger = new Logger(DunningLockoutGuard.name);

  // Phase 2: VoicePolicyService supplies the Day-10 lockout SCREEN copy + the
  // RomanAvatar crop the locked client sees. @Optional so the guard keeps
  // working in thin unit tests; the existing 403 `message` reason is left
  // untouched, the Roman copy is attached additively under `lockout_copy`.
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly voice?: VoicePolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Flag OFF → guard is invisible. v1 unaffected.
    if (!isDunningV2Enabled()) return true;

    const req = context.switchToHttp().getRequest<
      AuthedRequest & {
        path?: string;
        originalUrl?: string;
        url?: string;
      }
    >();

    const path = normalizePath(req.path ?? req.originalUrl ?? req.url ?? '');
    if (isAllowedWhileLocked(path)) return true;

    const userId = req.user?.id;
    if (!userId) return true; // unauthenticated routes are handled by auth guards

    let locked = false;
    try {
      locked = await this.isClientLockedOut(userId);
    } catch (err) {
      // Fail OPEN — never lock a user out on an infra error.
      this.logger.warn(
        `DunningLockoutGuard lookup failed for user=${userId}: ${(err as Error).message}`,
      );
      return true;
    }

    if (!locked) return true;

    // The short `message` is the stable 403 reason and is preserved verbatim
    // (flag-independent). The Day-10 lockout SCREEN copy + avatar crop the
    // client reads is supplied by the Voice Policy (FEATURE_ROMAN_COPY_V2-
    // gated): legacy household-ledger text while OFF, Roman Option-3 while ON.
    const lockoutCopy = this.voice ? this.voice.copyFor('lockout_day10') : undefined;
    throw new ForbiddenException({
      code: LOCKED_DUNNING_CODE,
      message:
        'Your account is locked pending a billing matter. Update your payment to restore access.',
      lockout_copy: lockoutCopy,
    });
  }

  /**
   * A client is locked out when ANY of their purchases has a DunningState with
   * `locked_out_at != null` and the purchase entitlement is off. We resolve via
   * ClientPurchase.client_user_id → DunningState.purchase_id.
   */
  private async isClientLockedOut(userId: string): Promise<boolean> {
    const lockedRow = await this.prisma.dunningState.findFirst({
      where: {
        locked_out_at: { not: null },
        status: 'active',
        purchase: {
          client_user_id: userId,
          entitlement_active: false,
        },
      },
      select: { id: true },
    });
    return lockedRow != null;
  }
}

/** Strip the global `/api` prefix and a leading slash, lowercase. */
export function normalizePath(raw: string): string {
  let p = (raw.split('?')[0] ?? '').toLowerCase();
  if (p.startsWith('/')) p = p.slice(1);
  if (p.startsWith('api/')) p = p.slice('api/'.length);
  // Strip a leading version segment (e.g. v1/) so prefix checks are stable.
  if (p.startsWith('v1/')) p = p.slice('v1/'.length);
  return p;
}

/** True if `path` is exactly `prefix` or sits underneath it. */
function matchesRoutePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** True if `path` (normalized) is reachable while the client is locked out. */
export function isAllowedWhileLocked(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return true; // root / health redirect

  if (ALLOWED_PREFIXES.includes(segments[0])) return true;
  for (const prefix of ALLOWED_ROUTE_PREFIXES) {
    if (matchesRoutePrefix(path, prefix)) return true;
  }
  // Dedicated Roman chat surface (/roman/*) so Roman can explain the lockout.
  for (const chat of ROMAN_CHAT_PREFIXES) {
    if (matchesRoutePrefix(path, chat)) return true;
  }
  return false;
}
