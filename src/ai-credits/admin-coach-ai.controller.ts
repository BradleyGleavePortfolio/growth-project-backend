import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { OwnerGuard } from '../common/guards/owner.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachAIBudgetService } from './coach-ai-budget.service';
import { PrismaService } from '../prisma.service';

class GrantCreditsRequestDto {
  @IsUUID()
  coach_user_id!: string;

  @IsInt()
  @Min(1)
  @Max(500_000) // owner-tool sanity ceiling: $5000 displayed (50x the largest pack).
  displayed_cents!: number;

  @IsString()
  @MaxLength(500)
  reason!: string;
}

class RefundPackRequestDto {
  @IsUUID()
  purchase_id!: string;

  @IsString()
  @MaxLength(500)
  reason!: string;
}

class ListBudgetsQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @IsOptional()
  @IsUUID()
  cursor?: string;
}

// Owner-only admin tooling for the Coach AI credit system.
//
// Every route here is gated by BOTH JwtAuthGuard + OwnerGuard at the class
// level (defence in depth — the explicit @Roles('owner') closes the
// 50 Failures #9 "auth as decoration" failure where a sibling handler
// later inherits the class guard but forgets the role tag). The owner-only
// posture means coaches cannot grant themselves credits or trigger their
// own refunds; only TGP staff (role=owner) can.

@ApiTags('admin-coach-ai')
@Controller('v1/admin/coach-ai')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class AdminCoachAiController {
  private readonly logger = new Logger(AdminCoachAiController.name);

  constructor(
    private readonly budget: CoachAIBudgetService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles('owner')
  @Post('grant-credits')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Owner-only: grant free AI credits to a coach',
    description:
      'Adds displayed_cents to the coach\'s current-period budget. Recorded as a ' +
      'CoachCreditPackPurchase row with paid_cents=0 so reports distinguish free ' +
      'grants from paid packs. Reason is mandatory and persisted in the structured log.',
  })
  async grantCredits(
    @Request() req: AuthedRequest,
    @Body() body: GrantCreditsRequestDto,
  ) {
    const result = await this.budget.grantFreeCredits({
      coachId: body.coach_user_id,
      displayedCents: body.displayed_cents,
      reason: body.reason,
      actorOwnerId: req.user.id,
    });
    return { ok: true, purchase_id: result.purchaseId, budget_id: result.budgetId };
  }

  @Roles('owner')
  @Post('refund-pack')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Owner-only: refund a credit pack purchase',
    description:
      'Reverses the displayed+paid accumulators on the budget row and flips the ' +
      'purchase status to "refunded". Refuses to refund a purchase that is not ' +
      'currently "paid". The Stripe refund itself is NOT issued here — that is ' +
      'handled by the existing refund tooling. This endpoint reverses our ' +
      'internal accounting only.',
  })
  async refundPack(
    @Request() req: AuthedRequest,
    @Body() body: RefundPackRequestDto,
  ) {
    const result = await this.budget.refundPack({
      purchaseId: body.purchase_id,
      actorOwnerId: req.user.id,
      reason: body.reason,
    });
    if (!result.refunded) {
      throw new BadRequestException({
        error: 'COACH_AI_PACK_REFUND_REFUSED',
        reason: result.reason,
      });
    }
    return { ok: true };
  }

  @Roles('owner')
  @Get('budgets')
  @ApiOperation({
    summary: 'Owner-only: paginated list of CoachAIBudget rows',
    description:
      'Cursor pagination by id. Used by the admin console to surface ' +
      'coaches near or over their cap. The DTO mirrors the coach-facing ' +
      'response but adds raw row counts for support.',
  })
  async listBudgets(@Query() query: ListBudgetsQueryDto) {
    const take = query.take ?? 50;
    const rows = await this.prisma.coachAIBudget.findMany({
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      include: {
        coach: { select: { id: true, email: true, name: true } },
      },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      data: page.map((r) => ({
        id: r.id,
        coach: r.coach,
        period_start: r.period_start.toISOString(),
        period_end: r.period_end.toISOString(),
        base_actual_cents: r.base_actual_cents,
        base_displayed_cents: r.base_displayed_cents,
        pack_paid_cents: r.pack_paid_cents,
        pack_displayed_cents: r.pack_displayed_cents,
        actual_used_cents: r.actual_used_cents,
        value_multiplier: r.value_multiplier.toFixed(3),
      })),
      next_cursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}
