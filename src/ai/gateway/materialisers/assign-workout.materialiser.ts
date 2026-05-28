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
 * Stream 2 — `draft.assign_workout`.
 *
 * AI proposes assigning a coach's existing `WorkoutPlan` to a specific
 * client on a specific date. Coach reviews in the pending-drafts inbox.
 * On approve, this materialiser inserts a single `ClientWorkoutAssignment`
 * row with `ai_draft_id = draft.id` (schema-level idempotency guard),
 * then fires a `workout_assigned` push notification to the client.
 *
 * Reversible? Hard-delete window ≤ 24h per spec §2.
 *
 * Spec §3 hard role boundary: layer 3 (materialiser-level creator-role
 * assertion). The controller guard (layer 1) and the gateway role-gate
 * (layer 2) already refuse non-coach/non-owner callers — but this check
 * is the last line of defence. If a future controller is added without
 * the coach guard AND the gateway role-gate is bypassed (e.g. a
 * background job that constructs an AiGatewayRequest manually), the
 * materialiser still refuses.
 */
export const ASSIGN_WORKOUT_CAPABILITY = 'draft.assign_workout';

/**
 * Payload shape persisted on `AiActionDraft.payload` for
 * `draft.assign_workout`. Validated at draft-creation time in
 * `AiGatewayService.invoke` AND at materialisation time here
 * (defence-in-depth — drift detection if a future migration ever
 * rewrites payload shape).
 *
 * Field choices:
 *   - `workoutPlanId` (UUID): the existing plan to assign. The plan
 *     must belong to `draft.tenant_coach_id` — we re-check here even
 *     though the controller's resolveContext already filtered, because
 *     the materialiser is the trust boundary on approval.
 *   - `clientId` (UUID): subject. Must be a client of the tenant coach.
 *   - `scheduledFor` (ISO date-time): when the workout is due. ISO 8601
 *     so the JSON column stays serializable; we parse to Date at
 *     create-time.
 *   - `notificationBody` (≤ 160 chars, optional): override copy for
 *     the push. Defaults to a deterministic template when unset so the
 *     coach doesn't have to write copy in the AI prompt.
 */
export const AssignWorkoutPayloadSchema = z
  .object({
    workoutPlanId: z
      .string()
      .uuid({ message: 'workoutPlanId must be a UUID' }),
    clientId: z.string().uuid({ message: 'clientId must be a UUID' }),
    scheduledFor: z
      .string()
      .refine((s) => !Number.isNaN(Date.parse(s)), {
        message: 'scheduledFor must be an ISO 8601 date-time string',
      }),
    notificationBody: z
      .string()
      .min(1)
      .max(160, { message: 'notificationBody exceeds 160 chars' })
      .optional(),
  })
  .strict();

export type AssignWorkoutPayload = z.infer<typeof AssignWorkoutPayloadSchema>;

/** Used by `AiGatewayService.invoke` to validate at draft creation. */
export function assertAssignWorkoutPayload(
  raw: unknown,
): AssignWorkoutPayload {
  return AssignWorkoutPayloadSchema.parse(raw);
}

