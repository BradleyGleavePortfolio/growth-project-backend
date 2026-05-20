import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../prisma.service';
import {
  REQUIRES_TIER_KEY,
  RequiredTier,
} from './requires-tier.decorator';

// SubscriptionGuard gates coach SaaS write paths behind subscription state
// and (since hybrid-coach-pricing) behind tier requirements.
//
// Tier policy (spec §6):
//   - Endpoints without @RequiresTier: free-tier-OK. Any coach with a valid
//     role passes regardless of subscription tier or status.
//   - Endpoints with @RequiresTier('pro'): guard checks sub.tier rank.
//     Free coach → 403 TIER_UPGRADE_REQUIRED in enforce mode.
//
// Subscription-status policy for Pro endpoints (from build_phase2a_stripe.md):
//   - active or trialing → allow
//   - grandfathered      → allow (one-time backfill for coaches who pre-date
//                          the billing system; see scripts/backfill-coach-
//                          subscriptions.ts)
//   - past_due           → allow during a 7-day grace then deny
//   - canceled / paused  → deny
//   - missing row        → free endpoints: allow silently (hybrid model —
//                          no row = treated as free+active).
//                          pro endpoints: denyOrObserve with tier='free'.
//
// OWNER bypasses all subscription and tier checks entirely (Tier-0 admin).
//
// BILLING_ENFORCEMENT escape hatch: when unset or not 'enforce', the guard
// runs in observe-only mode — denies are logged as PostHog telemetry and
// the request is allowed through. Set BILLING_ENFORCEMENT=enforce in
// production once all coaches have rows and Stripe is live.
//
// TODO(pro-upgrade): when the Pro upgrade endpoint ships, implement:
//   POST /billing/create-payment-intent
//   Returns { clientSecret } for in-app Stripe Payment Sheet (mobile) /
//   Elements (web). DO NOT use Stripe Checkout hosted pages —
//   all checkout must stay in-app. See spec §14 (deferred to follow-up PR).

const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// CoachTier values as a string union — mirrors the Prisma enum.
// Using a string union here rather than importing from @prisma/client
// so the guard compiles before `prisma generate` is run in CI.
type CoachTierValue = 'free' | 'pro' | 'enterprise';

/** Numeric rank for tier comparison. free < pro < enterprise. */
function rank(tier: CoachTierValue): number {
  switch (tier) {
    case 'free':
      return 0;
    case 'pro':
      return 1;
    case 'enterprise':
      return 2;
    default:
      return 0; // unknown values treated as free (conservative)
  }
}

