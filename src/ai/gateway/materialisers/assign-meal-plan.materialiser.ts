import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { z } from 'zod';
import { Prisma, type AiActionDraft } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { NotificationsService } from '../../../notifications/notifications.service';
import { NotificationKind } from '../../../notifications/notification-kind';
import {
  CapabilityMaterializer,
  MaterializeResult,
} from './capability-materialiser.interface';

/**
 * Stream 2 — `draft.assign_meal_plan`.
 *
 * Same pattern as `AssignWorkoutMaterializer`. AI proposes assigning a
 * coach's existing `DailyMealPlan` to a client for a date range. Coach
 * approves. Materialiser inserts a single `DailyMealPlanAssignment` row
 * with `ai_draft_id = draft.id` (schema-level idempotency) and fires a
 * `meal_plan_assigned` push.
 *
 * Reversible? Hard-delete window ≤ 24h per spec §2.
 */
export const ASSIGN_MEAL_PLAN_CAPABILITY = 'draft.assign_meal_plan';

/**
 * Payload shape:
 *   - `dailyMealPlanId` (UUID): the existing plan to assign. Must belong
 *     to `draft.tenant_coach_id` (re-checked here).
 *   - `clientId` (UUID): subject. Must be a client of the tenant coach.
 *   - `startsOn` (ISO date, `YYYY-MM-DD`): first day of the plan window.
 *   - `endsOn` (ISO date, `YYYY-MM-DD`, optional): inclusive last day.
 *     When unset the plan runs open-ended until manually unassigned.
 *   - `notificationBody` (≤ 160 chars, optional): override push copy.
 */
export const AssignMealPlanPayloadSchema = z
  .object({
    dailyMealPlanId: z.guid({ message: 'dailyMealPlanId must be a UUID' }),
    clientId: z.guid({ message: 'clientId must be a UUID' }),
    startsOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, {
        message: 'startsOn must be ISO date YYYY-MM-DD',
      }),
    endsOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, {
        message: 'endsOn must be ISO date YYYY-MM-DD',
      })
      .optional(),
    notificationBody: z.string().min(1).max(160).optional(),
  })
  .strict()
  .refine(
    (v) => !v.endsOn || v.endsOn >= v.startsOn,
    { message: 'endsOn must be on or after startsOn', path: ['endsOn'] },
  );

export type AssignMealPlanPayload = z.infer<typeof AssignMealPlanPayloadSchema>;

export function assertAssignMealPlanPayload(
  raw: unknown,
): AssignMealPlanPayload {
  return AssignMealPlanPayloadSchema.parse(raw);
}

@Injectable()
export class AssignMealPlanMaterializer implements CapabilityMaterializer {
  readonly capability = ASSIGN_MEAL_PLAN_CAPABILITY;
  private readonly logger = new Logger(AssignMealPlanMaterializer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  canHandle(capability: string): boolean {
    return capability === ASSIGN_MEAL_PLAN_CAPABILITY;
  }

  async materialize(draft: AiActionDraft): Promise<MaterializeResult> {
    // Spec §3 layer 3 — see AssignWorkoutMaterializer for the rationale.
    if (!draft.requester_id) {
      throw new ForbiddenException({
        error: 'AI_DRAFT_NO_REQUESTER',
        capability: this.capability,
        message: 'Draft has no requester_id.',
      });
    }
    const requester = await this.prisma.user.findUnique({
      where: { id: draft.requester_id },
      select: { id: true, role: true },
    });
    if (!requester || (requester.role !== 'coach' && requester.role !== 'owner')) {
      this.logger.warn(
        {
          event: 'AI_MATERIALISER_ROLE_REJECTED',
          capability: this.capability,
          draftId: draft.id,
          requesterId: draft.requester_id,
          requesterRole: requester?.role ?? null,
        },
        'materialiser refused: draft requester is not coach/owner at approval time',
      );
      throw new ForbiddenException({
        error: 'AI_DRAFT_ROLE_FORBIDDEN_AT_MATERIALISE',
        capability: this.capability,
        message:
          'The draft creator is not a coach at materialisation time. Refusing to emit side-effect.',
      });
    }

    if (!draft.tenant_coach_id) {
      throw new Error(
        `AssignMealPlanMaterializer: draft ${draft.id} has no tenant_coach_id`,
      );
    }

    let payload: AssignMealPlanPayload;
    try {
      payload = assertAssignMealPlanPayload(draft.payload);
    } catch (err) {
      this.logger.warn(
        `AssignMealPlanMaterializer: payload validation failed for draft ${draft.id}: ${(err as Error).message}`,
      );
      throw err;
    }

    let assignmentId: string;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const plan = await tx.dailyMealPlan.findUnique({
          where: { id: payload.dailyMealPlanId },
          select: { id: true, coach_id: true },
        });
        if (!plan) {
          throw new ForbiddenException({
            error: 'AI_DRAFT_MEAL_PLAN_NOT_FOUND',
            capability: this.capability,
            dailyMealPlanId: payload.dailyMealPlanId,
          });
        }
        if (plan.coach_id !== draft.tenant_coach_id) {
          throw new ForbiddenException({
            error: 'AI_DRAFT_MEAL_PLAN_TENANT_MISMATCH',
            capability: this.capability,
            planCoachId: plan.coach_id,
            tenantCoachId: draft.tenant_coach_id,
          });
        }
        return tx.dailyMealPlanAssignment.create({
          data: {
            daily_meal_plan_id: payload.dailyMealPlanId,
            client_id: payload.clientId,
            assigned_by_coach_id: draft.tenant_coach_id ?? requester.id,
            starts_on: new Date(payload.startsOn),
            ends_on: payload.endsOn ? new Date(payload.endsOn) : null,
            ai_draft_id: draft.id,
          },
        });
      });
      assignmentId = created.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.dailyMealPlanAssignment.findFirst({
          where: { ai_draft_id: draft.id },
          select: { id: true },
        });
        if (existing) {
          return { status: 'already_materialised', ref: existing.id };
        }
        this.logger.error(
          `AssignMealPlanMaterializer: P2002 on draft ${draft.id} but no row found by ai_draft_id`,
        );
      }
      throw err;
    }

    const body =
      payload.notificationBody ?? 'Your coach assigned a new meal plan.';
    void this.notifications
      .createNotification({
        user_id: payload.clientId,
        kind: NotificationKind.MEAL_PLAN_ASSIGNED,
        body,
        deep_link: `tgp://meal-plan/${assignmentId}`,
        channel: 'push',
        payload: {
          assignmentId,
          dailyMealPlanId: payload.dailyMealPlanId,
          aiDraftId: draft.id,
        },
      })
      .catch((err) => {
        this.logger.warn(
          {
            event: 'AI_MATERIALISER_PUSH_FAILED',
            capability: this.capability,
            draftId: draft.id,
            assignmentId,
            error: (err as Error).message,
          },
          'meal-plan-assigned push failed; assignment row is still authoritative',
        );
      });

    return { status: 'sent', ref: assignmentId };
  }
}
