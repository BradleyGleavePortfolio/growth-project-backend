import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MessagingService } from '../../messaging/messaging.service';
import { PrismaService } from '../../prisma.service';
import { ResolverSubCoachScope } from './sub-coach-scope.helper';
import {
  AutoMessageBodyMissingError,
} from './assignable-asset-resolver.errors';
import type {
  AssignableAssetMaterialiseInput,
  AssignableAssetMaterialiseResult,
  AssignableAssetResolver,
  AssignableAssetType,
} from './assignable-asset-resolver.interface';

// PR-7 — resolver for asset_type `auto_message`.
//
// Delegates to `MessagingService.sendAsCoach`
// (src/messaging/messaging.service.ts:396). `sendAsCoach` runs its OWN
// sub-coach split internally (Phase 11 fallback at messaging.service.ts:
// 285-314): given the acting coach id, it pins the thread's `coach_id` to
// the head coach but writes `sender_id` to the acting (sub-)coach so the
// thread is attributed correctly.
//
// IMPORTANT — what we pass as the first arg differs from workout/meal_plan.
// Those resolvers pass `acting.tenantCoachId` (head coach) because the
// downstream service enforces strict `plan.coach_id === coachId` ownership
// on a tenant column. `sendAsCoach` is the opposite: it expects the ACTING
// coach id and resolves the head-coach split internally. Passing the head
// coach id here would defeat that split and mis-attribute the sender to the
// head coach. We still call `ResolverSubCoachScope.resolve()` first so the
// out-of-scope refusal is uniform across every resolver (defence-in-depth)
// — we just don't substitute the tenant id in the call.
//
// The body comes from `displayCaption` (preferred) or `displayTitle`
// (fallback). PR-12 introduces the auto-message template authoring surface;
// until then a drop without either field cannot produce a non-empty message
// and we fail loudly with a typed `AutoMessageBodyMissingError` rather than
// sending whitespace.
//
// IDEMPOTENCY (PR-9 R1 audit-fix for P1-2):
//   `MessagingService.sendAsCoach` commits CoachMessage on its OWN
//   connection (not the caller's tx). The PR-9 atomicity contract — outer
//   tx rolls back → Stripe retries → idempotency makes the retry safe —
//   was BROKEN for this resolver because the sent CoachMessage row
//   persists across the rollback and a retry produces a SECOND message.
//
//   Fix: a durable `DripResolverMarker(purpose='auto_message',
//   purchase_id, content_id)` row is INSERTED in its own commit BEFORE
//   the send. The (purpose, purchase_id, content_id) unique key is
//   stable across an outer-tx rollback + Stripe retry. On retry the
//   second INSERT hits P2002, we re-read the marker:
//     - marker.materialised_ref != null → the prior attempt's send
//       succeeded and we return the cached message id (NO second send).
//     - marker.materialised_ref == null → the prior attempt died after
//       the marker insert but before the send finished. We complete the
//       send and stamp the marker. This is at-least-once for the send
//       in that narrow window (process kill / Stripe HTTP timeout
//       between the marker insert and the messaging service's commit),
//       but it is at-most-once across the routine rollback-and-retry
//       path the brief actually documents — which is the failure mode
//       P1-2 was concerned with.
//
//   When (purchaseId, contentId) are NOT supplied (PR-10 cron path with
//   a stable scheduledDropId, or non-drip callers), we skip the marker
//   and fall back to the legacy AT-LEAST-ONCE behaviour (gated by
//   ScheduledDrop.materialised_ref IS NULL in the executor).
//
// tx-honoring: `sendAsCoach` opens no transaction and we cannot push `tx`
// into it without an out-of-scope signature change to MessagingService.
// The marker INSERT/UPDATE deliberately uses `this.prisma` (NOT the
// caller's tx) so the marker survives an outer-tx rollback — that's the
// whole point.

@Injectable()
export class AutoMessageAssetResolver implements AssignableAssetResolver {
  private readonly logger = new Logger(AutoMessageAssetResolver.name);
  readonly assetType: AssignableAssetType = 'auto_message';
  private static readonly MARKER_PURPOSE = 'auto_message';