@Injectable()
export class AssignWorkoutMaterializer implements CapabilityMaterializer {
  readonly capability = ASSIGN_WORKOUT_CAPABILITY;
  private readonly logger = new Logger(AssignWorkoutMaterializer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  canHandle(capability: string): boolean {
    return capability === ASSIGN_WORKOUT_CAPABILITY;
  }

  async materialize(draft: AiActionDraft): Promise<MaterializeResult> {
    // Spec §3 layer 3 — refuse if the draft's requester is not a coach.
    // We re-fetch from User rather than trusting the draft row's
    // role-at-create-time because a coach who is demoted to client
    // between draft creation and approval must NOT be able to materialise
    // pending drafts. The 24h hard-delete window in spec §2 helps but
    // the role re-check is the actual guarantee.
    if (!draft.requester_id) {
      throw new ForbiddenException({
        error: 'AI_DRAFT_NO_REQUESTER',
        capability: this.capability,
        message:
          'Draft has no requester_id; cannot verify coach role at materialisation time.',
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
        `AssignWorkoutMaterializer: draft ${draft.id} has no tenant_coach_id`,
      );
    }

    // Defence-in-depth payload validation. The gateway already validated
    // at draft creation; a stale or hand-edited row must not crash the
    // assignment service.
    let payload: AssignWorkoutPayload;
    try {
      payload = assertAssignWorkoutPayload(draft.payload);
    } catch (err) {
      this.logger.warn(
        `AssignWorkoutMaterializer: payload validation failed for draft ${draft.id}: ${(err as Error).message}`,
      );
      throw err;
    }

    // Idempotency: schema-level @unique on ai_draft_id. We optimistically
    // attempt the INSERT inside a transaction and catch P2002. If P2002
    // fires, a prior approval already materialised this draft (or a
    // concurrent approver beat us); re-query and return the existing
    // row's id. This is the spec §4.2 race path.
    let assignmentId: string;
    try {
      // Read the workout plan to validate ownership + capture coach id
      // for the assignment FK. Inside the tx so the plan-existence check
      // is consistent with the create.
      const created = await this.prisma.$transaction(async (tx) => {
        const plan = await tx.workoutPlan.findUnique({
          where: { id: payload.workoutPlanId },
          select: { id: true, coach_id: true },
        });
        if (!plan) {
          throw new ForbiddenException({
            error: 'AI_DRAFT_WORKOUT_PLAN_NOT_FOUND',
            capability: this.capability,
            workoutPlanId: payload.workoutPlanId,
          });
        }
        // Plan-tenant check: the AI cannot assign a plan from another
        // coach. The draft's tenant_coach_id was pinned at invoke time;
        // the plan's coach_id must match.
        if (plan.coach_id !== draft.tenant_coach_id) {
          throw new ForbiddenException({
            error: 'AI_DRAFT_WORKOUT_PLAN_TENANT_MISMATCH',
            capability: this.capability,
            planCoachId: plan.coach_id,
            tenantCoachId: draft.tenant_coach_id,
          });
        }
        return tx.clientWorkoutAssignment.create({
          data: {
            workout_plan_id: payload.workoutPlanId,
            client_id: payload.clientId,
            assigned_by_coach_id: draft.tenant_coach_id ?? requester.id,
            scheduled_for: new Date(payload.scheduledFor),
            ai_draft_id: draft.id,
          },
        });
      });
      assignmentId = created.id;
    } catch (err) {
      // P2002 (unique constraint) is the race-recovery path: another
      // approver landed the row first. Re-query and return that id.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.clientWorkoutAssignment.findFirst({
          where: { ai_draft_id: draft.id },
          select: { id: true },
        });
        if (existing) {
          return { status: 'already_materialised', ref: existing.id };
        }
        // P2002 without an existing row is genuinely surprising — log
        // loudly and rethrow so the operator can investigate.
        this.logger.error(
          `AssignWorkoutMaterializer: P2002 on draft ${draft.id} but no row found by ai_draft_id`,
        );
      }
      throw err;
    }

    // Push notification — fire-and-forget per spec §4.2. The assignment
    // row IS the source of truth; a push delivery failure must NOT keep
    // the draft pending (rolling back the assignment because the push
    // failed would surprise the coach who already approved).
    const body =
      payload.notificationBody ?? 'Your coach assigned a new workout.';
    void this.notifications
      .createNotification({
        user_id: payload.clientId,
        kind: NotificationKind.WORKOUT_ASSIGNED,
        body,
        deep_link: `tgp://workouts/${assignmentId}`,
        channel: 'push',
        payload: {
          assignmentId,
          workoutPlanId: payload.workoutPlanId,
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
          'workout-assigned push failed; assignment row is still authoritative',
        );
      });

    return { status: 'sent', ref: assignmentId };
  }
}
