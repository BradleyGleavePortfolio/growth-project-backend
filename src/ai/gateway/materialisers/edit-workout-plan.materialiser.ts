import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { z } from 'zod';
import { Prisma, type AiActionDraft } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { SubCoachScopeService } from '../../../sub-coach/sub-coach-scope.service';
import {
  CapabilityMaterializer,
  MaterializeResult,
} from './capability-materialiser.interface';
import {
  applyWorkoutDiff,
  WorkoutDiffApplyError,
} from './__shared/workout-diff.applier';
import {
  PlanSnapshot,
  serialiseSnapshotExercises,
  snapshotFromRevisionJson,
  toPersistableRows,
  WorkoutDiffSchema,
} from './__shared/workout-diff.types';
import { isMwbAiLiveCreateEnabled } from '../mwb-live-create.feature';
import {
  LiveCreateMaterialiseError,
  coercePrismaWriteConflict,
  assertDiffSerializedSizeWithinLimit,
} from './__shared/live-create.shared';

/** Capability string handled by this materialiser. */
export const EDIT_WORKOUT_PLAN_CAPABILITY = 'draft.edit_workout_plan';

/**
 * Payload persisted on `AiActionDraft.payload` for `draft.edit_workout_plan`
 * (brief §4.2). Validated at draft-creation time AND at materialisation time.
 *
 *   - `target_plan_id`: the existing plan to edit.
 *   - `base_revision_index`: optimistic-concurrency token. Must equal the
 *     plan's current head revision_index, else the edit is coerced to a
 *     409 `gateway_concurrent_edit_retry` (brief Test matrix #5).
 *   - `diff`: 1..400 ops, <= 256KB serialised.
 */
export const EditWorkoutPlanPayloadSchema = z
  .object({
    capability: z.literal(EDIT_WORKOUT_PLAN_CAPABILITY),
    target_plan_id: z
      .string()
      .uuid({ message: 'target_plan_id must be a UUID' }),
    base_revision_index: z
      .number()
      .int({ message: 'base_revision_index must be an integer' })
      .min(0, { message: 'base_revision_index must be >= 0' }),
    diff: WorkoutDiffSchema,
  })
  .strict();

export type EditWorkoutPlanPayload = z.infer<
  typeof EditWorkoutPlanPayloadSchema
>;

/** Used by `AiGatewayService.invoke` to validate at draft creation. */
export function assertEditWorkoutPlanPayload(
  raw: unknown,
): EditWorkoutPlanPayload {
  const parsed = EditWorkoutPlanPayloadSchema.parse(raw);
  assertDiffSerializedSizeWithinLimit(parsed.diff);
  return parsed;
}

/**
 * MWB-5 — `draft.edit_workout_plan`.
 *
 * On approval, applies the draft's diff against the plan's CURRENT head
 * snapshot inside a Serializable transaction, after asserting the optimistic
 * concurrency token, then persists the mutated exercise rows + a new
 * WorkoutPlanRevision (cause='ai_apply', author_kind='ai') and advances the
 * head pointer. Idempotent on `draft.id`. The model is NEVER called here.
 */
@Injectable()
export class EditWorkoutPlanMaterializer implements CapabilityMaterializer {
  readonly capability = EDIT_WORKOUT_PLAN_CAPABILITY;
  private readonly logger = new Logger(EditWorkoutPlanMaterializer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subCoachScope: SubCoachScopeService,
  ) {}

  canHandle(capability: string): boolean {
    return capability === EDIT_WORKOUT_PLAN_CAPABILITY;
  }

