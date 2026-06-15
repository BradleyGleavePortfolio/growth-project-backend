/**
 * first-payment-tx-rollback.integration.spec.ts — Roman P4 (Option C), R81
 * (PR-395 follow-up, F1/F2 — the P0 + P1).
 *
 * The audit P0 was: the first-payment notification rows were written on
 * NotificationsService's OWN (autocommitting) PrismaService rather than the
 * ambient purchase `tx`. On an outer rollback the ledger row + stripe-event-id
 * dedup row vanished but the notification rows stayed committed, so Stripe's
 * redelivery re-INSERTed the ledger row and emitted AGAIN → duplicate
 * notifications.
 *
 * This spec drives the REAL collaborators end to end —
 *   CoachFirstPaymentService → FirstPaymentEmitter → NotificationsService —
 * against a fake DB that models the two write surfaces precisely:
 *
 *   - `prisma.notification.create(...)`  → writes to the COMMITTED store
 *     immediately (autocommit; survives a rollback). This is the BUGGY surface.
 *   - `tx.notification.create(...)`      → writes to a TX-scoped buffer that is
 *     only merged into the committed store on commit() and DISCARDED on
 *     rollback(). This is the FIXED surface.
 *
 * If the fix is in place, the emit writes ride `tx`, so a rollback leaves ZERO
 * committed notification rows. The test then simulates Stripe redelivery (a
 * fresh tx, ledger re-INSERT wins again) and asserts EXACTLY ONE committed
 * notification row of each channel after the second, successful commit.
 *
 * No live DB.
 */

import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { CoachFirstPaymentService } from '../coach-first-payment.service';
import { FirstPaymentEmitter } from '../emitters/first-payment.emitter';
import { NotificationsService } from '../notifications.service';
import { PrismaService } from '../../prisma.service';
import { asStub } from './_first-payment-test-stubs';

interface NotificationRow {
  user_id: string;
  kind: string;
  channel: string;
}

// Narrow surface the autocommit path touches. Declared as a `Pick<>` of the
// real PrismaService so the fake is shaped honestly; the final widening to the
// full type goes through the single `asStub` seam (no `as unknown as`).
type PrismaSurface = Pick<
  PrismaService,
  'notification' | 'notificationPreferences'
>;

/**
 * A fake Postgres-ish DB that distinguishes committed writes from tx-scoped
 * writes, modelling commit/rollback semantics for the two delegates the emit
 * path touches: notification + coachFirstPaymentNotification.
 */
class FakeDb {
  /** Rows that have actually committed (visible after the tx resolves). */
  committedNotifications: NotificationRow[] = [];
  committedCoachIds = new Set<string>();

  /** Build the autocommit client surface (NotificationsService.this.prisma). */
  makePrismaSurface(): PrismaSurface {
    const surface = {
      // NotificationsService.getPreferences reads this; null → defaults (all on).
      notificationPreferences: {
        findUnique: async () => null,
      },
      // The BUGGY surface: a write here commits immediately, ignoring any
      // outer rollback.
      notification: {
        create: async ({ data }: { data: NotificationRow }) => {
          this.committedNotifications.push({
            user_id: data.user_id,
            kind: data.kind,
            channel: data.channel,
          });
          return { id: `n_${this.committedNotifications.length}`, ...data };
        },
      },
    };
    return asStub<PrismaSurface>(surface);
  }

  /**
   * Open a transaction. Writes through the returned `tx` are buffered and only
   * land in the committed store on commit(); rollback() throws them away.
   */
  begin() {
    const bufferedNotifications: NotificationRow[] = [];
    const bufferedCoachIds = new Set<string>();

    const txSurface = {
      notificationPreferences: {
        findUnique: async () => null,
      },
      notification: {
        create: async ({ data }: { data: NotificationRow }) => {
          bufferedNotifications.push({
            user_id: data.user_id,
            kind: data.kind,
            channel: data.channel,
          });
          return { id: `tx_n_${bufferedNotifications.length}`, ...data };
        },
      },
      coachFirstPaymentNotification: {
        create: async ({ data }: { data: { coachId: string } }) => {
          if (
            this.committedCoachIds.has(data.coachId) ||
            bufferedCoachIds.has(data.coachId)
          ) {
            throw new PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
              meta: { target: ['coachId'] },
            });
          }
          bufferedCoachIds.add(data.coachId);
          return { id: `tx_row_${data.coachId}`, ...data };
        },
      },
    };
    const tx = asStub<Prisma.TransactionClient>(txSurface);

    const commit = () => {
      this.committedNotifications.push(...bufferedNotifications);
      bufferedCoachIds.forEach((id) => this.committedCoachIds.add(id));
    };
    const rollback = () => {
      bufferedNotifications.length = 0;
      bufferedCoachIds.clear();
    };

    return { tx, commit, rollback };
  }
}

