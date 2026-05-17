import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../prisma.service';

// SubscriptionGuard gates coach SaaS write paths behind subscription state.
//
// Policy (from build_phase2a_stripe.md):
//   - active or trialing → allow
//   - grandfathered      → allow (one-time backfill for coaches who pre-date
//                          the billing system; see scripts/backfill-coach-
//                          subscriptions.ts)
//   - past_due           → allow during a 7-day grace then deny
//   - canceled / paused  → deny
//   - missing row        → allow (a coach has been provisioned in the app
//                          but has not yet been onboarded to billing — this
//                          is the expected state during preview/dev rollout)
//
// OWNER bypasses subscription checks entirely (Tier-0 platform admin).
//
// A safe-rollout escape hatch is provided via the BILLING_ENFORCEMENT env
// var. Leaving it unset (or set to anything other than "enforce") puts the
// guard in observe-only mode: the check still runs, denies are reported as
// PostHog telemetry (`server_billing_enforcement_observed`) so we can size
// the impact before flipping enforce on, but the request is allowed
// through. Production must set BILLING_ENFORCEMENT=enforce after Stripe is
// live and every coach has a CoachSubscription row.

const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

type ObserveReason =
  | 'past_due_grace_expired'
  | 'canceled'
  | 'paused'
  | 'incomplete_or_unknown';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  private readonly logger = new Logger(SubscriptionGuard.name);

  constructor(
    private prisma: PrismaService,
    // @Optional() so tests that instantiate the guard with `new
    // SubscriptionGuard(prisma)` still work — analytics is best-effort.
    @Optional() private analytics?: AnalyticsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Authentication required');

    if (user.role === 'owner') return true;
    if (user.role !== 'coach') {
      // STUDENTs do not reach coach console writes; CoachOrOwnerGuard already
      // blocks this path. Defense in depth.
      throw new ForbiddenException('Coach or owner access required');
    }

    const enforce = process.env.BILLING_ENFORCEMENT === 'enforce';

    const sub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: user.id },
    });
    if (!sub) {
      if (enforce) {
        // In enforce mode a missing row means billing was never set up.
        // Deny with the same body as other inactive states.
        throw new ForbiddenException({
          error: 'SUBSCRIPTION_REQUIRED',
          message: 'Active coach subscription required',
        });
      }
      // Observe mode: allow but log so we can quantify missing rows before cutover.
      return this.observe(req, user.id, 'none', 'missing_subscription');
    }

    const status = sub.status;
    if (status === 'active' || status === 'trialing' || status === 'grandfathered') return true;

    if (status === 'past_due') {
      const failedAt = sub.last_payment_failed_at?.getTime() ?? 0;
      const within = Date.now() - failedAt < PAST_DUE_GRACE_MS;
      if (within) return true;
      return this.denyOrObserve(req, user.id, status, 'past_due_grace_expired', enforce, {
        error: 'SUBSCRIPTION_PAST_DUE_GRACE_EXPIRED',
        message: 'Subscription past due — update payment method to continue',
      });
    }

    if (status === 'canceled' || status === 'paused') {
      const reason: ObserveReason = status === 'canceled' ? 'canceled' : 'paused';
      return this.denyOrObserve(req, user.id, status, reason, enforce, {
        error: 'SUBSCRIPTION_INACTIVE',
        message: 'Subscription is inactive — billing portal required',
        status,
      });
    }

    // incomplete / unpaid / unknown — block on enforce, allow during rollout.
    return this.denyOrObserve(req, user.id, status, 'incomplete_or_unknown', enforce, {
      error: 'SUBSCRIPTION_INACTIVE',
      message: 'Subscription not active',
      status,
    });
  }

  private observe(
    req: { method?: string; route?: { path?: string }; url?: string },
    coachId: string,
    status: string,
    reason: string,
  ): true {
    const route = req.route?.path ?? req.url ?? 'unknown';
    const method = req.method ?? 'unknown';
    this.logger.warn(
      `[observe] coach=${coachId} status=${status} reason=${reason} route=${method} ${route}`,
    );
    try {
      this.analytics?.capture(coachId, 'server_billing_enforcement_observed', {
        status,
        reason,
        route,
        method,
      });
    } catch {
      // analytics best-effort
    }
    return true;
  }

  // Centralizes the deny/observe branch so every policy reason goes through
  // the same telemetry shape. Returns `true` when observing (request
  // allowed); throws ForbiddenException when enforcing.
  private denyOrObserve(
    req: { method?: string; route?: { path?: string }; url?: string },
    coachId: string,
    status: string,
    reason: ObserveReason,
    enforce: boolean,
    denyBody: Record<string, unknown>,
  ): true {
    if (enforce) {
      throw new ForbiddenException(denyBody);
    }
    const route = req.route?.path ?? req.url ?? 'unknown';
    const method = req.method ?? 'unknown';
    this.logger.warn(
      `[observe] coach=${coachId} status=${status} reason=${reason} route=${method} ${route}`,
    );
    try {
      this.analytics?.capture(coachId, 'server_billing_enforcement_observed', {
        status,
        reason,
        route,
        method,
      });
    } catch {
      // analytics is best-effort; never block the request
    }
    return true;
  }
}
