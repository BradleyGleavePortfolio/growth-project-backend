import {
  Body,
  Controller,
  Logger,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequiresTier } from '../../billing/requires-tier.decorator';
import { SubscriptionGuard } from '../../billing/subscription.guard';
import { AiGatewayService } from '../gateway/ai-gateway.service';
import {
  ASSIGN_WORKOUT_CAPABILITY,
} from '../gateway/materialisers/assign-workout.materialiser';
import {
  ASSIGN_MEAL_PLAN_CAPABILITY,
} from '../gateway/materialisers/assign-meal-plan.materialiser';
import {
  SEND_NOTIFICATION_CAPABILITY,
} from '../gateway/materialisers/send-notification.materialiser';

/**
 * Stream 2 — Coach-side entrypoints for the four AI-execution
 * capabilities. The existing `POST /ai/gateway/invoke` already accepts
 * any capability string in the body, but the spec §4.4 calls for
 * dedicated coach-scoped routes so:
 *
 *   1. Mobile gets a typed contract per capability instead of having
 *      to construct the generic gateway envelope inline.
 *   2. The role gate is at THREE concentric layers (controller +
 *      gateway + materialiser) — the spec §3 hard role boundary — and
 *      a dedicated controller is the natural primary defence.
 *   3. Per-endpoint throttle tuning (assign_workout 5/hr feels right;
 *      send_notification can be tighter since the side-effect is a
 *      push and rate-limiting matters more there).
 *
 * Every route here is `@Roles('coach', 'owner')` + `JwtAuthGuard` +
 * `CoachGuard` + `SubscriptionGuard` (tier=pro). Owners are listed for
 * the same self-documenting parity with the rest of /coach/ai/*; the
 * RolesGuard owner-bypass would admit them anyway. Clients hitting any
 * of these endpoints get 403 from the CoachGuard BEFORE the gateway
 * role gate fires.
 *
 * Note: `draft.client_message` is intentionally NOT a dedicated route
 * here. After the spec-invited build-time evaluation it was MERGED into
 * `draft.coach_message` (same target row, same payload, same
 * materialiser). The merge decision is recorded in the migration
 * commit body.
 */
@ApiTags('coach-ai-execution')
@Controller('v1/coach/ai/draft')
@RequiresTier('pro')
@UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
export class CoachAIExecutionController {
  private readonly logger = new Logger(CoachAIExecutionController.name);

  constructor(private readonly gateway: AiGatewayService) {}

  // ─── DTOs ────────────────────────────────────────────────────────────────
  //
  // Defined inline below as classes so `class-validator` decorators apply.
  // Keeps the controller file self-contained at this scale; if more
  // endpoints land, split into a sibling `.dto.ts`.

  /**
   * `POST /v1/coach/ai/draft/assign-workout`
   *
   * Body shape mirrors `AssignWorkoutPayloadSchema` but with a `prompt`
   * field for the AI invocation. The gateway runs the prompt through
   * the provider, validates the proposed payload against the Zod
   * schema, persists the draft in `AiActionDraft`, and returns the
   * draft id so mobile can route into the pending-drafts inbox.
   */
  @Roles('coach', 'owner')
  @Throttle({ default: { ttl: 3600000, limit: 30 } })
  @Post('assign-workout')
  async draftAssignWorkout(
    @Request() req: AuthedRequest,
    @Body() body: DraftAssignWorkoutDto,
  ) {
    const result = await this.gateway.invoke({
      capability: ASSIGN_WORKOUT_CAPABILITY,
      requester: { id: req.user.id, role: req.user.role },
      subjectUserId: body.clientId,
      tenantCoachId: req.user.id,
      userMessage: body.prompt,
      systemPrompt:
        'You are drafting a workout assignment proposal for a coach to review. ' +
        'Respond with the rationale only; the structured payload comes from the coach UI.',
      proposedActionPayload: {
        workoutPlanId: body.workoutPlanId,
        clientId: body.clientId,
        scheduledFor: body.scheduledFor,
        notificationBody: body.notificationBody,
      },
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });
    return draftResponse(result);
  }