  async materialize(draft: AiActionDraft): Promise<MaterializeResult> {
    if (draft.materialised_at && draft.materialised_ref) {
      return { status: 'already_materialised', ref: draft.materialised_ref };
    }

    if (!isMwbAiLiveCreateEnabled()) {
      throw new LiveCreateMaterialiseError(
        'AI_LIVE_CREATE_DISABLED',
        'FEATURE_MWB_AI_LIVE_CREATE is off; edit_workout_plan cannot materialise.',
      );
    }

    if (!draft.tenant_coach_id) {
      throw new LiveCreateMaterialiseError(
        'AI_DRAFT_NO_TENANT',
        `edit_workout_plan draft ${draft.id} has no tenant_coach_id`,
      );
    }
    if (!draft.requester_id) {
      throw new ForbiddenException({
        error: 'AI_DRAFT_NO_REQUESTER',
        capability: this.capability,
        message:
          'Draft has no requester_id; cannot verify scope at materialisation time.',
      });
    }

    const payload = this.validatePayload(draft);
    const tenantCoachId = draft.tenant_coach_id;
    const requesterId = draft.requester_id;

    // Authorization (brief §4.2 step 1): scope against the plan's owning
    // client, BEFORE any write. Resolution + check run OUTSIDE the write tx so
    // a scope failure never holds a serializable lock.
    await this.assertScope(payload.target_plan_id, tenantCoachId, requesterId);

    let editedPlanId: string;
    try {
      editedPlanId = await this.prisma.$transaction(
        async (tx) => {
          // SELECT … FOR UPDATE the plan + its head revision. We lock the plan
          // row so a concurrent edit serialises against this one.
          const lockedRows = await tx.$queryRaw<
            Array<{ id: string; head_revision_id: string | null }>
          >(Prisma.sql`
            SELECT id, head_revision_id
            FROM "WorkoutPlan"
            WHERE id = ${payload.target_plan_id}
            FOR UPDATE
          `);
          const locked = lockedRows[0];
          if (!locked) {
            throw new LiveCreateMaterialiseError(
              'AI_LIVE_CREATE_PLAN_NOT_FOUND',
              `edit target plan ${payload.target_plan_id} not found`,
            );
          }
          if (!locked.head_revision_id) {
            throw new LiveCreateMaterialiseError(
              'AI_LIVE_CREATE_PLAN_NO_HEAD',
              `edit target plan ${payload.target_plan_id} has no head revision`,
            );
          }

          const head = await tx.workoutPlanRevision.findUnique({
            where: { id: locked.head_revision_id },
            select: {
              revision_index: true,
              exercises_json: true,
              plan_meta_json: true,
            },
          });
          if (!head) {
            throw new LiveCreateMaterialiseError(
              'AI_LIVE_CREATE_HEAD_MISSING',
              `head revision ${locked.head_revision_id} missing for plan ${payload.target_plan_id}`,
            );
          }

          // Optimistic concurrency: stale base_revision_index → 409
          // gateway_concurrent_edit_retry (brief Test matrix #5).
          if (payload.base_revision_index !== head.revision_index) {
            throw new ConflictException({
              error: 'gateway_concurrent_edit_retry',
              capability: this.capability,
              reason:
                'The plan was edited since this draft was created. Refresh and retry.',
              expected_revision_index: head.revision_index,
              provided_base_revision_index: payload.base_revision_index,
            });
          }

          // Apply the diff against the current head snapshot via the pure
          // applier (single integrity boundary, shared with create).
          const baseline = snapshotFromRevisionJson(
            head.exercises_json,
            head.plan_meta_json,
          );
          let snapshot: PlanSnapshot;
          try {
            snapshot = applyWorkoutDiff(baseline, payload.diff);
          } catch (err) {
            if (err instanceof WorkoutDiffApplyError) {
              throw new LiveCreateMaterialiseError(
                'AI_LIVE_CREATE_DIFF_INVALID',
                `diff could not be applied: ${err.message}`,
              );
            }
            throw err;
          }

          // Persist the mutated exercise rows: archived rows stay archived;
          // we replace the live set by archiving the current live rows and
          // inserting the new ordered set. Archiving (not hard-delete)
          // preserves history for the assignment-snapshot read path.
          await tx.workoutPlanExercise.updateMany({
            where: { workout_plan_id: payload.target_plan_id, archived_at: null },
            data: { archived_at: new Date() },
          });
          const rows = toPersistableRows(snapshot);
          if (rows.length > 0) {
            await tx.workoutPlanExercise.createMany({
              data: rows.map((r) => ({
                ...r,
                workout_plan_id: payload.target_plan_id,
              })),
            });
          }

          // New plan revision (cause='ai_apply', author_kind='ai') at
          // revision_index + 1.
          const newRevision = await tx.workoutPlanRevision.create({
            data: {
              workout_plan_id: payload.target_plan_id,
              revision_index: head.revision_index + 1,
              exercises_json: serialiseSnapshotExercises(
                snapshot,
              ) as unknown as Prisma.InputJsonValue,
              plan_meta_json: {
                name: snapshot.meta.name,
                type: snapshot.meta.type,
                duration_estimate_minutes:
                  snapshot.meta.duration_estimate_minutes,
              } as unknown as Prisma.InputJsonValue,
              author_id: requesterId,
              author_kind: 'ai',
              cause: 'ai_apply',
            },
          });

          // Advance the head pointer + reflect meta + bump version (optimistic
          // token for the human builder path).
          await tx.workoutPlan.update({
            where: { id: payload.target_plan_id },
            data: {
              head_revision_id: newRevision.id,
              name: snapshot.meta.name,
              type: snapshot.meta.type,
              duration_estimate_minutes:
                snapshot.meta.duration_estimate_minutes,
              version: { increment: 1 },
            },
          });

          return payload.target_plan_id;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      throw coercePrismaWriteConflict(err, this.capability);
    }

    await this.prisma.aiActionDraft.updateMany({
      where: { id: draft.id, materialised_at: null },
      data: { materialised_at: new Date(), materialised_ref: editedPlanId },
    });

    return { status: 'sent', ref: editedPlanId };
  }

  private validatePayload(draft: AiActionDraft): EditWorkoutPlanPayload {
    try {
      return assertEditWorkoutPlanPayload(draft.payload);
    } catch (err) {
      this.logger.warn(
        `EditWorkoutPlanMaterializer: payload validation failed for draft ${draft.id}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * Scope gate (brief §4.2 step 1 / 50-Failures #5/#9). Resolves the plan's
   * owning client(s) via ClientWorkoutAssignment and requires
   * canAccessClient for the requester. The plan must also live in the draft's
   * tenant — a cross-tenant plan is refused outright. When the plan is not yet
   * assigned to any client, scope falls back to tenant ownership: the
   * requester must be able to access at least the tenant (head coach owns it;
   * a sub-coach with no assignment to any of the plan's clients is refused).
   */
  private async assertScope(
    planId: string,
    tenantCoachId: string,
    requesterId: string,
  ): Promise<void> {
    const plan = await this.prisma.workoutPlan.findUnique({
      where: { id: planId },
      select: { id: true, coach_id: true },
    });
    if (!plan) {
      throw new LiveCreateMaterialiseError(
        'AI_LIVE_CREATE_PLAN_NOT_FOUND',
        `edit target plan ${planId} not found`,
      );
    }
    if (plan.coach_id !== tenantCoachId) {
      throw new ForbiddenException({
        error: 'AI_LIVE_CREATE_PLAN_TENANT_MISMATCH',
        capability: this.capability,
        message: 'The target plan belongs to a different tenant.',
      });
    }

    const assignments = await this.prisma.clientWorkoutAssignment.findMany({
      where: { workout_plan_id: planId },
      select: { client_id: true },
      distinct: ['client_id'],
    });

    if (assignments.length === 0) {
      // Unassigned plan: scope on tenant ownership. A head coach (coach_id ===
      // tenant) owns it; any other requester must prove client access, which
      // they cannot for an unassigned plan, so they are refused.
      if (requesterId === tenantCoachId) return;
      const isSub = await this.subCoachScope.isSubCoach(requesterId);
      // A sub-coach in the tenant can only edit plans tied to a client they
      // are assigned to; with no assignment there is nothing to scope onto.
      throw new ForbiddenException({
        error: 'AI_LIVE_CREATE_CLIENT_SCOPE_FORBIDDEN',
        capability: this.capability,
        message: isSub
          ? 'This plan is not tied to a client you are assigned to.'
          : 'Requester is not authorized to edit this plan.',
      });
    }

    // Assigned plan: the requester must be able to access EVERY owning client
    // (deny-by-default — a sub-coach must not edit a plan shared with a client
    // outside their roster).
    for (const a of assignments) {
      const ok = await this.subCoachScope.canAccessClient(
        requesterId,
        a.client_id,
      );
      if (!ok) {
        this.logger.warn(
          {
            event: 'AI_LIVE_CREATE_SCOPE_REJECTED',
            capability: this.capability,
            planId,
            requesterId,
            clientId: a.client_id,
          },
          'edit_workout_plan refused: requester lacks canAccessClient',
        );
        throw new ForbiddenException({
          error: 'AI_LIVE_CREATE_CLIENT_SCOPE_FORBIDDEN',
          capability: this.capability,
          message:
            'Requester is not authorized to edit a plan for this client.',
        });
      }
    }
  }
}
