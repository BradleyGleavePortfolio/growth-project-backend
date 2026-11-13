/**
 * MONEY-TAP-BE (agent 203, class-first): no push the server queues opens nothing on tap. The daily money check's push
 * ("Money check: clean" / "Money check: needs review") carried { type, verdict } only, so the phone's tap router had
 * no screen, kind or link to route and the tap opened the app where it was. With this job its data also carries the
 * one tap target the phone already routes for the owner account: actionScreen 'NotificationCenter' (pushTapData for
 * coach_alert), which the coach app opens as ClientsStack > NotificationCenter, the list where that day's money row is.
 *
 * Each case runs the REAL ReconciliationDailyCron through the REAL CronLeaseService, NotificationsService and
 * PushDeliveryService (Expo mocked) over in-memory tables (as test/money-check-alarm.spec.ts drives it), then reads
 * the stored PushOutbox row and the Expo message. The phone's side is the one copy in test/utils/phone-link-routes.ts.
 * Nothing else of the push, its inbox row or the check's finished record may move (MONEY-NOTICE-BE stays held).
 * Purchases are a stand-in; no database, no network; no names or user text anywhere.
 */
import { Logger } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Expo } from 'expo-server-sdk';
import { CronLeaseService } from '../../src/checkout/cron-lease.service';
import { MoneyCheckStatusService } from '../../src/checkout/money-check-status.service';
import { ReconciliationDailyCron } from '../../src/checkout/reconciliation-daily.cron';
import { NotificationKind } from '../../src/notifications/notification-kind';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { ExpoPushClient } from '../../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../../src/notifications/push/push-delivery.service';
import type { PrismaService } from '../../src/prisma.service';
import { pushOutboxWorld } from '../utils/push-outbox-fake';
import { Table, asPrisma, type Row } from '../utils/settlement-fakes';
import { stub } from '../utils/trial-fakes';
import { ALL_ON, devicePushTap, type PhoneFlags } from '../utils/phone-link-routes';

const OWNER = 'owner-1';
const TOKEN = 'ExponentPushToken[moneytapowner000000]';
const DAY = '2026-11-07';
const RUN_AT = `${DAY}T11:00:00Z`;
const LIST = { root: 'ClientsStack', screen: 'NotificationCenter' };
const TAP = { actionScreen: 'NotificationCenter' };
/** The push data at main (7f566a59): what a row queued before the deploy holds. */
const AT_MAIN = (verdict: string) => ({ type: 'money_check', verdict });
const ALL_OFF: PhoneFlags = Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, false])) as unknown as PhoneFlags;

type Outcome = 'ok' | 'drift' | 'fail';

/** Two purchases in one short batch: both match, one does not ('drift'), or the batch throws ('fail'). */
function purchases(outcome: Outcome) {
  return {
    runSweep: jest.fn(async () => {
      if (outcome === 'fail') throw new Error('batch read failed');
      return {
        scanned: 2,
        drifted: outcome === 'drift' ? 1 : 0,
        unknown: 0,
        failed: 0,
        outcomes: [
          { purchase_id: 'pu-1', status: 'ok' as const },
          { purchase_id: 'pu-2', status: outcome === 'drift' ? ('drift' as const) : ('ok' as const) },
        ],
        timedOut: false,
      };
    }),
  };
}

