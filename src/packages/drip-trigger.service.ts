import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

// PR-11 — DripTriggerService.
//
// Wires the on_completion + on_milestone cadence kinds to existing
// completion/milestone signals. PR-9 seeds these drops with fire_at=NULL
// (PR-10's cron deliberately skips fire_at IS NULL). PR-11 flips the
// matching pending drops to fire_at=now() so PR-10's NEXT tick delivers
// them through the SAME dispatch + idempotency + alert + retry pipeline.
//
// TRIGGER -> FIRE MECHANISM (decision recorded here for future readers)
// ---------------------------------------------------------------------
// We flip fire_at rather than calling the resolver inline (option (a) in
// PR-11's brief). Two reasons:
//   1. Reuses PR-10's entire dispatch pipeline for free — claim/lock,
//      resolver materialise, push+in-app alert, retry/backoff, COACH_ALERT
//      on permanent failure, stranded-dispatching reclaim. An inline path
//      would duplicate every line of that and is the kind of subtle drift
//      that creates two divergent code paths over time.
//   2. Decouples the completion hook from the resolver. A workout-completion
//      request returns to the buyer in <10ms whether or not the resolver is
//      healthy. An inline path would couple buyer latency to (e.g.) a slow
//      MessagingService send.
// The cost is ~30s worst-case delivery latency (cron tick interval). That
// is acceptable for trigger drops (the buyer doesn't expect simultaneous
// firing — they expect "after you finish X, Y unlocks").
//
// ON_COMPLETION DEFAULT (when depends_on_content_id is omitted)
// -------------------------------------------------------------
// When a coach attaches a content row with cadence on_completion + no
// depends_on_content_id, the documented default is: the trigger fires
// when the buyer completes the content row IMMEDIATELY PRIOR in
// display_order WITHIN THE SAME PURCHASE. This matches the natural
// "finish Module 1 to unlock Module 2" mental model and is the only
// rule the snapshot has enough information to express without consulting
// the live CoachPackageContent table (which may have been re-ordered
// post-purchase). For the FIRST content row (display_order is the min
// of the purchase's snapshotted drops), an omitted depends_on means the
// drop has no preceding content to depend on and therefore NEVER fires
// via completion — which is the correct fail-closed behaviour (an
// authoring error should not result in surprise delivery).
//
// IDEMPOTENCY
// -----------
// Three layers protect against double-fire on a doubled completion or
// milestone emit:
//   1. The query filters fire_at IS NULL — once we flip a drop to
//      fire_at=now(), the next trigger emit no longer matches.
//   2. status='pending' AND materialised_ref IS NULL — a delivered drop
//      is excluded even if a stale completion event arrives later.
//   3. PR-10's claim/atomic-update + resolver-side stable-key dedup
//      (WorkoutBuilderIdempotencyKey 'drip:workout:p={p}:c={c}',
//      DripResolverMarker(purpose,purchase,content)) collapse any
//      retry onto the cached deliverable.
// A trigger emit that matches no pending drop is a NO-OP (most
// completions won't have a waiting drop).
//
// SCOPE (buyer A's completion must NOT fire buyer B's drops)
// ----------------------------------------------------------
// Every query joins through ClientPurchase.client_user_id = buyerId, so
// a drop belonging to a different buyer's purchase can never match.
//
// PERFORMANCE
// -----------
// The on_completion path issues two indexed queries:
//   1. ScheduledDrop.findMany filtered by (status='pending', fire_at IS
//      NULL, materialised_ref IS NULL, cadence_kind='on_completion',
//      asset_type, asset_id) — supported by the existing
//      ScheduledDrop @@index([status, fire_at]) which is the leading
//      index for the (status='pending', fire_at IS NULL) combination.
//      asset_type+asset_id are highly selective in steady state. We do
//      NOT add a new index because the in-steady-state cardinality of
//      (status='pending', fire_at IS NULL, on_completion) is small
//      (only buyers with unredeemed completion-triggers) and the
//      per-completion completion rate is bounded by user activity.
//   2. ClientPurchase lookup to scope to the buyer — already indexed on
//      client_user_id.
// The on_milestone path issues a single ScheduledDrop query gated on
// (status='pending', fire_at IS NULL, cadence_kind='on_milestone') with
// post-filter on cadence_payload.milestone_key + purchase ownership.

