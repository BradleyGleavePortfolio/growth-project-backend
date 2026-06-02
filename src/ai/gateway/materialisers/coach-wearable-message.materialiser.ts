import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AiActionDraft } from '@prisma/client';
import { WearableMetricBucket } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { MessagingService } from '../../../messaging/messaging.service';
import {
  CapabilityMaterializer,
  MaterializeResult,
} from './capability-materialiser.interface';

/** Capability string handled by this materialiser. */
export const COACH_WEARABLE_MESSAGE_CAPABILITY = 'draft.coach_wearable_message';

/**
 * Runtime schema for `draft.coach_wearable_message` payloads.
 *
 * These drafts are created by the wearable-insights approval endpoint
 * (`POST /v1/wearables/insights/approve`) when a coach approves (or edits)
 * an AI-suggested message about a client's wearable trends. Unlike
 * `draft.coach_message`, the body has already been seen — and possibly
 * hand-edited — by the coach, so the cap mirrors the insight contract's
 * `suggested_message_draft` max (1000 chars) rather than the larger
 * free-form coach-message budget.
 *
 * Validated at TWO points:
 *   1. Endpoint time, in `WearableInsightsController.approveInsight` — so a
 *      malformed body is rejected with a 400 BEFORE the draft row exists.
 *   2. Materialisation time, here in `materialize` — so a payload that
 *      somehow drifted in shape (a future migration bug, a direct DB write)
 *      cannot trigger a runtime cast error inside `sendAsCoach`.
 *
 * `.strict()` rejects unknown keys so an over-broad payload can never smuggle
 * extra fields into the send path.
 */
export const CoachWearableMessagePayloadSchema = z
  .object({
    clientId: z.string().uuid({ message: 'clientId must be a UUID' }),
    bucket: z.nativeEnum(WearableMetricBucket),
    // Matches insight-output `suggested_message_draft` max so an edited body
    // stays inside the contract the mobile panel renders against.
    body: z
      .string()
      .min(1, { message: 'body must not be empty' })
      .max(1000, { message: 'body exceeds 1000 chars' })
      .refine((s) => s.trim().length > 0, {
        message: 'body must not be whitespace-only',
      }),
  })
  .strict();

export type CoachWearableMessagePayload = z.infer<
  typeof CoachWearableMessagePayloadSchema
>;

/**
 * Convenience guard used by the approval endpoint to validate the persisted
 * payload shape. Throws a `z.ZodError` on failure — callers map that to a
 * 400 (endpoint) or surface it as a materialisation failure (materialiser).
 */
export function assertCoachWearableMessagePayload(
  raw: unknown,
): CoachWearableMessagePayload {
  return CoachWearableMessagePayloadSchema.parse(raw);
}

/**
 * Materialiser for `draft.coach_wearable_message`.
 *
 * Sibling to `CoachMessageMaterializer`: it shares the exact same hard-won
 * idempotency state machine (claim / race / recovery). The ONLY differences
 * are the payload validator and the `sendAsCoach` call site — the wearable
 * payload carries a `bucket` (recorded on the draft for provenance, not sent
 * to the client) alongside the recipient + body.
 *
 * Responsibilities:
 *   - Validate the payload one more time (defence in depth).
 *   - Call `MessagingService.sendAsCoach` with `tenant_coach_id` as the
 *     sender (NOT `requester_id`, which may be an OWNER acting on behalf of
 *     a coach; the recipient client is bound to the coach's namespace via
 *     the tenant column).
 *   - Idempotency: an in-flight or completed materialisation MUST NOT be
 *     re-emitted. We use `AiActionDraft.materialised_at` as the claim marker
 *     and `materialised_ref` as the committed-success marker.
 *
 * The race window between two concurrent `decide()` calls is closed by the
 * row-level lock the wrapping UPDATE in `AiApprovalService.decide` takes on
 * the draft row plus the conditional UPDATE here (WHERE materialised_at IS
 * NULL AND status='pending').
 */
@Injectable()
export class CoachWearableMessageMaterializer implements CapabilityMaterializer {
  readonly capability = COACH_WEARABLE_MESSAGE_CAPABILITY;
  private readonly logger = new Logger(CoachWearableMessageMaterializer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
  ) {}

  canHandle(capability: string): boolean {
    return capability === COACH_WEARABLE_MESSAGE_CAPABILITY;
  }

