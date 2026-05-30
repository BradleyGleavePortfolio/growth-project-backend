import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { OwnerGuard } from '../common/guards/owner.guard';
import { PrismaService } from '../prisma.service';
import { StartSubscriptionDto } from './start-subscription.dto';
import { StripeApiError, StripeApiService } from './stripe-api.service';

// OWNER-only billing actions. These are write paths that mutate a coach's
// billing relationship (provision a Stripe customer, start a subscription).
// They must never be reachable by coaches themselves — the per-seat-billing
// model depends on the OWNER deciding when a coach goes live, with what
// trial, on what plan.

// SubscriptionStatus enum members on CoachProfile. CoachSubscription.status
// holds the full Stripe lifecycle (`incomplete`/`unpaid` included); the
// CoachProfile mirror only carries the five enum values from prisma.
const PROFILE_STATUS_VALUES: Set<SubscriptionStatus> = new Set<SubscriptionStatus>([
  SubscriptionStatus.active,
  SubscriptionStatus.trialing,
  SubscriptionStatus.past_due,
  SubscriptionStatus.canceled,
  SubscriptionStatus.paused,
]);

function isProfileStatus(status: string): status is SubscriptionStatus {
  return PROFILE_STATUS_VALUES.has(status as SubscriptionStatus);
}

const ACTIVE_BLOCKING_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
]);

