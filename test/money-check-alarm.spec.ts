// MONEY-ALARM-BE (owner #202-E3, 202-S1 op 1): the daily money check's own
// status. Each case runs the REAL ReconciliationDailyCron through the REAL
// CronLeaseService, NotificationsService (inbox row) and PushDeliveryService
// (queued push) over in-memory tables, then the REAL MoneyCheckStatusService
// reads the same tables. Purchases are a stand-in. No database, no network.
import { INestApplication, Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CacheControlInterceptor } from '../src/common/cache-control.interceptor';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { CronLeaseService } from '../src/checkout/cron-lease.service';
import { MoneyCheckStatusController } from '../src/checkout/money-check-status.controller';
import {
  LATE_AFTER_MS,
  MONEY_DAILY_PUSH_KEY,
  MoneyCheckStatusService,
  moneyCheckState,
} from '../src/checkout/money-check-status.service';
import { DAILY_JOB_NAME, ReconciliationDailyCron } from '../src/checkout/reconciliation-daily.cron';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { PrismaService } from '../src/prisma.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { Table, asPrisma, type Row } from './utils/settlement-fakes';
import { stub } from './utils/trial-fakes';

const OWNER = 'owner-1';
const TOKEN = 'ExponentPushToken[moneyalarmowner00000]';
const H = 60 * 60_000;
const at = (iso: string) => new Date(iso);

interface InboxRow {
  id: string;
  user_id: string;
  kind: string;
  body: string;
  payload: Record<string, unknown> | null;
  channel: string;
  created_at: Date;
}

/** The Notification table: create (the daily check) and the status read (user, kind, payload.type). */
function inboxTable(clock: { at: Date }) {
  const rows: InboxRow[] = [];
  const reads: unknown[] = [];
  return {
    rows,
    reads,
    create: jest.fn(async ({ data }: { data: Omit<InboxRow, 'id' | 'created_at'> }) => {
      const row = { id: `n-${rows.length + 1}`, created_at: new Date(clock.at.getTime()), ...data } as InboxRow;
      rows.push(row);
      return row;
    }),
    findMany: jest.fn(async (args: any) => {
      reads.push(args);
      const { user_id, kind, payload } = args.where;
      return rows
        .filter((r) => r.user_id === user_id && r.kind === kind)
        .filter((r) => (r.payload as Record<string, unknown> | null)?.[payload.path[0]] === payload.equals)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .slice(0, args.take)
        .map((r) => ({ created_at: r.created_at, payload: r.payload }));
    }),
  };
}

/** Two clean purchases, one short batch; `fail` makes the batch throw instead. */
function purchases() {
  const svc = {
    fail: false,
    runSweep: jest.fn(async () => {
      if (svc.fail) throw new Error('batch read failed');
      return {
        scanned: 2,
        drifted: 0,
        unknown: 0,
        failed: 0,
        outcomes: [
          { purchase_id: 'pu-1', status: 'ok' as const },
          { purchase_id: 'pu-2', status: 'ok' as const },
        ],
        timedOut: false,
      };
    }),
  };
  return svc;
}

