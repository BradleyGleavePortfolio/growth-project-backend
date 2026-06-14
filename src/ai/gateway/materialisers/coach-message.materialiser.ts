import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AiActionDraft } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { MessagingService } from '../../../messaging/messaging.service';
import {
  CapabilityMaterializer,
  MaterializeResult,
} from './capability-materialiser.interface';

/** Capability string handled by this materialiser. */
export const COACH_MESSAGE_CAPABILITY = 'draft.coach_message';

/**
 * Runtime schema for `draft.coach_message` payloads. Validated at TWO points:
 *   1. Draft creation time, in `AiGatewayService.invoke` — so malformed
 *      payloads are rejected with a 400 BEFORE the row is persisted. This
 *      shifts the failure earlier so coaches never see a broken draft card.
 *   2. Materialisation time, in `CoachMessageMaterializer.materialize` — so
 *      a payload that somehow drifted in shape (e.g. via direct DB write or
 *      a future migration bug) cannot trigger a runtime cast error inside
 *      `sendAsCoach`.
 *
 * The shape is intentionally tight: a single recipient + a text body. Voice
 * notes are NOT a supported AI-drafted output (the model has no voice
 * channel) and are explicitly rejected.
 */
export const CoachMessagePayloadSchema = z
  .object({
    clientId: z.guid({ message: 'clientId must be a UUID' }),
    // 4000 chars is well above the model's per-message budget (~1k tokens)
    // but stays under realistic mobile chat-bubble rendering limits.
    body: z
      .string()
      .min(1, { message: 'body must not be empty' })
      .max(4000, { message: 'body exceeds 4000 chars' })
      .refine((s) => s.trim().length > 0, {
        message: 'body must not be whitespace-only',
      }),
  })
  .strict();

export type CoachMessagePayload = z.infer<typeof CoachMessagePayloadSchema>;

/**
 * Convenience guard used by `AiGatewayService.invoke` to validate the
 * `proposedActionPayload` for `draft.coach_message` before the draft row is
 * written. Throws a `z.ZodError` on failure — callers map that to a 400.
 */
export function assertCoachMessagePayload(
  raw: unknown,
): CoachMessagePayload {
  return CoachMessagePayloadSchema.parse(raw);
}

/**
 * Materialiser for `draft.coach_message`.
 *
 * Responsibilities:
 *   - Validate the payload one more time (defence in depth).
 *   - Call `MessagingService.sendAsCoach` with `tenant_coach_id` as the
 *     sender (NOT `requester_id`, which may be the OWNER acting on behalf
 *     of a coach; the recipient client is bound to the coach's namespace
 *     via the tenant column).
 *   - Idempotency: an in-flight or completed materialisation MUST NOT be
 *     re-emitted. We use `AiActionDraft.materialised_at` as the marker —
 *     a non-null value means the side-effect has already fired and we
 *     return `already_materialised`.
 *
 * Idempotency note: MessagingService does NOT currently support a
 * caller-supplied idempotency key (no unique constraint that would dedupe
 * a duplicate `sendAsCoach` call). Until that lands, this materialiser
 * relies on the `materialised_at` column. The race window between two
 * concurrent decide() calls is closed by the row-level lock the wrapping
 * UPDATE in `AiApprovalService.decide` takes on the draft row plus the
 * conditional UPDATE here (WHERE materialised_at IS NULL).
 *
 * TODO(messaging): add `idempotency_key` (or natural-key) support on
 * `coach_messages` so we can drop the conditional-UPDATE optimistic check
 * and let the DB enforce single-emit at the row level. Tracked alongside
 * PR AI-3.
 */
@Injectable()
export class CoachMessageMaterializer implements CapabilityMaterializer {
  readonly capability = COACH_MESSAGE_CAPABILITY;
  private readonly logger = new Logger(CoachMessageMaterializer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
  ) {}

  canHandle(capability: string): boolean {
    return capability === COACH_MESSAGE_CAPABILITY;
  }

