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
import type { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

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

  it('the query carries the current-coach rule for the caller', async () => {
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

// B1 (L-SB, b#946): only the client's current coach. A team assistant, a
// former coach and an old team's assistant after a move never see, count or
// dismiss a safety alert; other alert types keep the team rule. The fake
// evaluates the real where clauses.
describe('owner 4: the current coach only', () => {
  type Row = {
    id: string;
    coach_id: string;
    client_id: string;
    alert_type: string;
    message: string;
    payload: unknown;
    created_at: Date;
    acknowledged_at: Date | null;
  };
  function matches(row: Row & { client: { coach_id: string | null } }, w: any): boolean {
    if (!w) return true;
    if (w.AND && !w.AND.every((x: unknown) => matches(row, x))) return false;
    if (w.OR && !w.OR.some((x: unknown) => matches(row, x))) return false;
    if (w.id !== undefined && row.id !== w.id) return false;
    if (w.coach_id !== undefined && row.coach_id !== w.coach_id) return false;
    if (w.client_id?.in && !w.client_id.in.includes(row.client_id)) return false;
    if (w.alert_type?.in && !w.alert_type.in.includes(row.alert_type)) return false;
    if (w.alert_type?.notIn && w.alert_type.notIn.includes(row.alert_type)) return false;
    if (w.acknowledged_at === null && row.acknowledged_at !== null) return false;
    if (w.client?.coach_id !== undefined && row.client.coach_id !== w.client.coach_id) return false;
    return true;
  }
  function world(clientCoach: string) {
    const users = [{ id: 'client-1', name: 'Jane Doe', coach_id: clientCoach }];
    const rows: Row[] = [
      ['a-safe', 'roman_urgent_reply', URGENT_PUSH, { roman_message_id: 'm1' }],
      ['a-ed', 'roman_eating_disorder_reply', ED_PUSH, { roman_message_id: 'm1' }],
      ['a-labs', 'bloodwork_review', 'New labs uploaded.', null],
    ].map(([id, alert_type, message, payload]) => ({
      id: id as string,
      coach_id: 'coach-1',
      client_id: 'client-1',
      alert_type: alert_type as string,
      message: message as string,
      payload,
      created_at: new Date('2026-10-12T09:00:00Z'),
      acknowledged_at: null,
    }));
    const joined = () =>
      rows.map((r) => ({ ...r, client: { name: 'Jane Doe', coach_id: users[0].coach_id } }));
    const prisma = {
      coachAlert: {
        findMany: jest.fn(async ({ where }: { where: unknown }) => joined().filter((r) => matches(r, where))),
        count: jest.fn(async ({ where }: { where: unknown }) => joined().filter((r) => matches(r, where)).length),
        findFirst: jest.fn(async ({ where }: { where: unknown }) => joined().find((r) => matches(r, where)) ?? null),
        updateMany: jest.fn(async ({ where, data }: { where: unknown; data: { acknowledged_at: Date } }) => {
          const hit = joined().filter((r) => matches(r, where));
          for (const h of hit) rows.find((r) => r.id === h.id)!.acknowledged_at = data.acknowledged_at;
          return { count: hit.length };
        }),
      },
      romanMessage: {
        findMany: jest.fn(async () => [
          { id: 'm1', user_id: 'client-1', content: 'A persistent-vomiting message.', created_at: new Date() },
        ]),
      },
      user: { findMany: jest.fn(async () => []) },
    };
    // Team scope: head coach-1 sees its roster; assistant sub-1 has an open
    // assignment to client-1 under head coach-1 (still open after a move).
    const scope = {
      getAuthorizedClientIds: jest.fn(async (id: string) =>
        id === 'sub-1' || users[0].coach_id === id ? ['client-1'] : [],
      ),
      getHeadCoachIdForSubCoach: jest.fn(async (id: string) => (id === 'sub-1' ? 'coach-1' : null)),
    };
    const svc = new CommandCenterService(
      fakeOf<PrismaService>(prisma),
      fakeOf<AdminPtmService>({}),
      new CoachAlertsService(fakeOf<PrismaService>(prisma)),
      fakeOf<SubCoachScopeService>(scope),
    );
    return { svc, rows };
  }
  const types = async (svc: CommandCenterService, caller: string) =>
    (await svc.getActionQueue(caller, {})).items.map((i) => i.alert_type);

  it('the current coach sees both safety alerts and the quote, and can dismiss one', async () => {
    const { svc, rows } = world('coach-1');
    const out = await svc.getActionQueue('coach-1', {});
    expect(out.items.map((i) => i.alert_type)).toEqual([
      'roman_urgent_reply',
      'roman_eating_disorder_reply',
      'bloodwork_review',
    ]);
    expect(out.items[0].quote).toBe('A persistent-vomiting message.');
    await expect(svc.dismissAlert('a-safe', 'coach-1')).resolves.toEqual({ ok: true });
    expect(rows[0].acknowledged_at).not.toBeNull();
  });

  it('an assistant assigned to the client sees no safety alert and no quote, and cannot dismiss one', async () => {
    const { svc, rows } = world('coach-1');
    const out = await svc.getActionQueue('sub-1', {});
    expect(out.items.map((i) => i.alert_type)).toEqual(['bloodwork_review']);
    expect(out.total_pending).toBe(1);
    expect(JSON.stringify(out)).not.toContain('persistent-vomiting');
    await expect(svc.dismissAlert('a-safe', 'sub-1')).rejects.toThrow('Alert not found');
    expect(rows[0].acknowledged_at).toBeNull();
    await expect(svc.dismissAlert('a-labs', 'sub-1')).resolves.toEqual({ ok: true });
  });

  it('after the client moves, the former coach and the old team assistant lose it at once', async () => {
    const { svc } = world('coach-2');
    expect(await types(svc, 'coach-1')).toEqual([]);
    expect(await types(svc, 'sub-1')).toEqual(['bloodwork_review']);
    await expect(svc.dismissAlert('a-ed', 'sub-1')).rejects.toThrow('Alert not found');
  });
});