type ObserveReason =
  | 'missing_subscription'
  | 'tier_too_low'
  | 'past_due_grace_expired'
  | 'canceled'
  | 'paused'
  | 'incomplete_or_unknown';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  private readonly logger = new Logger(SubscriptionGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    // @Optional() so tests that instantiate the guard without analytics
    // still work — analytics is best-effort.
    @Optional() private readonly analytics?: AnalyticsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Authentication required');

    // OWNER bypass — preserved verbatim. Must stay first.
    if (user.role === 'owner') return true;

    if (user.role !== 'coach') {
      // Defense in depth: CoachGuard/CoachOrOwnerGuard already blocks
      // non-coaches on most paths, but SubscriptionGuard may be mounted
      // independently on some routes.
      throw new ForbiddenException('Coach or owner access required');
    }

    const enforce = process.env.BILLING_ENFORCEMENT === 'enforce';

    // Read @RequiresTier metadata. Handler-level wins over class-level.
    // Absent = 'free' (open to all coaches with a valid role).
    const requiredTier =
      this.reflector.getAllAndOverride<RequiredTier | undefined>(
        REQUIRES_TIER_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? 'free';

    // The `tier` field is added by migration 20260614000000_coach_subscription_tier.
    // The Prisma client type will include it after `prisma generate` runs in CI.
    // Cast via unknown to allow access before client regeneration.
    const sub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: user.id },
    }) as (Awaited<ReturnType<typeof this.prisma.coachSubscription.findUnique>> & { tier?: CoachTierValue }) | null;

    // ── Missing row case ─────────────────────────────────────────────────
    if (!sub) {
      if (requiredTier === 'free') {
        // Hybrid model: no row = treated as free + active.
        // Expected for new coaches who haven't hit becomeCoach yet, or
        // coaches created before the billing system existed.
        // Do NOT emit observe-log noise — this is the normal free path.
        return true;
      }
      // Pro-locked endpoint with no subscription row → free-tier denial.
      return this.denyOrObserve(
        req,
        user.id,
        'none',
        'missing_subscription',
        enforce,
        {
          code: 'TIER_UPGRADE_REQUIRED',
          required_tier: requiredTier,
          current_tier: 'free',
        },
      );
    }

    // ── Row exists ───────────────────────────────────────────────────────
    const currentTier = (sub.tier ?? 'free') as CoachTierValue;
    const status = sub.status;

    // Tier check — always runs first (before status checks).
    if (rank(currentTier) < rank(requiredTier)) {
      return this.denyOrObserve(
        req,
        user.id,
        currentTier,
        'tier_too_low',
        enforce,
        {
          code: 'TIER_UPGRADE_REQUIRED',
          required_tier: requiredTier,
          current_tier: currentTier,
        },
      );
    }

    // Tier is sufficient. For free endpoints stop here — status does not
    // matter. A free coach with status='canceled' can still use free
    // endpoints (their tier='free' is their entitlement, not their status).
    if (requiredTier === 'free') {
      return true;
    }

    // Pro (or enterprise) endpoint: also enforce subscription status.
    // A Pro coach whose subscription was canceled loses Pro access.
    if (
      status === 'active' ||
      status === 'trialing' ||
      status === 'grandfathered'
    ) {
      return true;
    }

    if (status === 'past_due') {
      // 7-day grace window — preserved from original guard.
      const failedAt = sub.last_payment_failed_at?.getTime() ?? 0;
      const withinGrace = Date.now() - failedAt < PAST_DUE_GRACE_MS;
      if (withinGrace) return true;
      return this.denyOrObserve(
        req,
        user.id,
        status,
        'past_due_grace_expired',
        enforce,
        {
          error: 'SUBSCRIPTION_PAST_DUE_GRACE_EXPIRED',
          message: 'Subscription past due — update payment method to continue',
        },
      );
    }

    if (status === 'canceled' || status === 'paused') {
      const reason: ObserveReason =
        status === 'canceled' ? 'canceled' : 'paused';
      return this.denyOrObserve(req, user.id, status, reason, enforce, {
        error: 'SUBSCRIPTION_INACTIVE',
        message: 'Subscription is inactive — billing portal required',
        status,
      });
    }

    // incomplete / unpaid / incomplete_expired / unknown
    return this.denyOrObserve(
      req,
      user.id,
      status,
      'incomplete_or_unknown',
      enforce,
      {
        error: 'SUBSCRIPTION_INACTIVE',
        message: 'Subscription not active',
        status,
      },
    );
  }

  /**
   * Centralises the deny/observe branch so every policy reason goes
   * through the same telemetry shape.
   *
   * Returns `true` when observing (request allowed).
   * Throws ForbiddenException when enforcing.
   */
  private denyOrObserve(
    req: { method?: string; route?: { path?: string }; url?: string },
    coachId: string,
    currentState: string,
    reason: ObserveReason,
    enforce: boolean,
    errorBody: Record<string, unknown>,
  ): true {
    const route = req.route?.path ?? req.url ?? 'unknown';
    const method = req.method ?? 'unknown';
    this.logger.warn(
      `[${enforce ? 'enforce' : 'observe'}] coach=${coachId} state=${currentState} reason=${reason} route=${method} ${route}`,
    );
    if (enforce) {
      throw new ForbiddenException(errorBody);
    }
    // Observe mode: log telemetry, allow through.
    try {
      this.analytics?.capture(
        coachId,
        'server_billing_enforcement_observed',
        { currentState, reason, route, method },
      );
    } catch (err) {
      // analytics is best-effort; never block the request — but log the failure
      this.logger.warn({ err }, 'analytics_capture_failed');
    }
    return true;
  }
}
