/**
 * FIRST-PAYMENT-PUSH (OB1, b#1154 AUDIT 6388619778): a coach whose first client
 * pays gets the phone push, not only the inbox row and its hidden twin. The
 * push carries the lock-screen line for its kind (never the inbox body), it
 * passes Mute all (FIRST_PAYMENT is a money kind), it rides the purchase
 * transaction, and a webhook retry never sends it twice.
 */
import type { Prisma } from '@prisma/client';
import { CoachFirstPaymentService } from '../src/notifications/coach-first-payment.service';
import { FirstPaymentEmitter } from '../src/notifications/emitters/first-payment.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import { lockScreenCopy } from '../src/notifications/push/lock-screen-copy';
import { ExpoPushClient, PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const TOKEN = 'ExponentPushToken[firstpaymentpush]';
const COACH = 'coach-fp';
const PAYLOAD = { amount: 4900, currency: 'usd', clientId: 'client-fp' };
const INBOX_BODY = 'You just landed your first client. Your first payment is on its way.';

function world() {
  const w = pushOutboxWorld({ now: () => new Date() });
  const inbox: Array<Record<string, unknown>> = [];
  const db = {
    ...w.db,
    // B-LSNOTIFY3-1: the first-payment step's SAVEPOINT / RELEASE / ROLLBACK TO.
    $executeRaw: jest.fn(async () => 0),
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        inbox.push(a.data);
        return { id: `n-${inbox.length}`, ...a.data };
      }),
    },
  };
  const send = jest.fn(async (m: unknown[]) => m.map((_x, i) => ({ status: 'ok', id: `ticket-${i}` })));
  const client = stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) });
  const delivery = new PushDeliveryService(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), client);
  delivery.autoDrain = false;
  const svc = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  w.tokens[COACH] = TOKEN;
  w.prefs[COACH] = { muted: true }; // Mute all on: a money push still goes out
  const tx = stub<Prisma.TransactionClient>(db);
  const outbox = w.rows;
  const queued = () =>
    outbox.map((r) => ({
      kind: r.kind,
      title: r.title,
      body: r.body,
      dedupe_key: r.dedupe_key,
      deepLink: (r.data as { deepLink?: string } | null)?.deepLink,
    }));
  return { db, tx, inbox, outbox, queued, send, delivery, svc, emitter: new FirstPaymentEmitter(svc) };
}

describe('FIRST-PAYMENT-PUSH: the coach gets the first-payment push', () => {
  it('queues one push with the lock-screen line, never the inbox body, and sends it with Mute all on', async () => {
    const w = world();
    await w.emitter.emit(COACH, PAYLOAD, w.tx);

    expect(w.inbox.map((r) => r.channel)).toEqual(['inapp', 'push']);
    const line = lockScreenCopy(NotificationKind.FIRST_PAYMENT, INBOX_BODY);
    expect(w.queued()).toEqual([
      {
        kind: NotificationKind.FIRST_PAYMENT,
        title: line.title,
        body: line.body,
        dedupe_key: `first_payment:${COACH}`,
        deepLink: `tgp://coach/clients/${PAYLOAD.clientId}`,
      },
    ]);
    expect(line.body).not.toBe(INBOX_BODY);
    expect(JSON.stringify(w.queued())).not.toMatch(/first client|first payment|4900|usd/i);

    await w.delivery.drain();
    expect(w.outbox.map((r) => [r.user_id, r.status])).toEqual([[COACH, 'sent']]);
    expect(w.send).toHaveBeenCalledTimes(1);
    expect(w.send.mock.calls[0][0]).toEqual([expect.objectContaining({ to: TOKEN, title: line.title, body: line.body })]);
  });

  it('a webhook retry (the ledger row already exists) queues no second push', async () => {
    const w = world();
    let ledger = 0;
    const tx = stub<Prisma.TransactionClient>({
      ...w.db,
      coachFirstPaymentNotification: {
        // B-LSNOTIFY-1: ON CONFLICT DO NOTHING — the retry counts 0, no throw.
        createMany: jest.fn(async () => {
          ledger += 1;
          return { count: ledger > 1 ? 0 : 1 };
        }),
      },
    });
    const service = new CoachFirstPaymentService(w.emitter);
    await service.tryEmitFirstPayment(tx, { coachId: COACH, ...PAYLOAD });
    await service.tryEmitFirstPayment(tx, { coachId: COACH, ...PAYLOAD });
    expect(w.outbox).toHaveLength(1);
  });

  it('the dedupe key keeps one push even if the emitter itself runs twice', async () => {
    const w = world();
    const push = jest.spyOn(w.svc, 'sendPush');
    await w.emitter.emit(COACH, PAYLOAD, w.tx);
    await w.emitter.emit(COACH, PAYLOAD, w.tx);
    expect(push).toHaveBeenCalledTimes(2);
    await expect(push.mock.results[1].value).resolves.toEqual(expect.objectContaining({ code: 'duplicate' }));
    expect(w.outbox).toHaveLength(1);
  });

  it('inside the purchase transaction a failed queue write fails the emit (the first-payment step then rolls back to its savepoint; see first-payment-notice-savepoint.spec)', async () => {
    const w = world();
    const tx = stub<Prisma.TransactionClient>({
      ...w.db,
      pushOutbox: {
        ...w.db.pushOutbox,
        createMany: jest.fn(async () => {
          throw new Error('outbox down');
        }),
      },
    });
    await expect(w.emitter.emit(COACH, PAYLOAD, tx)).rejects.toThrow('outbox down');
    expect(w.outbox).toHaveLength(0);
  });
});
