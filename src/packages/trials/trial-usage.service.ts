import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import type { CoachPackage, PackageTrialUsage, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { TRIAL_DAYS_MAX, TrialErrorCode } from './trial-rules';
import { TrialCheckoutCapability } from './trial-checkout-capability';

// B-TRIALS (OR-113-2) — one free trial per client per coach, enforced in the
// database.
//
// Lifecycle of a PackageTrialUsage row (unique per client + coach):
//
//   reserve()      -> reserved   the subscription creator (lane B-RECUR) calls
//                                this for the purchase BEFORE creating the
//                                Stripe subscription with trial_period_days.
//   markStarted()  -> started    the webhook calls this once the card is saved
//                                and the subscription is trialing. Permanent:
//                                a started trial is never released, so
//                                cancelling during the trial cannot buy a
//                                second trial with the same coach.
//   release()      -> released   the attempt ended before the trial started
//                                (sheet abandoned, no card, subscription
//                                deleted). The client keeps their trial.
//
// Race safety without aborting the caller's transaction:
//   * the first reservation is an INSERT ... ON CONFLICT DO NOTHING
//     (createMany + skipDuplicates), so a collision on (client, coach) or on
//     purchase_id returns count 0 instead of raising inside a Postgres
//     transaction (a raised unique violation would poison the caller's tx);
//   * every later transition is a compare-and-set updateMany keyed on the
//     row's current status and purchase, so two concurrent writers cannot
//     both win.

/** A reservation that never started is considered abandoned after this. */
export const TRIAL_RESERVATION_STALE_MS = 30 * 60 * 1000;

type Db = Prisma.TransactionClient | PrismaService;

export interface ReserveTrialArgs {
  clientUserId: string;
  coachUserId: string;
  packageId: string;
  purchaseId: string;
  trialDays: number;
}

export interface TrialReservation {
  /** Days to pass to Stripe as trial_period_days. 0 = no trial. */
  trial_days: number;
}

export interface MarkTrialStartedArgs {
  purchaseId: string;
  clientUserId: string;
  coachUserId: string;
  packageId: string;
  trialDays: number;
  trialEndsAt: Date | null;
}

/**
 * owned    — this purchase holds the client's trial with this coach.
 * conflict — another purchase already holds it; this trial must not grant
 *            free access (the webhook cancels the conflicting subscription
 *            after commit, so the client is never charged for it).
 */
export type TrialStartOutcome = 'owned' | 'conflict';

/** What a client sees about a package's trial before paying. */
export interface TrialOffer {
  /** The package's trial length (0 = the package has no trial). */
  trial_days: number;
  /** True when this client would get the trial if they subscribed now. */
  available: boolean;
  /**
   * offered         — the client gets the trial if they subscribe now;
   * none            — the package has no trial;
   * already_used    — the client already had a free trial with this coach;
   * not_offered_yet — the package has trial days but no checkout on this
   *                   server sends a trial to Stripe yet (#654 not wired), so
   *                   the app shows the regular price only.
   */
  reason: 'offered' | 'none' | 'already_used' | 'not_offered_yet';
}

export function trialAlreadyUsedError(): ConflictException {
  return new ConflictException({
    error: TrialErrorCode.ALREADY_USED,
    code: TrialErrorCode.ALREADY_USED,
    message:
      'Your free trial with this coach has already been used. You can still start the plan today at the regular price.',
  });
}

export function trialInProgressError(): ConflictException {
  return new ConflictException({
    error: 'TRIAL_IN_PROGRESS',
    code: 'TRIAL_IN_PROGRESS',
    message:
      'A free trial with this coach is already being set up on another plan. Finish that checkout, or try again in 30 minutes.',
  });
}

@Injectable()
export class TrialUsageService {
  private readonly logger = new Logger(TrialUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    // B-TRIALS-2 — absent (legacy wiring) = no checkout honors trials, so no
    // trial is ever advertised.
    @Optional() private readonly checkout?: TrialCheckoutCapability,
  ) {}

  /** Trial offers for one client across a list of packages (one query). */
  async offersForClient(
    clientUserId: string,
    packages: Array<Pick<CoachPackage, 'id' | 'coach_id' | 'trial_days'>>,
  ): Promise<Map<string, TrialOffer>> {
    const offers = new Map<string, TrialOffer>();
    const coachIds = [
      ...new Set(packages.filter((p) => (p.trial_days ?? 0) > 0).map((p) => p.coach_id)),
    ];
    const started = coachIds.length
      ? await this.prisma.packageTrialUsage.findMany({
          where: {
            client_user_id: clientUserId,
            coach_user_id: { in: coachIds },
            status: 'started',
          },
          select: { coach_user_id: true },
        })
      : [];
    const usedWith = new Set(started.map((r) => r.coach_user_id));
    const sellable = this.checkout?.isReady() === true;
    for (const p of packages) {
      offers.set(p.id, offerFor(p, usedWith.has(p.coach_id), sellable));
    }
    return offers;
  }

  /**
   * Reserve the client's trial with this coach for `purchaseId`.
   *
   * Returns the trial days to send to Stripe. Idempotent per purchase (a
   * retried attempt gets the same answer). Throws 409 TRIAL_ALREADY_USED when
   * the client already started a trial with this coach, and 409
   * TRIAL_IN_PROGRESS while another fresh attempt holds the reservation.
   * Safe inside the caller's interactive transaction.
   */
  async reserve(db: Db, args: ReserveTrialArgs): Promise<TrialReservation> {
    const days = clampTrialDays(args.trialDays);
    if (days === 0) return { trial_days: 0 };

    const inserted = await db.packageTrialUsage.createMany({
      data: [
        {
          client_user_id: args.clientUserId,
          coach_user_id: args.coachUserId,
          package_id: args.packageId,
          purchase_id: args.purchaseId,
          trial_days: days,
          status: 'reserved',
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 1) return { trial_days: days };

    const existing = await db.packageTrialUsage.findUnique({
      where: {
        client_user_id_coach_user_id: {
          client_user_id: args.clientUserId,
          coach_user_id: args.coachUserId,
        },
      },
    });
    if (!existing) {
      // The collision was on purchase_id alone: this purchase already holds a
      // row for a different (client, coach) pair, which a purchase never
      // changes. Refuse rather than guess.
      this.logger.error(
        `trial reserve: purchase ${args.purchaseId} already holds a trial row for another client/coach`,
      );
      throw trialInProgressError();
    }
    if (existing.purchase_id === args.purchaseId && existing.status !== 'released') {
      return { trial_days: existing.trial_days };
    }
    if (existing.status === 'started') throw trialAlreadyUsedError();

    const stale =
      existing.status === 'released' ||
      existing.reserved_at.getTime() < Date.now() - TRIAL_RESERVATION_STALE_MS;
    if (!stale) throw trialInProgressError();

    // Take over a released or abandoned reservation (compare-and-set on the
    // exact row state we read, so a concurrent writer cannot also win).
    const taken = await db.packageTrialUsage.updateMany({
      where: { id: existing.id, status: existing.status, purchase_id: existing.purchase_id },
      data: {
        purchase_id: args.purchaseId,
        package_id: args.packageId,
        trial_days: days,
        status: 'reserved',
        reserved_at: new Date(),
        started_at: null,
        trial_ends_at: null,
        released_at: null,
        release_reason: null,
      },
    });
    if (taken.count === 1) return { trial_days: days };

    const reread = await db.packageTrialUsage.findUnique({ where: { id: existing.id } });
    if (reread && reread.purchase_id === args.purchaseId && reread.status !== 'released') {
      return { trial_days: reread.trial_days };
    }
    if (reread?.status === 'started') throw trialAlreadyUsedError();
    throw trialInProgressError();
  }

  /**
   * Release a reservation that never started (abandoned sheet, no card,
   * subscription deleted before the card was saved). A started trial is never
   * released. Returns true when a row was released.
   */
  async release(db: Db, purchaseId: string, reason: string): Promise<boolean> {
    const res = await db.packageTrialUsage.updateMany({
      where: { purchase_id: purchaseId, status: 'reserved' },
      data: { status: 'released', released_at: new Date(), release_reason: reason.slice(0, 120) },
    });
    return res.count > 0;
  }

  /**
   * Record that this purchase's trial started (card saved, subscription
   * trialing). Creates the row when the subscription was minted without a
   * reservation, and reports a conflict when another purchase holds it.
   */
  async markStarted(db: Db, args: MarkTrialStartedArgs): Promise<TrialStartOutcome> {
    const now = new Date();
    const own = await db.packageTrialUsage.findUnique({ where: { purchase_id: args.purchaseId } });
    if (own) {
      if (own.status === 'started') {
        if (args.trialEndsAt && own.trial_ends_at?.getTime() !== args.trialEndsAt.getTime()) {
          await db.packageTrialUsage.updateMany({
            where: { id: own.id, status: 'started' },
            data: { trial_ends_at: args.trialEndsAt },
          });
        }
        return 'owned';
      }
      const res = await db.packageTrialUsage.updateMany({
        where: { id: own.id, purchase_id: args.purchaseId, status: own.status },
        data: { status: 'started', started_at: now, trial_ends_at: args.trialEndsAt },
      });
      if (res.count === 1) return 'owned';
      const reread = await db.packageTrialUsage.findUnique({ where: { id: own.id } });
      return reread?.purchase_id === args.purchaseId && reread.status === 'started'
        ? 'owned'
        : 'conflict';
    }

    const inserted = await db.packageTrialUsage.createMany({
      data: [
        {
          client_user_id: args.clientUserId,
          coach_user_id: args.coachUserId,
          package_id: args.packageId,
          purchase_id: args.purchaseId,
          trial_days: clampTrialDays(args.trialDays) || 1,
          status: 'started',
          started_at: now,
          trial_ends_at: args.trialEndsAt,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 1) return 'owned';

    // Another purchase holds this client's trial with this coach. A released
    // row can still be claimed (that attempt never started).
    const holder = await db.packageTrialUsage.findUnique({
      where: {
        client_user_id_coach_user_id: {
          client_user_id: args.clientUserId,
          coach_user_id: args.coachUserId,
        },
      },
    });
    if (holder && holder.status === 'released') {
      const res = await db.packageTrialUsage.updateMany({
        where: { id: holder.id, status: 'released', purchase_id: holder.purchase_id },
        data: {
          purchase_id: args.purchaseId,
          package_id: args.packageId,
          trial_days: clampTrialDays(args.trialDays) || holder.trial_days,
          status: 'started',
          started_at: now,
          trial_ends_at: args.trialEndsAt,
          released_at: null,
          release_reason: null,
        },
      });
      if (res.count === 1) return 'owned';
    }
    this.logger.error(
      `trial conflict: purchase ${args.purchaseId} started a trial while another purchase holds this client's trial with the coach (TRIAL_ALREADY_USED)`,
    );
    return 'conflict';
  }

  /**
   * True when this purchase's trial already started (card was saved and the
   * subscription was trialing). Used by the webhook so a started trial keeps
   * access to its end even if the card is later removed: Stripe then cancels
   * at the trial end (missing_payment_method=cancel) and nothing is charged.
   */
  async hasStarted(db: Db, purchaseId: string): Promise<boolean> {
    const row = await db.packageTrialUsage.findUnique({
      where: { purchase_id: purchaseId },
      select: { status: true },
    });
    return row?.status === 'started';
  }

  /** Test seam / support read. */
  async findForPurchase(purchaseId: string): Promise<PackageTrialUsage | null> {
    return this.prisma.packageTrialUsage.findUnique({ where: { purchase_id: purchaseId } });
  }
}

export function offerFor(
  pkg: Pick<CoachPackage, 'trial_days'>,
  usedWithCoach: boolean,
  sellable = true,
): TrialOffer {
  const days = pkg.trial_days ?? 0;
  if (days <= 0) return { trial_days: 0, available: false, reason: 'none' };
  if (usedWithCoach) return { trial_days: days, available: false, reason: 'already_used' };
  if (!sellable) return { trial_days: days, available: false, reason: 'not_offered_yet' };
  return { trial_days: days, available: true, reason: 'offered' };
}

function clampTrialDays(days: number): number {
  if (!Number.isInteger(days) || days <= 0) return 0;
  return Math.min(days, TRIAL_DAYS_MAX);
}
