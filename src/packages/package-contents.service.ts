import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CoachPackageContent, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma.service';
import { PackagesService } from './packages.service';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';
import {
  CADENCE_PAYLOAD_SCHEMAS,
  CreateContentSchema,
  PatchContentSchema,
  PushToExistingSchema,
  PushToExistingResponseSchema,
  ReorderContentSchema,
  type AssetType,
  type CadenceKind,
  type PushToExistingResponse,
} from './package-contents.dto';
import { computeFireAt as sharedComputeFireAt } from './drip-fire-at';
import { AuditService } from '../audit/audit.service';

// Prisma's `TransactionClient` minus `$transaction` / `$connect` / etc.
// Used as the in-transaction handle we thread through the read+write
// helpers.
type Tx = Prisma.TransactionClient;

// Stable namespace id for the per-package display_order advisory lock.
// pg_advisory_xact_lock(int4, int4) is keyed on TWO 32-bit ints — using a
// dedicated namespace (the first arg) keeps these locks from colliding
// with any future advisory-lock user in the schema. Picked an arbitrary
// constant; the only requirement is that it be unique across the codebase.
const ADVISORY_LOCK_NAMESPACE_PKG_CONTENT_ORDER = 0x70_6b_67_63; // ASCII 'pkgc'

// PR-8 — Coach package CONTENTS authoring service.
//
// Writes CoachPackageContent rows for a (sellable) package; this is what
// PR-9's fan-out reads at checkout to materialise per-buyer
// ScheduledDrop rows. The service owns:
//   1) zod validation per cadence_kind (discriminated union, strict
//      unknown-key rejection),
//   2) asset-ownership validation — REUSING the same coach-scoped lookups
//      the PR-7 AssignableAssetResolver implementations use; we do not
//      mint new ownership predicates,
//   3) the auto_message contract from PR-7 (resolver reads body from
//      displayCaption/displayTitle, so we require at least one to be
//      non-empty at attach time),
//   4) IDOR + sub-coach scope via PackagesService (resolveEffectiveCoachId
//      + requireOwnedPackage),
//   5) display_order integrity — append to max+1; reorder is atomic.
//
// Soft-delete only: removed_at set; rows are never hard-deleted because
// PR-9's snapshots reference them by id and existing buyers' ScheduledDrops
// must be unaffected by authoring edits.

@Injectable()
export class PackageContentsService {
  private readonly logger = new Logger(PackageContentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly packages: PackagesService,
    private readonly subCoachScope: SubCoachScopeService,
    private readonly audit: AuditService,
  ) {}

  // ── public API ─────────────────────────────────────────────────────────

  async listForPackage(
    coachUserId: string,
    packageId: string,
  ): Promise<CoachPackageContent[]> {
    await this.packages.requireOwnedPackage(coachUserId, packageId);
    return this.prisma.coachPackageContent.findMany({
      where: { package_id: packageId, removed_at: null },
      orderBy: { display_order: 'asc' },
    });
  }

  // PR-18 B2 — attach now takes BOTH the raw actor id AND the resolved
  // tenant (head) coach id. The controller passes:
  //   actorUserId   = req.user.id (the literal caller — sub OR head)
  //   tenantCoachId = await resolveEffectiveCoachId(req.user.id)
  //                   (head coach id; for a head coach this == actorUserId)
  //
  // Pre-PR-18 the controller passed ONLY the promoted (head) id, so the
  // service could not tell a sub-coach apart from the head coach and a
  // sub-coach could attach a head-owned asset without proving sub-coach
  // scope (IDOR / privilege escalation, #5). We now run
  // assertActorCanAttachAsset BEFORE the ownership check, and re-check it
  // under the display-order lock just before the insert (TOCTOU).
  async attach(
    actorUserId: string,
    tenantCoachId: string,
    packageId: string,
    body: unknown,
  ): Promise<CoachPackageContent> {
    await this.packages.requireOwnedPackage(tenantCoachId, packageId);
    const input = this.parseCreate(body);

    // (PR-18 B2, #5) Actor-scope guard. A sub-coach must prove they belong
    // to this head-coach team (and, for client-bound assets, that they can
    // access the bound client) BEFORE we even reveal whether the asset
    // exists. Throws NotFoundException on any scope failure so we do not
    // leak existence across scopes.
    await this.assertActorCanAttachAsset(
      actorUserId,
      tenantCoachId,
      input.asset_type,
      input,
    );

    // Asset-ownership validation reuses the exact same coach-scoped row
    // lookups the PR-7 resolvers consume at materialise time. The intent
    // is "if PR-9 would later refuse this asset, refuse it at authoring
    // time too" — so a coach can't save a package that will fail at
    // checkout. Workout/media branches add `archived_at`/`kind` filters
    // not present in the PR-7 resolvers — a stricter superset, intentional
    // (refuse-early at authoring is the right call). meal_plan is
    // byte-identical to MealPlanAssetResolver.assertPlanOwnedByTenant.
    // This is an ADDITIONAL gate (not a replacement) on top of the actor
    // scope check above (brief item 1.4).
    await this.assertAssetOwnedByCoach(tenantCoachId, input.asset_type, input);

    // display_order race fix: read max + INSERT must be serialised per
    // package, otherwise two concurrent attaches both read max=N and
    // both INSERT N+1. We take a per-package
    // pg_advisory_xact_lock at the top of the tx; concurrent attaches on
    // the same package serialise; concurrent attaches on different
    // packages run in parallel. xact-scoped → auto-released on commit
    // or rollback, no session-leak risk.
    return this.prisma.$transaction(async (tx) => {
      await this.acquirePackageOrderLock(tx, packageId);

      // (PR-18 B2, brief item 1.6) Re-check actor scope just before the
      // insert: a sub-coach assignment can be revoked between the initial
      // guard and the insert. The scope check is stricter than the
      // ownership check, so re-running it here closes the TOCTOU window
      // inside the same display-order transaction.
      await this.assertActorCanAttachAsset(
        actorUserId,
        tenantCoachId,
        input.asset_type,
        input,
      );

      const display_order =
        input.display_order ?? (await this.nextDisplayOrder(tx, packageId));

      return tx.coachPackageContent.create({
        data: {
          package_id: packageId,
          asset_type: input.asset_type,
          asset_id: input.asset_id,
          asset_revision_id: input.asset_revision_id ?? null,
          display_order,
          cadence_kind: input.cadence_kind,
          // zod has already validated the inner shape; storing as Prisma
          // expects a plain object for a Json column.
          cadence_payload: input.cadence_payload as object,
          display_title: input.display_title ?? null,
          display_caption: input.display_caption ?? null,
        },
      });
    });
  }

