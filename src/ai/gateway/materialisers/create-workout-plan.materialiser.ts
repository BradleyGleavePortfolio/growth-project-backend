import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { z } from 'zod';
import { Prisma, type AiActionDraft } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { AnalyticsService } from '../../../analytics/analytics.service';
import { Events } from '../../../analytics/events';
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
  emptyPlanSnapshot,
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
export const CREATE_WORKOUT_PLAN_CAPABILITY = 'draft.create_workout_plan';

/**
 * Payload persisted on `AiActionDraft.payload` for `draft.create_workout_plan`
 * (brief §4.2). Validated at draft-creation time in `AiGatewayService.invoke`
 * AND at materialisation time here (defence-in-depth — drift detection).
 *
 *   - `target_client_id`: the client this plan is authored for. The scope gate
 *     keys on it (brief 50-Failures #5/#9).
 *   - `template_seed.source_template_plan_id` (optional, Option-C): fork this
 *     template plan's exercises into the new plan as the baseline BEFORE the
 *     diff applies. The seed is NEVER mutated — a FRESH plan id is always
 *     written (brief Test matrix #2).
 *   - `target_program_id` (optional): append the new plan to an existing
 *     program; else a fresh standalone program-less plan path is taken with a
 *     new program created for the tenant.
 *   - `diff`: 1..400 ops, <= 256KB serialised.
 */
export const CreateWorkoutPlanPayloadSchema = z
  .object({
    capability: z.literal(CREATE_WORKOUT_PLAN_CAPABILITY),
    target_client_id: z
      .string()
      .uuid({ message: 'target_client_id must be a UUID' }),
    template_seed: z
      .object({
        source_template_plan_id: z
          .string()
          .uuid({ message: 'source_template_plan_id must be a UUID' }),
      })
      .strict()
      .optional(),
    target_program_id: z
      .string()
      .uuid({ message: 'target_program_id must be a UUID' })
      .optional(),
    diff: WorkoutDiffSchema,
  })
  .strict();

export type CreateWorkoutPlanPayload = z.infer<
  typeof CreateWorkoutPlanPayloadSchema
>;

/** Used by `AiGatewayService.invoke` to validate at draft creation. */
export function assertCreateWorkoutPlanPayload(
  raw: unknown,
): CreateWorkoutPlanPayload {
  const parsed = CreateWorkoutPlanPayloadSchema.parse(raw);
  // 256KB serialised cap is a property of the JSON, not the parsed array, so
  // it is checked separately here (throws a ZodError-compatible message path).
  assertDiffSerializedSizeWithinLimit(parsed.diff);
  return parsed;
}

/**
 * MWB-5 — `draft.create_workout_plan`.
 *
 * On approval, applies the draft's diff against an empty baseline (or a forked
 * template seed) and persists a brand-new WorkoutPlan + its exercise rows + a
 * v0 WorkoutPlanRevision (cause='initial', author_kind='ai'), all inside a
 * Serializable transaction. Idempotent on `draft.id` via the
 * `materialised_at`/`materialised_ref` markers (mirrors coach-message
 * semantics). The model is NEVER called here — the diff was filled before the
 * coach approved (brief §"Anti-scope").
 */
@Injectable()
export class CreateWorkoutPlanMaterializer implements CapabilityMaterializer {
  readonly capability = CREATE_WORKOUT_PLAN_CAPABILITY;
  private readonly logger = new Logger(CreateWorkoutPlanMaterializer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subCoachScope: SubCoachScopeService,
    private readonly analytics: AnalyticsService,
  ) {}

  canHandle(capability: string): boolean {
    return capability === CREATE_WORKOUT_PLAN_CAPABILITY;
  }