function world() {
  const clock = { at: at('2026-11-07T11:00:00Z') };
  const outbox = pushOutboxWorld({ now: () => clock.at, tokens: { [OWNER]: TOKEN } });
  const inbox = inboxTable(clock);
  const leaseRows: Row[] = [];
  const cronLease = new Table(leaseRows, { prefix: 'lease', unique: ['name'] });
  const owner = { present: true as boolean };
  const ownerReads: unknown[] = [];
  const db = {
    ...outbox.db,
    notification: inbox,
    cronLease,
    user: {
      ...outbox.db.user,
      findFirst: jest.fn(async (args: unknown) => {
        ownerReads.push(args);
        return owner.present ? { id: OWNER } : null;
      }),
    },
  };
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const delivery = new Clocked(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
    stub<ExpoPushClient>({ send: jest.fn(async () => []), getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  const sweep = purchases();
  const lease = new CronLeaseService(asPrisma({ cronLease }));
  const machine = () => new ReconciliationDailyCron(lease, sweep as any, notifications, db as any);
  const cron = machine();
  const status = new MoneyCheckStatusService(db as unknown as PrismaService);
  /** The 11:00 UTC tick on one machine, at `iso`. */
  const tick = async (iso: string, c: ReconciliationDailyCron = cron, holder = 'machine-a') => {
    clock.at = at(iso);
    return c.runOnce(at(iso), holder, async () => undefined);
  };
  /** The answer at `iso`; the serving machine started 3 days earlier unless given. */
  const read = (iso: string, startedAt = at(iso).getTime() - 72 * H) => status.status(at(iso), startedAt);
  return { clock, db, inbox, outbox, leaseRows, owner, ownerReads, sweep, machine, cron, status, tick, read };
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

describe('MONEY-ALARM-BE: what the rows hold and what the status says, case by case', () => {
  it('a finished run writes its inbox row and queues its push: on time for 26 hours, with that day', async () => {
    const w = world();
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, verdict: 'clean', alerted: true });
    // What the rows hold: the lease row, the day's inbox row, the day's queued push.
    expect(w.leaseRows).toEqual([expect.objectContaining({ name: DAILY_JOB_NAME, acquired_at: at('2026-11-07T11:00:00Z') })]);
    expect(w.inbox.rows).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        kind: NotificationKind.COACH_ALERT,
        payload: expect.objectContaining({ type: 'money_check', day: '2026-11-07' }),
      }),
    ]);
    expect(w.outbox.rows).toEqual([expect.objectContaining({ user_id: OWNER, dedupe_key: `${MONEY_DAILY_PUSH_KEY}2026-11-07` })]);
    await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({ status: 'on_time', lastDay: '2026-11-07' });
    await expect(w.read('2026-11-08T13:00:00Z')).resolves.toEqual({ status: 'on_time', lastDay: '2026-11-07' });
  });

  it('the timer never fired: no new row the next day, so 26 hours after the last notice it is late', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    // 11-08 11:00 UTC: no tick at all (a restart at 11:00, a stopped scheduler). The rows stay as they were.
    await expect(w.read('2026-11-08T12:59:00Z')).resolves.toEqual({ status: 'on_time', lastDay: '2026-11-07' });
    await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({ status: 'late', lastDay: '2026-11-07' });
    expect(w.inbox.rows).toHaveLength(1);
    expect(w.leaseRows[0].acquired_at).toEqual(at('2026-11-07T11:00:00Z'));
  });

  it('the lease read failed: the day is skipped with nothing written, and it goes late', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    const broken = new ReconciliationDailyCron(
      { tryAcquire: jest.fn(async () => { throw new Error('db'); }), release: jest.fn() } as unknown as CronLeaseService,
      w.sweep as any,
      new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(w.db)),
      w.db as any,
    );
    await expect(w.tick('2026-11-08T11:00:00Z', broken)).resolves.toEqual({ ran: false, reason: 'lock_error' });
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([1, 1]);
    await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({ status: 'late', lastDay: '2026-11-07' });
  });

  it('a batch failed: the run still finishes and tells the owner it stopped early, so it is on time (not silent)', async () => {
    const w = world();
    w.sweep.fail = true;
    const r = await w.tick('2026-11-07T11:00:00Z');
    expect(r).toMatchObject({ ran: true, verdict: 'needs_review', alerted: true, tally: { stopped: 'error' } });
    expect(w.inbox.rows[0].body).toContain('The check stopped early before it reached every purchase.');
    const answer = await w.read('2026-11-07T11:05:00Z');
    expect(answer).toEqual({ status: 'on_time', lastDay: '2026-11-07' });
    // The answer never carries the verdict, the counts or the words.
    expect(Object.keys(answer).sort()).toEqual(['lastDay', 'status']);
    expect(JSON.stringify(answer)).not.toMatch(/needs_review|checked|drift|stopped|purchase/);
  });

  it('no owner account: the run finishes but nothing is written; late at once (the check has started, no grace)', async () => {
    const w = world();
    w.owner.present = false;
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: false });
    expect([w.inbox.rows.length, w.outbox.rows.length, w.leaseRows.length]).toEqual([0, 0, 1]);
    await expect(w.read('2026-11-07T11:05:00Z', at('2026-11-07T10:00:00Z').getTime())).resolves.toEqual({
      status: 'late',
      lastDay: null,
    });
  });

  it('the notice failed after a finished run (the inbox write failed): no row, no push, late', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    w.inbox.create.mockRejectedValueOnce(new Error('inbox write failed'));
    await expect(w.tick('2026-11-08T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: false });
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([1, 1]);
    await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({ status: 'late', lastDay: '2026-11-07' });
  });

  it.each([
    ['the push could not be queued', (w: ReturnType<typeof world>) => w.outbox.db.pushOutbox.createMany.mockRejectedValueOnce(new Error('outbox down'))],
    ['no phone is signed in (no push token)', (w: ReturnType<typeof world>) => { w.outbox.tokens[OWNER] = null; }],
  ])(
    'the notice failed after a finished run (%s): the inbox row alone is not a sent notice, late',
    async (_name, breakPush) => {
      const w = world();
      await w.tick('2026-11-07T11:00:00Z');
      breakPush(w);
      // The daily check believes it alerted: the push path swallows its own failure.
      await expect(w.tick('2026-11-08T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: true });
      expect(w.inbox.rows.map((r) => r.payload?.day)).toEqual(['2026-11-07', '2026-11-08']);
      expect(w.outbox.rows.map((r) => r.dedupe_key)).toEqual([`${MONEY_DAILY_PUSH_KEY}2026-11-07`]);
      await expect(w.read('2026-11-08T12:00:00Z')).resolves.toEqual({ status: 'on_time', lastDay: '2026-11-07' });
      await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({ status: 'late', lastDay: '2026-11-07' });
    },
  );

  it('recovery: after a late day, the next good run puts it back on time with the new day', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({ status: 'late', lastDay: '2026-11-07' });
    await expect(w.tick('2026-11-09T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: true });
    await expect(w.read('2026-11-09T11:05:00Z')).resolves.toEqual({ status: 'on_time', lastDay: '2026-11-09' });
  });

  it('two machines at the same tick: one run, one inbox row, one queued push, and both machines answer the same', async () => {
    const w = world();
    const other = w.machine();
    w.clock.at = at('2026-11-07T11:00:00Z');
    const results = await Promise.all([
      w.cron.runOnce(at('2026-11-07T11:00:00Z'), 'machine-a', async () => undefined),
      other.runOnce(at('2026-11-07T11:00:00Z'), 'machine-b', async () => undefined),
    ]);
    expect(results.map((r) => (r.ran ? 'ran' : r.reason)).sort()).toEqual(['lock_held', 'ran']);
    // A late machine the same UTC day runs nothing either.
    await expect(w.tick('2026-11-07T15:00:00Z', other, 'machine-b')).resolves.toEqual({ ran: false, reason: 'lock_held' });
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([1, 1]);
    const second = new MoneyCheckStatusService(w.db as unknown as PrismaService);
    const now = at('2026-11-07T16:00:00Z');
    await expect(w.status.status(now, now.getTime() - 5 * H)).resolves.toEqual({ status: 'on_time', lastDay: '2026-11-07' });
    await expect(second.status(now, now.getTime() - 1 * H)).resolves.toEqual({ status: 'on_time', lastDay: '2026-11-07' });
  });

  it('the switch off: RECONCILIATION_DAILY_ENABLED=false answers off and nothing runs; unset or anything else is not off', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    process.env.RECONCILIATION_DAILY_ENABLED = 'false';
    await expect(w.tick('2026-11-08T11:00:00Z')).resolves.toEqual({ ran: false, reason: 'disabled' });
    await expect(w.read('2026-11-09T11:00:00Z')).resolves.toEqual({ status: 'off', lastDay: '2026-11-07' });
    for (const value of ['true', 'FALSE', '0', '']) {
      process.env.RECONCILIATION_DAILY_ENABLED = value;
      await expect(w.read('2026-11-09T11:00:00Z')).resolves.toEqual({ status: 'late', lastDay: '2026-11-07' });
    }
    delete process.env.RECONCILIATION_DAILY_ENABLED;
    await expect(w.read('2026-11-09T11:00:00Z')).resolves.toEqual({ status: 'late', lastDay: '2026-11-07' });
  });

  it('a new deployment inside the grace: on time while the check has never started, late after 26 hours of that machine', async () => {
    const w = world();
    const deployedAt = at('2026-11-07T07:12:39Z').getTime(); // b#1225's production deploy, before its first 11:00 UTC run
    expect(w.leaseRows).toHaveLength(0);
    await expect(w.read('2026-11-07T08:00:00Z', deployedAt)).resolves.toEqual({ status: 'on_time', lastDay: null });
    await expect(w.read('2026-11-08T09:12:39Z', deployedAt)).resolves.toEqual({ status: 'on_time', lastDay: null });
    // The first day never ran at all (the timer never fired): the grace ends 26 hours after the deployment.
    await expect(w.read('2026-11-08T09:13:00Z', deployedAt)).resolves.toEqual({ status: 'late', lastDay: null });
  });

  it('a new deployment once the check has started gets no grace: a missed day is not hidden by a restart', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    const deployedAt = at('2026-11-08T13:00:00Z').getTime();
    await expect(w.read('2026-11-08T13:30:00Z', deployedAt)).resolves.toEqual({ status: 'late', lastDay: '2026-11-07' });
    // The started-but-unfinished first day (the lease row is there, nothing was sent) is not a grace either.
    const fresh = world();
    fresh.inbox.create.mockRejectedValueOnce(new Error('inbox write failed'));
    await fresh.tick('2026-11-07T11:00:00Z');
    await expect(fresh.read('2026-11-07T11:05:00Z', at('2026-11-07T10:00:00Z').getTime())).resolves.toEqual({
      status: 'late',
      lastDay: null,
    });
  });
});

