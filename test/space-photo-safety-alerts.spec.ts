// test/space-photo-safety-alerts.spec.ts
//
// FR-1152R3 B1 (LS-1152R3; owner rule D, 10-26): "ALL alerts and information
// go to the space owner and their team, plus your resident coach (or just the
// space owner if coachless)". A photo safety alert's space copy (payload
// space_id, written to the owner or a coach-role team member of a public
// space) is listed, counted, opened, dismissed, shown in the inbox and pushed
// to that reader while they still lead that public space, whoever coaches the
// poster. Only that type: a Roman alert, the resident copy and a row written
// to someone who does not lead the space keep the old rule. Real alert,
// Command Center, inbox, emitter and push services; Prisma faked over rows.
// No network, no DB.

import { NotFoundException } from '@nestjs/common';
import type { ExpoPushMessage } from 'expo-server-sdk';
import { CoachAlertsService, type CoachAlertType } from '../src/coach/coach-alerts.service';
import { CoachAlertsController } from '../src/coach/coach-alerts.controller';
import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { CommandCenterController } from '../src/coach/command-center/command-center.controller';
import { CoachService } from '../src/coach/coach.service';
import type { AuditService } from '../src/audit/audit.service';
import type { ChurnInterventionService } from '../src/coach/command-center/churn-intervention.service';
import type { AdminPtmService } from '../src/admin/ptm/admin-ptm.service';
import type { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import type { PrismaService } from '../src/prisma.service';
import { fakeOf } from './ai-egress/ai-egress.fakes';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { whereMatches } from './utils/notification-where';

const SPACE = 'space-1';
const OWNER = 'owner-1'; // owns the space's workspace; coaches no one
const TEAM = 'team-1'; // a coach-role assistant in the space
const RESIDENT = 'coach-9'; // Jane's coach; not in the space's team
const STRANGER = 'coach-7'; // no tie to the space
const JANE = 'client-1'; // RESIDENT's client
const SAM = 'client-2'; // coachless
const RESIDENT_PUSH = 'Urgent safety alert for one of your clients. Open TGP to see details.';
// Wording rows SPACE-PUSH and SPACE-INBOX (owner rule 137-2): the space owner
// and team are not told "one of your clients" about somebody else's client.
const SPACE_PUSH = 'Urgent safety alert in one of your spaces. Open TGP to see details.';
const SPACE_INBOX = 'Urgent safety alert in one of your spaces. Tap to see details.';
const SPACE_LINK = `tgp://coach/space-alerts/${SPACE}`;

// A Prisma where over plain rows: AND/OR/NOT, equality, null, in/notIn/not,
// a JSON path, `some` over a list relation and a nested to-one relation.
function fits(row: unknown, where: unknown): boolean {
  const r = (row ?? {}) as Record<string, unknown>;
  return Object.entries((where ?? {}) as Record<string, unknown>).every(([k, c]) => {
    if (k === 'AND') return [c].flat().every((x) => fits(r, x));
    if (k === 'OR') return (c as unknown[]).some((x) => fits(r, x));
    if (k === 'NOT') return [c].flat().every((x) => !fits(r, x));
    const v = r[k];
    if (c === null) return v === null || v === undefined;
    if (typeof c !== 'object' || c instanceof Date) return v === c;
    const o = c as Record<string, unknown>;
    if ('path' in o) return (o.path as string[]).reduce<unknown>((x, p) => (x as Record<string, unknown> | null)?.[p], v) === o.equals;
    if ('some' in o) return ((v ?? []) as unknown[]).some((x) => fits(x, o.some));
    if ('in' in o || 'notIn' in o || 'not' in o) {
      if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(v)) return false;
      return !('not' in o) || (o.not === null ? v !== null && v !== undefined : v !== o.not);
    }
    return v !== null && typeof v === 'object' && fits(v, o);
  });
}

type Alert = {
  id: string;
  coach_id: string;
  client_id: string;
  alert_type: string;
  severity: string;
  message: string;
  payload: unknown;
  created_at: Date;
  acknowledged_at: Date | null;
};
type Note = {
  id: string;
  user_id: string;
  kind: string;
  body: string;
  payload: Record<string, unknown>;
  deep_link: string | null;
  read_at: Date | null;
  inbox_hidden: boolean;
};
type Lead = 'leads' | 'team-removed' | 'private';

