import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ClientPurchase, Prisma } from '@prisma/client';
import { AssignableAssetResolverRegistry } from './asset-resolvers/assignable-asset-resolver.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationKind } from '../notifications/notification-kind';
import { PrismaService } from '../prisma.service';

// PR-9 (Packages & Drip-Feed) — REAL fan-out body.
//
// Replaces the PR-4 no-op seam. onPurchaseEntitled() now:
//
//   1. Idempotently records the PurchaseFanout row (PR-4 contract preserved).
//   2. Loads the package's non-removed CoachPackageContent rows (authored in
//      PR-8) and SNAPSHOTS each into a ScheduledDrop row keyed on
//      (client_purchase_id, content_id) — the @@unique guard makes the seed
//      idempotent across Stripe webhook replays.
//   3. Per snapshot computes `fire_at` from the cadence:
//        - immediate                   → fire_at = now; MATERIALISE INLINE
//        - relative_to_purchase        → fire_at = purchase.created_at + offset_days
//        - fixed_calendar (future)     → fire_at = release_at
//        - fixed_calendar (past)       → fire_at = now; MATERIALISE INLINE
//        - on_completion / on_milestone → fire_at = null (PR-11 wires triggers)
//   4. For drops that should fire NOW it calls the PR-7
//      AssignableAssetResolverRegistry with the ambient `tx` so the
//      resolver's writes commit-or-roll-back together with the entitlement.
//      On success it stamps `materialised_ref` + `status='fired'` +
//      `fired_at`.
//
// IDEMPOTENCY (KEEPS PR-4 contract; PR-9 R1 closes the rollback-and-retry gap):
//   - PurchaseFanout.purchase_id @unique + upsert({update:{}}) — webhook
//     replay does not create a second row.
//   - ScheduledDrop.@@unique([client_purchase_id, content_id]) + use of
//     `skipDuplicates: true` on the bulk createMany — replay does not seed
//     duplicate drops.
//   - Immediate-materialisation guard (happy-path replay): after createMany
//     we re-read the drops we just seeded; we materialise ONLY drops whose
//     `materialised_ref IS NULL`. A happy-path replay finds the prior
//     fire's ref already set and skips.
//   - Rollback-and-retry replay (audit P1-1/P1-2 fix): the resolvers
//     additionally use STABLE per-(purchaseId, contentId) keys instead of
//     the regenerated scheduledDropId so a rolled-back+retried event
//     cannot double-fire downstream side-effects:
//       * workout → WorkoutBuilderIdempotencyKey value
//         `drip:workout:p={purchaseId}:c={contentId}`. The ledger is
//         written via `this.prisma` outside the outer tx, so it survives
//         the rollback and a retry observes the cached completed claim.
//       * auto_message → durable `DripResolverMarker(purpose=auto_message,
//         purchase_id, content_id)` claimed BEFORE sendAsCoach and
//         updated with the resulting CoachMessage id after. A retry
//         observes the marker and replays the cached message id without
//         a second send (see auto-message.resolver.ts for the
//         marker.materialised_ref==null reclaim case).
//       * meal_plan → `DailyMealPlanAssignment.drip_drop_id @unique`. The
//         per-drop key still regenerates on rollback, but the write rides
//         the outer tx so a rollback erases the row entirely — the retry
//         starts from a clean slate.
//       * pdf/video → `ClientAssetGrant @@unique[client_id, media_asset_id]`.
//         Composite is stable across UUID churn; retry collapses cleanly.
//     Net invariant: a rollback+retry of the same Stripe event id never
//     produces a second ClientWorkoutAssignment, CoachMessage,
//     DailyMealPlanAssignment, or ClientAssetGrant.
//
// ATOMICITY CONTRACT — IMMEDIATE RESOLVER FAILURE INSIDE THE TX:
//   We DO NOT swallow a resolver failure. We rethrow it so the outer
//   $transaction (opened by BillingService.handleEvent OR by
//   GuestCheckoutService.convertGuestToUser) rolls back the entire
//   purchase — the ClientPurchase.entitlement_active flip, the
//   PurchaseFanout row, every ScheduledDrop seed — together. Stripe (or
//   the guest reconciler) then retries the same event id and the
//   StripeProcessedEvent dedup + PR-7 per-type uniques make the retry
//   safe.
//
//   Rationale: PR-7's at-least-once contract is documented assuming a
//   crash between successful materialisation and ref-persist (the
//   per-drop @unique covers the loser). A resolver-internal failure
//   that NEVER materialised the deliverable is a different beast — if
//   we committed the money + entitlement and silently left the immediate
//   drop pending, the buyer would see their purchase succeed in the UI
//   but the promised content would not arrive until PR-10's cron fires
//   (which today does not exist; even when it does, the buyer just paid
//   $X for the content and expects it AT CHECKOUT — decision #8). Rolling
//   back gives Stripe a normal retry path; the buyer's checkout UI shows
//   "still processing" briefly rather than "succeeded but empty".
//
// ALERT SIDE-EFFECT BOUNDARY (decision #9):
//   Push + in-app drop alerts are NOT in the money tx. Failing to send
//   a push notification must NEVER roll back entitlement. PR-9 exposes
//   the AlertDispatchHook below and a fire-and-forget queue; the actual
//   push wire-up lands in PR-13. For now we record the drop IDs that
//   need alerting on the service instance (or via Logger if no hook is
//   injected) so an out-of-tx step can pick them up after the outer
//   $transaction commits.

