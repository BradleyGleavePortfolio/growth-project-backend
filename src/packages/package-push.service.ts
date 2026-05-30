import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AssignableAssetResolverRegistry } from './asset-resolvers/assignable-asset-resolver.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationKind } from '../notifications/notification-kind';
import { PrismaService } from '../prisma.service';
import { PackagesService } from './packages.service';
import type { PushAudience, PushMode } from './package-contents.dto';

// PR-17 B2 — package PUSH / BACKFILL service (decision-set in
// PR17_EXPANSION_PLAN.md §2.2). Pushes ONE authored CoachPackageContent
// row to a package's EXISTING buyers, seeding ScheduledDrop rows the same
// shape PR-9's purchase-fanout uses, then materialising the due-now drops
// inline (forward-dated ones are picked up by DripDispatcherCron when due).
//
// ─────────────────────────────────────────────────────────────────────────
// NO-STRIPE INVARIANT (decision #7, watchpoint §6.3)
// ─────────────────────────────────────────────────────────────────────────
// This path NEVER touches Stripe / billing. It runs entirely against
// CoachPackageContent + ClientPurchase + ScheduledDrop and the PR-7 asset
// resolvers. The inline-materialise resolvers (workout / meal_plan /
// auto_message / pdf / video) DELEGATE to assignment + messaging surfaces
// only — none of them open a Stripe client or write a Charge/Transfer. We
// assert that here as a standing invariant: a builder adding a Stripe call
// to a resolver would break this push path's money-free contract and the
// test/package-push.service.spec.ts "NO Stripe" case would catch it (the
// resolver stub records every call and the suite asserts no billing client
// is ever constructed). All seeds commit in ONE $transaction, chunked at
// CHUNK_SIZE via createMany({ skipDuplicates: true }).
//
// ─────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY (decision #8, watchpoint §6.1) — R2 audit remediation (P0)
// ─────────────────────────────────────────────────────────────────────────
// Two layers survive (PR17_EXPANSION_PLAN.md §1.4):
//   (a) the mutation-level UUID Idempotency-Key header. This is now ENFORCED
//       (not merely logged): the ENTIRE push mutation body is wrapped in a
//       request-level idempotency claim keyed by
//       (coachUserId, `package-push:${packageId}:${contentId}`, idempotencyKey)
//       persisted in the GENERIC ledger table WorkoutBuilderIdempotencyKey
//       (prisma/schema.prisma — "Generic idempotency ledger", unique on
//       (user_id, route_key, idempotency_key)). We REUSE that existing table
//       and replicate the audited WorkoutBuilderService.withIdempotency claim/
//       cache/release semantics inline (claimAndRun, below) because injecting
//       WorkoutBuilderService here would form a module cycle
//       (AssignableAssetResolversModule → WorkoutBuilderModule → PackagesModule
//       → … → PackagePushService). NO schema change, NO new table/column.
//       Net effect: a replayed POST with the SAME key returns the CACHED
//       { scheduled, skipped } and NEVER re-runs the seq computation, so a
//       resend can never mint a second push_seq → no double delivery. A
//       concurrent same-key retry gets a 409.
//   (b) the DB unique key (client_purchase_id, content_id, push_seq) plus
//       createMany({ skipDuplicates: true }). We compute the target push_seq
//       DETERMINISTICALLY per (purchase, content) from the current max INSIDE
//       the tx, so even a key-less replay of a push_existing re-derives the
//       SAME push_seq and the createMany is a true no-op (0 newly inserted →
//       scheduled is reported from the rows actually created).
//
// ─────────────────────────────────────────────────────────────────────────
// AUDIENCE CAP (watchpoint §6.2) — R2 audit remediation (P2)
// ─────────────────────────────────────────────────────────────────────────
// All seed creation + re-read + due-now materialise run in ONE interactive
// $transaction. To keep that transaction within Postgres statement-timeout
// headroom we BOUND the synchronous audience: after resolving the audience,
// a push whose resolved buyer count exceeds MAX_PUSH_AUDIENCE is rejected
// with a 400 (error 'AUDIENCE_TOO_LARGE'). Very large pushes must go through
// an operator / async path rather than blocking a single interactive tx.
//
// ─────────────────────────────────────────────────────────────────────────
// RESOLVER-KEY BYPASS (decision #5, the single most fragile rule, §1.3/§2.4)
// ─────────────────────────────────────────────────────────────────────────
// The inline due-now materialise applies the SAME conditional the B1 cron
// applies: pass the (clientPurchaseId, contentId) pair IFF push_seq === 0;
// for push_seq > 0 (a re-send) pass scheduledDropId ONLY and OMIT the pair,
// so the auto_message / workout resolvers fall back to their per-drop key
// and produce a GENUINELY FRESH delivery instead of collapsing to the cached
// marker / ledger result.