  async materialize(draft: AiActionDraft): Promise<MaterializeResult> {
    // Three in-flight states on the draft row (see CoachMessageMaterializer
    // for the full P1-1 / P2-1 derivation):
    //   (a) materialised_at=null, materialised_ref=null — never claimed.
    //   (b) materialised_at!=null, materialised_ref=null — claim held; the
    //       winner is either in-flight OR crashed without rolling back
    //       (STUCK-CLAIM). Indistinguishable from in-flight on a single read.
    //   (c) materialised_at!=null, materialised_ref!=null — committed success.
    // Only (c) is safe to treat as "already_materialised".
    if (draft.materialised_at && draft.materialised_ref) {
      return {
        status: 'already_materialised',
        ref: draft.materialised_ref,
      };
    }

    if (!draft.tenant_coach_id) {
      // A wearable-message draft without a tenant coach has no sender. The
      // approval endpoint pins tenant_coach_id to the requester, so this
      // should never happen — fail loudly rather than silently dropping it.
      throw new Error(
        `CoachWearableMessageMaterializer: draft ${draft.id} has no tenant_coach_id`,
      );
    }

    // Re-validate the persisted payload. Drift-detection: if a migration or
    // admin tool ever rewrites payload shape, we'd rather throw than crash
    // inside MessagingService.
    let payload: CoachWearableMessagePayload;
    try {
      payload = assertCoachWearableMessagePayload(draft.payload);
    } catch (err) {
      this.logger.warn(
        `CoachWearableMessageMaterializer: payload validation failed for draft ${draft.id}: ${(err as Error).message}`,
      );
      throw err;
    }

    // Optimistic idempotency claim. We require:
    //   - materialised_at currently NULL (no in-flight or completed claim).
    //   - status currently 'pending' (a concurrent decide(reject)/expire
    //     could otherwise flip status between our caller's read and this
    //     claim; without the clause we'd send a message on a rejected draft
    //     — rejected-but-sent, the symmetric PRODUCT-1 failure).
    // count=0 means we lost the race (or a STUCK-CLAIM / concurrent
    // reject is present); the race-loser path below handles all three.
    const claim = await this.prisma.aiActionDraft.updateMany({
      where: { id: draft.id, materialised_at: null, status: 'pending' },
      data: { materialised_at: new Date() },
    });
    if (claim.count === 0) {
      return this.awaitWinnerOrRecover(draft, payload);
    }

    // Send. If sendAsCoach throws (auth boundary, blocked recipient, DB
    // outage, …) we MUST release the claim so a retry can succeed — otherwise
    // the draft is permanently stuck with materialised_at set but no message.
    let sentId: string;
    try {
      const created = await this.messaging.sendAsCoach(
        draft.tenant_coach_id,
        payload.clientId,
        { body: payload.body },
      );
      sentId = created.id;
    } catch (err) {
      await this.prisma.aiActionDraft
        .updateMany({
          where: {
            id: draft.id,
            materialised_at: { not: null },
            materialised_ref: null,
          },
          data: { materialised_at: null },
        })
        .catch((rollbackErr) => {
          // Best-effort claim release. Surfacing the original error to the
          // caller matters more than the rollback noise.
          this.logger.error(
            `CoachWearableMessageMaterializer: failed to release materialisation claim on draft ${draft.id}: ${(rollbackErr as Error).message}`,
          );
        });
      throw err;
    }

    // Record the downstream ref so support can trace approved-draft ->
    // sent-message without grepping logs.
    await this.prisma.aiActionDraft.update({
      where: { id: draft.id },
      data: { materialised_ref: sentId },
    });

    return { status: 'sent', ref: sentId };
  }

  // Race-loser / STUCK-CLAIM recovery. Bounded polling: long enough for a
  // legitimate winner to finish a typical sendAsCoach round-trip, short
  // enough that we don't pile up requests on a wedged DB. Non-readonly so
  // race-window tests can shorten them; production never mutates them.
  static RACE_POLL_ATTEMPTS = 10;
  static RACE_POLL_INTERVAL_MS = 100;

  private async awaitWinnerOrRecover(
    draft: AiActionDraft,
    payload: CoachWearableMessagePayload,
  ): Promise<MaterializeResult> {
    for (
      let i = 0;
      i < CoachWearableMessageMaterializer.RACE_POLL_ATTEMPTS;
      i++
    ) {
      const fresh = await this.prisma.aiActionDraft.findUnique({
        where: { id: draft.id },
      });
      if (!fresh) {
        // Draft vanished mid-flight — surface racing so decide() throws a
        // conflict rather than flipping status on a row that no longer exists.
        return { status: 'racing', ref: null };
      }
      if (fresh.materialised_ref) {
        return {
          status: 'already_materialised',
          ref: fresh.materialised_ref,
        };
      }
      // Detect a terminal status flip (reject / expired). Without this the
      // poll would spin until budget exhaustion when the cause was a
      // concurrent reject that beat our claim — and the recovery branch
      // below would recurse into a claim that can never satisfy
      // status='pending'. Turn it into an immediate 'racing' so decide()
      // throws 409.
      if (fresh.status !== 'pending') {
        return { status: 'racing', ref: null };
      }
      if (!fresh.materialised_at) {
        // Winner rolled back. Re-attempt the claim ourselves with the freshly
        // observed draft (state (a)). Recursion is bounded by the poll budget.
        return this.materialize(fresh as AiActionDraft);
      }
      await this.sleep(
        CoachWearableMessageMaterializer.RACE_POLL_INTERVAL_MS,
      );
    }
    // Winner still in-flight (or genuinely stuck) after the budget. We cannot
    // prove the side-effect committed, so we MUST NOT let decide() flip
    // status. 'racing' is the explicit signal; the caller sees a 409 and can
    // retry.
    this.logger.warn(
      `CoachWearableMessageMaterializer: race-loser poll budget exhausted for draft ${draft.id}; surfacing racing state.`,
    );
    // Reference payload so the helper signature stays stable even when a
    // future variant of the race-recovery path re-validates mid-poll.
    void payload;
    return { status: 'racing', ref: null };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