export type FanoutEntrypoint = 'in_app_hosted' | 'in_app_ps' | 'storefront_guest';

export interface FanoutContext {
  entrypoint: FanoutEntrypoint;
  coachId?: string;
  clientId?: string;
  /**
   * Time the entitlement was granted ("purchase time" for cadence math).
   * Falls back to the purchase row's created_at when omitted — callers
   * SHOULD supply NOW() at the entitlement moment so the
   * relative_to_purchase offset is anchored to the actual entitlement,
   * not the original `pending` row creation. Provided for testability.
   */
  purchaseTime?: Date;
}

// Accepts either the live PrismaService or a Prisma.TransactionClient.
// onPurchaseEntitled MUST be called with a real tx (post-PR-9 mandate)
// so the entitlement + drop seeding + immediate materialisation
// commit-or-rollback together. We still keep the type flexible so
// legacy unit tests that hand-construct the service with a bare upsert
// stub continue to work.
type TxOrPrisma = Prisma.TransactionClient & {
  coachPackageContent?: Prisma.TransactionClient['coachPackageContent'];
  scheduledDrop?: Prisma.TransactionClient['scheduledDrop'];
  clientPurchase?: Prisma.TransactionClient['clientPurchase'];
  purchaseFanout: Prisma.TransactionClient['purchaseFanout'];
  // PR-15A — DripResolverMarker is the idempotency surface for the
  // COACH_NEW_PURCHASE alert: an in-tx upsert against
  // (purpose='coach_new_purchase', purchase_id, content_id='-') gates
  // a single flush per purchase across Stripe webhook replay. Optional
  // because legacy PR-4 tests stub the tx without engine tables.
  dripResolverMarker?: Prisma.TransactionClient['dripResolverMarker'];
  coachPackage?: Prisma.TransactionClient['coachPackage'];
};

type CadenceKind =
  | 'immediate'
  | 'relative_to_purchase'
  | 'fixed_calendar'
  | 'on_completion'
  | 'on_milestone';

interface AlertDescriptor {
  scheduledDropId: string;
  clientId: string;
  coachId: string;
  clientPurchaseId: string;
  assetType: string;
  displayTitle: string | null;
  displayCaption: string | null;
}

/**
 * Hook for the post-commit alert outbox. PR-13 wires the real
 * push+in-app emitter behind this seam. PR-9 keeps the wiring
 * structurally so the alert side-effect boundary is enforced today.
 */
export interface DripAlertDispatchHook {
  enqueue(alert: AlertDescriptor): void;
}

// PR-15A — COACH_NEW_PURCHASE alert descriptor. Captured inside the
// entitlement tx; flushed via NotificationsService (push + in-app)
// AFTER the outer tx commits, exactly like PR-9's drip-released
// pendingAlerts pattern.
interface CoachNewPurchaseAlertDescriptor {
  coachId: string;
  buyerId: string;
  buyerDisplayName: string;
  purchaseId: string;
  packageName: string;
  amountCents: number;
  currency: string;
}

@Injectable()
export class PurchaseFanoutService {
  private readonly logger = new Logger(PurchaseFanoutService.name);

