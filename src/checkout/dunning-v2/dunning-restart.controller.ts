import {
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Request,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CoachOrOwnerGuard } from '../../common/guards/coach-or-owner.guard';
import { DunningV2Service } from './dunning-v2.service';

const NOT_PAUSED =
  'This plan is not paused by a payment dispute or inquiry, so there is nothing to restart. Pull down to refresh.';
const UNAVAILABLE =
  'Billing could not be reached, so the plan stays paused and nothing was charged. Try again in a few minutes.';

/** Each coded refusal of restartAfterDisputePause, with the coach's next step. */
const REFUSALS: Record<string, [new (body: object) => HttpException, string, string]> = {
  not_found: [
    NotFoundException,
    'PURCHASE_NOT_FOUND',
    'That plan is not on your roster, so nothing was changed. Pull down to refresh your clients, then try again.',
  ],
  flag_off: [ConflictException, 'PLAN_NOT_DISPUTE_PAUSED', NOT_PAUSED],
  not_paused: [ConflictException, 'PLAN_NOT_DISPUTE_PAUSED', NOT_PAUSED],
  plan_ended: [
    ConflictException,
    'PLAN_ENDED',
    'This plan has ended, so it cannot be restarted. The client can buy the package again.',
  ],
  other_live_plan: [
    ConflictException,
    'OTHER_LIVE_PLAN',
    'The client already has another active plan for this package, so restarting this one would bill them twice. Nothing was changed.',
  ],
  new_dispute: [
    ConflictException,
    'NEW_DISPUTE',
    'The bank opened another payment dispute or inquiry on this plan, so it stays paused and nothing was charged.',
  ],
  billing_busy: [
    ConflictException,
    'BILLING_BUSY',
    'Billing for this plan is being updated right now, so nothing was changed. Try again in a minute.',
  ],
  billing_unavailable: [ServiceUnavailableException, 'BILLING_UNAVAILABLE', UNAVAILABLE],
  billing_resume_failed: [ServiceUnavailableException, 'BILLING_UNAVAILABLE', UNAVAILABLE],
};

/**
 * R-DISPUTE-PAUSE (B-690-8): the coach restarts a plan that a bank dispute or
 * inquiry paused.
 *
 *   POST /v1/coach/purchases/:id/dispute-restart   200 { restarted: true }
 *
 * Coach console route (CoachOrOwnerGuard: a client gets 403). Own roster only:
 * restartAfterDisputePause refuses a purchase whose coach_user_id is not the
 * caller with `not_found` (404) before any Stripe call. Every other refusal is
 * a coded 409/503 with a specific next step.
 */
@ApiTags('checkout')
@Controller('v1/coach/purchases')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class DunningRestartController {
  constructor(private readonly dunningV2: DunningV2Service) {}

  @Roles('coach', 'owner')
  @Post(':id/dispute-restart')
  @HttpCode(200)
  async restart(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<{ restarted: true }> {
    const out = await this.dunningV2.restartAfterDisputePause({
      coachUserId: req.user.id,
      purchaseId: id,
    });
    if (out.restarted) return { restarted: true };
    const [Refusal, code, message] = REFUSALS[out.reason] ?? [
      ConflictException,
      'RESTART_REFUSED',
      'The plan could not be restarted, so it stays paused and nothing was charged. Pull down to refresh, then try again.',
    ];
    throw new Refusal({ code, error: code, message });
  }
}