@ApiTags('billing-admin')
@Controller('v1/admin')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class OwnerBillingController {
  private readonly logger = new Logger(OwnerBillingController.name);

  constructor(
    private prisma: PrismaService,
    private stripeApi: StripeApiService,
  ) {}

  // POST /v1/admin/coaches/:id/start-subscription
  //
  // Provisions a Stripe Customer (if needed) and creates a Subscription on
  // the configured price for a coach. Mirrors immediately into
  // CoachSubscription / CoachProfile so the console reflects state without
  // waiting for the webhook (the webhook handler will idempotently re-apply
  // the same row on arrival).
  //
  // Body: { plan?: 'flat_300', trialDays?: 0..90 }
  //
  // B3 — createCustomer + createSubscription are Stripe-writes; throttle to
  // 10/min (mirrors the other Stripe-write routes) so the provisioning path
  // can't be hammered into Stripe rate limits.
  // B4 — StartSubscriptionDto enforces plan/trialDays at the boundary via
  // the global ValidationPipe before any Stripe call.
  @Post('coaches/:id/start-subscription')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async startSubscription(
    @Request() req: AuthedRequest,
    @Param('id') coachId: string,
    @Body() body: StartSubscriptionDto = {},
  ) {
    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { id: true, role: true, email: true, name: true },
    });
    if (!coach || coach.role !== 'coach') {
      throw new BadRequestException({
        error: 'COACH_NOT_FOUND',
        message: 'Target user is not a coach',
      });
    }

    const profile = await this.prisma.coachProfile.findUnique({
      where: { user_id: coachId },
    });
    if (!profile) {
      throw new BadRequestException({
        error: 'COACH_PROFILE_MISSING',
        message:
          'Coach has no CoachProfile row. Provision the profile before starting a subscription.',
      });
    }

    if (!this.stripeApi.isConfigured()) {
      throw new BadRequestException({
        error: 'STRIPE_NOT_CONFIGURED',
        message:
          'Stripe is not configured for this environment. Set STRIPE_SECRET_KEY to enable subscription start.',
      });
    }
    const priceId = process.env.STRIPE_PRICE_ID_FITNESS;
    if (!priceId) {
      throw new BadRequestException({
        error: 'STRIPE_PRICE_NOT_CONFIGURED',
        message:
          'STRIPE_PRICE_ID_FITNESS is unset. Configure the flat plan price id before starting a subscription.',
      });
    }

    let trialDays: number | undefined;
    if (typeof body.trialDays !== 'undefined') {
      const t = body.trialDays;
      if (!Number.isInteger(t) || t < 0 || t > 90) {
        throw new BadRequestException({
          error: 'INVALID_TRIAL_DAYS',
          message: 'trialDays must be an integer between 0 and 90.',
        });
      }
      // 0 means "no trial" — pass undefined so Stripe applies the default.
      trialDays = t > 0 ? t : undefined;
    }

    // Block re-provisioning when the coach is already on an active-style
    // subscription. Plan changes go through the Customer Portal.
    const existingSub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: coachId },
    });
    if (
      existingSub?.status &&
      ACTIVE_BLOCKING_STATUSES.has(existingSub.status)
    ) {
      throw new BadRequestException({
        error: 'SUBSCRIPTION_ALREADY_ACTIVE',
        message:
          'Coach already has an active subscription. Use the Customer Portal for plan changes.',
        status: existingSub.status,
      });
    }

    try {
      // 1) Reuse the customer id when one is already on the profile —
      //    avoid creating duplicate customers on Stripe's side.
      let customerId = profile.stripe_customer_id;
      if (!customerId) {
        const customer = await this.stripeApi.createCustomer({
          email: coach.email,
          name: coach.name,
          metadata: { coach_id: coach.id },
          idempotencyKey: `coach_customer_${coach.id}`,
        });
        customerId = customer.id;
      }

      // 2) Create the subscription. Idempotency key includes the price id so
      //    a future plan change with a different price is not a duplicate.
      const subscription = await this.stripeApi.createSubscription({
        customer: customerId,
        priceId,
        trialPeriodDays: trialDays,
        metadata: {
          coach_id: coach.id,
          plan_tier: 'flat_300',
          started_by_owner_id: req.user.id,
        },
        idempotencyKey: `coach_subscription_${coach.id}_${priceId}`,
      });

      // 3) Mirror immediately so the console doesn't have to wait for the
      //    webhook. The webhook handler upserts on the same key, so this is
      //    not racy — both paths converge on Stripe's eventually-consistent
      //    state.
      const status = subscription.status ?? 'incomplete';
      const currentPeriodEnd = toDate(subscription.current_period_end);
      const trialEnd = toDate(subscription.trial_end ?? null);
      const cancelAtPeriodEnd = !!subscription.cancel_at_period_end;
      const stripePriceId =
        subscription.items?.data?.[0]?.price?.id ?? priceId;

      await this.prisma.coachSubscription.upsert({
        where: { coach_id: coach.id },
        create: {
          coach_id: coach.id,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscription.id,
          stripe_price_id: stripePriceId,
          status,
          current_period_end: currentPeriodEnd,
          trial_end: trialEnd,
          cancel_at_period_end: cancelAtPeriodEnd,
        },
        update: {
          stripe_customer_id: customerId,
          stripe_subscription_id: subscription.id,
          stripe_price_id: stripePriceId,
          status,
          current_period_end: currentPeriodEnd,
          trial_end: trialEnd,
          cancel_at_period_end: cancelAtPeriodEnd,
        },
      });

      // Mirror onto CoachProfile too. subscription_status is a Prisma enum
      // with only five members, so only write it when the Stripe status maps
      // cleanly — `incomplete`/`unpaid` leave the enum field untouched and
      // are still carried in full on CoachSubscription.status.
      await this.prisma.coachProfile.update({
        where: { user_id: coach.id },
        data: {
          stripe_customer_id: customerId,
          stripe_subscription_id: subscription.id,
          ...(isProfileStatus(status)
            ? { subscription_status: status }
            : {}),
          current_period_end: currentPeriodEnd,
          trial_end: trialEnd,
        },
      });

      return {
        coachId: coach.id,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
        status,
        current_period_end: currentPeriodEnd,
        trial_end: trialEnd,
      };
    } catch (err) {
      if (err instanceof StripeApiError) {
        this.logger.warn(
          `start-subscription Stripe error coach=${coach.id} code=${err.stripeCode} status=${err.httpStatus}`,
        );
        throw new HttpException(
          {
            error: 'STRIPE_START_FAILED',
            message: err.message,
            stripeCode: err.stripeCode,
          },
          err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502,
        );
      }
      throw err;
    }
  }

  // POST /v1/admin/coaches/:id/cancel-subscription
  //
  // Cancels a coach's Stripe subscription. Two modes via the body:
  //   - { immediately: false } (default): set `cancel_at_period_end=true`.
  //     Coach keeps access through the current period; status converges
  //     to canceled on the period boundary via the webhook.
  //   - { immediately: true }: hard cancel today. Reserved for OWNER use
  //     in chargeback / fraud scenarios. Coach loses access immediately;
  //     the webhook fires `customer.subscription.deleted` and the mirror
  //     row's status flips to `canceled` synchronously below (the webhook
  //     idempotently re-applies the same state on arrival).
  //
  // The Stripe Customer Portal does NOT expose cancellation today (see
  // docs/stripe-setup.md §2.3 — cancellation is disabled in portal config
  // so it routes through OWNER tooling for CoachProfile reconciliation).
  // This endpoint is the canonical cancel surface.
  //
  // Owner-only: mutates a coach's billing relationship and is the only
  // cancel path (Customer Portal cancellation is disabled). A coach
  // canceling their own subscription must go through the OWNER, who
  // reconciles CoachProfile mirror state. Never expose to coaches or
  // students.
  @Roles('owner')
  @Post('coaches/:id/cancel-subscription')
  async cancelSubscription(
    @Request() req: AuthedRequest,
    @Param('id') coachId: string,
    @Body() body: { immediately?: boolean } = {},
  ) {
    if (!this.stripeApi.isConfigured()) {
      throw new BadRequestException({
        error: 'STRIPE_NOT_CONFIGURED',
        message:
          'Stripe is not configured for this environment. Set STRIPE_SECRET_KEY to enable cancellation.',
      });
    }
    const sub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: coachId },
    });
    if (!sub?.stripe_subscription_id) {
      throw new NotFoundException({
        error: 'SUBSCRIPTION_NOT_FOUND',
        message:
          'Coach has no Stripe subscription on file. Nothing to cancel.',
      });
    }
    if (sub.status === 'canceled') {
      // Idempotent — return the existing terminal state rather than
      // pinging Stripe (which would 400 on a re-cancellation).
      return {
        coachId,
        stripe_subscription_id: sub.stripe_subscription_id,
        status: 'canceled',
        cancel_at_period_end: sub.cancel_at_period_end,
        already_canceled: true,
      };
    }
    const immediately = body.immediately === true;
    // Idempotency key is per-mode so a follow-up immediate cancel after a
    // soft cancel is not a duplicate.
    const idempotencyKey = `coach_cancel_${coachId}_${immediately ? 'now' : 'eop'}`;

    try {
      const updated = await this.stripeApi.cancelSubscription({
        subscriptionId: sub.stripe_subscription_id,
        immediately,
        idempotencyKey,
      });
      const status = updated.status ?? (immediately ? 'canceled' : sub.status);
      const cancelAtPeriodEnd =
        typeof updated.cancel_at_period_end === 'boolean'
          ? updated.cancel_at_period_end
          : !immediately;

      // Mirror immediately so the console reflects the cancel before the
      // webhook arrives. The webhook handler upserts on the same key so
      // both paths converge.
      await this.prisma.coachSubscription.update({
        where: { coach_id: coachId },
        data: {
          status,
          cancel_at_period_end: cancelAtPeriodEnd,
        },
      });

      this.logger.log(
        `cancel-subscription owner=${req.user.id} coach=${coachId} mode=${immediately ? 'immediate' : 'period_end'} status=${status}`,
      );

      return {
        coachId,
        stripe_subscription_id: sub.stripe_subscription_id,
        status,
        cancel_at_period_end: cancelAtPeriodEnd,
        immediately,
      };
    } catch (err) {
      if (err instanceof StripeApiError) {
        this.logger.warn(
          `cancel-subscription Stripe error coach=${coachId} code=${err.stripeCode} status=${err.httpStatus}`,
        );
        throw new HttpException(
          {
            error: 'STRIPE_CANCEL_FAILED',
            message: err.message,
            stripeCode: err.stripeCode,
          },
          err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502,
        );
      }
      throw err;
    }
  }
}

function toDate(seconds: unknown): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}