  async patch(
    coachUserId: string,
    packageId: string,
    contentId: string,
    body: unknown,
  ): Promise<CoachPackageContent> {
    await this.packages.requireOwnedPackage(coachUserId, packageId);
    const input = this.parsePatch(body);

    // Cadence is all-or-nothing on patch. If either side is touched, the
    // OTHER side must also be present so we always validate the pair.
    let cadence:
      | { cadence_kind: CadenceKind; cadence_payload: object }
      | undefined;
    if (input.cadence_kind !== undefined || input.cadence_payload !== undefined) {
      if (input.cadence_kind === undefined || input.cadence_payload === undefined) {
        throw new BadRequestException({
          error: 'CADENCE_PAIR_REQUIRED',
          message:
            'cadence_kind and cadence_payload must be provided together when changing cadence',
        });
      }
      const schema = CADENCE_PAYLOAD_SCHEMAS[input.cadence_kind];
      const parsed = schema.safeParse(input.cadence_payload);
      if (!parsed.success) {
        throw this.zodToBadRequest(parsed.error, 'CADENCE_INVALID');
      }
      cadence = {
        cadence_kind: input.cadence_kind,
        cadence_payload: parsed.data as object,
      };
    }

    const buildData = (row: CoachPackageContent): Record<string, unknown> => {
      // auto_message body contract — if patching titles/captions for an
      // auto_message row, ensure the row STILL has a non-empty body after
      // the patch. (PR-7's AutoMessageAssetResolver reads body from
      // displayCaption/displayTitle and throws if both are empty.) Computed
      // against the row we just read INSIDE the lock so a concurrent patch
      // that already cleared the body can't slip through.
      if (row.asset_type === 'auto_message') {
        const nextTitle =
          input.display_title !== undefined
            ? input.display_title
            : row.display_title;
        const nextCaption =
          input.display_caption !== undefined
            ? input.display_caption
            : row.display_caption;
        this.assertAutoMessageBody({
          display_title: nextTitle,
          display_caption: nextCaption,
        });
      }
      const data: Record<string, unknown> = {};
      if (input.display_order !== undefined)
        data.display_order = input.display_order;
      if (input.display_title !== undefined)
        data.display_title = input.display_title;
      if (input.display_caption !== undefined)
        data.display_caption = input.display_caption;
      if (input.asset_revision_id !== undefined)
        data.asset_revision_id = input.asset_revision_id;
      if (cadence) {
        data.cadence_kind = cadence.cadence_kind;
        data.cadence_payload = cadence.cadence_payload;
      }
      return data;
    };

    // Display_order race fix (P2-c, R2 audit): when the patch body changes
    // `display_order`, the read+write window MUST be serialised against
    // every other display_order mutator (attach / reorder / other patch)
    // on the same package — otherwise the same TOCTOU class as P2-a/P2-b
    // is back. We take the per-package pg_advisory_xact_lock and validate
    // duplicate-rejection INSIDE the tx. Cheap title/cadence-only patches
    // skip the tx so we don't pay the lock cost when there's no risk.
    if (input.display_order === undefined) {
      const row = await this.requireOwnedContent(packageId, contentId);
      return this.prisma.coachPackageContent.update({
        where: { id: contentId },
        data: buildData(row),
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await this.acquirePackageOrderLock(tx, packageId);

      // Re-fetch under the lock so we see a consistent view of the
      // package: same filter as requireOwnedContent (removed_at IS NULL)
      // so patch still 404s on a soft-deleted row.
      const row = await tx.coachPackageContent.findFirst({
        where: { id: contentId, package_id: packageId, removed_at: null },
      });
      if (!row) {
        throw new NotFoundException({
          error: 'CONTENT_NOT_FOUND',
          message: `No content with id ${contentId} on package ${packageId}`,
        });
      }

      // PR-18 B2 (PR-8 swap-aware patch). Moving a row to an order held by
      // exactly ONE other active row used to dead-end with
      // DISPLAY_ORDER_TAKEN, forcing the editor onto /reorder for a simple
      // two-row swap. We now swap in place under the lock: the row that
      // currently holds the target order takes OUR old order, then we take
      // the requested order. Net effect is a transposition — still a
      // bijection over 0..n-1, so no gaps and no duplicates are created.
      //
      // No-op when the patch sets the row to its own current order
      // (input === row.display_order): skip the swap entirely.
      //
      // We keep the hard reject for AMBIGUOUS states (somehow >1 active
      // row already holds the target order — a corrupt set we must not
      // "fix" by guessing). Out-of-range orders are rejected by zod
      // (display_order: int >= 0) before we get here, so a swap never
      // produces a negative order.
      //
      // EMPTY-target reject (PR-18 B2, item 3): the active display_order
      // set is a bijection over 0..n-1. A single-row patch can only ever
      // be a transposition (swap) that keeps that bijection intact. If
      // the requested order is held by NO active row, moving there would
      // tear a hole in the sequence (e.g. 0,1,2 -> 1,2,5), which the brief
      // forbids. Such multi-row moves belong on /reorder, which rebuilds
      // the whole sequence atomically. So we reject empty targets here
      // rather than creating a gap.
      if (input.display_order !== row.display_order) {
        const holders = await tx.coachPackageContent.findMany({
          where: {
            package_id: packageId,
            removed_at: null,
            display_order: input.display_order,
            id: { not: contentId },
          },
          select: { id: true },
        });

        if (holders.length > 1) {
          // Corrupt/ambiguous: refuse rather than silently mangle. Use
          // /reorder to rebuild the whole sequence atomically.
          throw new BadRequestException({
            error: 'DISPLAY_ORDER_TAKEN',
            message: `display_order ${input.display_order} is held by multiple content rows on this package; use the /reorder endpoint to move multiple rows atomically`,
          });
        }

        if (holders.length === 0) {
          // No active row holds the target order -> a plain move here
          // would leave a gap (and likely an out-of-range order),
          // breaking the 0..n-1 bijection. Reject; the caller should use
          // the /reorder endpoint for multi-row moves.
          throw new BadRequestException({
            error: 'DISPLAY_ORDER_OUT_OF_RANGE',
            message: `display_order ${input.display_order} is not held by any active content row on this package; single-row patch only swaps with an existing row — use the /reorder endpoint to move multiple rows atomically`,
          });
        }

        if (holders.length === 1) {
          // Single-row collision → swap. Move the holder into our old slot
          // FIRST so the unique (active) display_order set is never
          // momentarily violated, then fall through to set our row to the
          // requested order via the update below. Both writes are in the
          // same tx under the lock, so the pair commits or rolls back
          // together. ScheduledDrop rows are never touched (snapshot
          // invariant) — we only move active CoachPackageContent rows.
          await tx.coachPackageContent.update({
            where: { id: holders[0].id },
            data: { display_order: row.display_order },
          });
        }
      }

      return tx.coachPackageContent.update({
        where: { id: contentId },
        data: buildData(row),
      });
    });
  }

  // PR-18 B2 (PR-8 display_order compaction). Soft-deleting a middle row
  // used to leave a permanent gap in the active display_order sequence
  // (append uses max+1, so the gap is never reused). We now compact the
  // ACTIVE rows so they stay a contiguous 0..n-1 after a delete.
  //
  // Concurrency: the mark-removed + compaction run together inside the
  // EXISTING per-package display-order advisory lock so they serialise
  // against attach/reorder/patch on the same package (otherwise a
  // concurrent attach reading max+1 could collide with the orders we
  // decrement). The lock is xact-scoped — released on commit/rollback.
  //
  // Invariants:
  //   - Idempotent: a row already removed (whether before we took the
  //     lock or by a racing delete that committed first) returns as-is
  //     and performs NO compaction — the gap it left was already closed
  //     by whoever removed it.
  //   - We never mutate removed rows and never resurrect content.
  //   - We do NOT touch ScheduledDrop rows: PR-9 snapshots reference
  //     content by id, so buyers' already-materialised drops keep their
  //     own (snapshotted) order regardless of authoring-side compaction.
  async softDelete(
    coachUserId: string,
    packageId: string,
    contentId: string,
  ): Promise<CoachPackageContent> {
    await this.packages.requireOwnedPackage(coachUserId, packageId);
    // Cheap pre-check OUTSIDE the lock: 404 a genuinely unknown id, and
    // short-circuit an already-removed row without paying the lock cost.
    // We look it up directly (not via requireOwnedContent, which filters
    // removed_at: null for patch safety) so a second DELETE on the same
    // id is a no-op rather than a 404.
    const existing = await this.prisma.coachPackageContent.findFirst({
      where: { id: contentId, package_id: packageId },
    });
    if (!existing) {
      throw new NotFoundException({
        error: 'CONTENT_NOT_FOUND',
        message: `No content with id ${contentId} on package ${packageId}`,
      });
    }
    if (existing.removed_at) return existing;

    return this.prisma.$transaction(async (tx) => {
      await this.acquirePackageOrderLock(tx, packageId);

      // Re-read under the lock so a concurrent delete that committed
      // between the pre-check and the lock is observed: if it's now
      // removed, return it idempotently and do NOT compact again.
      const row = await tx.coachPackageContent.findFirst({
        where: { id: contentId, package_id: packageId },
      });
      if (!row) {
        throw new NotFoundException({
          error: 'CONTENT_NOT_FOUND',
          message: `No content with id ${contentId} on package ${packageId}`,
        });
      }
      if (row.removed_at) return row;

      const removedOrder = row.display_order;
      const updated = await tx.coachPackageContent.update({
        where: { id: contentId },
        data: { removed_at: new Date() },
      });

      // Compact: every ACTIVE (non-removed) row that sat AFTER the removed
      // row shifts down by one, closing the gap. updateMany is a single
      // set-based statement under the lock — no per-row N+1. We scope to
      // package_id + removed_at: null so removed rows and other packages
      // are untouched, and never produce a negative order (we only
      // decrement orders strictly greater than removedOrder).
      await tx.coachPackageContent.updateMany({
        where: {
          package_id: packageId,
          removed_at: null,
          display_order: { gt: removedOrder },
        },
        data: { display_order: { decrement: 1 } },
      });

      return updated;
    });
  }

  // PR-17A — "Push to existing" (decision #2). Explicit, opt-in
  // propagation of a content edit to every CURRENT buyer's
  // UNDELIVERED drops. The default behavior remains snapshot-at-purchase
  // (only NEW purchases get the new config — unchanged here). This
  // method is the ADDITIVE escape hatch a coach invokes consciously.
  //
  // Invariants enforced inline (see PR17_BRIEF.md §A1/A2):
  //   1. Ownership + sub-coach scope via PackagesService.requireOwnedPackage
  //      (cross-coach → 404, no leak); the controller has already
  //      resolved the effective coach id via resolveEffectiveCoachId.
  //   2. The content's CURRENT cadence config is re-validated with
  //      the same zod discriminated union PR-8 uses BEFORE any write.
  //      A push must never produce an invalid schedule on a live drop.
  //   3. ONLY status='pending' drops are touched. Every other status
  //      (fired/due/dispatching/failed/canceled/skipped) is left
  //      alone — the buyer already received it, a worker is mid-
  //      delivery on it, or it terminally moved off pending.
  //   4. fire_at is recomputed per BUYER'S OWN anchor (purchase
  //      created_at — completion/milestone anchors collapse to NULL
  //      for those kinds, see drip-fire-at.ts). Two buyers with
  //      different purchase dates get DIFFERENT recomputed fire_at
  //      for a relative_to_purchase cadence.
  //   5. Whole push runs in one $transaction — all pending drops
  //      update or none. The per-package display_order advisory lock
  //      is acquired even though we don't touch display_order: a
  //      concurrent attach/reorder may be mid-flight and we want the
  //      same serialization domain for content edits that touch the
  //      same package's snapshot surface.
  //   6. Idempotent: the recompute is deterministic from
  //      (content snapshot, buyer anchor, kind) — pushing the same
  //      edit twice yields the same end state.
  //
  // Returns { drops_updated, buyers_affected, skipped_delivered }.
  // skipped_delivered counts every NON-pending drop for this content
  // across all buyers; the mobile UI surfaces it as "M items already
  // delivered were left unchanged."
  async pushToExisting(
    coachUserId: string,
    packageId: string,
    contentId: string,
    body: unknown,
  ): Promise<PushToExistingResponse> {
    await this.packages.requireOwnedPackage(coachUserId, packageId);
    const parsed = PushToExistingSchema.safeParse(body);
    if (!parsed.success) {
      throw this.zodToBadRequest(parsed.error, 'PUSH_INVALID');
    }

    // requireOwnedContent enforces removed_at IS NULL — pushing a
    // soft-deleted content row would be incoherent (PR-9's snapshots
    // still reference it by id but the coach can no longer see it).
    const content = await this.requireOwnedContent(packageId, contentId);

    // Re-validate cadence with the SAME zod-per-cadence discriminated
    // union the attach/patch paths use. A push must not write an invalid
    // schedule onto live drops, even if the row got into an invalid state
    // by some other path. PR-8's attach/patch guarantee this is a no-op
    // on a healthy row; the check is defense-in-depth.
    const cadenceKind = content.cadence_kind as CadenceKind;
    const cadenceSchema = CADENCE_PAYLOAD_SCHEMAS[cadenceKind];
    if (!cadenceSchema) {
      throw new BadRequestException({
        error: 'CADENCE_INVALID',
        message: `unknown cadence_kind on content ${contentId}: ${cadenceKind}`,
      });
    }
    const cadenceParsed = cadenceSchema.safeParse(content.cadence_payload);
    if (!cadenceParsed.success) {
      throw this.zodToBadRequest(cadenceParsed.error, 'CADENCE_INVALID');
    }

    // Read the unrestricted summary BEFORE the tx so the
    // skipped_delivered count is observable even when zero pending
    // drops exist. (A pure-pending updateMany inside the tx wouldn't
    // give us that figure.) The COUNT is a snapshot — a buyer who
    // entitlement-flips in the window between this count and the
    // update is fine: their fan-out seeds with the LATEST content
    // snapshot anyway, so their freshly-seeded pending drop already
    // reflects the edit.
    const allDropsForContent = await this.prisma.scheduledDrop.findMany({
      where: { content_id: contentId },
      select: {
        id: true,
        client_purchase_id: true,
        status: true,
      },
    });
    const pendingIds = allDropsForContent
      .filter((d) => d.status === 'pending')
      .map((d) => d.id);
    const skipped_delivered = allDropsForContent.length - pendingIds.length;

    if (pendingIds.length === 0) {
      // No drops to touch — the push is a no-op but the call still
      // succeeds so the mobile UI can show the skipped-delivered
      // figure for context. No audit entry: nothing mutated.
      return PushToExistingResponseSchema.parse({
        drops_updated: 0,
        buyers_affected: 0,
        skipped_delivered,
      });
    }

    // Defensive cap. ScheduledDrop count for a single content is
    // bounded by the number of active buyers; we don't expect this
    // to be huge in v1, but a single tx with a runaway buyer count
    // (e.g. a content row attached to a high-volume legacy package)
    // could hold the per-package lock too long. Process up to this
    // cap per call; over the cap we refuse with a clear error so an
    // operator can split the push manually rather than have the
    // request timeout silently. The brief calls for a defensive cap.
    const DEFENSIVE_PUSH_CAP = 10_000;
    if (pendingIds.length > DEFENSIVE_PUSH_CAP) {
      throw new BadRequestException({
        error: 'PUSH_TOO_LARGE',
        message: `${pendingIds.length} pending drops exceeds the per-push cap of ${DEFENSIVE_PUSH_CAP}; contact operator support to split the push`,
      });
    }

    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      // Reuse PR-8's per-package advisory lock so a concurrent
      // attach/reorder/patch on the same package serializes behind us.
      // We don't change display_order, but PR-8's invariant is that
      // every snapshot-surface mutation on a package goes through the
      // same lock so we never observe a torn view. Cheap on packages
      // with no concurrent edits.
      await this.acquirePackageOrderLock(tx, packageId);

      // Re-fetch the content INSIDE the lock so we see a consistent
      // view (a concurrent patch may have advanced the row since we
      // validated cadence above). The recompute uses THIS snapshot.
      const liveContent = await tx.coachPackageContent.findFirst({
        where: { id: contentId, package_id: packageId, removed_at: null },
      });
      if (!liveContent) {
        throw new NotFoundException({
          error: 'CONTENT_NOT_FOUND',
          message: `No content with id ${contentId} on package ${packageId}`,
        });
      }
      // Re-validate cadence on the locked snapshot. Catches the case
      // where a concurrent patch moved the row to an invalid state
      // (it shouldn't — patch validates — but defense in depth).
      const liveKind = liveContent.cadence_kind as CadenceKind;
      const liveCadenceSchema = CADENCE_PAYLOAD_SCHEMAS[liveKind];
      if (!liveCadenceSchema) {
        throw new BadRequestException({
          error: 'CADENCE_INVALID',
          message: `unknown cadence_kind on content ${contentId}: ${liveKind}`,
        });
      }
      const liveCadenceParsed = liveCadenceSchema.safeParse(
        liveContent.cadence_payload,
      );
      if (!liveCadenceParsed.success) {
        throw this.zodToBadRequest(liveCadenceParsed.error, 'CADENCE_INVALID');
      }

      // Batch fetch the pending drops + their purchase anchors in ONE
      // query each (no N+1). drops keyed by id; purchases keyed by id.
      const drops = await tx.scheduledDrop.findMany({
        where: {
          content_id: contentId,
          status: 'pending',
          id: { in: pendingIds },
        },
        select: {
          id: true,
          client_purchase_id: true,
          status: true,
        },
      });
      if (drops.length === 0) {
        // A concurrent dispatcher tick flipped every pending drop to
        // dispatching/fired between our pre-tx count and the locked
        // read. That's correct behavior — the push left them alone.
        return { drops_updated: 0, buyers_affected: 0 };
      }
      const purchaseIds = Array.from(
        new Set(drops.map((d) => d.client_purchase_id)),
      );
      const purchases = await tx.clientPurchase.findMany({
        where: { id: { in: purchaseIds } },
        select: { id: true, created_at: true },
      });
      const purchaseAnchor = new Map<string, Date>();
      for (const p of purchases) {
        purchaseAnchor.set(p.id, p.created_at ?? now);
      }

      // Compute the per-drop recompute IN MEMORY, then issue per-row
      // UPDATEs INSIDE the tx (Prisma has no set-based UPDATE that can
      // assign a per-row computed value short of raw SQL). The tx is
      // the atomicity boundary — any per-row failure rolls every
      // pending drop back to its prior state. Recompute is
      // deterministic from (snapshot, anchor) so a second push
      // produces identical writes (idempotent).
      const sharedNow = now;
      let dropsUpdated = 0;
      const buyersTouched = new Set<string>();
      for (const drop of drops) {
        const anchor = purchaseAnchor.get(drop.client_purchase_id) ?? sharedNow;
        // CRITICAL: anchor is the BUYER's own purchase time, NOT the
        // coach's now. Two buyers with different purchase dates get
        // different recomputed fire_at for a relative cadence.
        const newFireAt = sharedComputeFireAt(
          liveContent.cadence_kind,
          liveContent.cadence_payload,
          anchor,
          sharedNow,
        );
        // Re-assert status='pending' in the WHERE so a sibling
        // dispatcher claim mid-tx can never flip a row we believed
        // was pending. updateMany honors the composite filter:
        // count===1 means we won the row; count===0 means the
        // dispatcher claimed it (status→'dispatching') between our
        // inner findMany and this write. On count===0 we throw so the
        // ENTIRE transaction rolls back — the dispatch wins, no partial
        // push leaks, and the coach retries from a clean snapshot.
        // NEVER pre-check then update separately (that re-opens the
        // race); the filtered updateMany is the atomic check-and-set.
        const updated = await tx.scheduledDrop.updateMany({
          where: { id: drop.id, status: 'pending' },
          data: {
            display_title: liveContent.display_title,
            display_caption: liveContent.display_caption,
            asset_revision_id: liveContent.asset_revision_id,
            asset_type: liveContent.asset_type,
            cadence_kind: liveContent.cadence_kind,
            cadence_payload: liveContent.cadence_payload as Prisma.InputJsonValue,
            fire_at: newFireAt,
          },
        });
        if (updated.count !== 1) {
          throw new ConflictException(
            'Drop claimed by dispatcher; tx rolled back',
          );
        }
        dropsUpdated += 1;
        buyersTouched.add(drop.client_purchase_id);
      }

      return {
        drops_updated: dropsUpdated,
        buyers_affected: buyersTouched.size,
      };
    });

