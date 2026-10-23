// test/roman-safety-coach-alerts.spec.ts
//
// B-R1F (owner 22a, 57, 57w, 57x): the two Roman safety coach alerts on the
// coach side. The stored row and every push name no one and carry no message;
// the alert card (action queue) is built for the client's current coach only,
// with the client's one triggering message. R1F-2: the urgent push breaks
// quiet hours (owner 57q), and a push or inbox tap reads that one alert by id
// (owner 57d). No network, no DB.

import { NotFoundException } from '@nestjs/common';
import { CoachAlertsService, onceAlertId } from '../src/coach/coach-alerts.service';
import { CoachAlertsController } from '../src/coach/coach-alerts.controller';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { CommandCenterController } from '../src/coach/command-center/command-center.controller';
import type { ChurnInterventionService } from '../src/coach/command-center/churn-intervention.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  COACH_SAFETY_ALERT_SCREEN,
  SAFETY_ALERT_PUSH_BODY,
  lockScreenCopy,
} from '../src/notifications/push/lock-screen-copy';
import { fakeOf } from './ai-egress/ai-egress.fakes';
import type { PrismaService } from '../src/prisma.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import type { AdminPtmService } from '../src/admin/ptm/admin-ptm.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import type { ExpoPushMessage } from 'expo-server-sdk';
import { NotificationsService as RealNotificationsService } from '../src/notifications/notifications.service';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { whereMatches } from './utils/notification-where';

const URGENT_PUSH = 'Urgent safety alert for one of your clients. Open TGP to see details.';
const ED_PUSH = 'Safety alert for one of your clients. Open TGP to see details.';
// Owner 57d: the coach's inbox row for the same alerts.
const URGENT_INBOX = 'Urgent safety alert for one of your clients. Tap to see details.';
const ED_INBOX = 'Safety alert for one of your clients. Tap to see details.';
// ROMAN-CRISIS-ALERT: the approved in-app title, first name only.
const CRISIS_LINE = 'Roman sent Jane a crisis safety reply. Please check in with them today.';

describe('the lock-screen push', () => {
  it('is the fixed line for each safety alert, under the coach-alert title, and never the alert text', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    const urgent = lockScreenCopy(NotificationKind.COACH_ALERT, 'Jane Doe', { safetyAlert: 'roman_urgent_reply' }, now);
    const ed = lockScreenCopy(NotificationKind.COACH_ALERT, 'Jane Doe', { safetyAlert: 'roman_eating_disorder_reply' }, now);
    const plain = lockScreenCopy(NotificationKind.COACH_ALERT, 'Jane Doe', {}, now);
    expect(urgent).toEqual({ title: plain.title, body: URGENT_PUSH });
    expect(ed).toEqual({ title: plain.title, body: ED_PUSH });
    expect(lockScreenCopy(NotificationKind.COACH_ALERT, 'x', { safetyAlert: 'toString' }, now)).toEqual(plain);
    // ROMAN-CRISIS-ALERT: the crisis alert reuses the approved urgent line.
    expect(SAFETY_ALERT_PUSH_BODY).toEqual({
      roman_urgent_reply: URGENT_PUSH,
      roman_eating_disorder_reply: ED_PUSH,
      roman_crisis_reply: URGENT_PUSH,
    });
  });
});