  async materialize(draft: AiActionDraft): Promise<MaterializeResult> {
    // P1-1 / P2-1 — the invariant we hold for callers (AiApprovalService.decide):
    //   `status='approved'` MUST imply a committed downstream side-effect
    //   (`materialised_ref` non-null). To make that safe under concurrency the
    //   materialiser distinguishes THREE in-flight states on the draft row:
    //     (a) `materialised_at=null, materialised_ref=null` — never claimed.
    //     (b) `materialised_at!=null, materialised_ref=null` — claim held; the
    //         winner is either in-flight OR has crashed without rolling back
    //         (STUCK-CLAIM, P2-1 — a transient DB error during the rollback
    //         path). Indistinguishable from in-flight on a single read.
    //     (c) `materialised_at!=null, materialised_ref!=null` — committed
    //         success; the side-effect is done.
    //   Only (c) is safe to treat as "already_materialised". (a) is the
    //   normal claim path. (b) is the failure mode that PRODUCT-1 recurred
    //   from before this PR — short-circuiting on (b) flips status to
    //   'approved' with no message sent.
    if (draft.materialised_at && draft.materialised_ref) {
      return {
        status: 'already_materialised',
        ref: draft.materialised_ref,
      };
    }

    if (!draft.tenant_coach_id) {
      // A coach_message draft without a tenant coach has no sender. This
      // shouldn't happen — the controller pins tenant_coach_id at invoke
      // time — but fail loudly rather than silently dropping the send.
      throw new Error(
        `CoachMessageMaterializer: draft ${draft.id} has no tenant_coach_id`,
      );
    }

    // Re-validate the persisted payload. Drift-detection: if a future
    // migration or admin tool ever rewrites payload shape, we'd rather
    // 4xx the approval than crash inside MessagingService.
    let payload: CoachMessagePayload;
    try {
      payload = assertCoachMessagePayload(draft.payload);
    } catch (err) {
      this.logger.warn(
        `CoachMessageMaterializer: payload validation failed for draft ${draft.id}: ${(err as Error).message}`,
      );
      throw err;
    }

    // Optimistic idempotency lock. We claim the right to materialise this
    // draft by setting `materialised_at` in a conditional UPDATE that
    // requires:
    //   - `materialised_at` currently NULL (no in-flight or completed claim).
    //   - `status` currently 'pending' (P1-A round-3): a concurrent
    //     `decide(reject)` or `expireStaleDrafts` cron could otherwise flip
    //     status to 'rejected'/'expired' between our caller's status read
    //     and this claim. Without the status clause our claim would still
    //     succeed, sendAsCoach would deliver the message, and the draft
    //     would end `status='rejected', materialised_ref=non-null` — same
    //     trust-surface failure as PRODUCT-1 with the symptom flipped
    //     (rejected-but-sent). The status clause closes that race at the
    //     same row-lock that protects the at clause.
    // If another concurrent approver beat us to it (or a prior STUCK-CLAIM
    // exists, or a concurrent reject/expire flipped status), `count` will
    // be 0 and we enter the race-loser path below. P2-1: a row in state (b)
    // — `materialised_at!=null, materialised_ref=null` — will also produce
    // count=0; the race-loser path's polling + recovery loop handles it.
    const claim = await this.prisma.aiActionDraft.updateMany({
      where: { id: draft.id, materialised_at: null, status: 'pending' },
      data: { materialised_at: new Date() },
    });
    if (claim.count === 0) {
      // Race lost (or STUCK-CLAIM present). We do NOT assume the winner
      // succeeded — that's the PRODUCT-1 trap. Instead poll the draft row
      // until either:
      //   - `materialised_ref` becomes non-null (winner committed) → return
      //     `already_materialised` so decide() can record the link.
      //   - `materialised_at` returns to null (winner rolled back) → loop
      //     and attempt the claim again ourselves.
      //   - The poll budget elapses → return `status: 'racing'` so decide()
      //     refuses to flip status and surfaces a conflict to the caller,
      //     who can retry after the winner finishes.
      return this.awaitWinnerOrRecover(draft, payload);
    }

    // Send. If `sendAsCoach` throws (auth boundary, blocked sender, DB
    // outage, …), we MUST release the materialisation claim so a retry can
    // succeed — otherwise the draft would be permanently stuck with
    // materialised_at set but no downstream message row.
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
          where: { id: draft.id, materialised_at: { not: null }, materialised_ref: null },
          data: { materialised_at: null },
        })
        .catch((rollbackErr) => {
          // We tried our best to release the claim. Log and continue —
          // surfacing the original error to the caller is more important
          // than the rollback noise.
          this.logger.error(
            `CoachMessageMaterializer: failed to release materialisation claim on draft ${draft.id}: ${(rollbackErr as Error).message}`,
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

  // Race-loser / STUCK-CLAIM recovery. Bounded polling: short enough that a
  // legitimate winner has time to finish a typical `sendAsCoach` round-trip,
  // long enough that we don't pile up open requests waiting on a wedged DB.
  // Returns `already_materialised` if the winner commits, recurses into a
  // fresh claim attempt if the winner rolls back, and falls back to
  // `racing` so decide() can surface a 409 to the caller.
  //
  // These are non-readonly so the race-window integration tests can shorten
  // them; production code never mutates them.
  static RACE_POLL_ATTEMPTS = 10;
  static RACE_POLL_INTERVAL_MS = 100;

  private async awaitWinnerOrRecover(
    draft: AiActionDraft,
    payload: CoachMessagePayload,
  ): Promise<MaterializeResult> {
    for (let i = 0; i < CoachMessageMaterializer.RACE_POLL_ATTEMPTS; i++) {
      const fresh = await this.prisma.aiActionDraft.findUnique({
        where: { id: draft.id },
      });
      if (!fresh) {
        // Draft vanished mid-flight — surface as racing so decide() throws
        // a conflict rather than flipping status on a row that no longer
        // exists.
        return { status: 'racing', ref: null };
      }
      if (fresh.materialised_ref) {
        return {
          status: 'already_materialised',
          ref: fresh.materialised_ref,
        };
      }
      // P1-A round-3: detect a terminal status flip (reject / expired /
      // already-approved-by-other). Without this check the poll would
      // observe `materialised_at != null, materialised_ref = null` until
      // budget exhaustion when the actual cause was a concurrent reject
      // that beat our claim. We could "spin" pointlessly. Worse, if the
      // recovery branch below saw `at = null` (a rolled-back winner) we
      // would recurse into materialize() and try to claim — but with
      // status flipped, the claim's `status:'pending'` clause would
      // refuse forever. Detecting the flip here turns that loop into an
      // immediate 'racing' response so decide() throws 409.
      if (fresh.status !== 'pending') {
        return { status: 'racing', ref: null };
      }
      if (!fresh.materialised_at) {
        // Winner rolled back. Re-attempt the claim ourselves. Re-enter
        // materialize() with the freshly observed draft so the recursive
        // call sees state (a) (no claim) and proceeds normally. Recursion
        // is bounded by the poll budget on our side; if our own claim is
        // lost again to a third caller we'll re-poll under that caller's
        // ownership. No unbounded loops.
        return this.materialize(fresh as AiActionDraft);
      }
      await this.sleep(CoachMessageMaterializer.RACE_POLL_INTERVAL_MS);
    }
    // Winner is still in-flight (or genuinely stuck) after the poll
    // budget. We cannot prove the side-effect committed, so we MUST NOT
    // let decide() flip status. Returning `racing` is the explicit signal
    // for that. The caller will see a 409 and can retry.
    this.logger.warn(
      `CoachMessageMaterializer: race-loser poll budget exhausted for draft ${draft.id}; surfacing racing state.`,
    );
    // Reference payload deliberately so the helper signature is stable
    // even when future variants of the race-recovery path may need to
    // re-validate the persisted payload mid-poll.
    void payload;
    return { status: 'racing', ref: null };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
