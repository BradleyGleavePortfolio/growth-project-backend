// test/command-center-photo-safety-alert.spec.ts
//
// FR-1152 (#172-5 op 2): the space chat photo safety alert,
// 'community_photo_safety', on the coach side. It is a safety alert
// everywhere the Roman ones are: no dedupe, the fixed push and inbox lines
// (the approved urgent ones), the tap to that one alert, the Command Center
// card for the current coach only, and no quote (nothing the client wrote is
// shown, as on the crisis alert). No network, no DB.

import { CoachAlertsService, ROMAN_SAFETY_ALERT_TYPES, type CoachAlertType } from '../src/coach/coach-alerts.service';
import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  COACH_SAFETY_ALERT_SCREEN,
  SAFETY_ALERT_INBOX_BODY,
  SAFETY_ALERT_PUSH_BODY,
  lockScreenCopy,
} from '../src/notifications/push/lock-screen-copy';
import { fakeOf } from './ai-egress/ai-egress.fakes';
import type { PrismaService } from '../src/prisma.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import type { AdminPtmService } from '../src/admin/ptm/admin-ptm.service';
import type { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

const TYPE: CoachAlertType = 'community_photo_safety';
const URGENT_PUSH = 'Urgent safety alert for one of your clients. Open TGP to see details.';
const URGENT_INBOX = 'Urgent safety alert for one of your clients. Tap to see details.';
const CARD_LINE = 'Our safety check stopped a space chat photo from Jane. Please check in with them today.';

describe('the photo safety alert type', () => {
  it('is a safety alert type, with the approved urgent push and inbox lines', () => {
    expect(ROMAN_SAFETY_ALERT_TYPES).toContain(TYPE);
    expect(SAFETY_ALERT_PUSH_BODY[TYPE]).toBe(URGENT_PUSH);
    expect(SAFETY_ALERT_INBOX_BODY[TYPE]).toBe(URGENT_INBOX);
    const now = new Date('2026-10-24T12:00:00Z');
    const plain = lockScreenCopy(NotificationKind.COACH_ALERT, 'Jane Doe', {}, now);
    expect(lockScreenCopy(NotificationKind.COACH_ALERT, 'Jane Doe', { safetyAlert: TYPE }, now)).toEqual({
      title: plain.title,
      body: URGENT_PUSH,
    });
  });

  it('every refusal writes its own row (no dedupe, as the crisis alert), holding only the fixed line', async () => {
    let n = 0;
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `a${(n += 1)}`, ...data }));
    const findFirst = jest.fn(async () => ({ id: 'old' }));
    const svc = new CoachAlertsService(fakeOf<PrismaService>({ coachAlert: { create, findFirst } }));
    const input = { coachId: 'coach-1', clientId: 'client-1', alertType: TYPE, severity: 'critical' as const, message: URGENT_PUSH };
    await svc.createAlert(input);
    await svc.createAlert(input);
    expect(findFirst).not.toHaveBeenCalled();
    expect(create.mock.calls.map(([a]) => a.data)).toEqual([
      expect.objectContaining({ alert_type: TYPE, severity: 'critical', message: URGENT_PUSH, payload: null }),
      expect.objectContaining({ alert_type: TYPE, severity: 'critical', message: URGENT_PUSH, payload: null }),
    ]);
  });

  it('the inbox row has the fixed line, and the row and the push open that one alert', async () => {
    const create = jest.fn(async (_input: Record<string, unknown>) => ({ id: 'n1' }));
    const sendPush = jest.fn(async (_input: Record<string, unknown>) => ({ sent: 1, failed: 0 }));
    const e = new CoachAlertEmitter(fakeOf<NotificationsService>({ createNotification: create, sendPush }));
    await e.emit({ coachId: 'coach-1', alertId: 'a1', severity: 'critical', clientUserId: 'client-1', alertType: TYPE, message: URGENT_PUSH });
    const tap = { actionScreen: COACH_SAFETY_ALERT_SCREEN, actionParams: { alertId: 'a1' } };
    expect(create.mock.calls[0][0]).toMatchObject({ body: URGENT_INBOX, payload: { alertId: 'a1', alertType: TYPE, ...tap } });
    // FR-1154 (now in main): a critical safety alert's push is urgent, as the crisis one's is (#172-5 "the same alert").
    expect(sendPush.mock.calls[0][0]).toMatchObject({ context: { safetyAlert: TYPE, alertId: 'a1' }, urgent: true });
  });
});

describe('the photo safety alert in the Command Center', () => {
  const row = (payload: unknown = null) => ({
    id: 'a-photo',
    coach_id: 'coach-1',
    client_id: 'client-1',
    alert_type: TYPE,
    message: URGENT_PUSH,
    payload,
    created_at: new Date('2026-10-24T09:00:00Z'),
    acknowledged_at: null,
    client: { name: 'Jane Doe' },
  });
  function center(alert = row()) {
    const prisma = {
      user: { findMany: jest.fn(async () => [{ id: 'client-1' }]) },
      coachAlert: {
        findMany: jest.fn(async (_a: unknown) => [alert]),
        count: jest.fn(async () => 1),
        findFirst: jest.fn(async (_a: unknown) => alert),
      },
      romanMessage: { findMany: jest.fn(async (_a: unknown) => [{ id: 'm1', user_id: 'client-1', content: 'never shown', created_at: new Date() }]) },
      communityCohort: { findMany: jest.fn(async () => []) }, // FR-1152R3 B1: leads no public space
    };
    const scope = {
      getAuthorizedClientIds: jest.fn(async () => ['client-1']),
      getHeadCoachIdForSubCoach: jest.fn(async () => null),
    };
    const svc = new CommandCenterService(
      fakeOf<PrismaService>(prisma),
      fakeOf<AdminPtmService>({}),
      fakeOf<CoachAlertsService>({}),
      fakeOf<SubCoachScopeService>(scope),
    );
    return { svc, prisma };
  }

  it('the queue card names the client by first name, with no quote', async () => {
    const { svc, prisma } = center(row({ roman_message_id: 'm1' })); // even a stray id is never read
    const out = await svc.getActionQueue('coach-1', {});
    expect(out.items).toEqual([
      {
        alert_id: 'a-photo',
        client_id: 'client-1',
        client_name: 'Jane Doe',
        alert_type: TYPE,
        message: CARD_LINE,
        created_at: '2026-10-24T09:00:00.000Z',
        dismissed_at: null,
        quote: null,
        sent_at: null,
      },
    ]);
    expect(prisma.romanMessage.findMany).not.toHaveBeenCalled();
    // Read as a safety alert: the current-coach rule's safety branch names it.
    expect(JSON.stringify(prisma.coachAlert.findMany.mock.calls[0][0])).toContain(TYPE);
  });

  it('the tap opens it by id with no quote, not a 404', async () => {
    const { svc, prisma } = center();
    await expect(svc.getSafetyAlert('a-photo', 'coach-1')).resolves.toMatchObject({
      alert_id: 'a-photo',
      alert_type: TYPE,
      message: CARD_LINE,
      quote: null,
      sent_at: null,
    });
    expect(prisma.romanMessage.findMany).not.toHaveBeenCalled();
    expect(prisma.coachAlert.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'a-photo', alert_type: { in: expect.arrayContaining([TYPE]) } },
    });
  });
});