describe('MONEY-ALARM-BE: the status reads what the daily check writes', () => {
  it('the same owner account, the coach_alert kind, payload.type money_check and the money_daily push key', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    await w.read('2026-11-07T11:05:00Z');
    // ownerReads[0] is the daily check's lookup (alertOwner), ownerReads[1] the status's.
    expect(w.ownerReads).toHaveLength(2);
    expect(w.ownerReads[1]).toEqual(w.ownerReads[0]);
    expect(w.inbox.reads[0]).toMatchObject({
      where: { user_id: OWNER, kind: NotificationKind.COACH_ALERT, payload: { path: ['type'], equals: 'money_check' } },
      orderBy: { created_at: 'desc' },
    });
    expect(w.outbox.db.pushOutbox.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { user_id: OWNER, dedupe_key: { in: [`${MONEY_DAILY_PUSH_KEY}2026-11-07`] } } }),
    );
  });

  it('another account, another kind or a row without a day never counts as the money check', async () => {
    const w = world();
    const stray = (data: Partial<InboxRow>) =>
      w.inbox.rows.push({ id: 'x', user_id: OWNER, kind: NotificationKind.COACH_ALERT, body: 'x', payload: null, channel: 'inapp', created_at: at('2026-11-07T11:00:00Z'), ...data });
    stray({ user_id: 'coach-2', payload: { type: 'money_check', day: '2026-11-07' } });
    stray({ kind: 'message_received', payload: { type: 'money_check', day: '2026-11-07' } });
    stray({ payload: { type: 'money_check' } });
    stray({ payload: { type: 'money_check', day: 'yesterday' } });
    stray({ payload: { type: 'other', day: '2026-11-07' } });
    w.outbox.rows.push({ ...w.outbox.rows[0], user_id: OWNER, dedupe_key: `${MONEY_DAILY_PUSH_KEY}2026-11-07` } as any);
    w.leaseRows.push({ name: DAILY_JOB_NAME, holder: 'm', lease_until: at('2026-11-08T00:00:00Z'), acquired_at: at('2026-11-07T11:00:00Z') });
    await expect(w.read('2026-11-07T12:00:00Z')).resolves.toEqual({ status: 'late', lastDay: null });
  });

  it('moneyCheckState: off first, then 26 hours from the last notice, then the first-day grace', () => {
    const now = at('2026-11-08T13:00:00Z').getTime();
    const base = { enabled: true, lastNoticeAt: null, everStarted: true, machineStartedAt: now - H, now };
    expect(moneyCheckState({ ...base, enabled: false })).toBe('off');
    expect(moneyCheckState({ ...base, lastNoticeAt: new Date(now - LATE_AFTER_MS) })).toBe('on_time');
    expect(moneyCheckState({ ...base, lastNoticeAt: new Date(now - LATE_AFTER_MS - 1) })).toBe('late');
    expect(moneyCheckState(base)).toBe('late');
    expect(moneyCheckState({ ...base, everStarted: false })).toBe('on_time');
    expect(moneyCheckState({ ...base, everStarted: false, machineStartedAt: now - LATE_AFTER_MS - 1 })).toBe('late');
    expect(LATE_AFTER_MS).toBe(26 * H);
  });
});