  /**
   * `POST /v1/coach/ai/draft/assign-meal-plan`
   * Same envelope as assign-workout; capability = draft.assign_meal_plan.
   */
  @Roles('coach', 'owner')
  @Throttle({ default: { ttl: 3600000, limit: 30 } })
  @Post('assign-meal-plan')
  async draftAssignMealPlan(
    @Request() req: AuthedRequest,
    @Body() body: DraftAssignMealPlanDto,
  ) {
    const result = await this.gateway.invoke({
      capability: ASSIGN_MEAL_PLAN_CAPABILITY,
      requester: { id: req.user.id, role: req.user.role },
      subjectUserId: body.clientId,
      tenantCoachId: req.user.id,
      userMessage: body.prompt,
      systemPrompt:
        'You are drafting a meal-plan assignment proposal for a coach to review. ' +
        'Respond with the rationale only; the structured payload comes from the coach UI.',
      proposedActionPayload: {
        dailyMealPlanId: body.dailyMealPlanId,
        clientId: body.clientId,
        startsOn: body.startsOn,
        endsOn: body.endsOn,
        notificationBody: body.notificationBody,
      },
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });
    return draftResponse(result);
  }

  /**
   * `POST /v1/coach/ai/draft/send-notification`
   * Tighter throttle (10/hr) because the side-effect is a push and a
   * compromised coach account spamming pushes is a worse outcome than
   * spamming workout/meal-plan drafts (those are not delivered until
   * the coach also approves; for notifications the delivery + approval
   * step are basically the same event).
   */
  @Roles('coach', 'owner')
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @Post('send-notification')
  async draftSendNotification(
    @Request() req: AuthedRequest,
    @Body() body: DraftSendNotificationDto,
  ) {
    const result = await this.gateway.invoke({
      capability: SEND_NOTIFICATION_CAPABILITY,
      requester: { id: req.user.id, role: req.user.role },
      subjectUserId: body.clientId,
      tenantCoachId: req.user.id,
      userMessage: body.prompt,
      systemPrompt:
        'You are drafting a short push notification body for a coach to review. ' +
        'The notification is sent only after the coach approves. Respond with the ' +
        'rationale only; the structured payload comes from the coach UI.',
      proposedActionPayload: {
        clientId: body.clientId,
        kind: body.kind,
        body: body.body,
        deepLink: body.deepLink,
        channel: body.channel,
      },
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });
    return draftResponse(result);
  }
}

// ─── DTOs ──────────────────────────────────────────────────────────────────

export class DraftAssignWorkoutDto {
  @IsUUID()
  workoutPlanId!: string;

  @IsUUID()
  clientId!: string;

  // ISO 8601 string. Re-validated by the materialiser's Zod schema.
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  scheduledFor!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  prompt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  notificationBody?: string;
}

export class DraftAssignMealPlanDto {
  @IsUUID()
  dailyMealPlanId!: string;

  @IsUUID()
  clientId!: string;

  // `YYYY-MM-DD` enforced by the Zod schema at the materialiser; we
  // accept any string up to 10 chars here so a malformed value still
  // surfaces a structured 400 via the gateway's payload validator.
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startsOn!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endsOn?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  prompt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  notificationBody?: string;
}

export class DraftSendNotificationDto {
  @IsUUID()
  clientId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  kind!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  body!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  prompt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  deepLink?: string;

  @IsOptional()
  @IsString()
  channel?: 'push' | 'inapp';
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function draftResponse(result: {
  requestId: string;
  auditId: string;
  approvalDraftId: string | null;
  approvalRequired: boolean;
  approvalStatus: string;
}) {
  return {
    request_id: result.requestId,
    audit_id: result.auditId,
    approval: {
      required: result.approvalRequired,
      status: result.approvalStatus,
      draft_id: result.approvalDraftId,
    },
  };
}

function extractIp(req: AuthedRequest): string | null {
  const xff = (req.headers?.['x-forwarded-for'] as string) ?? '';
  if (xff) return xff.split(',')[0].trim();
  return req.ip ?? null;
}

function extractUserAgent(req: AuthedRequest): string | null {
  const ua = req.headers?.['user-agent'];
  if (!ua) return null;
  return Array.isArray(ua) ? ua[0] ?? null : ua;
}
