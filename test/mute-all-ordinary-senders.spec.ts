import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { BroadcastDispatcherService } from '../src/broadcasts/broadcast-dispatcher.service';
import type { BroadcastScopeService } from '../src/broadcasts/broadcast-scope.service';
import type { SegmentResolverService } from '../src/broadcasts/segment-resolver.service';
import { ChurnInterventionService } from '../src/coach/command-center/churn-intervention.service';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ExpoPushClient, PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { ScoutService } from '../src/scout/scout.service';
import type { SupabaseService } from '../src/supabase/supabase.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

// FR-1154R3 (B-LS1154-1, B-LS1154-2; owner #171-3 MUTE-PAY): a muted and an unmuted recipient through
// each ordinary sender's real path. Mute all stops only the push: the broadcast's in-app row, the
// churn-intervention message and the settled import all stay. The broadcast runs the real dispatcher,
// the real MessageReceivedEmitter and the real NotificationsService (row write + enqueue gate); the
// two direct pushes run the real sender and the real NotificationsService.pushToUser, with only the
// Expo transport and storage stubbed. Money and safety pushes (owner #168-18) are not on this path.

const TOKEN = 'ExponentPushToken[fr1154r3mutealloff]';
const NY_AFTERNOON = new Date('2026-06-02T18:00:00Z'); // 14:00 New York: outside quiet hours
const COACH = 'coach-a';
const CLIENT = 'client-1';

type Prefs = { muted: boolean; message_push: boolean; message_inapp: boolean; timezone: string };
const prefsOf = (p: Partial<Prefs>): Prefs => ({
  muted: false,
  message_push: true,
  message_inapp: true,
  timezone: 'America/New_York',
  ...p,
});

/** The real core for one recipient: in-app rows, the push outbox and the Expo transport. */
function core(user: string, prefs: Prefs) {
  const w = pushOutboxWorld({ now: () => NY_AFTERNOON });
  w.prefs[user] = prefs;
  w.tokens[user] = TOKEN;
  const inapp: Array<Record<string, unknown>> = [];
  const db = {
    ...w.db,
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        if (a.data.channel === 'inapp') inapp.push(a.data);
        return { id: `n-${inapp.length}`, ...a.data };
      }),
    },
  };
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(NY_AFTERNOON.getTime());
    }
  }
  const client = stub<ExpoPushClient>({
    send: jest.fn(async (m: unknown[]) => m.map((_x, i) => ({ status: 'ok', id: `ticket-${i}` }))),
    getReceipts: jest.fn(async () => ({})),
  });
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), client);
  delivery.autoDrain = false;
  const svc = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  const direct = jest.spyOn(svc, 'pushToUser');
  return {
    svc,
    rows: () => inapp.filter((r) => r.user_id === user).length,
    /** Queued pushes (the outbox) plus direct pushes that reached the Expo transport. */
    pushes: async () => {
      await Promise.all(direct.mock.results.map((r) => r.value));
      const sent = expoSend.mock.calls.flatMap(([chunk]) => chunk).filter((m) => m.to === TOKEN);
      return w.rows.filter((r) => r.user_id === user).length + sent.length;
    },
  };
}

let expoSend: jest.SpyInstance<Promise<ExpoPushTicket[]>, [ExpoPushMessage[]]>;

