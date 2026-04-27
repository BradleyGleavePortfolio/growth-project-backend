import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// SubscriptionGuard gates coach SaaS write paths behind subscription state.
//
// Policy (from build_phase2a_stripe.md):
//   - active or trialing → allow
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
// guard in observe-only mode: the check still runs and could be wired to
// PostHog telemetry later, but the request is allowed through. Production
// must set BILLING_ENFORCEMENT=enforce after Stripe is live.

const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

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
      // No mirror row yet — allowed during rollout. Once enforcement is on
      // and Stripe is live, every coach has a CoachSubscription row written
      // at customer.subscription.created time, so this branch becomes dead.
      return true;
    }

    const status = sub.status;
    if (status === 'active' || status === 'trialing') return true;

    if (status === 'past_due') {
      const failedAt = sub.last_payment_failed_at?.getTime() ?? 0;
      const within = Date.now() - failedAt < PAST_DUE_GRACE_MS;
      if (within) return true;
      if (!enforce) return true;
      throw new ForbiddenException({
        error: 'SUBSCRIPTION_PAST_DUE_GRACE_EXPIRED',
        message: 'Subscription past due — update payment method to continue',
      });
    }

    if (status === 'canceled' || status === 'paused') {
      if (!enforce) return true;
      throw new ForbiddenException({
        error: 'SUBSCRIPTION_INACTIVE',
        message: 'Subscription is inactive — billing portal required',
        status,
      });
    }

    // incomplete / unpaid / unknown — block on enforce, allow during rollout.
    if (!enforce) return true;
    throw new ForbiddenException({
      error: 'SUBSCRIPTION_INACTIVE',
      message: 'Subscription not active',
      status,
    });
  }
}