describe('the emitter', () => {
  function emitter() {
    const create = jest.fn(async (_input: Record<string, unknown>) => ({ id: 'n1' }));
    const sendPush = jest.fn(async (_input: Record<string, unknown>) => ({ sent: 1, failed: 0 }));
    return { e: new CoachAlertEmitter(fakeOf<NotificationsService>({ createNotification: create, sendPush })), create, sendPush };
  }
  const base = { coachId: 'coach-1', alertId: 'a1', severity: 'critical', clientUserId: 'client-1' };

  it.each([
    ['roman_urgent_reply', URGENT_PUSH, URGENT_INBOX],
    ['roman_eating_disorder_reply', ED_PUSH, ED_INBOX],
    ['roman_crisis_reply', URGENT_PUSH, URGENT_INBOX],
  ])('%s: the inbox row has its own line, and the row and the push open that alert', async (alertType, push, inbox) => {
    const { e, create, sendPush } = emitter();
    await e.emit({ ...base, alertType, message: push });
    const tap = { actionScreen: COACH_SAFETY_ALERT_SCREEN, actionParams: { alertId: 'a1' } };
    expect(create.mock.calls[0][0]).toMatchObject({ body: inbox, payload: { alertId: 'a1', alertType, ...tap } });
    expect(sendPush.mock.calls[0][0]).toMatchObject({ context: { safetyAlert: alertType, alertId: 'a1' } });
  });

  it('owner 57q: each safety alert is one push of its own; only the urgent and crisis ones are urgent', async () => {
    const { e, sendPush } = emitter();
    await e.emit({ ...base, alertType: 'roman_urgent_reply', message: URGENT_PUSH });
    await e.emit({ ...base, alertId: 'a2', alertType: 'roman_eating_disorder_reply', message: ED_PUSH });
    await e.emit({ ...base, alertId: 'a3', alertType: 'roman_crisis_reply', message: URGENT_PUSH });
    expect(sendPush.mock.calls[0][0]).toMatchObject({ urgent: true, dedupe_key: 'coach_alert:a1' });
    expect(sendPush.mock.calls[1][0]).toMatchObject({ dedupe_key: 'coach_alert:a2' });
    expect(sendPush.mock.calls[1][0]).not.toHaveProperty('urgent');
    expect(sendPush.mock.calls[2][0]).toMatchObject({ urgent: true, dedupe_key: 'coach_alert:a3', body: URGENT_PUSH });
  });

  it('any other alert is unchanged', async () => {
    const { e, create, sendPush } = emitter();
    await e.emit({ ...base, alertType: 'streak_dropped', message: 'Streak dropped.' });
    expect(create.mock.calls[0][0]).toMatchObject({ body: 'Streak dropped.' });
    expect(create.mock.calls[0][0].payload).not.toHaveProperty('actionScreen');
    expect(sendPush.mock.calls[0][0]).not.toHaveProperty('context');
    expect(sendPush.mock.calls[0][0]).not.toHaveProperty('urgent');
    expect(sendPush.mock.calls[0][0]).not.toHaveProperty('dedupe_key');
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
  function queue(opts: { messages?: Array<Record<string, unknown>>; crisisName?: string } = {}) {
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
      {
        // Roman stores no message id on a crisis alert; even one is never read.
        id: 'a-crisis',
        coach_id: 'coach-1',
        client_id: 'client-1',
        alert_type: 'roman_crisis_reply',
        message: URGENT_PUSH,
        payload: { roman_message_id: 'm1' },
        created_at: new Date('2026-10-12T06:00:00Z'),
        acknowledged_at: null,
        client: { name: opts.crisisName ?? 'Jane Doe' },
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
    expect(out.items[3]).toEqual({
      alert_id: 'a-crisis',
      client_id: 'client-1',
      client_name: 'Jane Doe',
      alert_type: 'roman_crisis_reply',
      message: CRISIS_LINE,
      created_at: '2026-10-12T06:00:00.000Z',
      dismissed_at: null,
      quote: null,
      sent_at: null,
    });
    expect(prisma.romanMessage.findMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['m1', 'm2'] }, role: 'user', session: { deleted_at: null } },
    });
  });

  // The crisis card's first name: a leading space or a one-word name still
  // gives it; with no word in the name, the name as the urgent card shows it.
  it.each([
    [' Jane Doe', 'Jane'],
    ['Jane', 'Jane'],
    ['  ', '  '],
  ])('the crisis card names %j as %j', async (crisisName, first) => {
    const { svc } = queue({ crisisName });
    const out = await svc.getActionQueue('coach-1', {});
    expect(out.items[3].message).toBe(CRISIS_LINE.replace('Jane', first));
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
    if (w.coach_id !== undefined && !(w.coach_id.in ?? [w.coach_id]).includes(row.coach_id)) return false;
    if (w.client_id?.in && !w.client_id.in.includes(row.client_id)) return false;
    if (w.alert_type?.in && !w.alert_type.in.includes(row.alert_type)) return false;
    if (w.alert_type?.notIn && w.alert_type.notIn.includes(row.alert_type)) return false;
    if (w.acknowledged_at === null && row.acknowledged_at !== null) return false;
    if (w.client?.coach_id !== undefined && row.client.coach_id !== w.client.coach_id) return false;
    return true;
  }
  const SENT_AT = new Date('2026-10-12T08:59:00Z');
  function world(clientCoach: string) {
    const users = [{ id: 'client-1', name: 'Jane Doe', coach_id: clientCoach }];
    const rows: Row[] = [
      ['a-safe', 'roman_urgent_reply', URGENT_PUSH, { roman_message_id: 'm1' }],
      ['a-ed', 'roman_eating_disorder_reply', ED_PUSH, { roman_message_id: 'm1' }],
      ['a-labs', 'bloodwork_review', 'New labs uploaded.', null],
      ['a-crisis', 'roman_crisis_reply', URGENT_PUSH, null],
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
          { id: 'm1', user_id: 'client-1', content: 'A persistent-vomiting message.', created_at: SENT_AT },
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
    return { svc, rows, prisma };
  }
  const types = async (svc: CommandCenterService, caller: string) =>
    (await svc.getActionQueue(caller, {})).items.map((i) => i.alert_type);

  it('the current coach sees every safety alert and the quote, and can dismiss one', async () => {
    const { svc, rows } = world('coach-1');
    const out = await svc.getActionQueue('coach-1', {});
    expect(out.items.map((i) => i.alert_type)).toEqual([
      'roman_urgent_reply',
      'roman_eating_disorder_reply',
      'bloodwork_review',
      'roman_crisis_reply',
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
    await expect(svc.dismissAlert('a-crisis', 'coach-1')).rejects.toThrow('Alert not found');
  });

  it('ROMAN-CRISIS-ALERT by id: the current coach opens it with no quote; others get the 404', async () => {
    const { svc, prisma } = world('coach-1');
    await expect(svc.getSafetyAlert('a-crisis', 'coach-1')).resolves.toMatchObject({
      alert_type: 'roman_crisis_reply',
      message: CRISIS_LINE,
      quote: null,
      sent_at: null,
    });
    expect(prisma.romanMessage.findMany).not.toHaveBeenCalled();
    await expect(svc.getSafetyAlert('a-crisis', 'sub-1')).rejects.toThrow('Alert not found');
    await expect(world('coach-2').svc.getSafetyAlert('a-crisis', 'coach-1')).rejects.toThrow('Alert not found');
  });

  // Owner 57d: the tap of a push or inbox row reads that one alert by id.
  it('by id: the current coach gets the queue row, also after dismissing it', async () => {
    const { svc, rows } = world('coach-1');
    const item = await svc.getSafetyAlert('a-safe', 'coach-1');
    expect(item).toEqual((await svc.getActionQueue('coach-1', {})).items[0]);
    expect(item).toMatchObject({
      alert_id: 'a-safe',
      client_name: 'Jane Doe',
      alert_type: 'roman_urgent_reply',
      message: 'Urgent: Roman sent Jane Doe a medical safety reply. Check in with them →',
      quote: 'A persistent-vomiting message.',
      sent_at: SENT_AT.toISOString(),
    });
    rows[0].acknowledged_at = new Date('2026-10-12T10:00:00Z');
    await expect(svc.getSafetyAlert('a-safe', 'coach-1')).resolves.toMatchObject({
      dismissed_at: '2026-10-12T10:00:00.000Z',
    });
  });

  it('by id: an assistant, a former coach, another alert type or a deleted message is the same 404', async () => {
    const team = world('coach-1');
    await expect(team.svc.getSafetyAlert('a-safe', 'sub-1')).rejects.toThrow('Alert not found');
    await expect(team.svc.getSafetyAlert('a-labs', 'coach-1')).rejects.toThrow('Alert not found');
    team.prisma.romanMessage.findMany.mockResolvedValueOnce([]);
    await expect(team.svc.getSafetyAlert('a-ed', 'coach-1')).rejects.toThrow('Alert not found');
    const moved = world('coach-2');
    await expect(moved.svc.getSafetyAlert('a-safe', 'coach-1')).rejects.toThrow('Alert not found');
    await expect(moved.svc.getSafetyAlert('a-safe', 'sub-1')).rejects.toThrow('Alert not found');
  });

  // B1 (FIX1030), owner 4: one current-coach rule on every path that reads or
  // changes a coach alert or its inbox row, for every alert type. Coach-1's
  // client has one alert of each type, each put in coach-1's inbox by the real
  // emitter, and coach-1 has two other inbox rows (a payout notice, a digest).
  // Control: coach-1 reaches all of it. Then the client moves to coach-2, and
  // coach-1 reaches none of the alerts at once; the two other rows stay.
  describe('after a move, the former coach loses every alert path at once', () => {
    type N = { id: string; user_id: string; kind: string; deep_link: string | null; read_at: Date | null; inbox_hidden: boolean };
    const TYPES = ['roman_crisis_reply', 'roman_urgent_reply', 'roman_eating_disorder_reply', 'bloodwork_review'];
    async function world(move: boolean) {
      const users = [{ id: 'client-1', coach_id: 'coach-1' }];
      const rows: Row[] = TYPES.map((alert_type, i) => ({
        id: `a-${i}`,
        coach_id: 'coach-1',
        client_id: 'client-1',
        alert_type,
        message: 'Fixed line.',
        payload: alert_type === 'roman_crisis_reply' ? null : { roman_message_id: 'm1' },
        created_at: new Date('2026-10-12T09:00:00Z'),
        acknowledged_at: null,
      }));
      const other = { user_id: 'coach-1', read_at: null, inbox_hidden: false };
      const inbox: N[] = [
        { ...other, id: 'n-payout', kind: NotificationKind.COACH_ALERT, deep_link: 'tgp://coach/payouts' },
        { ...other, id: 'n-digest', kind: 'coach_digest', deep_link: null },
      ];
      const hits = (where: unknown) => inbox.filter((r) => whereMatches(r, where));
      const joined = () => rows.map((r) => ({ ...r, client: { name: 'Jane Doe', coach_id: users[0].coach_id } }));
      const prisma = {
        userBlock: { findMany: jest.fn(async () => []) },
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
          findMany: jest.fn(async () => [{ id: 'm1', user_id: 'client-1', content: 'A message.', created_at: SENT_AT }]),
        },
        user: {
          findUnique: jest.fn(async () => ({ role: 'coach', coach_id: null })),
          findMany: jest.fn(async ({ where }: { where: { coach_id: string } }) => users.filter((u) => u.coach_id === where.coach_id)),
        },
        subCoachAssignment: { findMany: jest.fn(async () => []) },
        coachingSession: { findMany: jest.fn(async () => []) },
        notification: {
          findMany: jest.fn(async ({ where, take }: { where: unknown; take: number }) => hits(where).slice(0, take)),
          count: jest.fn(async ({ where }: { where: unknown }) => hits(where).length),
          findFirst: jest.fn(async ({ where }: { where: unknown }) => hits(where)[0] ?? null),
          update: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) =>
            Object.assign(inbox.find((r) => r.id === where.id)!, data),
          ),
          updateMany: jest.fn(async ({ where, data }: { where: unknown; data: object }) => ({
            count: hits(where).map((r) => Object.assign(r, data)).length,
          })),
        },
        checkIn: { groupBy: jest.fn(async () => []), count: jest.fn(async () => 0) },
        ptmPrediction: { groupBy: jest.fn(async () => []) },
        clientSignal: { groupBy: jest.fn(async () => []) },
        coachMessage: { count: jest.fn(async () => 0) },
      };
      const emitter = new CoachAlertEmitter(
        fakeOf<NotificationsService>({
          createNotification: async (n: Omit<N, 'id' | 'read_at' | 'inbox_hidden'>) =>
            inbox.push({ ...n, id: `n-${inbox.length}`, read_at: null, inbox_hidden: false }),
          sendPush: async () => null,
        }),
      );
      for (const r of rows) {
        await emitter.emit({ coachId: r.coach_id, alertId: r.id, alertType: r.alert_type, message: r.message, severity: 'critical', clientUserId: r.client_id });
      }
      const alerts = new CoachAlertsService(fakeOf<PrismaService>(prisma));
      const scope = {
        getAuthorizedClientIds: async (id: string) => users.filter((u) => u.coach_id === id).map((u) => u.id),
        getHeadCoachIdForSubCoach: async () => null,
      };
      const cc = new CommandCenterService(fakeOf<PrismaService>(prisma), fakeOf<AdminPtmService>({}), alerts, fakeOf<SubCoachScopeService>(scope));
      const alertInbox = inbox.filter((r) => r.deep_link === 'tgp://coach/clients/client-1').map((r) => r.id);
      expect(alertInbox).toHaveLength(TYPES.length);
      if (move) users[0].coach_id = 'coach-2';
      return {
        ids: rows.map((r) => r.id),
        alertInbox,
        alerts: new CoachAlertsController(alerts),
        cc: new CommandCenterController(cc, fakeOf<ChurnInterventionService>({})),
        inbox: new NotificationsController(new RealNotificationsService(fakeOf<PrismaService>(prisma))),
      };
    }
    type W = Awaited<ReturnType<typeof world>>;
    const req = fakeOf<AuthedRequest>({ user: { id: 'coach-1' } });
    // How many of the ids the path serves; its 404 counts as none.
    const served = async (ids: string[], call: (id: string) => Promise<unknown>) => {
      let n = 0;
      for (const id of ids) {
        n += await call(id).then(
          () => 1,
          (e: unknown) => {
            if (e instanceof NotFoundException) return 0;
            throw e;
          },
        );
      }
      return n;
    };
    const PATHS: Array<[string, number, number, (w: W) => Promise<number>]> = [
      ['GET /coach/alerts', 4, 0, async (w) => (await w.alerts.list(req)).length],
      ['POST /coach/alerts/:id/acknowledge', 4, 0, (w) => served(w.ids, (id) => w.alerts.acknowledge(req, id))],
      ['GET /coach/command-center/overview (open alerts)', 4, 0, async (w) => (await w.cc.getOverview(req)).open_alerts],
      ['GET /coach/command-center/action-queue', 4, 0, async (w) => (await w.cc.getActionQueue(req)).items.length],
      ['GET /coach/command-center/action-queue/:alertId (safety types)', 3, 0, (w) => served(w.ids, (id) => w.cc.getSafetyAlert(req, id))],
      ['POST /coach/command-center/action-queue/:alertId/dismiss', 4, 0, (w) => served(w.ids, (id) => w.cc.dismissAlert(req, id))],
      ['GET /notifications (rows)', 6, 2, async (w) => (await w.inbox.listNotifications(req, {})).items.length],
      ['GET /notifications (unread count)', 6, 2, async (w) => (await w.inbox.listNotifications(req, {})).unreadCount],
      ['GET /notifications/unread-count', 6, 2, async (w) => (await w.inbox.getUnreadCount(req)).count],
      ['POST /notifications/:id/read', 4, 0, (w) => served(w.alertInbox, (id) => w.inbox.markRead(id, req))],
      ['POST /notifications/mark-all-read', 6, 2, async (w) => (await w.inbox.markAllRead(req)).updated],
    ];
    it.each(PATHS)('%s: %i for the current coach, then %i once the client has moved', async (_path, before, after, run) => {
      expect(await run(await world(false))).toBe(before);
      expect(await run(await world(true))).toBe(after);
    });
  });

  // Owner 57q and the team chain: Roman writes the alert to the client's coach
  // of record, which can be a team sub-coach. The real SubCoachScopeService:
  // head coach-1 has seats for sub-1 and sub-2; each coaches one client.
  function team() {
    const users = [
      { id: 'coach-1', role: 'coach', coach_id: null, name: 'Head' },
      { id: 'sub-1', role: 'coach', coach_id: 'coach-1', name: 'Sub one' },
      { id: 'sub-2', role: 'coach', coach_id: 'coach-1', name: 'Sub two' },
      { id: 'client-1', role: 'student', coach_id: 'sub-1', name: 'Jane Doe' },
      { id: 'client-2', role: 'student', coach_id: 'sub-2', name: 'Sam Lee' },
      { id: 'client-3', role: 'student', coach_id: 'coach-1', name: 'Ana Ruiz' },
    ];
    const rows: Row[] = [
      ['a-sub1', 'sub-1', 'client-1'],
      ['a-sub2', 'sub-2', 'client-2'],
      ['a-head', 'coach-1', 'client-3'],
    ].map(([id, coach_id, client_id]) => ({
      id,
      coach_id,
      client_id,
      alert_type: 'roman_urgent_reply',
      message: URGENT_PUSH,
      payload: { roman_message_id: `m-${client_id}` },
      created_at: new Date('2026-10-12T09:00:00Z'),
      acknowledged_at: null,
    }));
    const joined = () =>
      rows.map((r) => {
        const c = users.find((u) => u.id === r.client_id)!;
        return { ...r, client: { name: c.name, coach_id: c.coach_id } };
      });
    const prisma = {
      userBlock: { findMany: jest.fn(async () => []) },
      user: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          users.find((u) => u.id === where.id) ?? null,
        ),
        findMany: jest.fn(async ({ where }: { where: { coach_id: string } }) =>
          users.filter((u) => u.role === 'student' && u.coach_id === where.coach_id),
        ),
      },
      teamSubCoachAssignment: {
        findFirst: jest.fn(async ({ where }: { where: { head_coach_id: string; sub_coach_id: string } }) =>
          where.head_coach_id === 'coach-1' && ['sub-1', 'sub-2'].includes(where.sub_coach_id) ? { id: 'seat' } : null,
        ),
      },
      subCoachAssignment: { findMany: jest.fn(async () => []) },
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
        findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id, user_id: id.replace(/^m-/, ''), content: 'The client message.', created_at: SENT_AT })),
        ),
      },
      checkIn: { groupBy: jest.fn(async () => []), count: jest.fn(async () => 0) },
      ptmPrediction: { groupBy: jest.fn(async () => []) },
      clientSignal: { groupBy: jest.fn(async () => []) },
      coachMessage: { count: jest.fn(async () => 0) },
    };
    const db = fakeOf<PrismaService>(prisma);
    const svc = new CommandCenterService(
      db,
      fakeOf<AdminPtmService>({}),
      new CoachAlertsService(db),
      new SubCoachScopeService(db),
    );
    return { svc, rows, prisma };
  }
  const ids = async (svc: CommandCenterService, caller: string) => {
    const out = await svc.getActionQueue(caller, {});
    const overview = await svc.getOverview(caller);
    return { ids: out.items.map((i) => i.alert_id), total: out.total_pending, open: overview.open_alerts };
  };

  it('a team sub-coach sees, counts, opens and dismisses the safety alert written to them', async () => {
    const { svc, rows } = team();
    expect(await ids(svc, 'sub-1')).toEqual({ ids: ['a-sub1'], total: 1, open: 1 });
    await expect(svc.getSafetyAlert('a-sub1', 'sub-1')).resolves.toMatchObject({
      alert_id: 'a-sub1',
      client_name: 'Jane Doe',
      quote: 'The client message.',
    });
    await expect(svc.dismissAlert('a-sub1', 'sub-1')).resolves.toEqual({ ok: true });
    expect(rows[0].acknowledged_at).not.toBeNull();
    expect(await ids(svc, 'sub-1')).toEqual({ ids: [], total: 0, open: 0 });
  });

  it('another sub-coach on the same team never sees, opens or dismisses it', async () => {
    const { svc, rows } = team();
    expect(await ids(svc, 'sub-2')).toEqual({ ids: ['a-sub2'], total: 1, open: 1 });
    await expect(svc.getSafetyAlert('a-sub1', 'sub-2')).rejects.toThrow('Alert not found');
    await expect(svc.dismissAlert('a-sub1', 'sub-2')).rejects.toThrow('Alert not found');
    expect(rows[0].acknowledged_at).toBeNull();
  });

  it('the head coach is unchanged: their own alerts, read under their own id only', async () => {
    const { svc, prisma } = team();
    expect(await ids(svc, 'coach-1')).toEqual({ ids: ['a-head'], total: 1, open: 1 });
    expect(prisma.coachAlert.findMany.mock.calls[0][0]).toMatchObject({ where: { coach_id: 'coach-1' } });
    await expect(svc.dismissAlert('a-head', 'coach-1')).resolves.toEqual({ ok: true });
  });
});