/** A broadcast copy to CLIENT: the real deliverOne, the real emitter, the real core. */
async function broadcast(prefs: Prefs) {
  const c = core(CLIENT, prefs);
  const settles: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];
  const settle = async (a: { data: Record<string, unknown> }) => {
    if (!('lease_holder' in a.data)) settles.push(a.data);
    return { count: 1 };
  };
  const tx = {
    $queryRaw: jest.fn(async () => [{ status: 'sending' }]),
    coachMessage: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => (messages.push(a.data), { id: 'm1' })),
    },
    coachMessageCard: { create: jest.fn(async () => ({})) },
    coachBroadcastDelivery: { updateMany: jest.fn(settle) },
  };
  const payload = { urgent: false, body: 'Morning {first_name}', card: null };
  const prisma = {
    coachBroadcastDelivery: {
      updateMany: jest.fn(settle),
      findUnique: jest.fn(async () => ({
        id: 'd1',
        attempts: 0,
        recipient_id: CLIENT,
        run: {
          ...payload,
          segment: {},
          broadcast: { id: 'b1', coach_id: COACH, author_user_id: COACH, status: 'sending', ...payload },
        },
      })),
    },
    user: {
      findFirst: jest.fn(async () => ({ id: CLIENT, name: 'Sarah Lee' })),
      findUnique: jest.fn(async () => ({ name: 'Coach Bradley' })),
    },
    userBlock: { findFirst: jest.fn(async () => null) },
    notificationPreferences: { findUnique: jest.fn(async () => prefs) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const svc = new BroadcastDispatcherService(
    stub<ConstructorParameters<typeof BroadcastDispatcherService>[0]>(prisma),
    stub<BroadcastScopeService>({ lockSendAuthority: jest.fn(async () => null) }),
    stub<SegmentResolverService>({}),
    stub<SupabaseService>({ pingChat: jest.fn(async () => undefined) }),
    new MessageReceivedEmitter(c.svc),
  );
  expect(await svc.deliverOne('d1', NY_AFTERNOON)).toBe('delivered');
  // The delivery's last push_status write is its receipt ('pending' becomes 'sent').
  const receipt = settles.filter((s) => 'push_status' in s).pop()?.push_status;
  return { kept: messages.length, row: c.rows(), push: await c.pushes(), receipt };
}

/** A churn intervention sent to CLIENT: the real sendIntervention, the real pushToUser. */
async function churnIntervention(prefs: Prefs) {
  const c = core(CLIENT, prefs);
  const nudges: Array<Record<string, unknown>> = [];
  const intervention = { id: 'int-1', coach_id: COACH, client_id: CLIENT, status: 'draft', draft_text: 'Hi' };
  const tx = {
    $queryRaw: jest.fn(async () => [{ id: CLIENT, coach_id: COACH, role: 'student', deleted_at: null }]),
    churnIntervention: { updateMany: jest.fn(async () => ({ count: 1 })) },
    coachNudge: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => (nudges.push(a.data), a.data)),
    },
  };
  const prisma = {
    churnIntervention: {
      findFirst: jest.fn(async (a: { where: { id?: string } }) => (a.where.id ? intervention : null)),
    },
    notificationPreferences: { findUnique: jest.fn(async () => prefs) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const svc = new ChurnInterventionService(
    stub<ConstructorParameters<typeof ChurnInterventionService>[0]>(prisma),
    stub<ConstructorParameters<typeof ChurnInterventionService>[1]>({}),
    stub<ConstructorParameters<typeof ChurnInterventionService>[2]>({}),
    stub<ConstructorParameters<typeof ChurnInterventionService>[3]>({}),
    c.svc,
  );
  const res = await svc.sendIntervention(COACH, 'int-1', {
    message_text: 'Checking in this week',
    idempotency_key: randomUUID(),
  });
  expect(res.ok).toBe(true);
  // The nudge row is the message the client sees in the app.
  return { kept: nudges.length, row: nudges.length, push: await c.pushes(), receipt: undefined };
}

/** An import settled for COACH (legacy run): the real complete(), the real pushToUser. */
async function importComplete(prefs: Prefs) {
  const c = core(COACH, prefs);
  const settled = jest.fn(async () => ({}));
  const prisma = {
    scoutImportCompletion: { create: jest.fn(async () => ({})) },
    scoutImport: { upsert: settled },
    notificationPreferences: { findUnique: jest.fn(async () => prefs) },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const svc = new ScoutService(
    stub<ConstructorParameters<typeof ScoutService>[0]>(prisma),
    c.svc,
    stub<AnalyticsService>({ capture: jest.fn() }),
  );
  const ack = await svc.complete(COACH, { intent_id: 'intent-1', terminal_status: 'success' });
  expect(ack).toEqual({ acknowledged: true, intent_id: 'intent-1' });
  const kept = settled.mock.calls.length; // the import record the importer screen shows
  return { kept, row: kept, push: await c.pushes(), receipt: undefined };
}

const SENDERS = { broadcast, 'churn intervention': churnIntervention, import: importComplete };

describe('FR-1154R3: Mute all on the ordinary senders stops only the push (owner #171-3)', () => {
  const savedFlag = process.env.FEATURE_COACH_BROADCASTS;
  beforeAll(() => {
    process.env.FEATURE_COACH_BROADCASTS = 'true';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  beforeEach(() => {
    expoSend = jest
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockImplementation(async (chunk) => chunk.map(() => ({ status: 'ok' as const, id: 'ticket' })));
  });
  afterEach(() => expoSend.mockRestore());
  afterAll(() => {
    if (savedFlag === undefined) delete process.env.FEATURE_COACH_BROADCASTS;
    else process.env.FEATURE_COACH_BROADCASTS = savedFlag;
    jest.restoreAllMocks();
  });

  // sender | recipient | prefs | committed (message, nudge, import) | in-app row | pushes | receipt
  it.each([
    ['broadcast', 'unmuted', prefsOf({}), 1, 1, 1, 'sent'],
    ['broadcast', 'muted', prefsOf({ muted: true }), 1, 1, 0, 'suppressed_muted'],
    ['broadcast', 'message push off', prefsOf({ message_push: false }), 1, 1, 0, 'suppressed_pref'],
    ['broadcast', 'message in-app off', prefsOf({ message_inapp: false }), 1, 0, 1, 'sent'],
    ['churn intervention', 'unmuted', prefsOf({}), 1, 1, 1, undefined],
    ['churn intervention', 'muted', prefsOf({ muted: true }), 1, 1, 0, undefined],
    ['import', 'unmuted', prefsOf({}), 1, 1, 1, undefined],
    ['import', 'muted', prefsOf({ muted: true }), 1, 1, 0, undefined],
  ] as const)('%s, %s recipient', async (sender, _who, prefs, kept, row, push, receipt) => {
    const got = await SENDERS[sender]({ ...prefs });
    expect(got).toEqual({ kept, row, push, receipt });
  });
});