/** The public space, owned by OWNER, with TEAM as an active assistant. */
function publicSpace() {
  return {
    id: SPACE,
    visibility: 'public',
    workspace: { coach_id: OWNER },
    memberships: [{ user_id: TEAM, status: 'active', role: 'assistant' }],
  };
}

async function world(lead: Lead = 'leads') {
  const users = [
    { id: JANE, role: 'student', coach_id: RESIDENT, name: 'Jane Doe' },
    { id: SAM, role: 'student', coach_id: null, name: 'Sam Lee' },
  ];
  const space = publicSpace();
  const alerts: Alert[] = [];
  const inbox: Note[] = [];
  const joined = () => alerts.map((a) => ({ ...a, client: users.find((u) => u.id === a.client_id) }));
  const hits = (where: unknown) => inbox.filter((n) => whereMatches(n, where));
  const prisma = {
    coachAlert: {
      create: jest.fn(async ({ data }: { data: Omit<Alert, 'id' | 'created_at' | 'acknowledged_at'> }) => {
        const row: Alert = { ...data, id: `a-${alerts.length + 1}`, created_at: new Date('2026-10-28T09:00:00Z'), acknowledged_at: null };
        alerts.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: { where: unknown }) => joined().filter((r) => fits(r, where))),
      count: jest.fn(async ({ where }: { where: unknown }) => joined().filter((r) => fits(r, where)).length),
      findFirst: jest.fn(async ({ where }: { where: unknown }) => joined().find((r) => fits(r, where)) ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: unknown; data: { acknowledged_at: Date } }) => {
        const hit = joined().filter((r) => fits(r, where));
        for (const h of hit) alerts.find((a) => a.id === h.id)!.acknowledged_at = data.acknowledged_at;
        return { count: hit.length };
      }),
    },
    communityCohort: {
      findMany: jest.fn(async ({ where }: { where: unknown }) => [space].filter((c) => fits(c, where))),
    },
    user: {
      findUnique: jest.fn(async () => ({ role: 'coach', coach_id: null })),
      findMany: jest.fn(async ({ where }: { where: { coach_id: string } }) => users.filter((u) => u.coach_id === where.coach_id)),
      findFirst: jest.fn(async ({ where }: { where: unknown }) => users.find((u) => fits(u, where)) ?? null),
    },
    // The client card's other reads (CoachService.getClientSummary): none here.
    loggedFoodEntry: { findMany: jest.fn(async () => []) },
    weightLog: { findMany: jest.fn(async () => []) },
    workoutSession: { findMany: jest.fn(async () => []) },
    clientWorkoutAssignment: { findMany: jest.fn(async () => []) },
    userBlock: { findMany: jest.fn(async () => []) },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    coachingSession: { findMany: jest.fn(async () => []) },
    romanMessage: { findMany: jest.fn(async () => []) },
    notification: {
      findMany: jest.fn(async ({ where, take }: { where: unknown; take: number }) => hits(where).slice(0, take)),
      count: jest.fn(async ({ where }: { where: unknown }) => hits(where).length),
      findFirst: jest.fn(async ({ where }: { where: unknown }) => hits(where)[0] ?? null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) =>
        Object.assign(inbox.find((n) => n.id === where.id)!, data),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: unknown; data: object }) => ({
        count: hits(where).map((n) => Object.assign(n, data)).length,
      })),
    },
    checkIn: { groupBy: jest.fn(async () => []), count: jest.fn(async () => 0) },
    ptmPrediction: { groupBy: jest.fn(async () => []) },
    clientSignal: { groupBy: jest.fn(async () => []) },
    coachMessage: { count: jest.fn(async () => 0) },
  };
  const emitter = new CoachAlertEmitter(
    fakeOf<NotificationsService>({
      createNotification: async (n: Omit<Note, 'id' | 'read_at' | 'inbox_hidden'>) =>
        inbox.push({ ...n, id: `n-${inbox.length + 1}`, read_at: null, inbox_hidden: false }),
      sendPush: async () => null,
    }),
  );
  const svc = new CoachAlertsService(fakeOf<PrismaService>(prisma), emitter);
  const write = (coachId: string, clientId: string, alertType: CoachAlertType, message: string, payload?: Record<string, unknown>) =>
    svc.createAlert({ coachId, clientId, alertType, severity: 'critical', message, ...(payload ? { payload } : {}) });
  await write(OWNER, SAM, 'community_photo_safety', SPACE_PUSH, { space_id: SPACE }); // a-1: coachless poster
  await write(TEAM, SAM, 'community_photo_safety', SPACE_PUSH, { space_id: SPACE }); // a-2
  await write(OWNER, JANE, 'community_photo_safety', SPACE_PUSH, { space_id: SPACE }); // a-3: another coach's client
  await write(RESIDENT, JANE, 'community_photo_safety', RESIDENT_PUSH); // a-4: the resident copy
  // a-5: a Roman alert row is never a space copy, whatever its payload holds.
  await write(OWNER, SAM, 'roman_urgent_reply', RESIDENT_PUSH, { space_id: SPACE, roman_message_id: 'm1' });
  await write(STRANGER, SAM, 'community_photo_safety', SPACE_PUSH, { space_id: SPACE }); // a-6: STRANGER leads no space
  if (lead !== 'leads') space.memberships[0].status = 'removed';
  if (lead === 'private') space.visibility = 'clients';
  const scope = {
    getAuthorizedClientIds: async (id: string) => users.filter((u) => u.coach_id === id).map((u) => u.id),
    getHeadCoachIdForSubCoach: async () => null,
  };
  const cc = new CommandCenterService(fakeOf<PrismaService>(prisma), fakeOf<AdminPtmService>({}), svc, fakeOf<SubCoachScopeService>(scope));
  return {
    alerts,
    inbox,
    list: new CoachAlertsController(svc),
    cc: new CommandCenterController(cc, fakeOf<ChurnInterventionService>({})),
    notes: new NotificationsController(new NotificationsService(fakeOf<PrismaService>(prisma))),
    card: new CoachService(fakeOf<PrismaService>(prisma), fakeOf<AuditService>({ write: async () => undefined })),
  };
}
type W = Awaited<ReturnType<typeof world>>;