    this.logger.log(
      `pushToExisting: package=${packageId} content=${contentId} drops_updated=${result.drops_updated} buyers_affected=${result.buyers_affected} skipped_delivered=${skipped_delivered}`,
    );

    // Durable audit trail for a high-value bulk coach mutation. Written
    // AFTER the $transaction commits, so a rolled-back push (e.g. F1
    // dispatcher-claim ConflictException) never records a success entry.
    // Audit failure must NOT surface as a 500 — AuditService.write already
    // swallows internally, but we wrap defensively so a future change to
    // its contract can never break the push response.
    try {
      await this.audit.write({
        action: 'package.push_to_existing_drops',
        actorId: coachUserId,
        tenantCoachId: coachUserId,
        targetType: 'coach_package_content',
        targetId: contentId,
        metadata: {
          packageId,
          contentId,
          dropsUpdated: result.drops_updated,
          buyersAffected: result.buyers_affected,
          skippedDelivered: skipped_delivered,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`pushToExisting audit write failed: ${msg}`);
    }

    return PushToExistingResponseSchema.parse({
      drops_updated: result.drops_updated,
      buyers_affected: result.buyers_affected,
      skipped_delivered,
    });
  }

  // Atomic reorder. The caller MUST supply exactly the current set of
  // non-removed content_ids for the package (any extra / missing id is
  // a 400 — surfaces editor/server divergence rather than silently
  // dropping rows). display_order is set to the array index.
  //
  // Concurrency: the parity read AND the bulk update both run inside the
  // SAME interactive $transaction with a per-package
  // pg_advisory_xact_lock at the top. Without the lock, a concurrent
  // `attach` could land between the parity read and the bulk update,
  // adding a row at max+1 that then collides with a display_order the
  // reorder is about to assign. The lock guarantees attach/reorder/
  // softDelete on the same package serialise.
  async reorder(
    coachUserId: string,
    packageId: string,
    body: unknown,
  ): Promise<CoachPackageContent[]> {
    await this.packages.requireOwnedPackage(coachUserId, packageId);
    const parsed = ReorderContentSchema.safeParse(body);
    if (!parsed.success) {
      throw this.zodToBadRequest(parsed.error, 'REORDER_INVALID');
    }
    const { content_ids } = parsed.data;
    if (new Set(content_ids).size !== content_ids.length) {
      throw new BadRequestException({
        error: 'REORDER_INVALID',
        message: 'content_ids contains duplicates',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await this.acquirePackageOrderLock(tx, packageId);

      // Parity read INSIDE the tx so it sees a consistent view: any
      // concurrent attach on this package is now serialised behind us.
      const current = await tx.coachPackageContent.findMany({
        where: { package_id: packageId, removed_at: null },
        select: { id: true },
      });
      const currentIds = new Set(current.map((r) => r.id));
      const incoming = new Set(content_ids);
      if (currentIds.size !== incoming.size) {
        throw new BadRequestException({
          error: 'REORDER_INVALID',
          message:
            'content_ids must include every non-removed content for this package',
        });
      }
      for (const id of currentIds) {
        if (!incoming.has(id)) {
          throw new BadRequestException({
            error: 'REORDER_INVALID',
            message: `content_ids missing existing content ${id}`,
          });
        }
      }
      for (const id of incoming) {
        if (!currentIds.has(id)) {
          throw new BadRequestException({
            error: 'REORDER_INVALID',
            message: `content_ids contains unknown content ${id}`,
          });
        }
      }
      // Single tx; one update per row. Tiny N (an editor list); cheap.
      for (let idx = 0; idx < content_ids.length; idx++) {
        await tx.coachPackageContent.update({
          where: { id: content_ids[idx] },
          data: { display_order: idx },
        });
      }
    });

    return this.prisma.coachPackageContent.findMany({
      where: { package_id: packageId, removed_at: null },
      orderBy: { display_order: 'asc' },
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  private parseCreate(body: unknown): {
    asset_type: AssetType;
    asset_id: string;
    asset_revision_id?: string | null;
    display_order?: number;
    display_title?: string | null;
    display_caption?: string | null;
    cadence_kind: CadenceKind;
    cadence_payload: unknown;
  } {
    const parsed = CreateContentSchema.safeParse(body);
    if (!parsed.success) {
      throw this.zodToBadRequest(parsed.error, 'CONTENT_INVALID');
    }
    const data = parsed.data as {
      asset_type: AssetType;
      asset_id: string;
      asset_revision_id?: string | null;
      display_order?: number;
      display_title?: string | null;
      display_caption?: string | null;
      cadence_kind: CadenceKind;
      cadence_payload: unknown;
    };
    // auto_message contract from PR-7 — at attach time, require a non-empty
    // body source. The resolver reads from displayCaption (preferred) /
    // displayTitle (fallback) and throws AutoMessageBodyMissingError if
    // both are empty. We catch the same error class here so the package
    // can't be saved in a state PR-9 would refuse.
    if (data.asset_type === 'auto_message') {
      this.assertAutoMessageBody({
        display_title: data.display_title ?? null,
        display_caption: data.display_caption ?? null,
      });
    }
    return data;
  }

  private parsePatch(body: unknown): {
    display_order?: number;
    display_title?: string | null;
    display_caption?: string | null;
    asset_revision_id?: string | null;
    cadence_kind?: CadenceKind;
    cadence_payload?: unknown;
  } {
    const parsed = PatchContentSchema.safeParse(body);
    if (!parsed.success) {
      throw this.zodToBadRequest(parsed.error, 'CONTENT_INVALID');
    }
    return parsed.data;
  }

  // PR-7-aligned auto_message contract: the resolver
  // (auto-message.resolver.ts:66-69) reads `(displayCaption ?? displayTitle
  // ?? '').trim()` and throws AutoMessageBodyMissingError on empty. We
  // mirror exactly that rule at attach/patch time so an auto_message row
  // cannot be saved in a state that would later fail in PR-10.
  private assertAutoMessageBody(input: {
    display_title: string | null | undefined;
    display_caption: string | null | undefined;
  }): void {
    const body = (input.display_caption ?? input.display_title ?? '').trim();
    if (!body) {
      throw new BadRequestException({
        error: 'AUTO_MESSAGE_BODY_REQUIRED',
        message:
          'auto_message requires display_caption (preferred) or display_title to be non-empty (matches PR-7 AutoMessageAssetResolver body contract)',
      });
    }
  }

  // Looks up a content row for mutation. Filters `removed_at: null` so
  // `patch` cannot mutate a soft-deleted row (e.g. resurrect it implicitly
  // by editing a field). softDelete on an already-removed row is handled
  // separately — see softDelete() which short-circuits idempotently and
  // therefore does NOT call this helper.
  private async requireOwnedContent(
    packageId: string,
    contentId: string,
  ): Promise<CoachPackageContent> {
    const row = await this.prisma.coachPackageContent.findFirst({
      where: { id: contentId, package_id: packageId, removed_at: null },
    });
    if (!row) {
      throw new NotFoundException({
        error: 'CONTENT_NOT_FOUND',
        message: `No content with id ${contentId} on package ${packageId}`,
      });
    }
    return row;
  }

  // Always called from inside the per-package advisory lock, so the
  // read+write window cannot race against another attach/reorder.
  private async nextDisplayOrder(
    db: Tx,
    packageId: string,
  ): Promise<number> {
    const tail = await db.coachPackageContent.findFirst({
      where: { package_id: packageId, removed_at: null },
      orderBy: { display_order: 'desc' },
      select: { display_order: true },
    });
    return tail ? tail.display_order + 1 : 0;
  }

  // Per-package transaction-scoped advisory lock used to serialise every
  // mutation that reads or writes `display_order` (attach/reorder). xact
  // scope means the lock is auto-released on commit OR rollback — there
  // is no session-leak risk and we never need an explicit unlock.
  //
  // The lock is keyed on (NAMESPACE, hashtext(package_id)). Postgres
  // hashtext is stable and well-distributed; collisions only matter for
  // two DIFFERENT packages that happen to hash to the same int4, in
  // which case they would briefly serialise — correct, just a slight
  // performance cost on a vanishing chance.
  //
  // The query uses parameter binding so packageId is never interpolated
  // into raw SQL.
  private async acquirePackageOrderLock(
    db: Tx,
    packageId: string,
  ): Promise<void> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE_PKG_CONTENT_ORDER}::int4, hashtext(${packageId}))`;
  }

  // ── PR-18 B2 — sub-coach fork-on-attach guard (#5 IDOR) ──────────────
  //
  // Enforces, BEFORE asset-ownership and before we leak whether the asset
  // exists, that the ACTOR (the literal caller) is authorised to attach
  // under `tenantCoachId`:
  //
  //   - Head coach actor (getHeadCoachIdForSubCoach === null): the
  //     downstream tenant id IS the actor's own id; the existing
  //     assertAssetOwnedByCoach(tenantCoachId, …) ownership check is
  //     sufficient. We still assert actorUserId === tenantCoachId as a
  //     belt-and-braces invariant (the controller resolves tenantCoachId
  //     from the SAME actorUserId, so for a head coach they must match).
  //
  //   - Sub-coach actor (getHeadCoachIdForSubCoach === some head id): the
  //     sub-coach must belong to THIS head-coach team, i.e.
  //     getHeadCoachIdForSubCoach(actorUserId) === tenantCoachId. We do
  //     NOT trust raw User.coach_id (brief item 1.3) — we route through
  //     SubCoachScopeService, the single source of truth. For client-bound
  //     assets we additionally require canAccessClient(actor, clientId);
  //     for global coach media (no client dimension) belonging to the head
  //     team is the default-safe allow (brief item 1.3).
  //
  // ANY failure throws NotFoundException with ASSET_NOT_FOUND so we never
  // leak existence across scopes (brief item 1.5). Called once up-front and
  // again under the display-order lock (TOCTOU, brief item 1.6).
  private async assertActorCanAttachAsset(
    actorUserId: string,
    tenantCoachId: string,
    assetType: AssetType,
    input: { asset_id: string },
  ): Promise<void> {
    const assetNotFound = () =>
      new NotFoundException({
        error: 'ASSET_NOT_FOUND',
        message: `No ${assetType} asset ${input.asset_id} owned by this coach`,
      });

    const headOfActor =
      await this.subCoachScope.getHeadCoachIdForSubCoach(actorUserId);

    if (headOfActor === null) {
      // Head-coach (or non-sub) actor. The controller resolves
      // tenantCoachId from this same actor, so a head coach acting on
      // their own tenant must satisfy actor === tenant. A mismatch means
      // the caller is acting under a tenant that is NOT their own and is
      // not a sub-coach of it → deny without leaking existence.
      if (actorUserId !== tenantCoachId) {
        throw assetNotFound();
      }
      return;
    }

    // Sub-coach actor: must belong to THIS head-coach team.
    if (headOfActor !== tenantCoachId) {
      throw assetNotFound();
    }

    // Client-bound asset → require explicit per-client scope via the
    // SubCoachScopeService overlay (NOT raw User.coach_id). Global coach
    // media (the only asset types today) carry no client dimension, so
    // the head-team membership proven above is the default-safe allow.
    // Routing through clientContextForAsset keeps the deny-by-default
    // posture if a future client-bound asset type is added (brief 1.3).
    const clientId = await this.clientContextForAsset(
      tenantCoachId,
      assetType,
      input,
    );
    if (clientId !== null) {
      const allowed = await this.subCoachScope.canAccessClient(
        actorUserId,
        clientId,
      );
      if (!allowed) {
        throw assetNotFound();
      }
    }
  }

  // Returns the client id a content asset is BOUND to, or null when the
  // asset is global coach media with no client dimension. Every asset type
  // wired today (workout_plan/program, meal_plan, pdf, video, auto_message)
  // is coach-tenant-global — the underlying rows key only on coach_id (see
  // prisma/schema.prisma: WorkoutPlan/DailyMealPlan/CoachMediaAsset all
  // have coach_id and NO client column). We centralise the mapping here so
  // that when PR-12+ introduces a client-private asset type, wiring its
  // client id in this one place automatically forces the
  // canAccessClient() gate in assertActorCanAttachAsset — deny-by-default.
  private async clientContextForAsset(
    _tenantCoachId: string,
    _assetType: AssetType,
    _input: { asset_id: string },
  ): Promise<string | null> {
    return null;
  }

  // Asset-ownership validation — REUSES the same per-type predicates the
  // PR-7 resolvers consume:
  //   - workout_program/workout_plan: WorkoutPlan.coach_id === tenant
  //     (the resolver uses WorkoutBuilderService.assignPlan which gates on
  //     this; we mirror the table-level predicate here so the authoring
  //     time refusal is a SUBSET of what the resolver would refuse).
  //   - meal_plan: DailyMealPlan.coach_id === tenant && archived_at IS NULL
  //     (identical to MealPlanAssetResolver.assertPlanOwnedByTenant
  //     at meal-plan.resolver.ts:176-186).
  //   - pdf/video: CoachMediaAsset.coach_id === tenant && archived_at IS
  //     NULL (identical to MediaAssetResolver's check at
  //     media-asset.resolver.ts:61-76). PR-12 builds the upload pipeline;
  //     tolerate that no rows exist yet by returning a clear 404 error.
  //   - auto_message: NO asset row (validated via the body contract
  //     above). asset_id is a free-form sentinel (will be a template id in
  //     PR-12).
  //
  // The coachUserId param IS the tenant id — for sub-coaches the caller
  // has already been promoted by PackagesService.resolveEffectiveCoachId,
  // so the same id we used to look up the package row is the right one
  // for the asset ownership check.
  private async assertAssetOwnedByCoach(
    tenantCoachId: string,
    assetType: AssetType,
    input: { asset_id: string },
  ): Promise<void> {
    switch (assetType) {
      case 'workout_program':
      case 'workout_plan': {
        const plan = await this.prisma.workoutPlan.findFirst({
          where: {
            id: input.asset_id,
            coach_id: tenantCoachId,
            archived_at: null,
          },
          select: { id: true },
        });
        if (!plan) {
          throw new NotFoundException({
            error: 'ASSET_NOT_FOUND',
            message: `No ${assetType} asset ${input.asset_id} owned by this coach`,
          });
        }
        // F2 — a workout_program that is an ARCHIVED named regime cannot be
        // attached to new package content. Active clients on the regime keep
        // receiving (existing ScheduledDrops are untouched), but new
        // attachments are blocked per the operator's archive decision. We
        // 422 (UnprocessableEntity) rather than 404 because the asset DOES
        // exist and is owned by this coach — it is simply not attachable.
        if (assetType === 'workout_program') {
          const regime = await this.prisma.workoutProgram.findFirst({
            where: {
              id: input.asset_id,
              coach_id: tenantCoachId,
              is_regime: true,
            },
            select: { archived_at: true },
          });
          if (regime?.archived_at) {
            throw new UnprocessableEntityException({
              error: 'REGIME_ARCHIVED',
              message: `Regime ${input.asset_id} is archived and cannot be attached to new package content`,
            });
          }
        }
        return;
      }
      case 'meal_plan': {
        const plan = await this.prisma.dailyMealPlan.findFirst({
          where: {
            id: input.asset_id,
            coach_id: tenantCoachId,
            archived_at: null,
          },
          select: { id: true },
        });
        if (!plan) {
          throw new NotFoundException({
            error: 'ASSET_NOT_FOUND',
            message: `No meal_plan asset ${input.asset_id} owned by this coach`,
          });
        }
        return;
      }
      case 'pdf':
      case 'video': {
        const asset = await this.prisma.coachMediaAsset.findFirst({
          where: {
            id: input.asset_id,
            coach_id: tenantCoachId,
            archived_at: null,
            kind: assetType,
          },
          select: { id: true },
        });
        if (!asset) {
          throw new NotFoundException({
            error: 'ASSET_NOT_FOUND',
            message: `No ${assetType} media asset ${input.asset_id} owned by this coach (CoachMediaAsset upload pipeline is PR-12)`,
          });
        }
        return;
      }
      case 'auto_message': {
        // No asset row — the body lives in display_caption/display_title
        // per PR-7's resolver contract. We validate that separately in
        // parseCreate / patch.
        return;
      }
    }
  }

  private zodToBadRequest(error: z.ZodError, code: string): BadRequestException {
    const issues = error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }));
    return new BadRequestException({
      error: code,
      message: issues[0]?.message ?? 'invalid body',
      issues,
    });
  }
}