// Terminal "shipped" statuses (G4 / watchpoint §6.7). The inline fan-out
// stamps 'fired'; the cron stamps 'delivered'. BOTH mean the buyer already
// received this content, so the skip / resend logic must treat them
// identically. Centralised here as the single source of truth.
export const SHIPPED_STATUSES = ['fired', 'delivered'] as const;
export type ShippedStatus = (typeof SHIPPED_STATUSES)[number];

function isShipped(status: string): boolean {
  return (SHIPPED_STATUSES as readonly string[]).includes(status);
}

// createMany chunk size for the single atomic tx (decision #7). 500 keeps
// each statement well under Postgres parameter limits while bounding the
// number of round-trips for a large `all` audience.
const CHUNK_SIZE = 500;

// R2 (P2) — maximum audience size for the SYNCHRONOUS push endpoint. The push
// seeds + re-reads + materialises every drop inside ONE interactive
// $transaction; an unbounded `all`/`active` audience (the plan §6.2 watchpoint
// flagged 10k+ buyers) risks blowing the Postgres statement/transaction
// timeout. 2000 buyers × (createMany chunked at CHUNK_SIZE + a bounded inline
// materialise) stays comfortably within statement-timeout headroom for a
// single interactive tx; anything larger must go through an operator/async
// path rather than block the request. Resolved-audience counts above this are
// rejected with a 400 ('AUDIENCE_TOO_LARGE').
export const MAX_PUSH_AUDIENCE = 2000;

// R2 (P0) — UUID v1-v5 shape for the mutation Idempotency-Key. The controller
// rejects a missing/invalid key with a 400 before reaching the service; this
// constant is exported so the controller and tests share one source of truth.
export const IDEMPOTENCY_KEY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PushOptions {
  audience: PushAudience;
  cohortPurchaseIds?: string[];
  fireAt: Date;
  mode: PushMode;
  notify: boolean;
}

export interface PushResult {
  scheduled: number;
  skipped: number;
}

export interface PushPreviewResult {
  count: number;
  already_delivered: number;
}