function buildService(db: FakeDb) {
  // Real NotificationsService wired only to the autocommit surface; no audit /
  // voice (both @Optional). The `Pick` keeps the fake honest about which
  // delegates the production path actually uses — a single `as` (no
  // `as unknown as`) because the fake is a structural subtype of PrismaSurface.
  const prismaSurface = db.makePrismaSurface();
  const notifications = new NotificationsService(asStub<PrismaService>(prismaSurface));
  const emitter = new FirstPaymentEmitter(notifications);
  const service = new CoachFirstPaymentService(emitter);
  return { service };
}

const INPUT = {
  coachId: 'coach_1',
  amount: 4999,
  currency: 'usd',
  clientId: 'client_1',
};

describe('first-payment emit rides the purchase transaction (R81 F1/F2)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    // NotificationsService applies an in-PROCESS push rate-limit (1 push per
    // user+kind per 60s) tracked in a module-level Map that is NOT
    // transactional and persists across emits/tests. To keep every push write
    // observable here, advance a fake clock far past the window on each
    // Date.now() read so no emit is ever rate-limited.
    let clock = 1_000_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      clock += 120_000; // +2 min per read → always outside the 60s window
      return clock;
    });
  });
  afterAll(() => jest.restoreAllMocks());

  it('ledger INSERT succeeds then outer tx ROLLS BACK → ZERO committed notification rows', async () => {
    const db = new FakeDb();
    const { service } = buildService(db);
    const { tx, rollback } = db.begin();

    // The emit runs inside the tx (ledger row + notification rows all buffered).
    await service.tryEmitFirstPayment(tx, INPUT);

    // Something downstream (e.g. the fanout resolver) throws → outer rollback.
    rollback();

    // The whole point of the fix: nothing committed.
    expect(db.committedNotifications).toHaveLength(0);
    expect(db.committedCoachIds.size).toBe(0);
  });

  it('after rollback, Stripe REDELIVERS → exactly ONE notification row per channel commits (no duplicate)', async () => {
    const db = new FakeDb();
    const { service } = buildService(db);

    // ── Delivery #1: emit, then the outer tx rolls back. ──
    const first = db.begin();
    await service.tryEmitFirstPayment(first.tx, INPUT);
    first.rollback();
    expect(db.committedNotifications).toHaveLength(0);

    // ── Delivery #2 (Stripe retry): fresh tx, ledger re-INSERT wins again
    //     (because delivery #1 was rolled back), emit fires, tx COMMITS. ──
    const second = db.begin();
    await service.tryEmitFirstPayment(second.tx, INPUT);
    second.commit();

    // Exactly one inapp + one push committed — the ledger gates the emit and
    // the rows rode the (now-committed) tx. No duplicate from delivery #1.
    expect(db.committedNotifications).toHaveLength(2);
    const channels = db.committedNotifications.map((n) => n.channel).sort();
    expect(channels).toEqual(['inapp', 'push']);
    expect(db.committedCoachIds.size).toBe(1);
  });

  it('happy path: emit inside tx, then COMMIT → notification rows persist exactly once', async () => {
    const db = new FakeDb();
    const { service } = buildService(db);
    const { tx, commit } = db.begin();

    await service.tryEmitFirstPayment(tx, INPUT);
    // No rollback — the outer $transaction commits.
    commit();

    expect(db.committedNotifications).toHaveLength(2);
    expect(db.committedCoachIds.size).toBe(1);
  });
});
