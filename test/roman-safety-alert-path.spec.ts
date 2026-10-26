// test/roman-safety-alert-path.spec.ts
//
// SAFETY-PROOF (owner facts): safety alerts are never lost or merged; urgent
// alerts go out at once; eating-disorder alerts wait until 08:00 in the
// coach's time and still deliver. One path, from the alert Roman writes
// (CoachAlertsService.createAlert, input pinned in
// test/roman/roman-urgent-symptoms.spec.ts) to the coach's phone, with the
// real emitter, NotificationsService and push outbox worker.
//
// The case no other suite covers: a coach with 100 clients on an ordinary
// morning. The pushes held overnight leave together at 08:00 and use up the
// coach's push burst cap (USER_WINDOW_MAX per USER_WINDOW_MS). The urgent and
// crisis alert pushes skip that cap; the eating-disorder push waits for room
// and is never dropped. No network, no DB, no client message text.

import type { ExpoPushMessage } from 'expo-server-sdk';
import { CoachAlertsService, type CoachAlertType } from '../src/coach/coach-alerts.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import { COACH_SAFETY_ALERT_SCREEN, SAFETY_ALERT_PUSH_BODY } from '../src/notifications/push/lock-screen-copy';
import {
  PushDeliveryService,
  USER_WINDOW_MAX,
  USER_WINDOW_MS,
} from '../src/notifications/push/push-delivery.service';
import type { PrismaService } from '../src/prisma.service';
import { fakeOf } from './ai-egress/ai-egress.fakes';
import { pushOutboxWorld } from './utils/push-outbox-fake';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
// Quiet hours are 21:00-08:00 in the coach's own zone (New York here).
const NIGHT = new Date('2026-06-03T02:00:00Z'); // 22:00
const MORNING = new Date('2026-06-03T12:00:00Z'); // 08:00
const minutesAfter8 = (m: number) => new Date(MORNING.getTime() + m * 60_000);

let clock = NIGHT;
class Clocked extends PushDeliveryService {
  protected now(): Date {
    return clock;
  }
}

function coachPhone() {
  clock = NIGHT;
  const w = pushOutboxWorld({
    now: () => clock,
    tokens: { 'coach-1': TOKEN },
    prefs: { 'coach-1': { timezone: 'America/New_York', timezone_updated_at: new Date('2026-06-01T00:00:00Z') } },
  });
  const alerts: Array<Record<string, unknown>> = [];
  const db = {
    ...w.db,
    notification: { create: jest.fn(async ({ data }: { data: object }) => ({ id: 'n1', ...data })) },
    coachAlert: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `alert-${alerts.length + 1}`, ...data };
        alerts.push(row);
        return row;
      }),
    },
  };
  const send = jest.fn(async (m: ExpoPushMessage[]) => m.map((_, i) => ({ status: 'ok' as const, id: `t-${i}` })));
  const delivery = new Clocked(fakeOf<PrismaService>(Object.create(db)), { send, getReceipts: jest.fn(async () => ({})) });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(fakeOf<PrismaService>(Object.create(db)), undefined, undefined, delivery);
  const coachAlerts = new CoachAlertsService(fakeOf<PrismaService>(db), new CoachAlertEmitter(notifications));
  return {
    rows: w.rows,
    alerts,
    inbox: db.notification.create,
    drain: () => delivery.drain(),
    // The alert type, line and severity Roman writes for one client (roman.service.ts).
    alert: (alertType: CoachAlertType, clientId: string) =>
      coachAlerts.createAlert({
        coachId: 'coach-1', clientId, alertType, message: SAFETY_ALERT_PUSH_BODY[alertType],
        severity: alertType === 'roman_eating_disorder_reply' ? 'warning' : 'critical',
      }),
    // An ordinary push: a new message in one client's thread.
    message: (i: number) =>
      notifications.sendPush({
        user_id: 'coach-1',
        kind: NotificationKind.MESSAGE_RECEIVED,
        body: 'New message',
        deep_link: `tgp://messages/client-${i}`,
      }),
    // The safety pushes that reached the phone, in order: [line, the alert it opens].
    alertLines: () =>
      send.mock.calls
        .map(([[m]]) => ({ body: m.body, tap: m.data as { actionScreen?: string; actionParams?: unknown } }))
        .filter(({ tap }) => tap.actionScreen === COACH_SAFETY_ALERT_SCREEN)
        .map(({ body, tap }) => [body, tap.actionParams]),
  };
}

describe('a busy morning on the coach phone (owner: never lost or merged, urgent at once, eating-disorder at 08:00)', () => {
  it.each(['roman_urgent_reply', 'roman_crisis_reply'] as const)(
    '%s goes out at once past the burst cap; the night\'s eating-disorder push waits for room and still arrives',
    async (urgentType) => {
      const p = coachPhone();
      // 22:00: clients write, and one gets the eating-disorder reply. Every push waits for 08:00.
      for (let i = 1; i <= USER_WINDOW_MAX; i += 1) await p.message(i);
      await p.alert('roman_eating_disorder_reply', 'client-ed');
      expect(await p.drain()).toBe(0);
      // The in-app alert is in the coach's inbox at once; only its push waits.
      expect(p.inbox).toHaveBeenCalledTimes(1);

      // 08:00: the night's pushes leave and use up the coach's burst cap; the
      // eating-disorder push is held for room, not dropped.
      clock = MORNING;
      expect(await p.drain()).toBe(USER_WINDOW_MAX);
      const room = minutesAfter8(USER_WINDOW_MS / 60_000);
      expect(p.rows.find((r) => r.dedupe_key === 'coach_alert:alert-1')).toMatchObject({
        status: 'pending',
        deferred_reason: 'burst_cap',
        not_before: room,
      });

      // 08:01: an urgent or crisis reply. Its push goes now, cap or not.
      clock = minutesAfter8(1);
      await p.alert(urgentType, 'client-u');
      expect(await p.drain()).toBe(1);
      expect(p.alertLines()).toEqual([[SAFETY_ALERT_PUSH_BODY[urgentType], { alertId: 'alert-2' }]]);

      // When there is room: the eating-disorder push arrives with its own line,
      // opening its own alert.
      clock = room;
      expect(await p.drain()).toBe(1);
      expect(p.alertLines()).toEqual([
        [SAFETY_ALERT_PUSH_BODY[urgentType], { alertId: 'alert-2' }],
        [SAFETY_ALERT_PUSH_BODY.roman_eating_disorder_reply, { alertId: 'alert-1' }],
      ]);

      // Never lost or merged: both alerts stored, every push sent, none folded.
      expect(p.alerts.map((a) => [a.alert_type, a.client_id])).toEqual([
        ['roman_eating_disorder_reply', 'client-ed'],
        [urgentType, 'client-u'],
      ]);
      expect(p.inbox).toHaveBeenCalledTimes(2);
      expect(p.rows).toHaveLength(USER_WINDOW_MAX + 2);
      expect(p.rows.every((r) => r.status === 'sent')).toBe(true);
    },
  );
});
