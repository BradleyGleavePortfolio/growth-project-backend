import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { AuditService } from '../../audit/audit.service';
import { Prisma } from '@prisma/client';
import { CapabilityMaterializerRegistry } from './materialisers/capability-materialiser.registry';
import { WORKOUT_BUILDER_MODEL_DIFF_SOURCE } from './ai-gateway.service';
import { isMwbLiveCreateCapability } from './mwb-live-create.feature';
import { computeLockToken } from '../../workout-builder/lock-token.helper';
import { emptyPlanSnapshot, snapshotFromRevisionJson } from './materialisers/__shared/workout-diff.types';
import { WeekLimits, subsetLimitBreach } from './workout-builder/subset-bounds';
import { loadWeekOtherSetsByMuscle, weeklySetsCap } from './workout-builder/week-limits';

// Human-approval workflow for consequential AI outputs. AiActionDraft
// rows land here as `pending`; an authorized human (coach for own-tenant
// drafts, owner for any draft) decides them. AI cannot self-approve —
// the service refuses any decision where decided_by_id == requester_id,
// except a tenant coach deciding a model-authored draft or a draft in a
// single-coach tenant (B-AIB1-125).
//
// Decisions are recorded both on the draft row and as an entry in the
// global AuditLog so the action is visible alongside other sensitive
// admin actions.

type Decision = 'approved' | 'rejected';

/**
 * B-AIB1-125 — true when a draft's payload is the model's own reply: the
 * gateway stores `{ reply: response.text }` when the caller supplies no
 * `proposedActionPayload`, and the same text (first 1,000 chars) as the
 * rationale. Caller-supplied payloads (every Stream 2 capability and
 * MWB-5 live-create today) are human-authored.
 */
export function isModelAuthoredPayload(payload: unknown, rationale: string | null): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== 'reply') return false;
  const reply = (payload as { reply?: unknown }).reply;
  return typeof reply === 'string' && reply.length > 0 && rationale === reply.slice(0, 1000);
}

// FIX-AIB-125 (B-807-1) — payload keys that name the client an approved
// draft acts on (same keys as PAYLOAD_CLIENT_ID_KEYS in ai-gateway.service.ts).
const PAYLOAD_CLIENT_ID_KEYS = ['clientId', 'client_id', 'target_client_id'] as const;

/** Client ids named by a draft payload (string values of the keys above). */
export function payloadClientIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const ids = new Set<string>();
  for (const key of PAYLOAD_CLIENT_ID_KEYS) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) ids.add(v);
  }
  return [...ids];
}

/**
 * B-AIB2-126 — true when the gateway marked this live-create draft model-written (the AI workout builder). Only the gateway
 * can add the marker (it strips caller provenance with that source). No payload hash: JSONB reorders keys on the way back.
 */
export function isWorkoutBuilderModelDraft(capability: string, provenance: unknown): boolean {
  return isMwbLiveCreateCapability(capability) && Array.isArray(provenance) && provenance.some(
    (p) => !!p && typeof p === 'object' && (p as { source?: unknown }).source === WORKOUT_BUILDER_MODEL_DIFF_SOURCE,
  );
}

/** Accepted subset (`c<i>` = diff index i). A reorder lists every ref, so it is kept only when all other ops are kept. */
export function selectAcceptedOps<T extends { kind: string }>(diff: readonly T[], acceptedChangeIds: readonly string[]): T[] {
  const ok = new Set(acceptedChangeIds);
  const allOthers = diff.every((op, i) => op.kind === 'reorder' || ok.has(`c${i}`));
  return diff.filter((op, i) => ok.has(`c${i}`) && (op.kind !== 'reorder' || allOthers));
}

