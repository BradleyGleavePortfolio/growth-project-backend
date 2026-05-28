import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachAIBudgetService } from './coach-ai-budget.service';
import { CoachAiCreditPackService } from './coach-ai-credit-pack.service';
import { CoachAiBudgetResponseDto } from './coach-ai-budget.dto';
import {
  CreditPackCheckoutRequestDto,
  CreditPackCheckoutResponseDto,
} from './credit-pack-checkout.dto';
import { THROTTLER_NAMES, THROTTLER_ROUTE_LIMITS } from '../throttler/throttler.config';

@ApiTags('coach-ai-credits')
@Controller('coach/ai')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachAiController {
  private readonly logger = new Logger(CoachAiController.name);

  constructor(
    private readonly budget: CoachAIBudgetService,
    private readonly packs: CoachAiCreditPackService,
  ) {}

  @Roles('coach', 'owner')
  @Get('budget')
  @ApiOperation({
    summary: 'Current AI budget snapshot for the authenticated coach',
    description:
      'Returns the combined coach+client AI budget for the current period. ' +
      'Sub-coaches see their head coach\'s envelope. Used by the mobile ' +
      'AIBudgetMeter for the 60% / 80% / 95% / 100% threshold logic.',
  })
  @ApiResponse({ status: 200, type: CoachAiBudgetResponseDto })
  async getBudget(@Request() req: AuthedRequest): Promise<CoachAiBudgetResponseDto> {
    const headCoachId = await this.budget.resolveHeadCoachId(req.user.id);
    return this.budget.getBudgetDto(headCoachId);
  }

  /**
   * POST /coach/ai/credit-packs/checkout
   *
   * Mints a Stripe Checkout Session for one of the three locked pack tiers
   * (small $10 / medium $25 / large $99) or a custom amount [$10, $500].
   *
   * The throttle is tighter than the catch-all coach-bucket because every
   * call hits Stripe + creates a row in CoachCreditPackPurchase. 5/min/user
   * stops automated abuse without ever interfering with a real coach who
   * legitimately retries on a flaky network.
   */
  @Roles('coach', 'owner')
  @Throttle({
    [THROTTLER_NAMES.COACH_AI_CREDIT_PACK_CHECKOUT]: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COACH_AI_CREDIT_PACK_CHECKOUT_PER_MIN,
    },
  })
  @Post('credit-packs/checkout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create a Stripe Checkout Session for a credit pack',
    description:
      'Locked tiers: $10 / $25 / $99. Custom: integer cents in [1000, 50000]. ' +
      'Returns checkout_url which the mobile app loads in a webview.',
  })
  @ApiResponse({ status: 200, type: CreditPackCheckoutResponseDto })
  async createCheckout(
    @Request() req: AuthedRequest,
    @Body() body: CreditPackCheckoutRequestDto,
  ): Promise<CreditPackCheckoutResponseDto> {
    const result = await this.packs.createCheckoutSession({
      coachUserId: req.user.id,
      tier: body.tier,
      amountCents: body.amount_cents,
      successUrl: body.success_url,
      cancelUrl: body.cancel_url,
    });
    return {
      checkout_session_id: result.checkout_session_id,
      checkout_url: result.checkout_url,
      amount_cents: result.amount_cents,
    };
  }
}
