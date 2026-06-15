/**
 * first-payment-throttle-rollback.integration.spec.ts — Roman P4 (Option C),
 * R81 (PR-395/#402 rebuild, N1 — push throttle pre-commit mutation).
 *
 * N1 (post-merge audit, P1): NotificationsService.createNotification() mutated
 * the module-level in-process push throttle (`recentPushes`) BEFORE the ambient
 * purchase transaction committed. If the outer Stripe webhook transaction rolls
 * back after the emit and Stripe redelivers the SAME event within 60 seconds,
 * the throttle Map still holds the primed entry → the retry commits the in-app
 * row but SILENTLY DROPS the push row.
 *
 * The pre-existing rollback suites
 *   (first-payment-tx-rollback.integration.spec.ts,
 *    first-payment-webhook.integration.spec.ts)
 * hide this bug by faking `Date.now()` to advance 120s on every read, so the
 * 60s window is never hit. This spec is the missing regression: it does NOT
 * advance time. The retry happens inside the same 60s window the throttle would
 * otherwise block — exactly the production condition (Stripe retries can arrive
 * immediately).
 *
 * Expected behaviour with the N1 fix in place: transactional emits (a `tx` is
 * supplied) never touch `recentPushes` — exactly-once is enforced by the
 * DB-backed CoachFirstPaymentNotification.coachId @unique ledger — so the
 * rolled-back delivery #1 leaves the throttle untouched and delivery #2 commits
 * BOTH the inapp and push rows.
 *
 * On the OLD (buggy) code this test FAILS: delivery #1 primes `recentPushes`
 * before rollback, and delivery #2 (same frozen-time window) drops the push,
 * leaving only the inapp row committed.
 *
 * No live DB.
 */

import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { CoachFirstPaymentService } from '../coach-first-payment.service';
import { FirstPaymentEmitter } from '../emitters/first-payment.emitter';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';
import { PrismaService } from '../../prisma.service';
import { asStub } from './_first-payment-test-stubs';

interface NotificationRow {
  user_id: string;
  kind: string;
  channel: string;
}

type PrismaSurface = Pick<
  PrismaService,
  'notification' | 'notificationPreferences'
>;

/**
 * Fake Postgres-ish DB modelling commit/rollback for the two delegates the emit
 * path touches (notification + coachFirstPaymentNotification). Mirrors the
 * harness in first-payment-tx-rollback.integration.spec.ts.
 */
class FakeDb {
  committedNotifications: NotificationRow[] = [];
  committedCoachIds = new Set<string>();

  makePrismaSurface(): PrismaSurface {
    const surface = {
      notificationPreferences: {
        findUnique: async () => null,
      },
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
  const prismaSurface = db.makePrismaSurface();
  const notifications = new NotificationsService(asStub<PrismaService>(prismaSurface));
  const emitter = new FirstPaymentEmitter(notifications);
  const service = new CoachFirstPaymentService(emitter);
  return { service };
}

describe('first-payment push survives rollback + immediate Stripe retry (R81 N1)', () => {
  let fixedNow: number;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    // CRITICAL: unlike the sibling rollback suites, we FREEZE time (no advance).
    // The Stripe redelivery below therefore lands INSIDE the 60s push-throttle
    // window — the exact production condition N1 describes. If the throttle is
    // (incorrectly) mutated by the rolled-back transactional emit, the retry's
    // push is dropped and this suite fails.
    fixedNow = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => fixedNow);
  });
  afterAll(() => jest.restoreAllMocks());

  it('rollback then SAME-WINDOW redelivery still commits BOTH inapp and push rows', async () => {
    const db = new FakeDb();
    const { service } = buildService(db);

    // A unique coach id so this assertion is independent of any other suite's
    // module-level throttle state for the shared 'first_payment' kind.
    const INPUT = {
      coachId: 'coach_n1_throttle',
      amount: 4999,
      currency: 'usd',
      clientId: 'client_n1',
    };

    // ── Delivery #1: emit inside the tx, then the outer tx ROLLS BACK. ──
    const first = db.begin();
    await service.tryEmitFirstPayment(first.tx, INPUT);
    first.rollback();
    expect(db.committedNotifications).toHaveLength(0);
    expect(db.committedCoachIds.size).toBe(0);

    // ── Delivery #2 (Stripe retry, SAME 60s window — time is frozen): fresh
    //     tx, ledger re-INSERT wins again, emit fires, tx COMMITS. ──
    const second = db.begin();
    await service.tryEmitFirstPayment(second.tx, INPUT);
    second.commit();

    // The push MUST NOT have been suppressed by throttle state left over from
    // the rolled-back delivery #1. Exactly one inapp + one push commit.
    expect(db.committedNotifications).toHaveLength(2);
    const channels = db.committedNotifications.map((n) => n.channel).sort();
    expect(channels).toEqual(['inapp', 'push']);
    expect(db.committedCoachIds.size).toBe(1);
  });

  it('two rolled-back deliveries then a committed third still emits the push (throttle never primed by tx emits)', async () => {
    const db = new FakeDb();
    const { service } = buildService(db);
    const INPUT = {
      coachId: 'coach_n1_throttle_2',
      amount: 1500,
      currency: 'usd',
      clientId: 'client_n1_2',
    };

    // Two consecutive rolled-back deliveries inside the frozen 60s window.
    for (let i = 0; i < 2; i++) {
      const d = db.begin();
      await service.tryEmitFirstPayment(d.tx, INPUT);
      d.rollback();
    }
    expect(db.committedNotifications).toHaveLength(0);

    // Third delivery commits — push must still fire.
    const final = db.begin();
    await service.tryEmitFirstPayment(final.tx, INPUT);
    final.commit();

    const channels = db.committedNotifications.map((n) => n.channel).sort();
    expect(channels).toEqual(['inapp', 'push']);
  });

  it('non-transactional push writes STILL honour the in-process throttle (no regression to the autocommit guard)', async () => {
    // The N1 fix only skips the throttle when a tx is present. Guard the
    // autocommit path: two back-to-back push writes in the frozen window must
    // collapse to one (throttle still active when tx is undefined).
    const db = new FakeDb();
    const prismaSurface = db.makePrismaSurface();
    const notifications = new NotificationsService(
      asStub<PrismaService>(prismaSurface),
    );

    const pushInput = {
      user_id: 'autocommit_user_n1',
      kind: NotificationKind.FIRST_PAYMENT,
      body: 'first payment!',
      channel: 'push' as const,
    };

    const firstWrite = await notifications.createNotification(pushInput);
    const secondWrite = await notifications.createNotification(pushInput);

    expect(firstWrite).not.toBeNull();
    // Second push within 60s (frozen clock) is rate-limited → null, not written.
    expect(secondWrite).toBeNull();
    expect(
      db.committedNotifications.filter((n) => n.channel === 'push'),
    ).toHaveLength(1);
  });
});