type CadencePayload = Record<string, unknown> | null;

interface MatchableDrop {
  id: string;
  client_purchase_id: string;
  content_id: string;
  asset_type: string;
  asset_id: string;
  cadence_kind: string;
  cadence_payload: Prisma.JsonValue;
  fire_at: Date | null;
  status: string;
  materialised_ref: string | null;
}

export interface OnCompletionInput {
  buyerUserId: string;
  assetType: string;
  assetId: string;
}

export interface OnMilestoneInput {
  buyerUserId: string;
  milestoneKey: string;
}

export interface TriggerResult {
  /** Count of pending-trigger drops flipped to fire_at=now. */
  flipped: number;
  /** Drop ids flipped (small, useful for tests + structured logs). */
  flippedDropIds: string[];
}

@Injectable()
export class DripTriggerService {
  private readonly logger = new Logger(DripTriggerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fire trigger when a buyer completes a unit of content (a workout
   * plan, a meal plan day, etc.). The caller supplies the asset
   * identity that was just completed. We:
   *   1. Look up the buyer's entitled ClientPurchase(s) whose
   *      snapshotted ScheduledDrop set INCLUDES the just-completed
   *      (asset_type, asset_id) — that establishes which content_id
   *      in which purchase the completion refers to.
   *   2. For each (purchase_id, completed_content_id) pair found:
   *      a. Find pending-trigger drops in the same purchase whose
   *         cadence_kind='on_completion' AND fire_at IS NULL AND
   *         status='pending' AND materialised_ref IS NULL.
   *      b. Filter to drops whose cadence_payload.depends_on_content_id
   *         equals completed_content_id (explicit dependency) OR whose
   *         depends_on_content_id is missing AND completed_content_id
   *         is the IMMEDIATELY-PRIOR content by display_order within
   *         the same purchase (documented default).
   *   3. Flip matched drops to fire_at=now() with a single conditional
   *      updateMany (fire_at IS NULL re-asserted in WHERE so a
   *      concurrent trigger cannot double-flip).
   *
   * Returns the count of drops flipped (0 on no-op, which is the
   * common case — most completions have no waiting drop).
   *
   * Never throws — completion path callers are fire-and-forget; we log
   * and absorb errors so a trigger pipeline blip cannot break a
   * legitimate completion request.
   */
  async onContentCompleted(input: OnCompletionInput): Promise<TriggerResult> {
    const empty: TriggerResult = { flipped: 0, flippedDropIds: [] };
    try {
      // Step 1: find the buyer's purchases that have a snapshotted drop
      // matching the just-completed asset. The snapshot's content_id
      // tells us which CoachPackageContent the completion corresponds
      // to within each purchase.
      const completedDrops = await this.prisma.scheduledDrop.findMany({
        where: {
          asset_type: input.assetType,
          asset_id: input.assetId,
          client_purchase: { client_user_id: input.buyerUserId },
        },
        select: {
          client_purchase_id: true,
          content_id: true,
          // Need display_order context — see step 2b. We don't store
          // display_order on the drop itself (it's not used by dispatch),
          // so we derive ordering from CoachPackageContent OR, if the
          // authoring row is soft-removed, from the drops' created_at
          // (which preserves the original fan-out display_order, since
          // PR-9 seeds in display_order).
          created_at: true,
        },
      });

      if (completedDrops.length === 0) {
        // The buyer completed an asset they don't have a packaged drop
        // for — entirely normal (manual coach-assigned content, or
        // content delivered via non-package flows). No-op.
        return empty;
      }

      const flippedIds: string[] = [];
      for (const cd of completedDrops) {
        const ids = await this.flipMatchingOnCompletion(
          cd.client_purchase_id,
          cd.content_id,
        );
        flippedIds.push(...ids);
      }

      if (flippedIds.length > 0) {
        this.logger.log(
          `DripTrigger on_completion: buyer=${input.buyerUserId} asset=${input.assetType}/${input.assetId} flipped=${flippedIds.length} drops=${flippedIds.join(',')}`,
        );
      }
      return { flipped: flippedIds.length, flippedDropIds: flippedIds };
    } catch (err) {
      this.logger.warn(
        `DripTrigger on_completion failed for buyer=${input.buyerUserId} asset=${input.assetType}/${input.assetId}: ${(err as Error).message}`,
      );
      return empty;
    }
  }

  /**
   * Fire trigger when a named milestone is emitted for a buyer.
   * Matches pending-trigger on_milestone drops whose
   * cadence_payload.milestone_key === input.milestoneKey AND whose
   * owning ClientPurchase belongs to the same buyer.
   *
   * Never throws — see onContentCompleted rationale.
   */
  async onMilestone(input: OnMilestoneInput): Promise<TriggerResult> {
    const empty: TriggerResult = { flipped: 0, flippedDropIds: [] };
    try {
      const candidates = await this.prisma.scheduledDrop.findMany({
        where: {
          status: 'pending',
          fire_at: null,
          materialised_ref: null,
          cadence_kind: 'on_milestone',
          client_purchase: { client_user_id: input.buyerUserId },
        },
        select: {
          id: true,
          cadence_payload: true,
        },
      });

      const matches = candidates.filter((c) =>
        this.payloadMilestoneKey(c.cadence_payload) === input.milestoneKey,
      );

      if (matches.length === 0) {
        // Either non-matching milestone_key or buyer has no waiting
        // milestone drops. No-op.
        return empty;
      }

      const flippedIds = await this.flipByIds(matches.map((m) => m.id));
      if (flippedIds.length > 0) {
        this.logger.log(
          `DripTrigger on_milestone: buyer=${input.buyerUserId} key=${input.milestoneKey} flipped=${flippedIds.length} drops=${flippedIds.join(',')}`,
        );
      }
      return { flipped: flippedIds.length, flippedDropIds: flippedIds };
    } catch (err) {
      this.logger.warn(
        `DripTrigger on_milestone failed for buyer=${input.buyerUserId} key=${input.milestoneKey}: ${(err as Error).message}`,
      );
      return empty;
    }
  }

  // ─── internal ────────────────────────────────────────────────────────

  private async flipMatchingOnCompletion(
    purchaseId: string,
    completedContentId: string,
  ): Promise<string[]> {
    // Fetch all the purchase's pending-trigger on_completion drops AND
    // its full snapshot ordering (via CoachPackageContent display_order)
    // so we can evaluate the "immediately-prior" default rule.
    const candidates = await this.prisma.scheduledDrop.findMany({
      where: {
        client_purchase_id: purchaseId,
        status: 'pending',
        fire_at: null,
        materialised_ref: null,
        cadence_kind: 'on_completion',
      },
      select: {
        id: true,
        content_id: true,
        cadence_payload: true,
      },
    });

    if (candidates.length === 0) return [];

    // For the documented-default branch we need the display_order of
    // the just-completed content AND of each candidate drop's content.
    // We also need the display_orders of OTHER content rows in this
    // purchase's package, because the "immediately prior" rule must
    // detect any row sitting between completed and candidate (even
    // rows whose own drops are not currently pending). We read every
    // CoachPackageContent row belonging to the purchase's package
    // (NOT scoped by removed_at — a content row that was soft-removed
    // post-purchase still has a stable display_order, and the snapshot
    // is the source of truth for the buyer's timeline).
    // First learn the package_id from any of the purchase's drops (we
    // already have the purchase_id; ClientPurchase.package_id is the
    // canonical link). One small join keeps the rest indexed.
    const purchaseRow = await this.prisma.clientPurchase.findUnique({
      where: { id: purchaseId },
      select: { package_id: true },
    });
    const packageId = purchaseRow?.package_id ?? null;
    const orderingRows = packageId
      ? await this.prisma.coachPackageContent.findMany({
          where: { package_id: packageId },
          select: { id: true, display_order: true },
        })
      : await this.prisma.coachPackageContent.findMany({
          where: {
            id: { in: [completedContentId, ...candidates.map((c) => c.content_id)] },
          },
          select: { id: true, display_order: true },
        });
    const orderById = new Map<string, number>(
      orderingRows.map((r) => [r.id, r.display_order]),
    );
    const completedOrder = orderById.get(completedContentId);

    const toFlip: string[] = [];
    for (const c of candidates) {
      const explicitDep = this.payloadDependsOnContentId(c.cadence_payload);
      if (explicitDep) {
        // Explicit depends_on_content_id — match against the just-
        // completed content_id.
        if (explicitDep === completedContentId) {
          toFlip.push(c.id);
        }
        continue;
      }
      // Documented default: trigger fires when the IMMEDIATELY-PRIOR
      // content (by display_order, within this purchase) is completed.
      // Concretely: the just-completed content's display_order must be
      // EXACTLY one less than the candidate drop's content's
      // display_order, with no other content row sitting between them.
      const candidateOrder = orderById.get(c.content_id);
      if (
        completedOrder === undefined ||
        candidateOrder === undefined ||
        completedOrder >= candidateOrder
      ) {
        continue;
      }
      // Walk the in-memory ordering map (loaded above for the whole
      // package) to confirm "immediately prior" — no other content
      // row with display_order strictly between completedOrder
      // (exclusive) and candidateOrder (exclusive). This is O(N) over
      // the package's content count, which is typically <20 and
      // entirely in-memory so no extra DB round-trip.
      let between = false;
      for (const order of orderById.values()) {
        if (order > completedOrder && order < candidateOrder) {
          between = true;
          break;
        }
      }
      if (!between) {
        toFlip.push(c.id);
      }
    }

    return this.flipByIds(toFlip);
  }

  /**
   * Conditional updateMany that flips fire_at on still-pending,
   * still-NULL-fire_at drops. Returns the ids that were actually
   * flipped (the ones whose row matched the WHERE — a concurrent
   * flip from a second trigger emit naturally collapses to zero).
   */
  private async flipByIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const now = new Date();
    // We use updateMany with the fire_at IS NULL re-assertion so a
    // concurrent flip (e.g. two simultaneous completion events) cannot
    // both succeed for the same drop. updateMany returns a count but
    // not the ids — so we read the drops back and filter to ones whose
    // fire_at WAS just set. The post-read is bounded by ids.length
    // (small, since pending-trigger drops per purchase are bounded by
    // the package's content count).
    await this.prisma.scheduledDrop.updateMany({
      where: {
        id: { in: ids },
        status: 'pending',
        fire_at: null,
        materialised_ref: null,
      },
      data: { fire_at: now },
    });
    // Confirm which rows we actually flipped (vs. ones a concurrent
    // trigger flipped first). We treat "fire_at >= now" as our flip.
    const flipped = await this.prisma.scheduledDrop.findMany({
      where: {
        id: { in: ids },
        fire_at: { gte: now },
      },
      select: { id: true },
    });
    return flipped.map((f) => f.id);
  }

  private payloadDependsOnContentId(
    payload: Prisma.JsonValue,
  ): string | null {
    const p = this.coercePayload(payload);
    if (!p) return null;
    const v = p['depends_on_content_id'];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  private payloadMilestoneKey(payload: Prisma.JsonValue): string | null {
    const p = this.coercePayload(payload);
    if (!p) return null;
    const v = p['milestone_key'];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  private coercePayload(payload: Prisma.JsonValue): CadencePayload {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
    return null;
  }
}

// Exported for test discovery convenience.
export type { MatchableDrop };