  async materialize(draft: AiActionDraft): Promise<MaterializeResult> {
    // Idempotency: committed success short-circuits (state (c) — see
    // coach-message.materialiser for the full claim/race rationale). A draft
    // with both markers set has already produced its plan; return the ref.
    if (draft.materialised_at && draft.materialised_ref) {
      return { status: 'already_materialised', ref: draft.materialised_ref };
    }

    // Defence-in-depth flag re-check (R0: never a silent bypass). The gateway
    // allow-list already refuses these capabilities while the flag is OFF, but
    // an internal caller that constructs a draft directly must not slip past.
    if (!isMwbAiLiveCreateEnabled()) {
      throw new LiveCreateMaterialiseError(
        'AI_LIVE_CREATE_DISABLED',
        'FEATURE_MWB_AI_LIVE_CREATE is off; create_workout_plan cannot materialise.',
      );
    }

    if (!draft.tenant_coach_id) {
      throw new LiveCreateMaterialiseError(
        'AI_DRAFT_NO_TENANT',
        `create_workout_plan draft ${draft.id} has no tenant_coach_id`,
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

    // Authorization (brief 50-Failures #5/#9): the requester must be able to
    // access the target client. Head coaches with cross-tenant scope are
    // rejected when the target is outside their tenant. Checked BEFORE any
    // write.
    const canAccess = await this.subCoachScope.canAccessClient(
      draft.requester_id,
      payload.target_client_id,
    );
    if (!canAccess) {
      this.logger.warn(
        {
          event: 'AI_LIVE_CREATE_SCOPE_REJECTED',
          capability: this.capability,
          draftId: draft.id,
          requesterId: draft.requester_id,
          targetClientId: payload.target_client_id,
        },
        'create_workout_plan refused: requester lacks canAccessClient',
      );
      throw new ForbiddenException({
        error: 'AI_LIVE_CREATE_CLIENT_SCOPE_FORBIDDEN',
        capability: this.capability,
        message:
          'Requester is not authorized to create a plan for this client.',
      });
    }

    const tenantCoachId = draft.tenant_coach_id;
    const requesterId = draft.requester_id;

    // P1.1 — claim-first inside the SAME transaction that writes the
    // program/plan rows. The conditional claim is the FIRST statement in the
    // txn so the draft-row claim is ATOMIC with the irreversible writes: two
    // concurrent approvers can no longer both observe a pending draft and each
    // commit a duplicate WorkoutProgram/WorkoutPlan. The race-loser's claim
    // returns count=0 and we throw a typed ConflictException, which the
    // approval service treats as a benign 409 retry (NOT a materialisation
    // failure). On any write error the whole txn rolls back — releasing the
    // claim automatically (Prisma $transaction semantics) so a retry can win.
    // `claimAt` is the SAME timestamp persisted as materialised_at, so the
    // claim row and the success marker agree.
    const claimAt = new Date();
    const startedAtMs = Date.now();

    let createdPlanId: string;
    const weekCount = 1;
    let exerciseCount = 0;
    try {
      const txResult = await this.prisma.$transaction(
        async (tx) => {
          // Atomic idempotency claim. Requires the draft to be unclaimed
          // (materialised_at IS NULL) AND not yet finalised (materialised_ref
          // IS NULL). If another approver already holds the claim (or a prior
          // run finalised it) count is 0 and we abort BEFORE any write — the
          // duplicate-plan window is closed.
          const claim = await tx.aiActionDraft.updateMany({
            where: {
              id: draft.id,
              materialised_at: null,
              materialised_ref: null,
            },
            data: { materialised_at: claimAt },
          });
          if (claim.count === 0) {
            throw new ConflictException({
              error: 'mwb_materialise_conflict',
              capability: this.capability,
              reason:
                'Another approver is materialising this draft, or it is already materialised. Refresh and retry.',
            });
          }

          // Build the baseline: empty, or a deep-copy fork of a template plan's
          // exercises (Option-C seed). The seed is read only — never mutated.
          const baseline = payload.template_seed
            ? await this.loadTemplateSeedSnapshot(
                tx,
                payload.template_seed.source_template_plan_id,
                tenantCoachId,
              )
            : emptyPlanSnapshot();

          // Apply the diff through the single pure applier (integrity boundary).
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

          // Resolve / validate the owning program. When target_program_id is
          // given, the program must belong to the tenant; we append a plan to
          // it WITHOUT bumping its revision_index (this slice: no structural
          // change — brief Test matrix #3). Else create a fresh program + a v1
          // WorkoutProgramRevision (cause='initial', author_kind='ai').
          const programId = payload.target_program_id
            ? await this.assertProgramInTenant(
                tx,
                payload.target_program_id,
                tenantCoachId,
              )
            : await this.createProgram(tx, tenantCoachId, requesterId, snapshot);

          const plan = await tx.workoutPlan.create({
            data: {
              coach_id: tenantCoachId,
              name: snapshot.meta.name,
              type: snapshot.meta.type,
              duration_estimate_minutes:
                snapshot.meta.duration_estimate_minutes,
              program_id: programId,
              is_template: false,
              version: 1,
            },
          });

          const rows = toPersistableRows(snapshot);
          exerciseCount = rows.length;
          if (rows.length > 0) {
            await tx.workoutPlanExercise.createMany({
              data: rows.map((r) => ({ ...r, workout_plan_id: plan.id })),
            });
          }

          // v0 plan revision (cause='initial', author_kind='ai'). The
          // exercises_json carries client_ref + derived order so a later
          // edit-diff can re-address rows.
          const revision = await tx.workoutPlanRevision.create({
            data: {
              workout_plan_id: plan.id,
              revision_index: 0,
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
              cause: 'initial',
            },
          });

          await tx.workoutPlan.update({
            where: { id: plan.id },
            data: { head_revision_id: revision.id },
          });

          return plan.id;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      createdPlanId = txResult;
    } catch (err) {
      // P2034 serialization failures + write conflicts coerce to a recoverable
      // 409 (never a leaked Prisma code — mirrors MWB-2 workout-builder).
      // ConflictException (incl. our claim-conflict above) passes through
      // untouched so the approval service treats it as a benign 409 retry.
      throw coercePrismaWriteConflict(err, this.capability);
    }

    // P1.1 — finalise: write materialised_ref in a SECOND short, idempotent
    // update now that the txn has COMMITTED. The claim above already set
    // materialised_at = claimAt inside the txn; here we only stamp the ref so
    // consumers that read `materialised_ref IS NOT NULL` see the finalised
    // state. Conditional on the claim still being ours (materialised_at =
    // claimAt, materialised_ref IS NULL) so a concurrent rollback/re-claim
    // can never have this overwrite someone else's marker.
    await this.prisma.aiActionDraft.updateMany({
      where: {
        id: draft.id,
        materialised_at: claimAt,
        materialised_ref: null,
      },
      data: { materialised_ref: createdPlanId },
    });

    // P1.2 — PostHog telemetry on SUCCESS only (failures already surface via
    // the exception path; capturing there would double-count). capture() is
    // internally guarded and never throws.
    this.analytics.capture(tenantCoachId, Events.MWB_LIVE_CREATE_INVOKED, {
      capability: this.capability,
      draft_id: draft.id,
      plan_id: createdPlanId,
      coach_id: tenantCoachId,
      week_count: weekCount,
      exercise_count: exerciseCount,
      duration_ms: Date.now() - startedAtMs,
    });

    return { status: 'sent', ref: createdPlanId };
  }

  private validatePayload(draft: AiActionDraft): CreateWorkoutPlanPayload {
    try {
      return assertCreateWorkoutPlanPayload(draft.payload);
    } catch (err) {
      this.logger.warn(
        `CreateWorkoutPlanMaterializer: payload validation failed for draft ${draft.id}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * Load a template plan's exercises as a deep-copied baseline snapshot
   * (Option-C seed). The template MUST belong to the tenant; the fork starts
   * from its live (non-archived) exercise rows. The seed is read-only — a
   * FRESH plan id is written by the caller (brief Test matrix #2).
   */
  private async loadTemplateSeedSnapshot(
    tx: Prisma.TransactionClient,
    sourceTemplatePlanId: string,
    tenantCoachId: string,
  ): Promise<PlanSnapshot> {
    const seed = await tx.workoutPlan.findUnique({
      where: { id: sourceTemplatePlanId },
      select: {
        id: true,
        coach_id: true,
        name: true,
        type: true,
        duration_estimate_minutes: true,
        head_revision_id: true,
      },
    });
    if (!seed || seed.coach_id !== tenantCoachId) {
      throw new LiveCreateMaterialiseError(
        'AI_LIVE_CREATE_SEED_NOT_FOUND',
        `template seed plan ${sourceTemplatePlanId} not found in tenant`,
      );
    }

    // Prefer the head revision's snapshot (carries client_ref) when present;
    // otherwise rebuild from the live exercise rows. Either way we synthesise a
    // baseline whose refs the diff can address.
    if (seed.head_revision_id) {
      const head = await tx.workoutPlanRevision.findUnique({
        where: { id: seed.head_revision_id },
        select: { exercises_json: true, plan_meta_json: true },
      });
      if (head) {
        const snap = snapshotFromRevisionJson(
          head.exercises_json,
          head.plan_meta_json,
        );
        // The fork starts from the seed's exercises but is a brand-new plan;
        // meta name carries over from the seed plan row (authoritative).
        snap.meta.name = seed.name;
        snap.meta.type = seed.type;
        snap.meta.duration_estimate_minutes =
          seed.duration_estimate_minutes ?? null;
        return snap;
      }
    }

    const liveRows = await tx.workoutPlanExercise.findMany({
      where: { workout_plan_id: seed.id, archived_at: null },
      orderBy: { order: 'asc' },
      select: {
        exercise_external_id: true,
        order: true,
        sets: true,
        reps_or_duration_seconds: true,
        weight_lbs: true,
        rest_seconds: true,
        superset_group_id: true,
        notes: true,
      },
    });
    return {
      meta: {
        name: seed.name,
        type: seed.type,
        duration_estimate_minutes: seed.duration_estimate_minutes ?? null,
      },
      exercises: liveRows.map((r, i) => ({
        client_ref: `seed-${i}`,
        exercise_external_id: r.exercise_external_id,
        order: i,
        sets: r.sets,
        reps_or_duration_seconds: r.reps_or_duration_seconds,
        weight_lbs: r.weight_lbs ?? null,
        rest_seconds: r.rest_seconds ?? null,
        superset_group_id: r.superset_group_id ?? null,
        notes: r.notes ?? null,
      })),
    };
  }

  /** Assert an existing program belongs to the tenant; return its id. */
  private async assertProgramInTenant(
    tx: Prisma.TransactionClient,
    programId: string,
    tenantCoachId: string,
  ): Promise<string> {
    const program = await tx.workoutProgram.findUnique({
      where: { id: programId },
      select: { id: true, coach_id: true },
    });
    if (!program || program.coach_id !== tenantCoachId) {
      throw new LiveCreateMaterialiseError(
        'AI_LIVE_CREATE_PROGRAM_NOT_FOUND',
        `target program ${programId} not found in tenant`,
      );
    }
    return program.id;
  }

  /**
   * Create a fresh WorkoutProgram for the tenant plus a v1
   * WorkoutProgramRevision (cause='initial', author_kind='ai'). A single
   * AI-created plan lives as the lone "day" of a 1-week / 1-day program — the
   * minimal container the schema requires.
   */
  private async createProgram(
    tx: Prisma.TransactionClient,
    tenantCoachId: string,
    requesterId: string,
    snapshot: PlanSnapshot,
  ): Promise<string> {
    const program = await tx.workoutProgram.create({
      data: {
        coach_id: tenantCoachId,
        owner_user_id: requesterId,
        visibility: 'owner_only',
        name: snapshot.meta.name,
        weeks: 1,
        days_per_week: 1,
        is_template: false,
        version: 1,
      },
    });
    const programRevision = await tx.workoutProgramRevision.create({
      data: {
        program_id: program.id,
        revision_index: 0,
        structure_json: {
          weeks: 1,
          days_per_week: 1,
          plan_count: 1,
        } as unknown as Prisma.InputJsonValue,
        author_id: requesterId,
        author_kind: 'ai',
        cause: 'initial',
      },
    });
    await tx.workoutProgram.update({
      where: { id: program.id },
      data: { head_revision_id: programRevision.id },
    });
    return program.id;
  }
}