@Injectable()
export class PackagePushService {
  private readonly logger = new Logger(PackagePushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly packages: PackagesService,
    @Optional() private readonly resolvers?: AssignableAssetResolverRegistry,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ── public API ─────────────────────────────────────────────────────────

  /**
   * Preview the audience for the confirm modal (#10) WITHOUT scheduling.
   * Pure read; IDOR-guarded. Returns the candidate buyer count and how many
   * of them have already been shipped this content (G4).
   */
  async previewPush(
    coachUserId: string,
    packageId: string,
    contentId: string,
    opts: { audience: PushAudience; mode: PushMode; cohortPurchaseIds?: string[] },
  ): Promise<PushPreviewResult> {
    // (1) IDOR + content existence.
    await this.packages.requireOwnedPackage(coachUserId, packageId);
    await this.requireContent(packageId, contentId);

    // (3) Resolve audience → purchases.
    const purchases = await this.resolveAudience(
      packageId,
      opts.audience,
      opts.cohortPurchaseIds,
    );
    const purchaseIds = purchases.map((p) => p.id);

    // Existing drops for the (purchase, content) pair across all push_seq.
    const existing = purchaseIds.length
      ? await this.prisma.scheduledDrop.findMany({
          where: { client_purchase_id: { in: purchaseIds }, content_id: contentId },
          select: { client_purchase_id: true, status: true, push_seq: true },
        })
      : [];

    const byPurchase = this.groupDrops(existing);
    let alreadyDelivered = 0;
    let count = 0;
    for (const id of purchaseIds) {
      const drops = byPurchase.get(id) ?? [];
      const shippedHere = drops.some((d) => isShipped(d.status));
      if (shippedHere) alreadyDelivered += 1;
      if (opts.mode === 'resend') {
        // resend targets only buyers whose latest drop is shipped.
        if (this.latestIsShipped(drops)) count += 1;
      } else {
        // push_existing targets buyers with NO existing drop for the pair.
        if (drops.length === 0) count += 1;
      }
    }

    return { count, already_delivered: alreadyDelivered };
  }

  /**
   * Push / backfill ONE content row to existing buyers. The 9-step
   * algorithm from PR17_EXPANSION_PLAN.md §2.2.
   */
  async pushContentToExistingBuyers(
    coachUserId: string,
    packageId: string,
    contentId: string,
    opts: PushOptions,
    idempotencyKey?: string,
  ): Promise<PushResult> {
    // (1) IDOR + load the content row (or 404).
    await this.packages.requireOwnedPackage(coachUserId, packageId);
    const content = await this.requireContent(packageId, contentId);

    // (2) Server-side past-date guard (#2/#6). The coach's chosen fire_at is
    // used DIRECTLY as the drop's fire_at — we do NOT double-normalise it
    // through the cadence-derived timing. We only reject a date before the
    // start of today (defense-in-depth behind the disabled mobile picker).
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0,
    );
    if (opts.fireAt.getTime() < startOfToday.getTime()) {
      throw new BadRequestException({
        error: 'FIRE_AT_IN_PAST',
        message: 'fire_at must be today or later',
      });
    }

    // (R2 P0) Enforce the mutation Idempotency-Key at the REQUEST layer by
    // reusing the generic ledger. The ENTIRE mutation below runs inside the
    // claim, so a replayed same-key request returns the CACHED result and
    // NEVER re-runs audience resolution / seq computation (no second
    // push_seq, no double delivery). routeKey is scoped per (package,
    // content) so the same key for a DIFFERENT content stays independent.
    // A key-less call (e.g. internal/test) simply runs the op once.
    const routeKey = `package-push:${packageId}:${contentId}`;
    return this.claimAndRun<PushResult>(
      coachUserId,
      routeKey,
      idempotencyKey,
      () => this.runPush(coachUserId, packageId, contentId, content, opts, now),
    );
  }