const req = (id: string) => fakeOf<AuthedRequest>({ user: { id, role: 'coach' } });
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
const allAlerts = (w: W) => w.alerts.map((a) => a.id);
const notesOf = (w: W, who: string) => w.inbox.filter((n) => n.user_id === who).map((n) => n.id);

describe('B1 (rule D): a public-space photo safety alert reaches the space owner and team on every path', () => {
  const PATHS: Array<[string, (w: W, who: string) => Promise<number>]> = [
    ['GET /coach/alerts', async (w, who) => (await w.list.list(req(who))).length],
    ['POST /coach/alerts/:id/acknowledge', (w, who) => served(allAlerts(w), (id) => w.list.acknowledge(req(who), id))],
    ['GET /coach/command-center/overview (open alerts)', async (w, who) => (await w.cc.getOverview(req(who))).open_alerts],
    ['GET /coach/command-center/action-queue', async (w, who) => (await w.cc.getActionQueue(req(who))).items.length],
    ['GET /coach/command-center/action-queue/:alertId', (w, who) => served(allAlerts(w), (id) => w.cc.getSafetyAlert(req(who), id))],
    ['POST /coach/command-center/action-queue/:alertId/dismiss', (w, who) => served(allAlerts(w), (id) => w.cc.dismissAlert(req(who), id))],
    ['GET /notifications (rows)', async (w, who) => (await w.notes.listNotifications(req(who), {})).items.length],
    ['GET /notifications/unread-count', async (w, who) => (await w.notes.getUnreadCount(req(who))).count],
    ['POST /notifications/:id/read', (w, who) => served(notesOf(w, who), (id) => w.notes.markRead(id, req(who)))],
    ['POST /notifications/mark-all-read', async (w, who) => (await w.notes.markAllRead(req(who))).updated],
  ];
  // [reader, while they lead, team member removed, space no longer public]
  const READERS: Array<[string, number, number, number]> = [
    ['the space owner (coaches neither poster)', 2, 2, 0],
    ['a coach-role team member', 1, 0, 0],
    ['the poster\'s resident coach (unchanged)', 1, 1, 1],
    ['a coach who does not lead the space', 0, 0, 0],
  ];
  const WHO: Record<string, string> = {
    [READERS[0][0]]: OWNER,
    [READERS[1][0]]: TEAM,
    [READERS[2][0]]: RESIDENT,
    [READERS[3][0]]: STRANGER,
  };
  describe.each(PATHS)('%s', (_path, run) => {
    it.each(READERS)('%s: %i, then %i once off the team, %i once the space is not public', async (reader, leads, removed, closed) => {
      const who = WHO[reader];
      expect(await run(await world('leads'), who)).toBe(leads);
      expect(await run(await world('team-removed'), who)).toBe(removed);
      expect(await run(await world('private'), who)).toBe(closed);
    });
  });

  it('the space copy: its own line and link, the alert screen tap, the first-name card with no quote, and the space id', async () => {
    const w = await world();
    expect(w.inbox.find((n) => n.payload.alertId === 'a-1')).toMatchObject({
      user_id: OWNER,
      body: SPACE_INBOX,
      deep_link: SPACE_LINK,
      payload: { actionScreen: 'CoachSafetyAlert', actionParams: { alertId: 'a-1' } },
    });
    const card = {
      alert_id: 'a-1',
      client_id: SAM,
      client_name: 'Sam Lee',
      alert_type: 'community_photo_safety',
      message: 'Our safety check stopped a space chat photo from Sam. Please check in with them today.',
      quote: null,
      space_id: SPACE,
    };
    expect((await w.cc.getActionQueue(req(OWNER))).items.find((i) => i.alert_id === 'a-1')).toMatchObject(card);
    await expect(w.cc.getSafetyAlert(req(OWNER), 'a-1')).resolves.toMatchObject(card);
  });

  it('the resident copy is unchanged: the client line and link, and no space id', async () => {
    const w = await world();
    expect(w.inbox.find((n) => n.payload.alertId === 'a-4')).toMatchObject({
      user_id: RESIDENT,
      body: 'Urgent safety alert for one of your clients. Tap to see details.',
      deep_link: `tgp://coach/clients/${JANE}`,
    });
    const [item] = (await w.cc.getActionQueue(req(RESIDENT))).items;
    expect(item).toMatchObject({ alert_id: 'a-4', client_id: JANE });
    expect(item).not.toHaveProperty('space_id');
  });

  it('a Roman alert and a stranger\'s row never ride the space branch, whatever their payload holds', async () => {
    const w = await world();
    const ownerIds = (await w.list.list(req(OWNER))).map((a) => a.id);
    expect(ownerIds).not.toContain('a-5');
    expect(w.inbox.find((n) => n.payload.alertId === 'a-5')).toMatchObject({ deep_link: `tgp://coach/clients/${SAM}` });
    await expect(w.cc.getSafetyAlert(req(OWNER), 'a-5')).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.cc.getSafetyAlert(req(STRANGER), 'a-6')).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.list.acknowledge(req(STRANGER), 'a-6')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the client card stays resident-only: the owner opens no card for Sam, and Jane\'s card shows her coach\'s own copy', async () => {
    const w = await world();
    await expect(w.card.getClientSummary(OWNER, SAM)).resolves.toEqual({ error: 'Client not found' });
    await expect(w.card.getClientSummary(OWNER, JANE)).resolves.toEqual({ error: 'Client not found' });
    expect(await w.card.getClientSummary(RESIDENT, JANE)).toMatchObject({ open_safety_alert: { alert_id: 'a-4' } });
  });
});

