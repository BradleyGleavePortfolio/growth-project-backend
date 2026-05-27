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
    clientId: z.string().uuid({ message: 'clientId must be a UUID' }),
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
    // Idempotency short-circuit: a prior successful run wrote
    // `materialised_at`. Bail out without re-sending. The caller (decide())
    // will still flip status to 'approved' if needed — that path is also
    // idempotent because decide() refuses to re-decide a non-pending draft.
    if (draft.materialised_at) {
      return {
        status: 'already_materialised',
        ref: draft.materialised_ref ?? null,
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
    // requires the column to currently be NULL. If another concurrent
    // approver beat us to it, `count` will be 0 and we bail out.
    const claim = await this.prisma.aiActionDraft.updateMany({
      where: { id: draft.id, materialised_at: null },
      data: { materialised_at: new Date() },
    });
    if (claim.count === 0) {
      // Race lost — the other caller is doing the send. Re-read to expose
      // the ref they wrote (if any) so the caller's response is accurate.
      const fresh = await this.prisma.aiActionDraft.findUnique({
        where: { id: draft.id },
      });
      return {
        status: 'already_materialised',
        ref: fresh?.materialised_ref ?? null,
      };
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
}
