import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { OwnerGuard } from '../common/guards/owner.guard';
import { PrismaService } from '../prisma.service';

// OWNER-only billing actions. These are write paths that mutate a coach's
// billing relationship (provision a Stripe customer, start a subscription).
// They must never be reachable by coaches themselves — the per-seat-billing
// model depends on Bradley/Dynasia being the ones who decide when a coach
// goes live, with what trial, on what plan.
@Controller('v1/admin')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class OwnerBillingController {
  constructor(private prisma: PrismaService) {}

  // POST /v1/admin/coaches/:id/start-subscription
  //
  // Skeleton: validates inputs, ensures the target user is a coach, and
  // returns a 501-shaped response that documents the next-PR contract. The
  // actual Stripe customer + subscription creation calls land in the
  // follow-up PR once STRIPE_SECRET_KEY is provisioned. This route is safe
  // to ship today because:
  //   - it is OWNER-only (OwnerGuard)
  //   - it does not yet write to Stripe or to CoachSubscription
  //   - it returns a deterministic, non-leaking 400 when Stripe is not
  //     configured, so the console renders the right empty state
  @Post('coaches/:id/start-subscription')
  async startSubscription(
    @Request() req: AuthedRequest,
    @Param('id') coachId: string,
    @Body() body: { plan?: 'flat_300' },
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
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new BadRequestException({
        error: 'STRIPE_NOT_CONFIGURED',
        message:
          'Stripe is not configured for this environment. Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID_FITNESS, and STRIPE_WEBHOOK_SECRET to enable subscription start.',
      });
    }
    void req.user.id;
    void body;
    throw new BadRequestException({
      error: 'STRIPE_START_NOT_IMPLEMENTED',
      message: 'Stripe subscription provisioning lands in the next PR',
      coachId,
    });
  }
}