// The push worker re-renders the lock screen from the stored context and
// re-checks the reader at send time (pushStillCurrent). Real emitter,
// NotificationsService and PushDeliveryService; Expo mocked.
describe('B1 (rule D): the space owner\'s phone gets the space copy', () => {
  const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
  const AFTERNOON = new Date('2026-06-02T18:00:00Z'); // 14:00 New York
  const NIGHT = new Date('2026-06-03T02:00:00Z'); // 22:00 New York
  let clock = AFTERNOON;
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return clock;
    }
  }
  function phone(at: Date, prefs: Record<string, unknown> = {}, token: string | null = TOKEN) {
    clock = at;
    const space = publicSpace();
    const w = pushOutboxWorld({
      now: () => clock,
      tokens: { [OWNER]: token },
      prefs: { [OWNER]: { timezone: 'America/New_York', timezone_updated_at: new Date('2026-06-01T00:00:00Z'), ...prefs } },
    });
    const db = {
      ...w.db,
      // The worker re-checks a coach's push (pushStillCurrent); OWNER is a coach.
      user: { ...w.db.user, findUnique: jest.fn(async (args: { where: { id: string } }) => ({ ...(await w.db.user.findUnique(args)), role: 'coach' })) },
      // A client-link push's re-check (the roster rule) reads these too: OWNER runs no sessions.
      coachingSession: { ...w.db.coachingSession, findMany: jest.fn(async () => []) },
      communityCohort: { findMany: jest.fn(async ({ where }: { where: unknown }) => [space].filter((c) => fits(c, where))) },
      notification: { create: jest.fn(async ({ data }: { data: object }) => ({ id: 'n1', ...data })) },
      coachAlert: {
        create: jest.fn(async ({ data }: { data: object }) => ({ ...data, id: 'a-space', created_at: clock, acknowledged_at: null })),
      },
    };
    const send = jest.fn(async (m: ExpoPushMessage[]) => m.map((_, i) => ({ status: 'ok' as const, id: `t-${i}` })));
    const delivery = new Clocked(fakeOf<PrismaService>(Object.create(db)), { send, getReceipts: jest.fn(async () => ({})) });
    delivery.autoDrain = false;
    const notifications = new NotificationsService(fakeOf<PrismaService>(Object.create(db)), undefined, undefined, delivery);
    const alerts = new CoachAlertsService(fakeOf<PrismaService>(db), new CoachAlertEmitter(notifications));
    const raise = () =>
      alerts.createAlert({
        coachId: OWNER,
        clientId: SAM,
        alertType: 'community_photo_safety',
        severity: 'critical',
        message: SPACE_PUSH,
        payload: { space_id: SPACE },
      });
    return { rows: w.rows, space, delivery, send, raise };
  }

  it('the space line under "Client update", opening that alert', async () => {
    const p = phone(AFTERNOON);
    await p.raise();
    expect(await p.delivery.drain()).toBe(1);
    const sent = p.send.mock.calls[0][0][0];
    expect(sent).toMatchObject({ to: TOKEN, title: 'Client update', body: SPACE_PUSH });
    expect(sent.data).toMatchObject({ actionScreen: 'CoachSafetyAlert', actionParams: { alertId: 'a-space' } });
  });

  it('urgent: at 22:00 it goes out at once', async () => {
    const p = phone(NIGHT);
    await p.raise();
    expect(p.rows[0]).toMatchObject({ urgent: true, not_before: NIGHT, deferred_reason: null });
    expect(await p.delivery.drain()).toBe(1);
    expect(p.send.mock.calls[0][0][0]).toMatchObject({ body: SPACE_PUSH });
  });

  it('passes Mute all (#168-18 op 1)', async () => {
    const p = phone(AFTERNOON, { muted: true });
    await p.raise();
    expect(await p.delivery.drain()).toBe(1);
    expect(p.send.mock.calls[0][0][0]).toMatchObject({ body: SPACE_PUSH });
  });

  it('is not sent once the owner no longer leads a public space, or after sign-out', async () => {
    const closed = phone(AFTERNOON);
    await closed.raise();
    closed.space.visibility = 'clients';
    await closed.delivery.drain();
    expect(closed.send).not.toHaveBeenCalled();
    const signedOut = phone(AFTERNOON, {}, null);
    await signedOut.raise();
    await signedOut.delivery.drain();
    expect(signedOut.send).not.toHaveBeenCalled();
  });
});