  // The actual push mutation body (steps 3–9), extracted so the public method
  // can wrap it in the idempotency claim (R2 P0). Runs EXACTLY ONCE per
  // claimed key.
  private async runPush(
    coachUserId: string,
    packageId: string,
    contentId: string,
    content: {
      id: string;
      asset_type: string;
      asset_id: string;
      asset_revision_id: string | null;
      cadence_kind: string;
      cadence_payload: unknown;
      display_title: string | null;
      display_caption: string | null;
    },
    opts: PushOptions,
    now: Date,
  ): Promise<PushResult> {
    void coachUserId;
    // (3) Resolve audience → ClientPurchase rows.
    const purchases = await this.resolveAudience(
      packageId,
      opts.audience,
      opts.cohortPurchaseIds,
    );
    if (purchases.length === 0) {
      return { scheduled: 0, skipped: 0 };
    }
    // (R2 P2) Bound the synchronous audience so the single interactive tx
    // below cannot exceed statement-timeout headroom. Above the cap the push
    // must go through an operator/async path.
    if (purchases.length > MAX_PUSH_AUDIENCE) {
      throw new BadRequestException({
        error: 'AUDIENCE_TOO_LARGE',
        message: `This push resolves ${purchases.length} buyers, above the synchronous limit of ${MAX_PUSH_AUDIENCE}. Narrow the audience (e.g. a cohort) or use an operator/async path for very large pushes.`,
      });
    }
    const purchaseIds = purchases.map((p) => p.id);

    // Existing drops for the pair → decide per-buyer target push_seq (#8) and
    // skip set (G4). Read once, group in memory.
    const existing = await this.prisma.scheduledDrop.findMany({
      where: { client_purchase_id: { in: purchaseIds }, content_id: contentId },
      select: { client_purchase_id: true, status: true, push_seq: true },
    });
    const byPurchase = this.groupDrops(existing);

    // (4)/(5) Build seed rows. fire_at is the coach date DIRECTLY (#2). The
    // cadence_kind / cadence_payload are SNAPSHOTTED from the current content
    // row for buyer-side display + consumer routing, but they do NOT change
    // the scheduling date. push_seq is deterministic per (purchase, content).
    const cadencePayload = content.cadence_payload as Prisma.InputJsonValue;
    let skipped = 0;
    const seedRows: Prisma.ScheduledDropCreateManyInput[] = [];

    for (const purchase of purchases) {
      const drops = byPurchase.get(purchase.id) ?? [];
      if (opts.mode === 'push_existing') {
        // Backfill the FIRST delivery only — skip a buyer who already has ANY
        // drop for this pair (G4: includes pending originals, not just
        // shipped ones — you don't backfill someone already scheduled).
        if (drops.length > 0) {
          skipped += 1;
          continue;
        }
        seedRows.push(
          this.buildSeedRow(purchase.id, content, cadencePayload, opts, 0),
        );
      } else {
        // resend: only buyers whose LATEST drop for the pair is shipped
        // (G4). A buyer whose original is still pending is skipped — there's
        // nothing shipped to "re-send".
        if (!this.latestIsShipped(drops)) {
          skipped += 1;
          continue;
        }
        const maxSeq = drops.reduce((m, d) => Math.max(m, d.push_seq), 0);
        seedRows.push(
          this.buildSeedRow(
            purchase.id,
            content,
            cadencePayload,
            opts,
            maxSeq + 1,
          ),
        );
      }
    }

    if (seedRows.length === 0) {
      return { scheduled: 0, skipped };
    }

    // (6) ONE atomic $transaction, CHUNKED createMany (decision #7). NO
    // Stripe anywhere in here. skipDuplicates makes a replay a true no-op:
    // the deterministic push_seq lands on the same row the prior run wrote,
    // so createMany inserts 0 and `scheduled` reflects only fresh inserts.
    const purchaseById = new Map(purchases.map((p) => [p.id, p]));
    const seededDropIds = await this.prisma.$transaction(async (tx) => {
      let total = 0;
      for (let i = 0; i < seedRows.length; i += CHUNK_SIZE) {
        const chunk = seedRows.slice(i, i + CHUNK_SIZE);
        const res = await tx.scheduledDrop.createMany({
          data: chunk,
          skipDuplicates: true,
        });
        total += res.count;
      }

      // Re-read exactly the rows we intended to seed so we can (a) report
      // the true scheduled count (the rows that actually exist at our target
      // push_seq) and (b) materialise the due-now subset inline. We match on
      // the (purchase, content, push_seq) tuples we built.
      const targetSeqByPurchase = new Map<string, number>();
      for (const row of seedRows) {
        targetSeqByPurchase.set(row.client_purchase_id, row.push_seq ?? 0);
      }
      const persisted = await tx.scheduledDrop.findMany({
        where: {
          client_purchase_id: { in: Array.from(targetSeqByPurchase.keys()) },
          content_id: contentId,
        },
      });
      // Keep only the rows at our target push_seq for each purchase (the
      // re-send insert, or the seq-0 backfill) — not prior shipped rows.
      const ours = persisted.filter(
        (d) => targetSeqByPurchase.get(d.client_purchase_id) === d.push_seq,
      );

      // (7) Materialise the due-NOW drops inline (coach chose today/now).
      // Forward-dated drops are left pending — the cron picks them up when
      // due, with NO change required there.
      const dueNow = ours.filter(
        (d) =>
          d.materialised_ref == null &&
          d.fire_at != null &&
          d.fire_at.getTime() <= now.getTime() &&
          d.status !== 'fired' &&
          d.status !== 'delivered' &&
          d.status !== 'failed' &&
          d.status !== 'canceled',
      );

      for (const drop of dueNow) {
        const purchase = purchaseById.get(drop.client_purchase_id);
        if (!purchase) continue;
        if (!this.resolvers) {
          throw new Error(
            `PackagePush: AssignableAssetResolverRegistry not wired; cannot materialise drop=${drop.id} type=${drop.asset_type}`,
          );
        }
        // (#5) Resolver-key bypass — pass the (clientPurchaseId, contentId)
        // pair IFF push_seq === 0; for a re-send (push_seq > 0) pass ONLY the
        // per-drop scheduledDropId so the resolver produces a FRESH delivery.
        const isResend = drop.push_seq > 0;
        const result = await this.resolvers.materialise(drop.asset_type, {
          clientId: purchase.client_user_id,
          coachId: purchase.coach_user_id,
          assetId: drop.asset_id,
          assetRevisionId: drop.asset_revision_id ?? null,
          displayTitle: drop.display_title,
          displayCaption: drop.display_caption,
          scheduledDropId: drop.id,
          clientPurchaseId: isResend ? null : purchase.id,
          contentId: isResend ? null : drop.content_id,
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
      }

      void total; // createMany count is informational; we report from `ours`.
      return ours.map((d) => d.id);
    });

    // (8) Buyer notify (#9). When notify===false we ALREADY stamped
    // alert_dispatched_at=now at seed time (see buildSeedRow), so both the
    // inline path here AND the cron's dispatchBuyerAlert guard skip the
    // DRIP_RELEASED push for those drops. When notify===true we fire the
    // alert for the due-now drops we just materialised inline (fire-and-
    // forget; a push failure must never reach back into the seed tx);
    // forward-dated drops notify automatically when the cron fires them.
    if (opts.notify) {
      await this.dispatchInlineAlerts(seededDropIds, purchaseById, contentId, now);
    }

    // (9) Idempotent return: `scheduled` = rows that exist at our target seq.
    // The request-level claim (claimAndRun) caches THIS result, so a replay
    // never reaches here again.
    return { scheduled: seededDropIds.length, skipped };
  }

  // ── internal ─────────────────────────────────────────────────────────

  /**
   * Request-level idempotency for the push mutation (R2 P0).
   *
   * REUSES the existing generic ledger table WorkoutBuilderIdempotencyKey
   * (prisma/schema.prisma — "Generic idempotency ledger", unique on
   * (user_id, route_key, idempotency_key)) and replicates the audited
   * WorkoutBuilderService.withIdempotency() claim/cache/release semantics.
   * We do NOT inject WorkoutBuilderService directly: it would create a
   * module cycle (AssignableAssetResolversModule → WorkoutBuilderModule →
   * PackagesModule → … → PackagePushService). NO schema change.
   *
   * Flow (race-safe — the key is CLAIMED atomically BEFORE op() runs):
   *   1. Insert a ledger row status='in_progress'. P2002 (duplicate) →
   *      another request holds the key:
   *        - existing.status==='completed' → return the CACHED response.
   *        - existing.status==='in_progress' → 409 (concurrent retry); op()
   *          is NOT run a second time.
   *   2. Run op() exactly once under the claim.
   *   3. Persist the response + flip to 'completed'.
   *   4. If op() throws, delete the claim so the caller can retry the key.
   */
  private async claimAndRun<T>(
    userId: string,
    routeKey: string,
    idempotencyKey: string | null | undefined,
    op: () => Promise<T>,
  ): Promise<T> {
    if (!idempotencyKey) return op();

    // Step 1: atomically claim the key.
    let claimId: string | null = null;
    try {
      const claim = await this.prisma.workoutBuilderIdempotencyKey.create({
        data: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
          status: 'in_progress',
        },
      });
      claimId = claim.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing =
          await this.prisma.workoutBuilderIdempotencyKey.findUnique({
            where: {
              WorkoutBuilderIdempotencyKey_user_route_key_key: {
                user_id: userId,
                route_key: routeKey,
                idempotency_key: idempotencyKey,
              },
            },
          });
        if (existing && existing.status === 'completed') {
          // Replay of a finished push → return the cached {scheduled,skipped}
          // WITHOUT re-running the mutation (no second push_seq).
          return existing.response_json as unknown as T;
        }
        // in_progress (or a row just deleted by a failed op) → concurrent
        // same-key retry. Surface 409; do NOT run the mutation again.
        throw new ConflictException({
          error: 'PUSH_IN_PROGRESS',
          message: 'A push with this Idempotency-Key is already in progress — retry in a moment',
        });
      }
      throw err;
    }

    // Step 2: run the protected mutation under the claim.
    let result: T;
    try {
      result = await op();
    } catch (err) {
      // Release the claim (best-effort) so the client can retry the same key.
      try {
        await this.prisma.workoutBuilderIdempotencyKey.delete({
          where: { id: claimId },
        });
      } catch {
        /* swallow — the original error wins */
      }
      throw err;
    }

    // Step 3: cache the response + flip to 'completed'.
    await this.prisma.workoutBuilderIdempotencyKey.update({
      where: { id: claimId },
      data: {
        status: 'completed',
        response_json: result as unknown as Prisma.InputJsonValue,
        status_code: 200,
      },
    });

    return result;
  }