describe('MONEY-ALARM-BE: GET /api/money-check/status over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  const status = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MoneyCheckStatusController],
      providers: [{ provide: MoneyCheckStatusService, useValue: { status } }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new CacheControlInterceptor());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
  });

  it('answers only the state and the last finished day, never cached', async () => {
    status.mockResolvedValueOnce({ status: 'late', lastDay: '2026-11-07', checked: 12, verdict: 'needs_review' });
    const res = await fetch(new URL('/api/money-check/status', baseUrl));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({ status: 'late', lastDay: '2026-11-07' });
  });

  it('a read failure is 503 with an empty body: no reason, no raw error', async () => {
    const SENTINEL = 'postgresql://synthetic-user:synthetic-password@synthetic-db.invalid/x';
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logged.mockClear();
    status.mockRejectedValueOnce(new Error(`Connection failed: ${SENTINEL}`));
    const res = await fetch(new URL('/api/money-check/status', baseUrl));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({});
    expect(logged).toHaveBeenCalledWith({ event: 'money_check_status_unavailable', operation: 'money-check.status' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SENTINEL);
  });

  it('is public, GET money-check/status, and is not /health or /readyz (which Fly routes traffic on)', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MoneyCheckStatusController)).toBe(true);
    expect(Reflect.getMetadata(PATH_METADATA, MoneyCheckStatusController)).toBe('money-check');
    const handler = MoneyCheckStatusController.prototype.status;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('status');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    const fly = readFileSync(join(__dirname, '..', 'fly.toml'), 'utf8');
    expect(fly).not.toContain('money-check');
    const health = readFileSync(join(__dirname, '..', 'src', 'health', 'health.controller.ts'), 'utf8');
    expect(health).not.toMatch(/money|reconciliation/i);
  });
});