  // Pending alerts captured in-tx; flushed (fire-and-forget) only when
  // the outer tx caller indicates commit succeeded. Keyed by
  // purchase_id so a rollback can discard the bucket cleanly.
  private readonly pendingAlerts = new Map<string, AlertDescriptor[]>();

  // PR-15A — pending coach-new-purchase alerts, same staging+flush
  // model as pendingAlerts. Capped at one per purchase via the
  // DripResolverMarker(purpose='coach_new_purchase') in-tx claim, so a
  // Stripe webhook replay (which re-enters onPurchaseEntitled) cannot
  // produce a second alert: the second tx's marker upsert is a no-op
  // and the staging block is skipped.
  private readonly pendingCoachNewPurchaseAlerts = new Map<
    string,
    CoachNewPurchaseAlertDescriptor
  >();

  constructor(
    @Optional() private readonly resolvers?: AssignableAssetResolverRegistry,
    @Optional() private readonly alertHook?: DripAlertDispatchHook,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async onPurchaseEntitled(
    purchase: ClientPurchase | { id: string },
    ctx: FanoutContext,
    tx: TxOrPrisma,
  ): Promise<void> {
    // --- (1) PR-4 idempotency row ----------------------------------------
    await tx.purchaseFanout.upsert({
      where: { purchase_id: purchase.id },
      create: {
        purchase_id: purchase.id,
        entrypoint: ctx.entrypoint,
        state: 'pending',
      },
      update: {},
    });

    // Defensive: legacy unit-test wiring may pass a minimal stub that
    // doesn't expose the engine tables. Bail out (no-op fan-out) so
    // PR-4-era tests continue to pass.
    if (!tx.coachPackageContent || !tx.scheduledDrop || !tx.clientPurchase) {
      this.logger.debug(
        `fanout: skipping drop seed for purchase=${purchase.id} (no engine tables on tx)`,
      );
      return;
    }

    // --- (2) Load the purchase + the package's authoring rows -----------
    const purchaseRow = await tx.clientPurchase.findUnique({
      where: { id: purchase.id },
    });
    if (!purchaseRow) {
      // Should never happen — entitlement just wrote it. Treat as a
      // wiring bug.
      throw new Error(
        `PurchaseFanout: ClientPurchase ${purchase.id} not found inside tx`,
      );
    }
    const purchaseTime = ctx.purchaseTime ?? purchaseRow.created_at ?? new Date();

    const contents = await tx.coachPackageContent.findMany({
      where: { package_id: purchaseRow.package_id, removed_at: null },
      orderBy: { display_order: 'asc' },
    });

    // Empty package (paywall-only legacy package): nothing to seed.
    // PR-15A — even an empty package still fires COACH_NEW_PURCHASE; a
    // legacy paywall-only purchase is still a sale the coach should
    // hear about. Stage the alert and return; the bucket flushes via
    // the normal flushAlerts() post-commit hook.
    if (contents.length === 0) {
      this.logger.debug(
        `fanout: package=${purchaseRow.package_id} has no contents — purchase=${purchase.id}`,
      );
      await this.stageCoachNewPurchaseAlert(tx, purchase.id, purchaseRow);
      return;
    }

    // --- (3) Compute snapshots + per-cadence fire_at --------------------
    const now = new Date();
    const seedRows = contents.map((c) => {
      const fireAt = this.computeFireAt(
        c.cadence_kind as CadenceKind,
        c.cadence_payload,
        purchaseTime,
        now,
      );
      return {
        client_purchase_id: purchase.id,
        content_id: c.id,
        asset_type: c.asset_type,
        asset_id: c.asset_id,
        asset_revision_id: c.asset_revision_id,
        cadence_kind: c.cadence_kind,
        cadence_payload: c.cadence_payload as Prisma.InputJsonValue,
        display_title: c.display_title,
        display_caption: c.display_caption,
        fire_at: fireAt,
        status: 'pending',
      };
    });

    // skipDuplicates so a webhook replay (which already seeded these
    // drops on the prior delivery) is a true no-op rather than a
    // unique-constraint abort.
    await tx.scheduledDrop.createMany({
      data: seedRows,
      skipDuplicates: true,
    });

    // --- (4) Re-read what's on disk now and materialise the
    //          due-immediately drops INLINE inside the tx. -----------------
    const persisted = await tx.scheduledDrop.findMany({
      where: { client_purchase_id: purchase.id },
    });

    const dueNow = persisted.filter(
      (d) =>
        d.materialised_ref == null &&
        d.fire_at != null &&
        d.fire_at.getTime() <= now.getTime() &&
        d.status !== 'fired' &&
        d.status !== 'failed' &&
        d.status !== 'canceled',
    );

    // Collect alerts in a local list so a tx rollback discards them
    // (we only flush after the tx returns).
    const localAlerts: AlertDescriptor[] = [];

    for (const drop of dueNow) {
      if (!this.resolvers) {
        // No registry wired — bail with a hard error rather than
        // silently committing money for content that never arrived.
        throw new Error(
          `PurchaseFanout: AssignableAssetResolverRegistry not wired; cannot materialise drop=${drop.id} type=${drop.asset_type}`,
        );
      }
      const result = await this.resolvers.materialise(drop.asset_type, {
        clientId: purchaseRow.client_user_id,
        coachId: purchaseRow.coach_user_id,
        assetId: drop.asset_id,
        assetRevisionId: drop.asset_revision_id ?? null,
        displayTitle: drop.display_title,
        displayCaption: drop.display_caption,
        scheduledDropId: drop.id,
        // PR-9 R1 audit-fix — STABLE keys for cross-rollback idempotency.
        // ScheduledDrop UUIDs regenerate when the outer tx rolls back; the
        // (clientPurchaseId, contentId) pair does not. Resolvers whose
        // side-effects commit OUTSIDE this tx (workout, auto_message)
        // use this pair to gate their dedup so a rolled-back-then-retried
        // event cannot create a second ClientWorkoutAssignment or a
        // second CoachMessage. See P1-1/P1-2 in PR9_AUDIT.md.
        clientPurchaseId: purchase.id,
        contentId: drop.content_id,
        tx: tx as Prisma.TransactionClient,
      });

      await tx.scheduledDrop.update({
        where: { id: drop.id },
        data: {
          materialised_ref: result.materialisedRef,
          status: 'fired',
          fired_at: now,
          attempt_count: { increment: 1 },
          failure_reason: null,
        },
      });

      localAlerts.push({
        scheduledDropId: drop.id,
        clientId: purchaseRow.client_user_id,
        coachId: purchaseRow.coach_user_id,
        clientPurchaseId: purchase.id,
        assetType: drop.asset_type,
        displayTitle: drop.display_title,
        displayCaption: drop.display_caption,
      });
    }

    // Stamp the fanout row as succeeded INSIDE the tx so a partial
    // commit (entitlement+drops without fanout state) is impossible.
    await tx.purchaseFanout.update({
      where: { purchase_id: purchase.id },
      data: { state: 'succeeded', finished_at: new Date() },
    });

    // Stash the alerts into the per-purchase bucket. The caller (the
    // webhook handler / guest path) is expected to call
    // flushAlerts(purchase.id) AFTER the outer tx commits. If they
    // forget, we degrade to silent — never roll back entitlement on a
    // push failure.
    if (localAlerts.length > 0) {
      this.pendingAlerts.set(purchase.id, localAlerts);
    }

    // --- (5) PR-15A — COACH_NEW_PURCHASE staging ----------------------
    await this.stageCoachNewPurchaseAlert(tx, purchase.id, purchaseRow);
  }

  // PR-15A — claim the per-purchase idempotency marker IN-TX and stage
  // the alert into the post-commit bucket. Called from the empty-contents
  // early-return path AND the normal fan-out path so paywall-only
  // packages still notify the coach.
  //
  // Idempotency: DripResolverMarker (purpose='coach_new_purchase',
  // purchase_id, content_id='-') is unique per purchase. The first
  // commit wins; every Stripe webhook replay's create() raises a P2002
  // unique-constraint violation which we swallow → the staging is
  // skipped → exactly one COACH_NEW_PURCHASE per purchase.
  //
  // Rollback semantics: marker INSERT rides the outer tx; a rollback
  // erases it, and discardPendingAlerts() wipes the in-memory bucket.
  // A successful retry re-claims the marker on the next attempt.
  private async stageCoachNewPurchaseAlert(
    tx: TxOrPrisma,
    purchaseId: string,
    purchaseRow: {
      coach_user_id: string;
      client_user_id: string;
      package_id: string;
      amount_cents?: number;
      currency?: string;
    },
  ): Promise<void> {
    if (!tx.dripResolverMarker) return;

    let claimedFirst = false;
    try {
      await tx.dripResolverMarker.create({
        data: {
          purpose: 'coach_new_purchase',
          purchase_id: purchaseId,
          content_id: '-',
        },
      });
      claimedFirst = true;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const code = (err as { code?: string }).code ?? '';
      if (!/unique|UNIQUE|P2002/i.test(msg) && code !== 'P2002') {
        throw err;
      }
      this.logger.debug(
        `coach_new_purchase: marker already claimed for purchase=${purchaseId} (webhook replay)`,
      );
    }
    if (!claimedFirst) return;

    const coachId = purchaseRow.coach_user_id;
    const amountCents = purchaseRow.amount_cents ?? 0;
    const currency = purchaseRow.currency ?? 'usd';

    let buyerDisplayName = 'A new client';
    try {
      const buyer = await (tx as Prisma.TransactionClient).user.findUnique({
        where: { id: purchaseRow.client_user_id },
        select: { id: true, name: true, email: true },
      });
      if (buyer) {
        const trimmed = (buyer.name ?? '').trim();
        if (trimmed) buyerDisplayName = trimmed;
        else if (buyer.email) buyerDisplayName = buyer.email;
      }
    } catch {
      // Best-effort.
    }

    let packageName = 'your package';
    if (tx.coachPackage) {
      try {
        const pkg = await tx.coachPackage.findUnique({
          where: { id: purchaseRow.package_id },
          select: { name: true },
        });
        if (pkg?.name) packageName = pkg.name;
      } catch {
        // Best-effort.
      }
    }

    this.pendingCoachNewPurchaseAlerts.set(purchaseId, {
      coachId,
      buyerId: purchaseRow.client_user_id,
      buyerDisplayName,
      purchaseId,
      packageName,
      amountCents,
      currency,
    });
  }

  /**
   * Fire-and-forget alert dispatch for drops materialised inline at
   * checkout. MUST be called AFTER the outer $transaction commits;
   * MUST NEVER be allowed to roll back entitlement (returns void,
   * swallows errors). PR-13 wires the actual push+in-app emit behind
   * `alertHook`.
   */
  flushAlerts(purchaseId: string): void {
    const bucket = this.pendingAlerts.get(purchaseId);
    if (bucket && bucket.length > 0) {
      this.pendingAlerts.delete(purchaseId);
      for (const alert of bucket) {
        try {
          if (this.alertHook) {
            this.alertHook.enqueue(alert);
          } else {
            // PR-13 will replace this with push+in-app via NotificationsService.
            this.logger.log(
              `drip alert (no hook): drop=${alert.scheduledDropId} client=${alert.clientId} asset=${alert.assetType}`,
            );
          }
        } catch (err) {
          // Alert side-effect failure MUST NEVER bubble.
          this.logger.warn(
            `drip alert dispatch failed drop=${alert.scheduledDropId}: ${(err as Error).message}`,
          );
        }
      }
    }
    // PR-15A — also flush the COACH_NEW_PURCHASE alert on the same hook
    // so the webhook/guest path's existing flushAlerts(purchaseId) call
    // post-commit lights up both buyer (drip-released, PR-10) and coach
    // (coach-new-purchase, PR-15A) sides without a new call site.
    this.flushCoachNewPurchaseAlert(purchaseId);
  }

  // PR-16 — Refund / dispute / subscription-deleted → cancel pending drops.
  //
  // CONTRACT
  // --------
  // Single set-based UPDATE flips every NOT-YET-FIRED ScheduledDrop for the
  // given purchase to status='canceled'. The WHERE clause filters
  // status IN ('pending','due') so the call is naturally idempotent: a
  // Stripe webhook replay (or duplicate revocation path) sees zero
  // matching rows on the second pass and is a true no-op.
  //
  // We deliberately leave the following statuses ALONE:
  //   - 'fired' / 'delivered' — already shipped; can't un-deliver.
  //   - 'failed' — terminal, owned by PR-10's MAX_ATTEMPTS + COACH_ALERT path.
  //   - 'skipped' — terminal, set by future authoring tooling.
  //   - 'canceled' — already canceled (replay-safety).
  //   - 'dispatching' — a worker has already CLAIMED this row and may be
  //     mid-resolver-call. PR-10's claim is exactly-once and the resolver
  //     side-effects ride STABLE (clientPurchaseId, contentId) keys, so
  //     allowing an already-claimed dispatching row to finish does not
  //     double-deliver. We do NOT flip it — flipping would race with the
  //     dispatcher's own post-success UPDATE (which asserts
  //     status='dispatching') and could either strand the row or, worse,
  //     drop the materialised_ref stamp. Rule: cancel pending+due now,
  //     let an already-claimed dispatching row finish on its own.
  //     (See PR16_BUILD_REPORT.md.)
  //
  // TRANSACTION
  // -----------
  // Accepts an optional tx so callers (the three revocation handlers) can
  // run this INSIDE their existing $transaction — entitlement-revoke +
  // drop-cancel commit-or-rollback together. With no tx we fall back to
  // this.prisma and the cancel runs in its own implicit single-statement tx.
  //
  // CRON INTERACTION (PR-10)
  // ------------------------
  // DripDispatcherCron.findDue gates on `status IN ('pending','dispatching')`
  // (see drip-dispatcher.cron.ts:185-218); a canceled drop is excluded
  // from candidate selection AND the claim re-checks status, so a
  // mid-tick race after a cancel cannot flip a canceled row back to
  // dispatching.
  //
  // Returns the number of rows transitioned. Callers may log it; a return
  // of 0 is a valid replay no-op, not an error.
  async cancelPendingForPurchase(
    clientPurchaseId: string,
    reason: 'refund' | 'dispute' | 'subscription_canceled' | 'payment_failed',
    tx?: TxOrPrisma | Prisma.TransactionClient,
  ): Promise<number> {
    const db: { scheduledDrop: Prisma.TransactionClient['scheduledDrop'] } | undefined =
      (tx as TxOrPrisma | undefined)?.scheduledDrop
        ? (tx as TxOrPrisma)
        : this.prisma
          ? (this.prisma as unknown as TxOrPrisma)
          : undefined;
    if (!db || !db.scheduledDrop) {
      this.logger.warn(
        `cancelPendingForPurchase: no scheduledDrop client available (purchase=${clientPurchaseId}, reason=${reason}) — skipping`,
      );
      return 0;
    }
    const result = await db.scheduledDrop.updateMany({
      where: {
        client_purchase_id: clientPurchaseId,
        status: { in: ['pending', 'due'] },
      },
      data: {
        status: 'canceled',
        failure_reason: `canceled:${reason}`,
        next_retry_at: null,
        locked_at: null,
      },
    });
    if (result.count > 0) {
      this.logger.log(
        `cancelPendingForPurchase: canceled ${result.count} drop(s) for purchase=${clientPurchaseId} reason=${reason}`,
      );
    } else {
      this.logger.debug(
        `cancelPendingForPurchase: no pending/due drops for purchase=${clientPurchaseId} (replay or never-entitled) reason=${reason}`,
      );
    }
    return result.count;
  }

  /**
   * Discard alerts staged inside a rolled-back tx so a successful
   * retry doesn't double-alert. Callers invoke from their tx catch
   * block.
   */
  discardPendingAlerts(purchaseId: string): void {
    this.pendingAlerts.delete(purchaseId);
    // PR-15A — discard the coach-new-purchase bucket together with the
    // drip-released bucket so a rolled-back+retried Stripe event does
    // not double-alert. The DripResolverMarker row in the rolled-back
    // tx is gone too, so the retry's marker insert claims the alert
    // anew (correct).
    this.pendingCoachNewPurchaseAlerts.delete(purchaseId);
  }

  /**
   * PR-15A — fire-and-forget COACH_NEW_PURCHASE dispatch. Sends push +
   * in-app to the selling coach via NotificationsService. Failure-
   * isolated like flushAlerts above: a hostile push provider or
   * prisma blip MUST NEVER reach back into entitlement.
   *
   * Called from flushAlerts() so the existing post-commit hook lights
   * up both pillars without a new wiring site. Idempotency rides the
   * DripResolverMarker upsert inside the entitlement tx — by the time
   * we reach this method we are guaranteed at most one staged alert
   * per purchase, and a missing bucket is the expected no-op when the
   * marker upsert lost the race to a prior commit.
   */
  flushCoachNewPurchaseAlert(purchaseId: string): void {
    const alert = this.pendingCoachNewPurchaseAlerts.get(purchaseId);
    if (!alert) return;
    this.pendingCoachNewPurchaseAlerts.delete(purchaseId);

    if (!this.notifications) {
      this.logger.log(
        `coach_new_purchase alert (no NotificationsService wired): coach=${alert.coachId} purchase=${alert.purchaseId}`,
      );
      return;
    }

    const amountStr = formatAmount(alert.amountCents, alert.currency);
    const title = 'New purchase';
    const body =
      `${alert.buyerDisplayName} just bought ${alert.packageName}` +
      (amountStr ? ` (${amountStr})` : '');
    const payload = {
      purchase_id: alert.purchaseId,
      buyer_id: alert.buyerId,
      package_name: alert.packageName,
      amount_cents: alert.amountCents,
      currency: alert.currency,
    };
    const deep_link = `tgp://coach/purchases/${alert.purchaseId}`;

    void (async () => {
      try {
        await this.notifications!.createNotification({
          user_id: alert.coachId,
          kind: NotificationKind.COACH_NEW_PURCHASE,
          body: body.slice(0, 160),
          payload,
          deep_link,
          channel: 'inapp',
        });
      } catch (err) {
        this.logger.warn(
          `coach_new_purchase in-app row failed coach=${alert.coachId} purchase=${alert.purchaseId}: ${(err as Error).message}`,
        );
      }
      try {
        await this.notifications!.pushToUser(alert.coachId, title, body.slice(0, 160), {
          kind: NotificationKind.COACH_NEW_PURCHASE,
          purchase_id: alert.purchaseId,
        });
      } catch (err) {
        this.logger.warn(
          `coach_new_purchase push failed coach=${alert.coachId} purchase=${alert.purchaseId}: ${(err as Error).message}`,
        );
      }
      try {
        await this.notifications!.createNotification({
          user_id: alert.coachId,
          kind: NotificationKind.COACH_NEW_PURCHASE,
          body: body.slice(0, 160),
          payload,
          deep_link,
          channel: 'push',
        });
      } catch (err) {
        this.logger.warn(
          `coach_new_purchase push-row failed coach=${alert.coachId} purchase=${alert.purchaseId}: ${(err as Error).message}`,
        );
      }
    })();
  }

  // --- internal --------------------------------------------------------

  private computeFireAt(
    kind: CadenceKind,
    payload: unknown,
    purchaseTime: Date,
    now: Date,
  ): Date | null {
    switch (kind) {
      case 'immediate':
        return now;
      case 'relative_to_purchase': {
        const offset = this.readOffsetDays(payload);
        return new Date(purchaseTime.getTime() + offset * 24 * 3600 * 1000);
      }
      case 'fixed_calendar': {
        const releaseAt = this.readReleaseAt(payload);
        if (!releaseAt) return now; // malformed — treat as immediate so
                                    // the drop fires rather than dangles.
        // PR-8 documented rule: past fixed_calendar at purchase
        // counts as immediate — fire now.
        if (releaseAt.getTime() <= now.getTime()) return now;
        return releaseAt;
      }
      case 'on_completion':
      case 'on_milestone':
        // PR-11 wires the trigger; PR-9 just seeds with fire_at null.
        return null;
      default:
        // Unknown kind — leave the drop pending with no fire_at so an
        // operator notices and PR-10's executor doesn't blindly fire.
        return null;
    }
  }

  private readOffsetDays(payload: unknown): number {
    if (
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { offset_days?: unknown }).offset_days === 'number'
    ) {
      const v = (payload as { offset_days: number }).offset_days;
      return Number.isFinite(v) && v >= 0 ? v : 0;
    }
    return 0;
  }

  private readReleaseAt(payload: unknown): Date | null {
    if (
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { release_at?: unknown }).release_at === 'string'
    ) {
      const raw = (payload as { release_at: string }).release_at;
      const ms = Date.parse(raw);
      if (!Number.isNaN(ms)) return new Date(ms);
    }
    return null;
  }
}

// PR-15A helper — format integer minor-unit amounts as a human string
// for the coach alert body. Currency is the lowercase ISO code stored on
// ClientPurchase.currency. Falls back to a bare-number representation if
// the locale/currency combo throws (rare for ISO codes Stripe accepts).
function formatAmount(amountCents: number, currency: string): string {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return '';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${(currency || 'usd').toUpperCase()}`;
  }
}