  private async requireContent(packageId: string, contentId: string) {
    const content = await this.prisma.coachPackageContent.findFirst({
      where: { id: contentId, package_id: packageId, removed_at: null },
    });
    if (!content) {
      throw new NotFoundException({
        error: 'CONTENT_NOT_FOUND',
        message: `No content ${contentId} on package ${packageId}`,
      });
    }
    return content;
  }

  // (#1 / §2.6) Audience scoping. For cohort we RE-FILTER the supplied ids by
  // package_id so a coach can't push to another package's purchases by
  // id-guessing (IDOR, watchpoint §6.4) — the `package_id` clause does this
  // implicitly because we only ever query within this package.
  private async resolveAudience(
    packageId: string,
    audience: PushAudience,
    cohortPurchaseIds?: string[],
  ) {
    const where: Prisma.ClientPurchaseWhereInput = { package_id: packageId };
    if (audience === 'active') {
      where.entitlement_active = true;
    } else if (audience === 'cohort') {
      where.id = { in: cohortPurchaseIds ?? [] };
    }
    return this.prisma.clientPurchase.findMany({ where });
  }

  private buildSeedRow(
    clientPurchaseId: string,
    content: {
      id: string;
      asset_type: string;
      asset_id: string;
      asset_revision_id: string | null;
      cadence_kind: string;
      display_title: string | null;
      display_caption: string | null;
    },
    cadencePayload: Prisma.InputJsonValue,
    opts: PushOptions,
    pushSeq: number,
  ): Prisma.ScheduledDropCreateManyInput {
    return {
      client_purchase_id: clientPurchaseId,
      content_id: content.id,
      asset_type: content.asset_type,
      asset_id: content.asset_id,
      asset_revision_id: content.asset_revision_id,
      cadence_kind: content.cadence_kind,
      cadence_payload: cadencePayload,
      display_title: content.display_title,
      display_caption: content.display_caption,
      // #2 — coach-chosen date DIRECTLY, no double-normalize.
      fire_at: opts.fireAt,
      status: 'pending',
      push_seq: pushSeq,
      // #9 — notify suppression. Pre-stamp alert_dispatched_at so B1's
      // dispatchBuyerAlert guard skips the buyer push for a silent push. A
      // notify=true push leaves it NULL so the alert fires normally.
      alert_dispatched_at: opts.notify ? null : new Date(),
    };
  }

