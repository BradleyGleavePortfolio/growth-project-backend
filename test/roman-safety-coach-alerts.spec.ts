// test/roman-safety-coach-alerts.spec.ts
//
// B-R1F (owner 22a, 57, 57w, 57x): the two Roman safety coach alerts on the
// coach side. The stored row and every push name no one and carry no message;
// the alert card (action queue) is built for the client's current coach only,
// with the client's one triggering message. No network, no DB.

import { CoachAlertsService, onceAlertId } from '../src/coach/coach-alerts.service';
import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  COACH_ACTION_QUEUE_SCREEN,
  SAFETY_ALERT_PUSH_BODY,
  lockScreenCopy,
} from '../src/notifications/push/lock-screen-copy';
import { fakeOf } from './ai-egress/ai-egress.fakes';
import type { PrismaService } from '../src/prisma.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import type { AdminPtmService } from '../src/admin/ptm/admin-ptm.service';

const URGENT_PUSH = 'Urgent safety alert for one of your clients. Open TGP to see details.';
const ED_PUSH = 'Safety alert for one of your clients. Open TGP to see details.';

describe('the lock-screen push', () => {
  it('is the fixed line for each safety alert, under the coach-alert title, and never the alert text', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    const urgent = lockScreenCopy(NotificationKind.COACH_ALERT, 'Jane Doe', { safetyAlert: 'roman_urgent_reply' }, now);
    const ed = lockScreenCopy(NotificationKind.COACH_ALERT, 'Jane Doe', { safetyAlert: 'roman_eating_disorder_reply' }, now);
    const plain = lockScreenCopy(NotificationKind.COACH_ALERT, 'Jane Doe', {}, now);
    expect(urgent).toEqual({ title: plain.title, body: URGENT_PUSH });
    expect(ed).toEqual({ title: plain.title, body: ED_PUSH });
    expect(lockScreenCopy(NotificationKind.COACH_ALERT, 'x', { safetyAlert: 'toString' }, now)).toEqual(plain);
    expect(SAFETY_ALERT_PUSH_BODY).toEqual({ roman_urgent_reply: URGENT_PUSH, roman_eating_disorder_reply: ED_PUSH });
  });
});

describe('the emitter', () => {
  function emitter() {
    const create = jest.fn(async (_input: Record<string, unknown>) => ({ id: 'n1' }));
    const sendPush = jest.fn(async (_input: Record<string, unknown>) => ({ sent: 1, failed: 0 }));
    return { e: new CoachAlertEmitter(fakeOf<NotificationsService>({ createNotification: create, sendPush })), create, sendPush };
  }
  const base = { coachId: 'coach-1', alertId: 'a1', severity: 'critical', clientUserId: 'client-1' };

  it('a safety alert: the inbox row and the push open the action queue; the push gets the safety line', async () => {
    const { e, create, sendPush } = emitter();
    await e.emit({ ...base, alertType: 'roman_urgent_reply', message: URGENT_PUSH });
    expect(create.mock.calls[0][0]).toMatchObject({
      body: URGENT_PUSH,
      payload: { alertId: 'a1', alertType: 'roman_urgent_reply', actionScreen: COACH_ACTION_QUEUE_SCREEN },
    });
    expect(sendPush.mock.calls[0][0]).toMatchObject({ context: { safetyAlert: 'roman_urgent_reply' } });
  });

  it('any other alert is unchanged', async () => {
    const { e, create, sendPush } = emitter();
    await e.emit({ ...base, alertType: 'streak_dropped', message: 'Streak dropped.' });
    expect(create.mock.calls[0][0].payload).not.toHaveProperty('actionScreen');
    expect(sendPush.mock.calls[0][0]).not.toHaveProperty('context');
  });
});