export interface DecideInput {
  draftId: string;
  decider: { id: string; role: string };
  decision: Decision;
  note?: string;
  // B-AIB2-126 — apply only these changes (`c<i>` = diff index i) of an AI
  // workout-builder draft. Omitted = apply every change.
  acceptedChangeIds?: string[];
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AiApprovalService {
  private readonly logger = new Logger(AiApprovalService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    // PR AI-3 (PRODUCT-1): optional so legacy unit tests that build the
    // service via `new AiApprovalService(prisma, audit)` keep compiling. In
    // production DI it's provided via AiGatewayModule.
    // NEST-TOKENS-134: the explicit token is required. With strictNullChecks a
    // `T | null` param is emitted as `Object` in design:paramtypes, so without
    // @Inject Nest resolved nothing: an approved draft flipped to 'approved'
    // and its materialiser (message send, assignment) never ran.
    @Optional()
    @Inject(CapabilityMaterializerRegistry)
    private materialisers: CapabilityMaterializerRegistry | null = null,
  ) {}

  async listPending(scope: { tenantCoachId?: string; subjectUserId?: string; limit?: number; status?: string }) {
    const limit = Math.min(Math.max(scope.limit ?? 50, 1), 200);
    // Allow filtering by explicit status; fall back to 'pending' when omitted so
    // existing callers that don't pass a status keep their current behaviour.
    const VALID_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
    type ValidStatus = (typeof VALID_STATUSES)[number];
    const resolvedStatus: ValidStatus =
      scope.status && (VALID_STATUSES as readonly string[]).includes(scope.status)
        ? (scope.status as ValidStatus)
        : 'pending';
    return this.prisma.aiActionDraft.findMany({
      where: {
        status: resolvedStatus,
        ...(scope.tenantCoachId ? { tenant_coach_id: scope.tenantCoachId } : {}),
        ...(scope.subjectUserId ? { subject_user_id: scope.subjectUserId } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  async getById(id: string) {
    const draft = await this.prisma.aiActionDraft.findUnique({ where: { id } });
    if (!draft) throw new NotFoundException('AI draft not found');
    return draft;
  }

  /**
   * B-AIB1-125 — may the tenant coach decide a draft they requested?
   * Only a coach deciding inside their own tenant (checked by the caller).
   * Yes when the model authored the payload (the gateway's default
   * `{ reply: <model text> }`, whose text is also the stored rationale), or
   * when the tenant has no active sub-coach (the coach is its only human).
   */
  /** B-815-1: ceiling breach of a partial selection against the plan's CURRENT head and its program week, else null. */
  private async subsetLimitBreachFor(
    subjectUserId: string | null, payload: Record<string, unknown>, fullDiff: readonly unknown[], subset: readonly unknown[],
  ): Promise<string | null> {
    const planId = typeof payload.target_plan_id === 'string' ? payload.target_plan_id : null;
    if (!planId) return subsetLimitBreach(emptyPlanSnapshot(), fullDiff, subset, null);
    const plan = await this.prisma.workoutPlan.findUnique({
      where: { id: planId }, select: { id: true, coach_id: true, head_revision_id: true, program_id: true, week_index: true },
    });
    const head = plan?.head_revision_id
      ? await this.prisma.workoutPlanRevision.findUnique({ where: { id: plan.head_revision_id }, select: { exercises_json: true, plan_meta_json: true } })
      : null;
    if (!plan || !head) {
      throw new ConflictException({ code: 'REVISION_STALE', message: 'This workout changed on another screen. Reload it and ask again.' });
    }
    let week: WeekLimits | null = null;
    if (plan.program_id && plan.week_index != null) {
      const profile = subjectUserId
        ? await this.prisma.userProfile.findUnique({ where: { user_id: subjectUserId }, select: { workout_experience: true } })
        : null;
      week = {
        otherSetsByMuscle: await loadWeekOtherSetsByMuscle(this.prisma, { planId: plan.id, coachId: plan.coach_id, programId: plan.program_id, weekIndex: plan.week_index }),
        cap: weeklySetsCap(profile ? { experience: profile.workout_experience } : null),
      };
    }
    return subsetLimitBreach(snapshotFromRevisionJson(head.exercises_json, head.plan_meta_json), fullDiff, subset, week);
  }

  private async tenantCoachMayDecideOwnDraft(
    draft: { capability: string; payload: unknown; rationale: string | null; tenant_coach_id: string | null; provenance?: unknown },
    decider: { id: string; role: string },
  ): Promise<boolean> {
    if (decider.role !== 'coach' || draft.tenant_coach_id !== decider.id) return false;
    if (isModelAuthoredPayload(draft.payload, draft.rationale)) return true;
    if (isWorkoutBuilderModelDraft(draft.capability, draft.provenance)) return true;
    const otherHumans = await this.prisma.teamSubCoachAssignment.count({
      where: { head_coach_id: decider.id, archived_at: null },
    });
    return otherHumans === 0;
  }

  async decide(input: DecideInput) {
    const draft = await this.prisma.aiActionDraft.findUnique({
      where: { id: input.draftId },
    });
    if (!draft) throw new NotFoundException('AI draft not found');
    if (draft.status !== 'pending') {
      // Idempotency: a second approve/reject must not silently overwrite
      // the first decision. Surface a 403 so callers can refresh state.
      throw new ForbiddenException(`Draft already ${draft.status}`);
    }

    // Tenant boundary: coaches can only decide drafts inside their own
    // tenant, for their own clients. Owners can decide any draft. Other
    // roles are rejected. B-AIB1-125: a draft with no tenant is no coach's
    // to decide, and the subject must be on the deciding coach's roster
    // (re-read now), so a coach can never decide another coach's client's
    // draft.
    if (input.decider.role !== 'owner') {
      if (input.decider.role !== 'coach') {
        throw new ForbiddenException('Approver role not permitted');
      }
      if (draft.tenant_coach_id !== input.decider.id) {
        throw new ForbiddenException('Draft is outside your tenant');
      }
      if (draft.subject_user_id) {
        const subject = await this.prisma.user.findUnique({
          where: { id: draft.subject_user_id },
          select: { coach_id: true },
        });
        if (subject?.coach_id !== input.decider.id) {
          throw new ForbiddenException('Draft is outside your tenant');
        }
      }
      // FIX-AIB-125 (B-807-1): every client the payload names must be the
      // subject (checked above) or on the deciding coach's roster, so an
      // approved assign / notification draft can never reach another
      // coach's client.
      for (const clientId of payloadClientIds(draft.payload)) {
        if (clientId === draft.subject_user_id) continue;
        const named = await this.prisma.user.findUnique({
          where: { id: clientId },
          select: { coach_id: true },
        });
        if (named?.coach_id !== input.decider.id) {
          throw new ForbiddenException('Draft is outside your tenant');
        }
      }
    }

    // AI never approves itself. The original requester also cannot
    // approve their OWN human-written draft when someone else in the
    // tenant could — approving an action they themselves typed defeats the
    // human-in-the-loop check. Owners stay bound by this rule.
    //
    // B-AIB1-125 (AUDIT-14 U2, SAFE-MWBAI-125 blocker 3): the tenant coach
    // IS the human in the loop for (a) a draft whose payload the model
    // wrote, and (b) any draft in a single-coach tenant (no one else in the
    // tenant can decide, so the rule only dead-ended the coach). The tenant
    // and roster checks above already ran.
    if (
      draft.requester_id &&
      draft.requester_id === input.decider.id &&
      !(await this.tenantCoachMayDecideOwnDraft(draft, input.decider))
    ) {
      throw new ForbiddenException('A draft cannot be decided by its requester');
    }

    const status = input.decision;

    // B-AIB2-126 — subset approval: materialise only the accepted ops (the
    // materialiser re-validates and dry-runs them against the current head).
    let toMaterialise = draft;
    let appliedPayload: Prisma.JsonObject | undefined;
    if (status === 'approved' && input.acceptedChangeIds) {
      const payload = draft.payload as { diff?: unknown } | null;
      if (!isMwbLiveCreateCapability(draft.capability) || !payload || !Array.isArray(payload.diff)) {
        throw new BadRequestException({
          code: 'ACCEPTED_CHANGES_UNSUPPORTED',
          message: 'This draft cannot be applied in part.',
        });
      }
      const subset = selectAcceptedOps(payload.diff as Array<{ kind: string } & Prisma.JsonObject>, input.acceptedChangeIds);
      if (subset.length === 0) {
        throw new BadRequestException({
          code: 'NO_CHANGES_ACCEPTED',
          message: 'Keep at least one change to apply, or discard the suggestions.',
        });
      }
      // B-815-1: a partial selection is re-checked against the training ceilings the full proposal was validated
      // against (sets per muscle per workout and per program week, exercises per workout). Refused = draft stays pending.
      if (subset.length < payload.diff.length) {
        const breach = await this.subsetLimitBreachFor(draft.subject_user_id, payload as Record<string, unknown>, payload.diff, subset);
        if (breach) {
          throw new UnprocessableEntityException({
            code: 'SELECTION_OVER_LIMITS',
            message: `${breach} Keep the matching removal too, or untick an addition.`,
          });
        }
      }
      appliedPayload = { ...(payload as Prisma.JsonObject), diff: subset };
      toMaterialise = { ...draft, payload: appliedPayload };
    }

    // PR AI-3 (PRODUCT-1): for 'approved' decisions on capabilities that
    // have a registered materialiser, run materialisation BEFORE flipping
    // status. If the materialiser throws, the draft stays in 'pending' so
    // the coach can retry — recreating PRODUCT-1 (silent status flip with
    // no downstream send) is the one thing this PR exists to prevent.
    //
    // Capabilities WITHOUT a registered materialiser fall through to the
    // legacy behaviour (status flip + audit only) — that preserves the
    // inline-materialisation path used by WORKOUT_PROGRAM / MEAL_PLAN in
    // `coach-ai.service.ts:approveDraft`.
    let materialisationRef: string | null = null;
    if (status === 'approved' && this.materialisers) {
      const materialiser = this.materialisers.resolve(draft.capability);
      if (materialiser) {
        try {
          const result = await materialiser.materialize(toMaterialise);
          materialisationRef = result.ref ?? null;
          if (result.status === 'racing') {
            // P1-1: a concurrent approver holds the materialisation claim
            // but the downstream side-effect has not been observably
            // committed. Refuse to flip status — surfacing 409 lets the
            // caller retry once the winner's outcome is known, and is
            // the only way to preserve the invariant that
            // `status='approved'` implies a real downstream row when
            // such a row is expected.
            throw new ConflictException({
              error: 'AI_DRAFT_RACE_IN_FLIGHT',
              capability: draft.capability,
              reason:
                'Another approver is currently materialising this draft. Retry after their decision settles.',
            });
          }
          // `sent` / `already_materialised` carry a non-null ref;
          // `noop` is a legitimate terminal state for capabilities that
          // intentionally produce no downstream row. All three are
          // accepted; the decide-gate below distinguishes them at the
          // ref level, not via a coarse confirmed-or-not flag.
        } catch (err) {
          if (err instanceof ConflictException) {
            // Don't audit-log the race state as a materialisation failure
            // — it's a benign concurrency outcome and the winner will
            // record the success. Re-throw so the caller sees a 409.
            throw err;
          }
          // Surface as a 500 with the underlying message so the coach UI
          // can render a retry CTA. The draft remains in 'pending' status,
          // which means the next approve attempt will retry materialisation.
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Materialisation failed for draft ${draft.id} (capability=${draft.capability}): ${msg}`,
          );
          // Best-effort audit so ops can spot patterns of materialisation
          // failure even when the request 500s out.
          await this.audit
            .write({
              action: 'ai.draft_materialise_failed',
              actorId: input.decider.id,
              actorRole: input.decider.role,
              targetType: 'ai_action_draft',
              targetId: draft.id,
              targetUserId: draft.subject_user_id ?? null,
              tenantCoachId: draft.tenant_coach_id ?? null,
              ip: input.ip ?? null,
              userAgent: input.userAgent ?? null,
              metadata: {
                capability: draft.capability,
                error: msg,
              },
            })
            .catch(() => undefined);
          throw new InternalServerErrorException({
            error: 'AI_MATERIALISATION_FAILED',
            capability: draft.capability,
            reason: msg,
          });
        }
      } else {
        // No-op materialiser for this capability. Log a debug-level note so
        // the path is observable in dev without spamming production logs.
        this.logger.debug?.(
          `No materialiser registered for capability=${draft.capability}; proceeding with status flip only.`,
        );
      }
    }

    // P2-3 / P1-1 — atomic decide guard. Two concurrent approvers could both
    // pass the status==='pending' in-memory check above; without an atomic
    // gate the second writer overwrites `decided_by_id` and the audit trail
    // loses the actual decider. We therefore use updateMany with WHERE
    // status='pending' so only the first approver's update lands, and the
    // second sees count=0 and is told to retry.
    //
    // For approved decisions where a materialiser actually committed a
    // downstream row (`materialisationRef !== null`), we ADDITIONALLY
    // require `materialised_ref IS NOT NULL`. This is the invariant that
    // closes the PRODUCT-1 race (P1-1): even if a race-loser somehow
    // reached this point without observing the winner's commit, the gate
    // refuses to flip status until the downstream side-effect is visible.
    //
    // P2-A round-3: we gate on `materialisationRef !== null` rather than
    // a broader `materialisationConfirmed` flag. The previous code added
    // the clause for any non-error materialiser outcome — including
    // `noop` — which has no ref by definition, so the gate would refuse
    // to flip and 409 the caller. A `noop` materialiser is legitimate
    // (the side-effect is a no-op, e.g. an idempotent ack); the gate
    // should accept it. Approved-without-materialiser and rejected paths
    // preserve the legacy status-flip-only semantics.
    //
    // P1-A round-3: for the 'rejected' path on capabilities with a
    // registered materialiser, we ADDITIONALLY require
    // `materialised_at IS NULL` — i.e. no materialiser claim is in
    // flight. Without this clause a concurrent decide(approve) could be
    // mid-`sendAsCoach` (claim held, message in flight) while we flip
    // status to 'rejected' here, ending in `status='rejected',
    // materialised_ref=non-null` after the approve writes its ref. That
    // is the same trust-surface failure as PRODUCT-1 with the symptom
    // flipped (rejected-but-sent). Refusing the reject while at !=
    // null forces the rejecter to wait for the materialiser to either
    // succeed (status goes 'approved' — reject no longer applicable) or
    // rollback (at returns to null — reject can proceed). The 409
    // returned in that window is the same retry contract the approver
    // race uses.
    const decideGate: Record<string, unknown> = {
      id: draft.id,
      status: 'pending',
    };
    if (status === 'approved' && materialisationRef !== null) {
      decideGate.materialised_ref = { not: null };
    }
    if (status === 'rejected' && this.materialisers) {
      const materialiserForCap = this.materialisers.resolve(draft.capability);
      if (materialiserForCap) {
        decideGate.materialised_at = null;
      }
    }
    // HK-6a R2 (P1-4): the status flip and the linked AiRequestAudit status
    // update are wrapped in a single interactive $transaction so a mid-flight
    // crash can never leave `status='approved'/'rejected'` on the draft while
    // the linked audit row still reads its old approval_status. Before this,
    // those were two independent writes (the auditor's "status flip with a
    // missing follow-on audit update" gap). Both run on `tx` so they commit
    // or roll back together.
    //
    // Deliberately OUTSIDE this transaction:
    //   - The materialiser ran ABOVE (it performs MessagingService.sendAsCoach,
    //     an external push/notification side-effect that cannot be rolled
    //     back; the materialised_ref it persists is the committed-success
    //     marker, and its claim write must stay visible to concurrent
    //     approvers for the idempotency state machine to work — holding it
    //     inside an interactive transaction would hide it until commit and
    //     also pin a DB connection across a network call).
    //   - The global AuditLog write (best-effort, its own error handling, and
    //     the terminal write — a crash after it is immaterial).
    const decideResult = await this.prisma.$transaction(async (tx) => {
      const flip = await tx.aiActionDraft.updateMany({
        where: decideGate,
        data: {
          status,
          decided_by_id: input.decider.id,
          decided_at: new Date(),
          decision_note: input.note ?? null,
          ...(appliedPayload !== undefined ? { payload: appliedPayload } : {}),
        },
      });
      if (flip.count === 0) {
        // No row matched the gate (already decided, or the P1-1/P1-A
        // materialisation invariant not yet satisfied). Return early so the
        // transaction commits as a no-op and the caller surfaces a 409 — we
        // do NOT touch the linked audit row in that case.
        return flip;
      }
      // Reflect the decision on the linked audit row, if any. Same tx so it
      // is atomic with the status flip above.
      await tx.aiRequestAudit.updateMany({
        where: { approval_draft_id: draft.id },
        data: { approval_status: status },
      });
      return flip;
    });
    if (decideResult.count === 0) {
      // Another approver already decided this draft (P2-3) OR — for the
      // approved-with-materialiser path — the materialisation has not
      // observably committed (P1-1 belt-and-braces). Surface as 409 so the
      // caller refreshes and tries again. We do NOT need to roll back the
      // materialisation here: either the winner already owns the success
      // (no rollback needed) or our materialise() call earlier returned
      // `racing` (no claim held, nothing to undo).
      throw new ConflictException({
        error: 'AI_DRAFT_ALREADY_DECIDED',
        capability: draft.capability,
        reason:
          'Draft was decided by another approver before this request landed.',
      });
    }
    const updated = await this.prisma.aiActionDraft.findUnique({
      where: { id: draft.id },
    });
    if (!updated) {
      // Should be unreachable — the transaction's updateMany returned count=1
      // a moment ago — but TypeScript still requires we treat findUnique as
      // nullable.
      throw new InternalServerErrorException('Draft not found after decide');
    }

    await this.audit.write({
      action: status === 'approved' ? 'ai.draft_approved' : 'ai.draft_rejected',
      actorId: input.decider.id,
      actorRole: input.decider.role,
      targetType: 'ai_action_draft',
      targetId: draft.id,
      targetUserId: draft.subject_user_id ?? null,
      tenantCoachId: draft.tenant_coach_id ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: {
        capability: draft.capability,
        requester_id: draft.requester_id,
        note: input.note ?? null,
        materialised_ref: materialisationRef,
      },
    });

    // B-AIB2-126 — the AI workout builder adopts the new head at once (plan section 3): plan id, head revision, fresh lock token.
    if (status === 'approved' && materialisationRef && isWorkoutBuilderModelDraft(draft.capability, draft.provenance)) {
      return { ...updated, materialised_ref: await this.workoutBuilderRef(materialisationRef) };
    }
    return updated;
  }

  private async workoutBuilderRef(planId: string): Promise<{ plan_id: string; revision_index: number; lock_token?: string }> {
    const plan = await this.prisma.workoutPlan.findUnique({ where: { id: planId }, select: { version: true, head_revision_id: true } });
    const headId = plan?.head_revision_id;
    const head = headId ? await this.prisma.workoutPlanRevision.findUnique({ where: { id: headId }, select: { revision_index: true } }) : null;
    const ref = { plan_id: planId, revision_index: head?.revision_index ?? 0 };
    if (!plan || !headId) return ref;
    try {
      return { ...ref, lock_token: computeLockToken(planId, plan.version, headId) };
    } catch (err) {
      // No autosave secret: the builder re-reads the plan instead of adopting the token.
      this.logger.warn(`workout builder lock token unavailable: ${err instanceof Error ? err.name : 'unknown'}`);
      return ref;
    }
  }

  // Background sweep entry point. Mark any pending draft past its
  // `expires_at` as `expired` and write a single AuditLog row per sweep.
  // Wired to a cron in a follow-up; kept as a service method here so
  // tests and one-off scripts can invoke it directly.
  //
  // P1-A round-3: the WHERE clause requires `materialised_at IS NULL` so
  // we do not flip a draft to 'expired' while a materialiser holds an
  // active claim mid-`sendAsCoach`. Otherwise the symmetric trust-surface
  // failure of P1-A would land here too: the draft would end
  // `status='expired', materialised_ref=non-null` and the client would
  // have received a message the system regards as expired. Drafts in
  // STUCK-CLAIM state (at != null, ref = null with no live writer) are
  // intentionally left for ops to clear; the sweep is a best-effort
  // hygiene pass, not a forcing function.
  async expireStaleDrafts(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.aiActionDraft.updateMany({
      where: {
        status: 'pending',
        expires_at: { lt: now },
        materialised_at: null,
      },
      data: { status: 'expired' },
    });
    if (result.count > 0) {
      await this.audit.write({
        action: 'ai.drafts_expired',
        actorRole: 'system',
        metadata: { count: result.count, swept_at: now.toISOString() },
      });
    }
    return result.count;
  }
}