/** The money check's world: the lease, the inbox, the push outbox (Expo mocked) and the status read. */
function world(opts: { outcome?: Outcome; zone?: string; muted?: boolean } = {}) {
  const clock = { at: new Date(RUN_AT) };
  const prefs: Record<string, Record<string, unknown>> = {
    [OWNER]: {
      timezone: opts.zone ?? 'America/Los_Angeles',
      timezone_updated_at: new Date('2026-01-01T00:00:00Z'),
      ...(opts.muted ? { muted: true } : {}),
    },
  };
  const outbox = pushOutboxWorld({ now: () => clock.at, tokens: { [OWNER]: TOKEN }, prefs });
  const inbox: Array<Record<string, unknown>> = [];
  const leaseRows: Row[] = [];
  const cronLease = new Table(leaseRows, { prefix: 'lease', unique: ['name'] });
  const db = {
    ...outbox.db,
    notification: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `n-${inbox.length + 1}`, created_at: new Date(clock.at.getTime()), ...data };
        inbox.push(row);
        return row;
      }),
    },
    cronLease,
    user: { ...outbox.db.user, findFirst: jest.fn(async () => ({ id: OWNER })) },
  };
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const sent = jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `tap-${i}` })));
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const delivery = new Clocked(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
    stub<ExpoPushClient>({ send: sent, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  const lease = new CronLeaseService(asPrisma({ cronLease }));
  const sweep = purchases(opts.outcome ?? 'ok');
  const cron = new ReconciliationDailyCron(lease, sweep as any, notifications, db as any);
  const status = new MoneyCheckStatusService(db as unknown as PrismaService);
  const tick = async (iso: string = RUN_AT, holder = 'machine-a') => {
    clock.at = new Date(iso);
    return cron.runOnce(new Date(iso), holder, async () => undefined);
  };
  const expo = () => sent.mock.calls.flatMap((c) => c[0] as Array<Record<string, unknown>>);
  /** Moves the clock to the row's own send time and runs the worker once. */
  const sendWhenDue = async () => {
    const due = Math.max(...outbox.rows.map((r) => r.not_before.getTime()));
    if (due > clock.at.getTime()) clock.at = new Date(due);
    return delivery.drain();
  };
  return { clock, db, inbox, outbox, delivery, notifications, cron, status, tick, expo, sendWhenDue };
}

beforeAll(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  delete process.env.RECONCILIATION_DAILY_ENABLED;
});

const RUNS: Array<{ name: string; outcome: Outcome; verdict: string; title: string; body: string }> = [
  {
    name: 'a clean run',
    outcome: 'ok',
    verdict: 'clean',
    title: 'Money check: clean',
    body: 'Checked 2 purchases against Stripe. Every one matches.',
  },
  {
    name: 'a run with one purchase that does not match',
    outcome: 'drift',
    verdict: 'needs_review',
    title: 'Money check: needs review',
    body: "Checked 2 purchases against Stripe. 1 doesn't match.",
  },
  {
    name: 'a run that stopped early',
    outcome: 'fail',
    verdict: 'needs_review',
    title: 'Money check: needs review',
    body: 'Checked 0 purchases against Stripe. The check stopped early before it reached every purchase.',
  },
];

describe('MONEY-TAP-BE: the money push carries the tap target the phone routes (red at main)', () => {
  it.each(RUNS)('1. $name: the queued push data is exactly { type, verdict, actionScreen }', async (run) => {
    const w = world({ outcome: run.outcome });
    await expect(w.tick()).resolves.toMatchObject({ ran: true, verdict: run.verdict, alerted: true });
    expect(w.outbox.rows).toHaveLength(1);
    expect(w.outbox.rows[0].data).toEqual({ type: 'money_check', verdict: run.verdict, actionScreen: 'NotificationCenter' });
  });

  it.each(RUNS)(
    '2. $name: held for the owner night, then the Expo message carries that data with no kind key added',
    async (run) => {
      const w = world({ outcome: run.outcome });
      await w.tick();
      // 11:00 UTC is 03:00 in the owner zone: the outbox holds the push for the morning (QH_OUTBOX).
      const [row] = w.outbox.rows;
      expect(row.deferred_reason).toBe('quiet_hours');
      expect(row.not_before.getTime()).toBeGreaterThan(new Date(RUN_AT).getTime());
      expect(await w.delivery.drain()).toBe(0);
      expect(w.expo()).toEqual([]);
      expect(await w.sendWhenDue()).toBe(1);
      const messages = w.expo();
      expect(messages).toHaveLength(1);
      expect(messages[0].data).toEqual({ type: 'money_check', verdict: run.verdict, actionScreen: 'NotificationCenter' });
      expect(messages[0].data).not.toHaveProperty('kind');
    },
  );

  it('2. an open hour (owner zone UTC): sent at once with the same data', async () => {
    const w = world({ zone: 'UTC' });
    await w.tick();
    expect(w.outbox.rows[0].deferred_reason).toBeNull();
    expect(await w.delivery.drain()).toBe(1);
    expect(w.expo().map((m) => m.data)).toEqual([{ ...AT_MAIN('clean'), ...TAP }]);
  });

  it.each(RUNS)("3. $name: the owner's device tap opens ClientsStack > NotificationCenter; main's data opens nothing", async (run) => {
    const w = world({ outcome: run.outcome });
    await w.tick();
    await w.sendWhenDue();
    const data = w.expo()[0].data as Record<string, unknown>;
    // The owner account runs the coach app (phone RootNavigator.tsx:761-767): its taps use COACH_PUSH_ROUTES.
    expect(devicePushTap('coach', data)).toEqual(LIST);
    expect(devicePushTap('coach', data, ALL_OFF)).toEqual(LIST);
    expect(devicePushTap('coach', AT_MAIN(run.verdict))).toBe('nothing');
  });
});

describe('MONEY-TAP-BE: guards (green at main and with the fix)', () => {
  it.each(RUNS)('4. $name: title, body, user, kind, dedupe key and context as at main', async (run) => {
    const w = world({ outcome: run.outcome });
    await w.tick();
    const [row] = w.outbox.rows;
    expect({
      user_id: row.user_id,
      kind: row.kind,
      dedupe_key: row.dedupe_key,
      collapse_key: row.collapse_key,
      title: row.title,
      body: row.body,
      context: row.context,
      urgent: row.urgent,
    }).toEqual({
      user_id: OWNER,
      kind: NotificationKind.COACH_ALERT,
      dedupe_key: `money_daily:${DAY}`,
      collapse_key: `money_daily:${DAY}`,
      title: run.title,
      body: run.body,
      context: { senderWords: true, passesMuteAll: true },
      urgent: false,
    });
    await w.sendWhenDue();
    const [message] = w.expo();
    expect([message.to, message.title, message.body]).toEqual([TOKEN, run.title, run.body]);
  });

  it.each(RUNS)('5. $name: the inbox row is as at main (no tap key in its payload)', async (run) => {
    const w = world({ outcome: run.outcome });
    await w.tick();
    expect(w.inbox).toHaveLength(1);
    const row = w.inbox[0];
    expect([row.user_id, row.kind, row.body, row.channel]).toEqual([OWNER, NotificationKind.COACH_ALERT, run.body, 'inapp']);
    expect(row.payload).toEqual({
      type: 'money_check',
      title: run.title,
      verdict: run.verdict,
      checked: run.outcome === 'fail' ? 0 : 2,
      drift: run.outcome === 'drift' ? 1 : 0,
      unknown: 0,
      failed: 0,
      day: DAY,
    });
  });

  it('6. the status route reads the finished record as at main: on time with that day', async () => {
    const w = world();
    await w.tick();
    const started = new Date(RUN_AT).getTime() - 72 * 60 * 60_000;
    await expect(w.status.status(new Date(`${DAY}T11:05:00Z`), started)).resolves.toEqual({
      status: 'on_time',
      lastDay: DAY,
    });
  });

  it('7. one push per UTC day: a second run the same day queues nothing new', async () => {
    const w = world();
    await w.tick();
    await expect(w.tick(`${DAY}T15:00:00Z`, 'machine-b')).resolves.toEqual({ ran: false, reason: 'lock_held' });
    // A second call of the same day's send (a retry inside one run) is the same dedupe key: still one row.
    await w.notifications.pushToUser(OWNER, 'Money check: clean', 'x', { ...AT_MAIN('clean'), ...TAP }, undefined, {
      kind: NotificationKind.COACH_ALERT,
      passesMuteAll: true,
      dedupeKey: `money_daily:${DAY}`,
    });
    expect(w.outbox.rows).toHaveLength(1);
    await w.sendWhenDue();
    expect(w.expo()).toHaveLength(1);
  });

  it('7. Mute all on: the money push still queues and sends', async () => {
    const w = world({ muted: true });
    await w.tick();
    expect(w.outbox.rows).toHaveLength(1);
    expect(await w.sendWhenDue()).toBe(1);
    expect(w.expo().map((m) => [m.to, m.title, m.data])).toEqual([
      [TOKEN, 'Money check: clean', expect.objectContaining(AT_MAIN('clean'))],
    ]);
  });

  it.each(RUNS)('8. $name: no user text and no other key: only type, verdict and actionScreen, each a fixed value', async (run) => {
    const w = world({ outcome: run.outcome });
    await w.tick();
    const { data } = w.outbox.rows[0];
    // No kind, link, params, counts or words: the keys are a subset of the three (main has the first two).
    expect(Object.keys(data).filter((k) => !['type', 'verdict', 'actionScreen'].includes(k))).toEqual([]);
    expect(data.type).toBe('money_check');
    expect(data.verdict).toBe(run.verdict);
    if ('actionScreen' in data) expect(data.actionScreen).toBe('NotificationCenter');
  });

  it('2. a push queued before the deploy sends as stored: no key added, and its tap still opens nothing', async () => {
    const w = world({ zone: 'UTC' });
    await w.delivery.enqueue({
      userId: OWNER,
      kind: NotificationKind.COACH_ALERT,
      title: 'Money check: clean',
      body: 'Checked 2 purchases against Stripe. Every one matches.',
      data: AT_MAIN('clean'),
      context: { senderWords: true, passesMuteAll: true },
      dedupeKey: `money_daily:${DAY}`,
      collapseKey: `money_daily:${DAY}`,
      timeZone: 'UTC',
    });
    expect(await w.delivery.drain()).toBe(1);
    expect(w.expo().map((m) => m.data)).toEqual([AT_MAIN('clean')]);
    expect(devicePushTap('coach', AT_MAIN('clean'))).toBe('nothing');
  });
});

/** Class-first ([R24]): every pushToUser caller in src, the one path that keeps a sender's data as given. */
const PUSH_TO_USER_CALLERS = [
  'src/checkout/dunning-v2/dunning-v2.dispatcher.ts', // kind + actionScreen
  'src/checkout/payout-notice.service.ts', // deep_link (b#1247 "Found, not fixed")
  'src/checkout/reconciliation-daily.cron.ts', // this job: actionScreen
  'src/coach/brief/coach-brief.scheduler.ts', // actionScreen + deep_link
  'src/community/notifications/community-notifications.service.ts', // kind (+ deepLink)
  'src/engagement/workout-reminder.service.ts', // kind + deep_link
  'src/notifications/notifications.service.ts', // pushToCoach: no caller in src ("Found, not fixed")
  'src/notifications/nudges/nudge-engine.service.ts', // kind + deep_link
  'src/nudges/coach-nudge-send.ts', // kind + actionScreen
  'src/packages/trials/trial-notice.service.ts', // kind + actionScreen + deep_link
  'src/scout/scout.service.ts', // kind
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('MONEY-TAP-BE: the class', () => {
  it('9. the pushToUser callers are the eleven in the class table (a new sender is classified before it lands)', () => {
    const root = join(__dirname, '..', '..');
    const callers = sourceFiles(join(root, 'src'))
      .filter((f) => /\.pushToUser\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).split('\\').join('/'))
      .sort();
    expect(callers).toEqual([...PUSH_TO_USER_CALLERS].sort());
  });
});