describe('alert storage', () => {
  it('onceAlertId is stable per conversation, UUID-shaped and differs across conversations', () => {
    const a = onceAlertId('roman_eating_disorder_reply', 'sess_1');
    expect(a).toBe(onceAlertId('roman_eating_disorder_reply', 'sess_1'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(onceAlertId('roman_eating_disorder_reply', 'sess_2'));
  });

  it('the eating-disorder alert skips the 24h window and is written with its fixed id', async () => {
    const prisma = {
      coachAlert: {
        findFirst: jest.fn(async () => ({ id: 'older' })),
        create: jest.fn(async ({ data }: { data: object }) => ({ ...data })),
      },
    };
    const svc = new CoachAlertsService(fakeOf<PrismaService>(prisma));
    const id = onceAlertId('roman_eating_disorder_reply', 'sess_1');
    await svc.createAlert({
      id,
      coachId: 'coach-1',
      clientId: 'client-1',
      alertType: 'roman_eating_disorder_reply',
      message: ED_PUSH,
    });
    expect(prisma.coachAlert.findFirst).not.toHaveBeenCalled();
    expect(prisma.coachAlert.create.mock.calls[0][0]).toMatchObject({ data: { id, message: ED_PUSH } });
  });
});

describe('the alert card in the action queue', () => {
  const SENT = new Date('2026-10-12T09:41:00Z');
  function queue(opts: { messages?: Array<Record<string, unknown>> } = {}) {
    const alerts = [
      {
        id: 'a-urgent',
        coach_id: 'coach-1',
        client_id: 'client-1',
        alert_type: 'roman_urgent_reply',
        message: URGENT_PUSH,
        payload: { roman_message_id: 'm1' },
        created_at: new Date('2026-10-12T09:41:02Z'),
        acknowledged_at: null,
        client: { name: 'Jane Doe' },
      },
      {
        id: 'a-ed',
        coach_id: 'coach-1',
        client_id: 'client-2',
        alert_type: 'roman_eating_disorder_reply',
        message: ED_PUSH,
        payload: { roman_message_id: 'm2' },
        created_at: new Date('2026-10-12T08:00:00Z'),
        acknowledged_at: null,
        client: { name: 'Sam Lee' },
      },
      {
        id: 'a-other',
        coach_id: 'coach-1',
        client_id: 'client-1',
        alert_type: 'bloodwork_review',
        message: 'New labs uploaded.',
        payload: null,
        created_at: new Date('2026-10-12T07:00:00Z'),
        acknowledged_at: null,
        client: { name: 'Jane Doe' },
      },
    ];
    const messages = opts.messages ?? [
      { id: 'm1', user_id: 'client-1', content: 'A persistent-vomiting message, in full.', created_at: SENT },
      { id: 'm2', user_id: 'client-2', content: 'A below-the-floor calorie question.', created_at: SENT },
    ];
    const prisma = {
      user: { findMany: jest.fn(async () => [{ id: 'client-1' }, { id: 'client-2' }]) },
      coachAlert: { findMany: jest.fn(async (_a: unknown) => alerts), count: jest.fn(async () => alerts.length) },
      romanMessage: { findMany: jest.fn(async (_a: unknown) => messages) },
    };
    const svc = new CommandCenterService(
      fakeOf<PrismaService>(prisma),
      fakeOf<AdminPtmService>({}),
      fakeOf<CoachAlertsService>({}),
    );
    return { svc, prisma };
  }

  it('line 1 names the client; the quote and the time sent are the one triggering message', async () => {
    const { svc, prisma } = queue();
    const out = await svc.getActionQueue('coach-1', {});
    expect(out.items[0]).toMatchObject({
      alert_type: 'roman_urgent_reply',
      message: 'Urgent: Roman sent Jane Doe a medical safety reply. Check in with them →',
      quote: 'A persistent-vomiting message, in full.',
      sent_at: SENT.toISOString(),
    });
    expect(out.items[1]).toMatchObject({
      alert_type: 'roman_eating_disorder_reply',
      message: 'Roman sent Sam Lee an eating-disorder safety reply. Check in with them →',
      quote: 'A below-the-floor calorie question.',
    });
    expect(out.items[2]).toEqual(expect.not.objectContaining({ quote: expect.anything() }));
    expect(out.items[2].message).toBe('New labs uploaded.');
    expect(prisma.romanMessage.findMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['m1', 'm2'] }, role: 'user', session: { deleted_at: null } },
    });
  });

  it('only while the client is still with this coach (owner 4)', async () => {
    const { svc, prisma } = queue();
    await svc.getActionQueue('coach-1', {});
    const where = (prisma.coachAlert.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      coach_id: 'coach-1',
      client_id: { in: ['client-1', 'client-2'] },
      AND: [
        {
          OR: [
            { alert_type: { notIn: ['roman_urgent_reply', 'roman_eating_disorder_reply'] } },
            { client: { coach_id: 'coach-1' } },
          ],
        },
      ],
    });
  });

  it('a deleted chat or another person\'s message gives no quote', async () => {
    const { svc } = queue({
      messages: [{ id: 'm2', user_id: 'client-1', content: 'not this client', created_at: SENT }],
    });
    const out = await svc.getActionQueue('coach-1', {});
    expect(out.items[0]).toMatchObject({ quote: null, sent_at: null });
    expect(out.items[1]).toMatchObject({ quote: null, sent_at: null });
  });
});