  constructor(
    private readonly messaging: MessagingService,
    private readonly scope: ResolverSubCoachScope,
    private readonly prisma: PrismaService,
  ) {}

  canHandle(assetType: string): boolean {
    return assetType === 'auto_message';
  }

  async materialise(
    input: AssignableAssetMaterialiseInput,
  ): Promise<AssignableAssetMaterialiseResult> {
    const body = (input.displayCaption ?? input.displayTitle ?? '').trim();
    if (!body) {
      throw new AutoMessageBodyMissingError();
    }

    // Run the resolver-wide scope check (uniform with the other resolvers)
    // but DELIBERATELY pass the acting coach id — not tenantCoachId — to
    // sendAsCoach. The service does its own Phase-11 sub-coach split using
    // exactly that id; passing the head coach would mis-attribute the
    // sender. See the file-level comment for the full rationale.
    const acting = await this.scope.resolve(input.coachId, input.clientId);

    const purchaseId = input.clientPurchaseId ?? null;
    const contentId = input.contentId ?? null;
    const useMarker = !!(purchaseId && contentId);

    // PR-9 R1 — DRIP fan-out path (purchase+content known): claim the
    // durable marker FIRST. If a prior attempt already claimed it and
    // succeeded, replay the cached message id without a second send.
    if (useMarker) {
      const claim = await this.tryClaimMarker(purchaseId!, contentId!);
      if (claim.kind === 'cached') {
        // Prior attempt already sent the message; return its id without
        // firing sendAsCoach a second time.
        return { materialisedRef: claim.materialisedRef };
      }
      // claim.kind === 'fresh' or 'reclaim' — proceed to send, then
      // stamp the marker with the message id.
    }

    const sent = await this.messaging.sendAsCoach(
      acting.actingCoachId,
      input.clientId,
      { body },
    );
    if (!sent?.id) {
      this.logger.error(
        `AutoMessageAssetResolver: sendAsCoach returned no id for client=${input.clientId}`,
      );
      throw new Error('AutoMessageAssetResolver: sendAsCoach returned no id');
    }

    if (useMarker) {
      // Stamp the marker with the materialised ref so a future retry
      // observes it and short-circuits. Best-effort: failure here is
      // observable (next retry would re-send), but the message did
      // land — we log and surface the message id either way.
      try {
        await this.prisma.dripResolverMarker.update({
          where: {
            purpose_purchase_id_content_id: {
              purpose: AutoMessageAssetResolver.MARKER_PURPOSE,
              purchase_id: purchaseId!,
              content_id: contentId!,
            },
          },
          data: { materialised_ref: sent.id },
        });
      } catch (err) {
        this.logger.warn(
          `AutoMessageAssetResolver: marker update failed purchase=${purchaseId} content=${contentId}: ${(err as Error).message}`,
        );
      }
    }
    return { materialisedRef: sent.id };
  }

  private async tryClaimMarker(
    purchaseId: string,
    contentId: string,
  ): Promise<
    | { kind: 'fresh' }
    | { kind: 'reclaim' }
    | { kind: 'cached'; materialisedRef: string }
  > {
    try {
      await this.prisma.dripResolverMarker.create({
        data: {
          purpose: AutoMessageAssetResolver.MARKER_PURPOSE,
          purchase_id: purchaseId,
          content_id: contentId,
        },
      });
      return { kind: 'fresh' };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.dripResolverMarker.findUnique({
          where: {
            purpose_purchase_id_content_id: {
              purpose: AutoMessageAssetResolver.MARKER_PURPOSE,
              purchase_id: purchaseId,
              content_id: contentId,
            },
          },
        });
        if (existing?.materialised_ref) {
          return { kind: 'cached', materialisedRef: existing.materialised_ref };
        }
        // Prior attempt inserted the marker but died before stamping
        // the ref. Reclaim and complete the send — there is no message
        // row in the database to be duplicated yet.
        return { kind: 'reclaim' };
      }
      throw err;
    }
  }
}