// B1 (L-OB, b#946): the push worker re-renders the lock screen from the
// stored context at send time, so the safety line must survive the outbox.
// Real emitter, NotificationsService and PushDeliveryService; Expo mocked.
describe('the coach phone receives the safety push line', () => {
  const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
  const AFTERNOON = new Date('2026-06-02T18:00:00Z'); // 14:00 New York
  let clock = AFTERNOON;
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return clock;
    }
  }
  function phone(at: Date) {
    clock = at;
    const w = pushOutboxWorld({
      now: () => clock,
      tokens: { 'coach-1': TOKEN },
      prefs: { 'coach-1': { timezone: 'America/New_York', timezone_updated_at: new Date('2026-06-01T00:00:00Z') } },
    });
    const db = { ...w.db, notification: { create: jest.fn(async ({ data }: { data: object }) => ({ id: 'n1', ...data })) } };
    const send = jest.fn(async (m: ExpoPushMessage[]) => m.map((_, i) => ({ status: 'ok' as const, id: `t-${i}` })));
    const delivery = new Clocked(fakeOf<PrismaService>(Object.create(db)), { send, getReceipts: jest.fn(async () => ({})) });
    delivery.autoDrain = false;
    const notifications = new RealNotificationsService(fakeOf<PrismaService>(Object.create(db)), undefined, undefined, delivery);
    const emit = (alertType: string, message: string, alertId = 'a1') =>
      new CoachAlertEmitter(notifications).emit({
        coachId: 'coach-1',
        alertId,
        alertType,
        severity: 'critical',
        message,
        clientUserId: 'client-1',
      });
    return { rows: w.rows, delivery, send, emit };
  }
  async function deliver(alertType: string, message: string) {
    const p = phone(AFTERNOON);
    await p.emit(alertType, message);
    expect(await p.delivery.drain()).toBe(1);
    return p.send.mock.calls[0][0][0];
  }

  it.each([
    ['roman_urgent_reply', URGENT_PUSH],
    ['roman_eating_disorder_reply', ED_PUSH],
    ['roman_crisis_reply', URGENT_PUSH],
  ])('%s: the exact line under "Client update", opening that alert', async (alertType, line) => {
    const sent = await deliver(alertType, line);
    expect(sent).toMatchObject({ to: TOKEN, title: 'Client update', body: line });
    expect(sent.data).toMatchObject({
      actionScreen: COACH_SAFETY_ALERT_SCREEN,
      actionParams: { alertId: 'a1' },
      kind: NotificationKind.COACH_ALERT,
    });
  });

  it('any other coach alert keeps the generic line', async () => {
    const sent = await deliver('streak_dropped', 'Streak dropped.');
    expect(sent.body).toBe('There is a new update about a client. Open the app to see it.');
    expect(sent.data).toMatchObject({ actionScreen: 'NotificationCenter' });
  });

  // Owner 57q: quiet hours are 21:00-08:00 in the coach's zone (New York).
  const NIGHT = new Date('2026-06-03T02:00:00Z'); // 22:00
  const DAWN = new Date('2026-06-03T11:59:00Z'); // 07:59
  const MORNING = new Date('2026-06-03T12:00:00Z'); // 08:00

  it.each([
    ['22:00', 'roman_urgent_reply', NIGHT],
    ['07:59', 'roman_urgent_reply', DAWN],
    ['22:00', 'roman_crisis_reply', NIGHT],
  ])('at %s the %s push goes out at once', async (_label, alertType, at) => {
    const p = phone(at);
    await p.emit(alertType, URGENT_PUSH);
    expect(p.rows[0]).toMatchObject({ urgent: true, not_before: at, deferred_reason: null });
    expect(await p.delivery.drain()).toBe(1);
    expect(p.send.mock.calls[0][0][0]).toMatchObject({ body: URGENT_PUSH });
  });

  it.each([
    ['22:00', NIGHT],
    ['07:59', DAWN],
  ])('at %s the eating-disorder alert push still waits until 08:00', async (_label, at) => {
    const p = phone(at);
    await p.emit('roman_eating_disorder_reply', ED_PUSH);
    expect(p.rows[0]).toMatchObject({ urgent: false, not_before: MORNING, deferred_reason: 'quiet_hours' });
    expect(await p.delivery.drain()).toBe(0);
    expect(p.send).not.toHaveBeenCalled();
    clock = MORNING;
    expect(await p.delivery.drain()).toBe(1);
    expect(p.send.mock.calls[0][0][0]).toMatchObject({ body: ED_PUSH });
  });

  it.each([
    ['before it', ['ed', 'urgent']],
    ['while it waits to be sent', ['urgent', 'ed']],
    ['just after it was sent', ['urgent', 'send', 'ed']],
  ])('at 22:00, an eating-disorder alert %s leaves the urgent push whole and still waits until 08:00', async (_label, steps) => {
    const p = phone(NIGHT);
    for (const step of steps) {
      if (step === 'urgent') await p.emit('roman_urgent_reply', URGENT_PUSH, 'a-urgent');
      if (step === 'ed') await p.emit('roman_eating_disorder_reply', ED_PUSH, 'a-ed');
      if (step === 'send') await p.delivery.drain();
    }
    await p.delivery.drain();
    const sent = () =>
      p.send.mock.calls.map(([[m]]) => [m.body, (m.data as { actionParams?: unknown }).actionParams]);
    expect(sent()).toEqual([[URGENT_PUSH, { alertId: 'a-urgent' }]]);
    expect(p.rows.find((r) => !r.urgent)).toMatchObject({ not_before: MORNING, deferred_reason: 'quiet_hours' });
    clock = MORNING;
    await p.delivery.drain();
    expect(sent()).toEqual([
      [URGENT_PUSH, { alertId: 'a-urgent' }],
      [ED_PUSH, { alertId: 'a-ed' }],
    ]);
  });

  // EDPUSH (owner 57q): the eating-disorder push waits for 08:00 on its own
  // row. An ordinary coach alert for the same client (same collapse key)
  // never takes it over, and it never takes over the ordinary one.
  const OTHER_PUSH = 'There is a new update about a client. Open the app to see it.';
  const lines = (p: ReturnType<typeof phone>) =>
    p.send.mock.calls.map(([[m]]) => [m.body, (m.data as { actionParams?: unknown }).actionParams]);

  it.each([
    ['then an ordinary coach alert', ['ed', 'other']],
    ['after an ordinary coach alert', ['other', 'ed']],
  ])('at 22:00, an eating-disorder alert %s: at 08:00 both arrive, each with its own line', async (_label, steps) => {
    const p = phone(NIGHT);
    for (const step of steps) {
      if (step === 'ed') await p.emit('roman_eating_disorder_reply', ED_PUSH, 'a-ed');
      if (step === 'other') await p.emit('streak_dropped', 'Streak dropped.', 'a-other');
    }
    expect(p.rows).toHaveLength(2);
    expect(p.rows.find((r) => r.dedupe_key === 'coach_alert:a-ed')).toMatchObject({
      urgent: false,
      not_before: MORNING,
      deferred_reason: 'quiet_hours',
    });
    expect(await p.delivery.drain()).toBe(0);
    clock = MORNING;
    expect(await p.delivery.drain()).toBe(2);
    expect(lines(p)).toHaveLength(2);
    expect(lines(p)).toEqual(
      expect.arrayContaining([
        [ED_PUSH, { alertId: 'a-ed' }],
        [OTHER_PUSH, undefined],
      ]),
    );
  });

  it('at 08:00, an ordinary coach alert just after the eating-disorder push was sent is not folded into it', async () => {
    const p = phone(NIGHT);
    await p.emit('roman_eating_disorder_reply', ED_PUSH, 'a-ed');
    clock = MORNING;
    expect(await p.delivery.drain()).toBe(1);
    clock = new Date(MORNING.getTime() + 20_000);
    await p.emit('streak_dropped', 'Streak dropped.', 'a-other');
    expect(await p.delivery.drain()).toBe(1);
    expect(lines(p)).toEqual([
      [ED_PUSH, { alertId: 'a-ed' }],
      [OTHER_PUSH, undefined],
    ]);
  });
});

describe('GET /coach/command-center/action-queue/:alertId (owner 57d)', () => {
  it('reads that one alert for the signed-in coach', async () => {
    const getSafetyAlert = jest.fn(async () => ({ alert_id: 'a1' }));
    const controller = new CommandCenterController(
      fakeOf<CommandCenterService>({ getSafetyAlert }),
      fakeOf<ChurnInterventionService>({}),
    );
    expect(Reflect.getMetadata('path', CommandCenterController.prototype.getSafetyAlert)).toBe(
      'action-queue/:alertId',
    );
    const req = fakeOf<AuthedRequest>({ user: { id: 'coach-1' } });
    await expect(controller.getSafetyAlert(req, 'a1')).resolves.toEqual({
      alert_id: 'a1',
    });
    expect(getSafetyAlert).toHaveBeenCalledWith('a1', 'coach-1');
  });
});