  // Group existing drops by client_purchase_id.
  private groupDrops(
    rows: Array<{ client_purchase_id: string; status: string; push_seq: number }>,
  ): Map<string, Array<{ status: string; push_seq: number }>> {
    const map = new Map<string, Array<{ status: string; push_seq: number }>>();
    for (const r of rows) {
      const arr = map.get(r.client_purchase_id) ?? [];
      arr.push({ status: r.status, push_seq: r.push_seq });
      map.set(r.client_purchase_id, arr);
    }
    return map;
  }

  // The buyer's LATEST drop (highest push_seq) is shipped (G4). Used to gate
  // resend targets: you only re-send to someone whose current delivery is
  // already out.
  private latestIsShipped(drops: Array<{ status: string; push_seq: number }>): boolean {
    if (drops.length === 0) return false;
    const latest = drops.reduce((a, b) => (b.push_seq > a.push_seq ? b : a));
    return isShipped(latest.status);
  }

  // Fire-and-forget DRIP_RELEASED for the inline-materialised drops only.
  // Failure-isolated: a notification provider blip must never bubble (the
  // seed tx has already committed). Mirrors the cron's dispatchBuyerAlert
  // envelope. Drops the coach asked NOT to announce were pre-stamped with
  // alert_dispatched_at and are NOT in the notify branch caller.
  private async dispatchInlineAlerts(
    dropIds: string[],
    purchaseById: Map<string, { client_user_id: string }>,
    contentId: string,
    now: Date,
  ): Promise<void> {
    if (dropIds.length === 0 || !this.notifications) return;
    // Re-read the rows we materialised so we only alert the ones that fired
    // inline (status 'fired') and have not already been alerted.
    let fired: Array<{
      id: string;
      client_purchase_id: string;
      asset_type: string;
      asset_id: string;
      display_title: string | null;
    }>;
    try {
      fired = await this.prisma.scheduledDrop.findMany({
        where: { id: { in: dropIds }, status: 'fired', alert_dispatched_at: null },
        select: {
          id: true,
          client_purchase_id: true,
          asset_type: true,
          asset_id: true,
          display_title: true,
        },
      });
    } catch (err) {
      this.logger.warn(
        `push: inline alert re-read failed: ${(err as Error).message}`,
      );
      return;
    }

    for (const drop of fired) {
      const purchase = purchaseById.get(drop.client_purchase_id);
      if (!purchase) continue;
      const clientUserId = purchase.client_user_id;
      const title = drop.display_title?.slice(0, 80) || 'New content unlocked';
      const body = drop.display_title
        ? `New content unlocked: ${drop.display_title}`.slice(0, 160)
        : 'New content unlocked';
      const payload = {
        scheduled_drop_id: drop.id,
        client_purchase_id: drop.client_purchase_id,
        asset_type: drop.asset_type,
        asset_id: drop.asset_id,
        content_id: contentId,
      };
      try {
        await this.notifications.createNotification({
          user_id: clientUserId,
          kind: NotificationKind.DRIP_RELEASED,
          body,
          payload,
          deep_link: 'tgp://client/library',
          channel: 'inapp',
        });
      } catch (err) {
        this.logger.warn(
          `push: inline in-app alert failed drop=${drop.id}: ${(err as Error).message}`,
        );
      }
      try {
        await this.notifications.pushToUser(clientUserId, title, body, {
          kind: NotificationKind.DRIP_RELEASED,
          scheduled_drop_id: drop.id,
          asset_type: drop.asset_type,
        });
      } catch (err) {
        this.logger.warn(
          `push: inline push alert failed drop=${drop.id}: ${(err as Error).message}`,
        );
      }
      // Stamp alert_dispatched_at so the cron's safety sweep / guard never
      // double-pushes this buyer (mirrors the cron's own post-alert stamp).
      try {
        await this.prisma.scheduledDrop.update({
          where: { id: drop.id },
          data: { alert_dispatched_at: now },
        });
      } catch (err) {
        this.logger.warn(
          `push: inline alert stamp failed drop=${drop.id}: ${(err as Error).message}`,
        );
      }
    }
  }
}
