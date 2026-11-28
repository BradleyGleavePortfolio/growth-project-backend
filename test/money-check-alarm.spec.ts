// MONEY-ALARM-BE (owner #202-E3, 202-S1 op 1): the daily money check's own
// status. Each case runs the REAL ReconciliationDailyCron through the REAL
// CronLeaseService, NotificationsService (inbox row) and PushDeliveryService
// (queued push) over in-memory tables, then the REAL MoneyCheckStatusService
// reads the same tables. Purchases are a stand-in. No database, no network.
//
// MONEY-NOTICE-BE (owner #203-E117, 203-D1 op 1): a day counts only when the
// run reached every purchase, read at least one (or had none to read) and its
// result was saved to the owner's inbox in the app (or, with his in-app
// alerts off, queued as a push), whether or not a phone got the push. The
// record is the reconciliation-daily lease row's cursor; the status reads it
// and nothing else. "case N" names the job's numbered cases.
//
// MONEY-EMAIL-BE (owner #203-E125): the run also emails its result, counts
// only, to the address in OWNER_ALERT_EMAIL through the REAL EmailService
// (Resend's one POST mocked), and a day also counts when the provider
// accepted that email (status 'sent'). Those cases are in the MONEY-EMAIL-BE
// describe below; "case N" there names that job's numbered cases.
import { INestApplication, Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, OPTIONAL_DEPS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CacheControlInterceptor } from '../src/common/cache-control.interceptor';
import { ENV_RULES } from '../src/common/env-validation';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { EmailService } from '../src/email/email.service';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { CronLeaseService } from '../src/checkout/cron-lease.service';
import { MoneyCheckStatusController } from '../src/checkout/money-check-status.controller';
import {
  CLOCK_SKEW_MS,
  LATE_AFTER_MS,
  MoneyCheckStatusService,
  countedRecord,
  moneyCheckState,
} from '../src/checkout/money-check-status.service';
import { AdminPaymentOpsController } from '../src/checkout/payment-ops.controller';
import {
  BATCH,
  DAILY_JOB_NAME,
  ReconciliationDailyCron,
  dailyAlertCopy,
  dailyRecord,
  notCountedReason,
  parseDailyRecord,
  type DailyRunResult,
  type DailyTally,
} from '../src/checkout/reconciliation-daily.cron';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { PrismaService } from '../src/prisma.service';
import { scanEnvReadsInSource } from './prod-readiness/env-registration';
import { loadRegistry } from './prod-readiness/registry-loader';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { Table, asPrisma, type Row } from './utils/settlement-fakes';
import { stub } from './utils/trial-fakes';

const OWNER = 'owner-1';
const TOKEN = 'ExponentPushToken[moneyalarmowner00000]';
const H = 60 * 60_000;
const at = (iso: string) => new Date(iso);
/** The day's push key, as the daily check writes it (pushToUser's dedupeKey). */
const PUSH_KEY = 'money_daily:';

interface InboxRow {
  id: string;
  user_id: string;
  kind: string;
  body: string;
  payload: Record<string, unknown> | null;
  channel: string;
  created_at: Date;
}

/** The Notification table: the daily check writes it; the status never reads it. */
function inboxTable(clock: { at: Date }) {
  const rows: InboxRow[] = [];
  return {
    rows,
    create: jest.fn(async ({ data }: { data: Omit<InboxRow, 'id' | 'created_at'> }) => {
      const row = {
        id: `n-${rows.length + 1}`,
        created_at: new Date(clock.at.getTime()),
        ...data,
      } as InboxRow;
      rows.push(row);
      return row;
    }),
  };
}

/**
 * How the stand-in sweep ends: 'ok' two clean purchases in one short batch;
 * 'error' the batch throws; 'time_limit' the batch hits the budget;
 * 'no_progress' a full batch of the same purchases failing every time;
 * 'unread' every purchase unknown or failed (Stripe down), the run reaching the end.
 */
type SweepMode = 'ok' | 'error' | 'time_limit' | 'no_progress' | 'unread';

/** The purchases; `fail` makes the batch throw; `runMs` moves the fake clock once, as the run's own time. */
function purchases(clock: { at: Date }) {
  const state: { fail: boolean; mode: SweepMode; runMs: number } = { fail: false, mode: 'ok', runMs: 0 };
  const runSweep = jest.fn(async () => {
    if (state.runMs > 0) {
      clock.at = new Date(clock.at.getTime() + state.runMs);
      state.runMs = 0;
    }
    if (state.fail || state.mode === 'error') throw new Error('batch read failed');
    if (state.mode === 'no_progress') {
      return {
        scanned: BATCH,
        drifted: 0,
        unknown: 0,
        failed: BATCH,
        outcomes: Array.from({ length: BATCH }, (_, i) => ({
          purchase_id: `pu-${i}`,
          status: 'failed' as const,
        })),
        timedOut: false,
      };
    }
    if (state.mode === 'unread') {
      return {
        scanned: 2,
        drifted: 0,
        unknown: 1,
        failed: 1,
        outcomes: [
          { purchase_id: 'pu-1', status: 'unknown' as const },
          { purchase_id: 'pu-2', status: 'failed' as const },
        ],
        timedOut: false,
      };
    }
    return {
      scanned: 2,
      drifted: 0,
      unknown: 0,
      failed: 0,
      outcomes: [
        { purchase_id: 'pu-1', status: 'ok' as const },
        { purchase_id: 'pu-2', status: 'ok' as const },
      ],
      timedOut: state.mode === 'time_limit',
    };
  });
  // One object: the cases set fail, mode and runMs on it, and the cron calls its runSweep.
  return Object.assign(state, { runSweep });
}

/**
 * MONEY-EMAIL-BE: the email world. A made-up recipient and sender on the reserved example.com domain
 * (RFC 2606); the owner's own address is a server setting and is never written in code or tests.
 */
const RECIPIENT = 'owner.alerts@example.com';
const SENDER = 'Money Check Test <money-sender@example.com>';
const EMAIL_KEY = 'money-check-daily:';
type MailTransport = 'resend' | 'log';

interface EmailLogRow {
  id: string;
  idempotency_key: string;
  template_key: string;
  recipient_email: string;
  status: string;
  provider_message_id?: string | null;
  error?: string | null;
  sent_at?: Date | null;
}

/** The EmailSendLog table: one row per idempotency key (a reused key is P2002, as the unique index does). */
function emailSendLogTable() {
  const rows: EmailLogRow[] = [];
  return {
    rows,
    create: jest.fn(async ({ data }: { data: Omit<EmailLogRow, 'id'> }) => {
      if (rows.some((r) => r.idempotency_key === data.idempotency_key)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`idempotency_key`)', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const row = { id: `email-${rows.length + 1}`, ...data };
      rows.push(row);
      return { id: row.id };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<EmailLogRow> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error('no such email row');
      Object.assign(row, data);
      return row;
    }),
  };
}

/** The REAL EmailService over the fake table; Resend's one POST is mocked per case (global fetch). */
function mailer(transport: MailTransport) {
  const emailSendLog = emailSendLogTable();
  const config: Record<string, string> = {
    EMAIL_TRANSPORT: transport,
    RESEND_API_KEY: 're_test_money_check_fake',
    EMAIL_FROM_ADDRESS: SENDER,
  };
  const service = new EmailService(
    stub<PrismaService>({ emailSendLog }),
    stub<ConfigService>({ get: (key: string) => config[key] }),
  );
  return { service, emailSendLog };
}

/** `mail`: give the cron a real EmailService (its fifth parameter); without it the cron is built as before. */
function world(opts: { mail?: MailTransport } = {}) {
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
  const sweep = purchases(clock);
  const lease = new CronLeaseService(asPrisma({ cronLease }));
  const mail = opts.mail ? mailer(opts.mail) : null;
  const machine = () => new ReconciliationDailyCron(lease, sweep as any, notifications, db as any, mail?.service);
  const cron = machine();
  const status = new MoneyCheckStatusService(db as unknown as PrismaService);
  /** The 11:00 UTC tick on one machine, at `iso`. */
  const tick = async (iso: string, c: ReconciliationDailyCron = cron, holder = 'machine-a') => {
    clock.at = at(iso);
    return c.runOnce(at(iso), holder, async () => undefined);
  };
  /** The same tick with the run's clock seam on the fake clock; the sweep takes `runMs`. */
  const timedTick = async (iso: string, runMs: number, holder = 'machine-a') => {
    clock.at = at(iso);
    sweep.runMs = runMs;
    return cron.runOnce(at(iso), holder, async () => undefined, () => clock.at.getTime());
  };
  /** The answer at `iso`; the serving machine started 3 days earlier unless given. */
  const read = (iso: string, startedAt = at(iso).getTime() - 72 * H) =>
    status.status(at(iso), startedAt);
  return {
    clock,
    db,
    inbox,
    outbox,
    leaseRows,
    owner,
    ownerReads,
    sweep,
    machine,
    cron,
    status,
    tick,
    timedTick,
    read,
    mail,
  };
}

const logSpies: jest.SpyInstance[] = [];
/** Every line the services logged in this case. */
const logged = () => logSpies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));
/** The daily check's own lines (MONEY_DAILY_*). */
const dailyLines = () => logged().filter((l) => l.startsWith('MONEY_DAILY_'));

beforeAll(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    logSpies.push(jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
  }
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  delete process.env.RECONCILIATION_DAILY_ENABLED;
  for (const s of logSpies) s.mockClear();
});

describe('MONEY-ALARM-BE: what the rows hold and what the status says, case by case', () => {
  it('a finished run writes its inbox row and queues its push: on time for 26 hours, with that day', async () => {
    const w = world();
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({
      ran: true,
      verdict: 'clean',
      alerted: true,
    });
    // What the rows hold: the lease row, the day's inbox row, the day's queued push.
    expect(w.leaseRows).toEqual([
      expect.objectContaining({ name: DAILY_JOB_NAME, acquired_at: at('2026-11-07T11:00:00Z') }),
    ]);
    expect(w.inbox.rows).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        kind: NotificationKind.COACH_ALERT,
        payload: expect.objectContaining({ type: 'money_check', day: '2026-11-07' }),
      }),
    ]);
    expect(w.outbox.rows).toEqual([
      expect.objectContaining({ user_id: OWNER, dedupe_key: `${PUSH_KEY}2026-11-07` }),
    ]);
    await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({
      status: 'on_time',
      lastDay: '2026-11-07',
    });
    await expect(w.read('2026-11-08T13:00:00Z')).resolves.toEqual({
      status: 'on_time',
      lastDay: '2026-11-07',
    });
  });

  it('the timer never fired: no new row the next day, so 26 hours after the last notice it is late', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    // 11-08 11:00 UTC: no tick at all (a restart at 11:00, a stopped scheduler). The rows stay as they were.
    await expect(w.read('2026-11-08T12:59:00Z')).resolves.toEqual({
      status: 'on_time',
      lastDay: '2026-11-07',
    });
    await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
    expect(w.inbox.rows).toHaveLength(1);
    expect(w.leaseRows[0].acquired_at).toEqual(at('2026-11-07T11:00:00Z'));
  });

  it('the lease read failed: the day is skipped with nothing written, and it goes late', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    const broken = new ReconciliationDailyCron(
      {
        tryAcquire: jest.fn(async () => {
          throw new Error('db');
        }),
        release: jest.fn(),
      } as unknown as CronLeaseService,
      w.sweep as any,
      new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(w.db)),
      w.db as any,
    );
    await expect(w.tick('2026-11-08T11:00:00Z', broken)).resolves.toEqual({
      ran: false,
      reason: 'lock_error',
    });
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([1, 1]);
    await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
  });

  it.each([
    ['error', 'The check stopped early before it reached every purchase.'],
    ['time_limit', 'The check hit its time limit before it reached every purchase.'],
    ['no_progress', 'The check stopped early before it reached every purchase.'],
  ] as const)(
    'case 3: a run stopped early (%s) still tells the owner so, but the day does not count: late 26 hours after the last counted day',
    async (stop, words) => {
      const w = world();
      await w.tick('2026-11-07T11:00:00Z');
      const recordBefore = w.leaseRows[0].cursor;
      w.sweep.mode = stop;
      const r = await w.tick('2026-11-08T11:00:00Z');
      expect(r).toMatchObject({
        ran: true,
        verdict: 'needs_review',
        alerted: true,
        counted: false,
        tally: { stopped: stop },
      });
      // His "stopped early" notice is unchanged: the inbox row and the push are both written.
      expect(w.inbox.rows[1].body).toContain(words);
      expect(w.outbox.rows.map((row) => row.dedupe_key)).toEqual([
        `${PUSH_KEY}2026-11-07`,
        `${PUSH_KEY}2026-11-08`,
      ]);
      // No record is written for the stopped day.
      expect(w.leaseRows[0].cursor).toBe(recordBefore);
      expect(dailyLines()).toContainEqual(expect.stringMatching(/^MONEY_DAILY_NOT_COUNTED .*reason=stopped/));
      await expect(w.read('2026-11-08T12:00:00Z')).resolves.toEqual({
        status: 'on_time',
        lastDay: '2026-11-07',
      });
      const answer = await w.read('2026-11-08T13:01:00Z');
      expect(answer).toEqual({ status: 'late', lastDay: '2026-11-07' });
      // case 16: the answer never carries the verdict, the counts, the reason or the words.
      expect(Object.keys(answer).sort()).toEqual(['lastDay', 'status']);
      expect(JSON.stringify(answer)).not.toMatch(/needs_review|checked|drift|stopped|purchase|reason/);
    },
  );

  it('no owner account: the run finishes but nothing is written; late at once (the check has started, no grace)', async () => {
    const w = world();
    w.owner.present = false;
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({
      ran: true,
      alerted: false,
    });
    expect([w.inbox.rows.length, w.outbox.rows.length, w.leaseRows.length]).toEqual([0, 0, 1]);
    await expect(
      w.read('2026-11-07T11:05:00Z', at('2026-11-07T10:00:00Z').getTime()),
    ).resolves.toEqual({
      status: 'late',
      lastDay: null,
    });
  });

  it('the notice failed after a finished run (the inbox write failed): no row, no push, late', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    w.inbox.create.mockRejectedValueOnce(new Error('inbox write failed'));
    await expect(w.tick('2026-11-08T11:00:00Z')).resolves.toMatchObject({
      ran: true,
      alerted: false,
    });
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([1, 1]);
    await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
  });

  it.each([
    [
      'case 1: no phone is signed in (no push token)',
      (w: ReturnType<typeof world>) => {
        w.outbox.tokens[OWNER] = null;
      },
    ],
    [
      'case 2: the phone token has a bad shape (invalid-token)',
      (w: ReturnType<typeof world>) => {
        w.outbox.tokens[OWNER] = 'not-a-push-token';
      },
    ],
  ])(
    '%s: the run finished and its result is in his inbox, so the day counts whatever the phone got',
    async (_name, breakPush) => {
      const w = world();
      breakPush(w);
      const RUN_MS = 20 * 60_000;
      await expect(w.timedTick('2026-11-07T11:00:00Z', RUN_MS)).resolves.toMatchObject({
        ran: true,
        alerted: true,
        counted: true,
      });
      expect(w.inbox.rows.map((r) => r.payload?.day)).toEqual(['2026-11-07']);
      expect(w.outbox.rows).toEqual([]);
      // The device gap has its own code; no line holds an id or a token.
      expect(dailyLines()).toContainEqual(expect.stringMatching(/^MONEY_DAILY_NO_DEVICE /));
      expect(dailyLines()).not.toContainEqual(expect.stringMatching(/^MONEY_DAILY_ALERT_FAILED/));
      expect(dailyLines().join('\n')).not.toMatch(/owner-1|ExponentPushToken|not-a-push-token/);
      // The finish time is the run's start plus the time the run took (11:20 UTC), not the start.
      const finished = at('2026-11-07T11:20:00Z').getTime();
      await expect(w.read('2026-11-07T11:25:00Z')).resolves.toEqual({
        status: 'on_time',
        lastDay: '2026-11-07',
      });
      await expect(w.status.status(new Date(finished + LATE_AFTER_MS), finished - 72 * H)).resolves.toEqual({
        status: 'on_time',
        lastDay: '2026-11-07',
      });
      await expect(w.status.status(new Date(finished + LATE_AFTER_MS + 1), finished - 72 * H)).resolves.toEqual({
        status: 'late',
        lastDay: '2026-11-07',
      });
    },
  );

  it('case 8: the push could not be queued (the enqueue throws) after the inbox row was written: the day counts', async () => {
    const w = world();
    w.outbox.db.pushOutbox.createMany.mockRejectedValueOnce(new Error('outbox down'));
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({
      ran: true,
      alerted: true,
      counted: true,
    });
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([1, 0]);
    expect(dailyLines()).toContainEqual(expect.stringMatching(/^MONEY_DAILY_PUSH_FAILED /));
    expect(dailyLines()).not.toContainEqual(expect.stringMatching(/^MONEY_DAILY_ALERT_FAILED/));
    expect(dailyLines()).not.toContainEqual(expect.stringMatching(/^MONEY_DAILY_NO_DEVICE/));
    await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({
      status: 'on_time',
      lastDay: '2026-11-07',
    });
  });

  it('case 4: the run reached the end but read no purchase (every one unknown or failed) with the push queued: not counted', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    w.sweep.mode = 'unread';
    const r = await w.tick('2026-11-08T11:00:00Z');
    expect(r).toMatchObject({
      ran: true,
      verdict: 'needs_review',
      alerted: true,
      counted: false,
      tally: { checked: 2, ok: 0, drift: 0, unknown: 1, failed: 1, stopped: null },
    });
    expect(w.outbox.rows.map((row) => row.dedupe_key)).toEqual([
      `${PUSH_KEY}2026-11-07`,
      `${PUSH_KEY}2026-11-08`,
    ]);
    expect(dailyLines()).toContainEqual(expect.stringMatching(/^MONEY_DAILY_NOT_COUNTED .*reason=nothing_read/));
    await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
  });

  it('case 7: his in-app alerts off and no phone: nothing he can read holds the result, late with no record', async () => {
    const w = world();
    w.outbox.prefs[OWNER] = { coach_alert_inapp: false };
    w.outbox.tokens[OWNER] = null;
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true });
    expect([w.inbox.rows.length, w.outbox.rows.length, w.leaseRows.length]).toEqual([0, 0, 1]);
    expect(w.leaseRows[0].cursor ?? null).toBeNull();
    await expect(
      w.read('2026-11-07T11:05:00Z', at('2026-11-07T10:00:00Z').getTime()),
    ).resolves.toEqual({
      status: 'late',
      lastDay: null,
    });
  });

  it('the owner turned in-app coach alerts off: no inbox row, the push is still queued, so on time (no false alarm)', async () => {
    const w = world();
    w.outbox.prefs[OWNER] = { coach_alert_inapp: false };
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({
      ran: true,
      alerted: true,
    });
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([0, 1]);
    await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({
      status: 'on_time',
      lastDay: '2026-11-07',
    });
  });

  it('recovery: after a late day, the next good run puts it back on time with the new day', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
    await expect(w.tick('2026-11-09T11:00:00Z')).resolves.toMatchObject({
      ran: true,
      alerted: true,
    });
    await expect(w.read('2026-11-09T11:05:00Z')).resolves.toEqual({
      status: 'on_time',
      lastDay: '2026-11-09',
    });
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
    await expect(w.tick('2026-11-07T15:00:00Z', other, 'machine-b')).resolves.toEqual({
      ran: false,
      reason: 'lock_held',
    });
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([1, 1]);
    // case 13: one record, written by the holder that ran.
    const ranHolder = results[0].ran ? 'machine-a' : 'machine-b';
    expect(w.leaseRows).toHaveLength(1);
    expect(w.leaseRows[0].holder).toBe(ranHolder);
    expect(w.leaseRows[0].cursor).toMatch(/^2026-11-07\|2026-11-07T11:00:00\.\d{3}Z$/);
    const second = new MoneyCheckStatusService(w.db as unknown as PrismaService);
    const now = at('2026-11-07T16:00:00Z');
    await expect(w.status.status(now, now.getTime() - 5 * H)).resolves.toEqual({
      status: 'on_time',
      lastDay: '2026-11-07',
    });
    await expect(second.status(now, now.getTime() - 1 * H)).resolves.toEqual({
      status: 'on_time',
      lastDay: '2026-11-07',
    });
  });

  it('the switch off: RECONCILIATION_DAILY_ENABLED=false answers off and nothing runs; unset or anything else is not off', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    process.env.RECONCILIATION_DAILY_ENABLED = 'false';
    await expect(w.tick('2026-11-08T11:00:00Z')).resolves.toEqual({
      ran: false,
      reason: 'disabled',
    });
    await expect(w.read('2026-11-09T11:00:00Z')).resolves.toEqual({
      status: 'off',
      lastDay: '2026-11-07',
    });
    for (const value of ['true', 'FALSE', '0', '']) {
      process.env.RECONCILIATION_DAILY_ENABLED = value;
      await expect(w.read('2026-11-09T11:00:00Z')).resolves.toEqual({
        status: 'late',
        lastDay: '2026-11-07',
      });
    }
    delete process.env.RECONCILIATION_DAILY_ENABLED;
    await expect(w.read('2026-11-09T11:00:00Z')).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
  });

  it('a new deployment inside the grace: on time while the check has never started, late after 26 hours of that machine', async () => {
    const w = world();
    const deployedAt = at('2026-11-07T07:12:39Z').getTime(); // b#1225's production deploy, before its first 11:00 UTC run
    expect(w.leaseRows).toHaveLength(0);
    await expect(w.read('2026-11-07T08:00:00Z', deployedAt)).resolves.toEqual({
      status: 'on_time',
      lastDay: null,
    });
    await expect(w.read('2026-11-08T09:12:39Z', deployedAt)).resolves.toEqual({
      status: 'on_time',
      lastDay: null,
    });
    // The first day never ran at all (the timer never fired): the grace ends 26 hours after the deployment.
    await expect(w.read('2026-11-08T09:13:00Z', deployedAt)).resolves.toEqual({
      status: 'late',
      lastDay: null,
    });
  });

  it('a new deployment once the check has started gets no grace: a missed day is not hidden by a restart', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    const deployedAt = at('2026-11-08T13:00:00Z').getTime();
    await expect(w.read('2026-11-08T13:30:00Z', deployedAt)).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
    // The started-but-unfinished first day (the lease row is there, nothing was sent) is not a grace either.
    const fresh = world();
    fresh.inbox.create.mockRejectedValueOnce(new Error('inbox write failed'));
    await fresh.tick('2026-11-07T11:00:00Z');
    await expect(
      fresh.read('2026-11-07T11:05:00Z', at('2026-11-07T10:00:00Z').getTime()),
    ).resolves.toEqual({
      status: 'late',
      lastDay: null,
    });
  });
});

describe('MONEY-ALARM-BE: the status reads what the daily check writes', () => {
  it('case 5: the status reads the one reconciliation-daily row and nothing else; a money_daily push row with no record (every row from before this deploy) never counts', async () => {
    const w = world();
    const stray = (user_id: string, dedupe_key: string | null) =>
      w.outbox.db.pushOutbox.create({
        data: { user_id, kind: NotificationKind.COACH_ALERT, dedupe_key, collapse_key: 'x' },
      });
    // The owner's own push row for the day, as a run before this deploy queued it, and strays.
    await stray(OWNER, `${PUSH_KEY}2026-11-07`);
    await stray('coach-2', `${PUSH_KEY}2026-11-07`);
    await stray(OWNER, 'push:6f1c');
    await stray(OWNER, null);
    await stray(OWNER, `money_daily_2026-11-07`);
    // That run's lease row: no cursor, as every row from before this deploy.
    w.leaseRows.push({
      name: DAILY_JOB_NAME,
      holder: 'm',
      lease_until: at('2026-11-08T00:00:00Z'),
      acquired_at: at('2026-11-07T11:00:00Z'),
      updated_at: at('2026-11-07T11:00:00Z'),
    });
    w.outbox.db.pushOutbox.findFirst.mockClear();
    w.db.user.findFirst.mockClear();
    w.db.cronLease.findUnique.mockClear();
    await expect(w.read('2026-11-07T12:00:00Z')).resolves.toEqual({
      status: 'late',
      lastDay: null,
    });
    // No owner lookup and no push outbox read: only the lease row, by name.
    expect(w.db.user.findFirst).not.toHaveBeenCalled();
    expect(w.outbox.db.pushOutbox.findFirst).not.toHaveBeenCalled();
    expect(w.db.cronLease.findUnique).toHaveBeenCalledTimes(1);
    expect(w.db.cronLease.findUnique.mock.calls[0][0]).toMatchObject({ where: { name: DAILY_JOB_NAME } });
    // The inbox is written by the daily check and never read by the status.
    expect(Object.keys(w.inbox)).toEqual(['rows', 'create']);
  });

  it('moneyCheckState: off first, then 26 hours from the last notice, then the first-day grace', () => {
    const now = at('2026-11-08T13:00:00Z').getTime();
    const base = {
      enabled: true,
      lastNoticeAt: null,
      everStarted: true,
      machineStartedAt: now - H,
      now,
    };
    expect(moneyCheckState({ ...base, enabled: false })).toBe('off');
    expect(moneyCheckState({ ...base, lastNoticeAt: new Date(now - LATE_AFTER_MS) })).toBe(
      'on_time',
    );
    expect(moneyCheckState({ ...base, lastNoticeAt: new Date(now - LATE_AFTER_MS - 1) })).toBe(
      'late',
    );
    expect(moneyCheckState(base)).toBe('late');
    expect(moneyCheckState({ ...base, everStarted: false })).toBe('on_time');
    expect(
      moneyCheckState({ ...base, everStarted: false, machineStartedAt: now - LATE_AFTER_MS - 1 }),
    ).toBe('late');
    expect(LATE_AFTER_MS).toBe(26 * H);
  });
});

describe('MONEY-NOTICE-BE: the record, its write and its lifetime', () => {
  it('case 10: the record write throws after a sent notice: late, the run resolves, the notice stays as sent, the reason is logged', async () => {
    const w = world();
    const real = w.db.cronLease.updateMany.getMockImplementation()!;
    w.db.cronLease.updateMany.mockImplementation(async (args: any) => {
      if (args?.data && 'cursor' in args.data) throw new Error('write failed');
      return real(args);
    });
    try {
      await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({
        ran: true,
        alerted: true,
        counted: false,
      });
    } finally {
      w.db.cronLease.updateMany.mockImplementation(real);
    }
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([1, 1]);
    expect(w.leaseRows[0].cursor ?? null).toBeNull();
    expect(dailyLines()).toContainEqual(expect.stringMatching(/^MONEY_DAILY_NOT_COUNTED .*reason=write_failed/));
    await expect(
      w.read('2026-11-07T11:05:00Z', at('2026-11-07T10:00:00Z').getTime()),
    ).resolves.toEqual({ status: 'late', lastDay: null });
  });

  it('case 10: the holder no longer matches when the record is written (count 0): late, the run resolves, the reason is logged', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    const yesterday = w.leaseRows[0].cursor;
    // While today's run sweeps, another holder takes the row (a lease that ran out under a stuck run).
    const real = w.sweep.runSweep.getMockImplementation()!;
    w.sweep.runSweep.mockImplementationOnce(async () => {
      w.leaseRows[0].holder = 'machine-z';
      return real();
    });
    await expect(w.tick('2026-11-08T11:00:00Z')).resolves.toMatchObject({
      ran: true,
      alerted: true,
      counted: false,
    });
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([2, 2]);
    expect(w.leaseRows[0].cursor).toBe(yesterday);
    expect(dailyLines()).toContainEqual(expect.stringMatching(/^MONEY_DAILY_NOT_COUNTED .*reason=write_failed/));
    await expect(w.read('2026-11-08T13:01:00Z')).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
  });

  it('case 11: yesterday counted; today the run takes the lease and dies before the end: late 26 hours after yesterday\'s finish (acquired_at and updated_at are not read)', async () => {
    const w = world();
    await w.timedTick('2026-11-07T11:00:00Z', 20 * 60_000);
    const yesterday = w.leaseRows[0].cursor;
    // Today's run takes the lease, then the process dies inside the sweep: it never comes back.
    w.sweep.runSweep.mockImplementationOnce(() => new Promise(() => undefined));
    void w.tick('2026-11-08T11:00:00Z');
    await new Promise((r) => setImmediate(r));
    expect(w.leaseRows[0]).toMatchObject({ holder: 'machine-a', acquired_at: at('2026-11-08T11:00:00Z') });
    expect(w.leaseRows[0].cursor).toBe(yesterday);
    expect(w.inbox.rows).toHaveLength(1);
    // Yesterday's finish was 11:20 UTC: on time to 13:20 UTC today, late after, whatever the lease row's times say.
    await expect(w.read('2026-11-08T13:20:00Z')).resolves.toEqual({
      status: 'on_time',
      lastDay: '2026-11-07',
    });
    await expect(w.read('2026-11-08T13:20:00.001Z')).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
  });

  it.each([
    ['junk', 'not a record'],
    ['empty', ''],
    ['a bad day', '2026-02-30|2026-02-30T11:00:00.000Z'],
    ['a bad time', '2026-11-07|2026-11-07T24:00:00.000Z'],
    ['another writer\'s cursor shape', '2026-11-07|inapp,push|0'],
    ['a finish time more than 5 minutes ahead of now', '2026-11-07|2026-11-07T12:05:00.001Z'],
  ])('case 12: a cursor that is %s is no record: lastDay null, not on time, no throw', async (_name, cursor) => {
    const w = world();
    w.leaseRows.push({
      name: DAILY_JOB_NAME,
      holder: 'machine-a',
      lease_until: at('2026-11-08T00:00:00Z'),
      acquired_at: at('2026-11-07T11:00:00Z'),
      cursor,
    });
    await expect(w.read('2026-11-07T12:00:00Z', at('2026-11-07T10:00:00Z').getTime())).resolves.toEqual({
      status: 'late',
      lastDay: null,
    });
  });

  it('case 14: the admin run-sweeper between two daily runs leaves the record alone, and a late answer stays late', async () => {
    const w = world();
    await w.tick('2026-11-07T11:00:00Z');
    const record = { ...w.leaseRows[0] };
    const ctl = Object.create(AdminPaymentOpsController.prototype) as AdminPaymentOpsController;
    (ctl as any).reconciliation = w.sweep;
    w.clock.at = at('2026-11-08T14:00:00Z');
    await expect(ctl.runReconciliationSweeper('50')).resolves.toEqual({ scanned: 2, drifted: 0, unknown: 0 });
    expect(w.leaseRows).toEqual([record]);
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([1, 1]);
    await expect(w.read('2026-11-08T14:05:00Z')).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
  });

  it('case 17: the notice is unchanged: the push title, body, data and route and the inbox row body and payload', async () => {
    const w = world();
    w.sweep.mode = 'error';
    await w.tick('2026-11-07T11:00:00Z');
    const body = 'Checked 0 purchases against Stripe. The check stopped early before it reached every purchase.';
    expect(w.inbox.rows).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        kind: NotificationKind.COACH_ALERT,
        channel: 'inapp',
        body,
        payload: {
          type: 'money_check',
          title: 'Money check: needs review',
          verdict: 'needs_review',
          checked: 0,
          drift: 0,
          unknown: 0,
          failed: 0,
          day: '2026-11-07',
        },
      }),
    ]);
    expect(w.outbox.rows).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        kind: NotificationKind.COACH_ALERT,
        dedupe_key: `${PUSH_KEY}2026-11-07`,
        collapse_key: `${PUSH_KEY}2026-11-07`,
        title: 'Money check: needs review',
        body,
        data: { type: 'money_check', verdict: 'needs_review', actionScreen: 'NotificationCenter' },
        context: expect.objectContaining({ passesMuteAll: true, senderWords: true }),
      }),
    ]);
  });

  it.each([
    ['inbox written, push queued', {}, true],
    ['inbox written, no phone', { token: null }, true],
    ['in-app off, push queued', { inapp: false }, true],
    ['in-app off, no phone', { inapp: false, token: null }, false],
  ] as const)('R6: alerted is rule (c) alone: %s', async (_name, opts, alerted) => {
    const w = world();
    if ('inapp' in opts) w.outbox.prefs[OWNER] = { coach_alert_inapp: false };
    if ('token' in opts) w.outbox.tokens[OWNER] = null;
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted });
  });
});

describe('MONEY-NOTICE-BE: the pure parts, table by table', () => {
  it('dailyRecord writes the day and the finish time; parseDailyRecord reads them back', () => {
    const record = { day: '2026-11-07', finishedAt: at('2026-11-07T11:20:00.000Z') };
    expect(dailyRecord(record)).toBe('2026-11-07|2026-11-07T11:20:00.000Z');
    expect(parseDailyRecord(dailyRecord(record))).toEqual(record);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['junk', 'counted'],
    ['a day alone', '2026-11-07'],
    ['a day and an empty time', '2026-11-07|'],
    ['month 13', '2026-13-01|2026-11-07T11:00:00.000Z'],
    ['February 30', '2026-02-30|2026-11-07T11:00:00.000Z'],
    ['hour 24', '2026-11-07|2026-11-07T24:00:00.000Z'],
    ['no milliseconds', '2026-11-07|2026-11-07T11:00:00Z'],
    ['a time zone offset', '2026-11-07|2026-11-07T11:00:00.000+01:00'],
    ['a leading space', ' 2026-11-07|2026-11-07T11:00:00.000Z'],
    ['an extra field', '2026-11-07|2026-11-07T11:00:00.000Z|x'],
    ['another writer\'s cursor shape', '2026-11-07|inapp,push|0'],
    ['JSON', '{"day":"2026-11-07","finishedAt":"2026-11-07T11:00:00.000Z"}'],
  ])('parseDailyRecord: %s is no record (null, never a throw)', (_name, raw) => {
    expect(parseDailyRecord(raw as string | null | undefined)).toBeNull();
  });

  it('countedRecord: a finish time up to 5 minutes ahead of now is a record; any later is none (R5)', () => {
    const now = at('2026-11-07T12:00:00.000Z');
    const cursor = (finish: number) => dailyRecord({ day: '2026-11-07', finishedAt: new Date(finish) });
    expect(CLOCK_SKEW_MS).toBe(5 * 60_000);
    expect(countedRecord(cursor(now.getTime() - H), now)).toEqual({
      day: '2026-11-07',
      finishedAt: new Date(now.getTime() - H),
    });
    expect(countedRecord(cursor(now.getTime() + CLOCK_SKEW_MS), now)).not.toBeNull();
    expect(countedRecord(cursor(now.getTime() + CLOCK_SKEW_MS + 1), now)).toBeNull();
    expect(countedRecord('junk', now)).toBeNull();
    expect(countedRecord(null, now)).toBeNull();
  });

  const t = (p: Partial<DailyTally>): DailyTally => ({
    checked: 2,
    ok: 2,
    drift: 0,
    unknown: 0,
    failed: 0,
    stopped: null,
    ...p,
  });
  it.each([
    ['reached the end, read, reached him', t({}), true, null],
    ['every purchase read and none matches (drift is a read)', t({ ok: 0, drift: 2 }), true, null],
    ['no purchases to check', t({ checked: 0, ok: 0 }), true, null],
    ['a few unknown or failed among reads', t({ checked: 4, ok: 2, unknown: 1, failed: 1 }), true, null],
    ['stopped: error', t({ stopped: 'error' }), true, 'stopped'],
    ['stopped: time_limit', t({ stopped: 'time_limit' }), true, 'stopped'],
    ['stopped: no_progress', t({ checked: 50, ok: 0, failed: 50, stopped: 'no_progress' }), true, 'stopped'],
    ['every purchase unknown or failed', t({ ok: 0, unknown: 1, failed: 1 }), true, 'nothing_read'],
    ['every purchase unknown', t({ ok: 0, unknown: 2 }), true, 'nothing_read'],
    ['the result reached nothing he reads', t({}), false, 'notice'],
    ['stopped and not reached: stopped first', t({ stopped: 'error' }), false, 'stopped'],
    ['nothing read and not reached: nothing_read first', t({ ok: 0, failed: 2 }), false, 'nothing_read'],
  ] as const)('notCountedReason: %s', (_name, tally, reached, reason) => {
    expect(notCountedReason(tally, reached)).toBe(reason);
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
    status.mockResolvedValueOnce({
      status: 'late',
      lastDay: '2026-11-07',
      checked: 12,
      verdict: 'needs_review',
    });
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
    expect(logged).toHaveBeenCalledWith({
      event: 'money_check_status_unavailable',
      operation: 'money-check.status',
    });
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
    const health = readFileSync(
      join(__dirname, '..', 'src', 'health', 'health.controller.ts'),
      'utf8',
    );
    expect(health).not.toMatch(/money|reconciliation/i);
  });
});

describe('MONEY-EMAIL-BE: the daily result is emailed to OWNER_ALERT_EMAIL, and an accepted email counts the day', () => {
  const savedAddress = process.env.OWNER_ALERT_EMAIL;
  let fetchSpy: jest.SpyInstance | null = null;
  const setAddress = (value: string | undefined) => {
    if (value === undefined) delete process.env.OWNER_ALERT_EMAIL;
    else process.env.OWNER_ALERT_EMAIL = value;
  };
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    setAddress(savedAddress);
  });

  interface ResendCall {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }
  /** Resend's one HTTP POST, answered the same way each time; every call is recorded. */
  const resend = (answer: 'ok' | 'reject' | 'throw' | 'no-id' = 'ok'): ResendCall[] => {
    const calls: ResendCall[] = [];
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      calls.push({
        url: String(url),
        headers: { ...(init?.headers ?? {}) },
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      if (answer === 'throw') throw new TypeError('fetch failed');
      if (answer === 'reject') {
        return { ok: false, status: 422, json: async () => ({}), text: async () => '{"name":"validation_error"}' } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => (answer === 'no-id' ? {} : { id: `re_msg_${calls.length}` }),
        text: async () => '',
      } as any;
    });
    return calls;
  };
  /** The two lines that say why no email was accepted. */
  const emailLines = () => dailyLines().filter((l) => /^MONEY_DAILY_(NO_EMAIL|EMAIL_FAILED)\b/.test(l));
  /** No line any service logged in this case holds the address or any part of it. */
  const expectNoAddressLogged = (...parts: string[]) => {
    const all = logged().join('\n');
    for (const part of parts) expect(all).not.toContain(part);
  };
  /** Handlebars' own escaping of {{body}}, to look for the words inside the html. */
  const esc = (s: string) =>
    s.replace(/[&<>"'`=]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#x27', '`': '#x60', '=': '#x3D' }[c]};`);
  const tallyOf = (r: DailyRunResult): DailyTally => {
    if (!r.ran) throw new Error(`the run did not run: ${r.reason}`);
    return r.tally;
  };
  const ME7 =
    'This email holds counts only: no names, amounts or purchase ids. The daily money check sends it once a day, after its 11:00 UTC run, to the address in the server setting OWNER_ALERT_EMAIL.';

  it('case 1: no owner account, a valid address, Resend accepts: on time with that day, one sent EmailSendLog row, one POST; late 26 hours and 1 ms after the finish', async () => {
    setAddress(RECIPIENT);
    const calls = resend('ok');
    const w = world({ mail: 'resend' });
    w.owner.present = false;
    const r = await w.timedTick('2026-11-07T11:00:00Z', 20 * 60_000);
    expect(r).toMatchObject({ ran: true, verdict: 'clean', alerted: true, counted: true });
    expect([w.inbox.rows.length, w.outbox.rows.length]).toEqual([0, 0]);
    expect(w.mail!.emailSendLog.rows).toEqual([
      expect.objectContaining({
        idempotency_key: `${EMAIL_KEY}2026-11-07`,
        template_key: 'money-check-daily',
        status: 'sent',
        provider_message_id: 're_msg_1',
      }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].body).toMatchObject({ to: RECIPIENT, subject: dailyAlertCopy(tallyOf(r)).title });
    // The day's key goes to Resend as its Idempotency-Key (with the content hash EmailService adds).
    expect(calls[0].headers['Idempotency-Key']).toMatch(/^money-check-daily:2026-11-07:[0-9a-f]{32}$/);
    // The record: the day and the finish time on the run's own clock (11:20 UTC).
    expect(w.leaseRows[0].cursor).toBe('2026-11-07|2026-11-07T11:20:00.000Z');
    expect(dailyLines()).toContainEqual('MONEY_DAILY_COUNTED day=2026-11-07');
    // E6: no owner account still says so, and now says only the inbox row and the push were not sent.
    expect(dailyLines()).toContainEqual('MONEY_DAILY_NO_OWNER alert=true no owner account; no inbox row or push was sent');
    expect(emailLines()).toEqual([]);
    const finished = at('2026-11-07T11:20:00Z').getTime();
    await expect(w.status.status(new Date(finished + LATE_AFTER_MS), finished - 72 * H)).resolves.toEqual({
      status: 'on_time',
      lastDay: '2026-11-07',
    });
    await expect(w.status.status(new Date(finished + LATE_AFTER_MS + 1), finished - 72 * H)).resolves.toEqual({
      status: 'late',
      lastDay: '2026-11-07',
    });
    expectNoAddressLogged(RECIPIENT, 'owner.alerts');
  });

  it('case 2: Resend refuses (422): late with no day, the row failed, MONEY_DAILY_EMAIL_FAILED status=failed, not alerted, no record', async () => {
    setAddress(RECIPIENT);
    const calls = resend('reject');
    const w = world({ mail: 'resend' });
    w.owner.present = false;
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: false, counted: false });
    expect(calls).toHaveLength(1);
    expect(w.mail!.emailSendLog.rows).toEqual([expect.objectContaining({ status: 'failed', provider_message_id: null })]);
    expect(emailLines()).toEqual([
      expect.stringMatching(/^MONEY_DAILY_EMAIL_FAILED status=failed error=provider=resend status=422 code=validation_error\b/),
    ]);
    expect(dailyLines()).toContainEqual(expect.stringMatching(/^MONEY_DAILY_NOT_COUNTED .*reason=notice/));
    expect(w.leaseRows[0].cursor ?? null).toBeNull();
    await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({ status: 'late', lastDay: null });
    expectNoAddressLogged(RECIPIENT, 'owner.alerts');
  });

  it('case 3: the provider call throws (no network): late, the run resolves, the row failed', async () => {
    setAddress(RECIPIENT);
    resend('throw');
    const w = world({ mail: 'resend' });
    w.owner.present = false;
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: false, counted: false });
    expect(w.mail!.emailSendLog.rows).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(emailLines()).toEqual([expect.stringMatching(/^MONEY_DAILY_EMAIL_FAILED status=failed error=/)]);
    await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({ status: 'late', lastDay: null });
  });

  it('case 3b: the send itself throws (its EmailSendLog write fails): late, the run resolves, MONEY_DAILY_EMAIL_FAILED status=thrown', async () => {
    setAddress(RECIPIENT);
    const calls = resend('ok');
    const w = world({ mail: 'resend' });
    w.owner.present = false;
    w.mail!.emailSendLog.create.mockRejectedValueOnce(new Error('email log down'));
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: false, counted: false });
    expect(calls).toEqual([]);
    expect(emailLines()).toEqual([expect.stringMatching(/^MONEY_DAILY_EMAIL_FAILED status=thrown error=Error\b/)]);
    expect(logged().join('\n')).not.toContain('email log down');
    await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({ status: 'late', lastDay: null });
  });

  it("case 4: EMAIL_TRANSPORT 'log': status logged, no fetch, late, MONEY_DAILY_EMAIL_FAILED status=logged", async () => {
    setAddress(RECIPIENT);
    const calls = resend('ok');
    const w = world({ mail: 'log' });
    w.owner.present = false;
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: false, counted: false });
    expect(calls).toEqual([]);
    expect(w.mail!.emailSendLog.rows).toEqual([expect.objectContaining({ status: 'logged' })]);
    expect(emailLines()).toEqual([expect.stringMatching(/^MONEY_DAILY_EMAIL_FAILED status=logged error=none\b/)]);
    await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({ status: 'late', lastDay: null });
  });

  it.each([true, false])(
    'case 5a: OWNER_ALERT_EMAIL unset (owner account present: %s): every outcome is as a run with no EmailService; no fetch, no EmailSendLog row',
    async (present) => {
      setAddress(undefined);
      const calls = resend('ok');
      const before = world();
      const mailed = world({ mail: 'resend' });
      before.owner.present = present;
      mailed.owner.present = present;
      // The run's clock seam on the fake clock, so both records carry the same finish time.
      const a = await before.timedTick('2026-11-07T11:00:00Z', 0);
      const b = await mailed.timedTick('2026-11-07T11:00:00Z', 0);
      expect(b).toEqual(a);
      expect(a).toMatchObject({ ran: true, alerted: present, counted: present });
      expect(mailed.inbox.rows).toEqual(before.inbox.rows);
      expect(mailed.outbox.rows).toEqual(before.outbox.rows);
      // The lease row as the status reads it (the fake table's own id counter and wall-clock stamps differ per world).
      const leaseView = (rows: Row[]) =>
        rows.map(({ name, holder, acquired_at, lease_until, cursor }) => ({ name, holder, acquired_at, lease_until, cursor }));
      expect(leaseView(mailed.leaseRows)).toEqual(leaseView(before.leaseRows));
      expect(mailed.leaseRows).toHaveLength(1);
      await expect(mailed.read('2026-11-07T11:05:00Z')).resolves.toEqual(await before.read('2026-11-07T11:05:00Z'));
      expect(calls).toEqual([]);
      expect(mailed.mail!.emailSendLog.rows).toEqual([]);
    },
  );

  it('case 5b: OWNER_ALERT_EMAIL unset: MONEY_DAILY_NO_EMAIL reason=unset, once', async () => {
    setAddress(undefined);
    resend('ok');
    const w = world({ mail: 'resend' });
    await w.tick('2026-11-07T11:00:00Z');
    expect(emailLines()).toEqual([expect.stringMatching(/^MONEY_DAILY_NO_EMAIL reason=unset\b/)]);
  });

  it.each([
    ['empty', ''],
    ['spaces only', '   '],
    ['two addresses with a comma', 'owner.alerts@example.com, second.inbox@example.com'],
    ['a CR inside', 'owner.alerts@example.com\rBcc: second.inbox@example.com'],
    ['an LF inside', 'owner.alerts@example.com\nBcc: second.inbox@example.com'],
    ['no @', 'owner.alerts.example.com'],
  ])(
    'case 6: OWNER_ALERT_EMAIL %s is not one address: no send, MONEY_DAILY_NO_EMAIL reason=invalid, and no line holds the value',
    async (_name, value) => {
      setAddress(value);
      const calls = resend('ok');
      const w = world({ mail: 'resend' });
      w.owner.present = false;
      await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: false, counted: false });
      expect(calls).toEqual([]);
      expect(w.mail!.emailSendLog.rows).toEqual([]);
      expect(emailLines()).toEqual([expect.stringMatching(/^MONEY_DAILY_NO_EMAIL reason=invalid\b/)]);
      expectNoAddressLogged('owner.alerts', 'second.inbox', 'Bcc');
    },
  );

  it('case 6: a display-name form on example.com is one address and sends', async () => {
    const named = 'Owner Alerts <owner.alerts@example.com>';
    setAddress(named);
    const calls = resend('ok');
    const w = world({ mail: 'resend' });
    w.owner.present = false;
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: true, counted: true });
    expect(calls.map((c) => c.body.to)).toEqual([named]);
    expect(emailLines()).toEqual([]);
    expectNoAddressLogged('owner.alerts', 'Owner Alerts');
  });

  it.each([['error'], ['time_limit'], ['no_progress'], ['unread']] as const)(
    'case 7: a run that %s, with the email sent: late, no record; the email still says "needs review"',
    async (mode) => {
      setAddress(RECIPIENT);
      const calls = resend('ok');
      const w = world({ mail: 'resend' });
      w.owner.present = false;
      w.sweep.mode = mode;
      const r = await w.tick('2026-11-07T11:00:00Z');
      expect(r).toMatchObject({ ran: true, verdict: 'needs_review', alerted: true, counted: false });
      expect(dailyLines()).toContainEqual(
        expect.stringMatching(mode === 'unread' ? /^MONEY_DAILY_NOT_COUNTED .*reason=nothing_read/ : /^MONEY_DAILY_NOT_COUNTED .*reason=stopped/),
      );
      expect(w.leaseRows[0].cursor ?? null).toBeNull();
      await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({ status: 'late', lastDay: null });
      const { title, body } = dailyAlertCopy(tallyOf(r));
      expect(title).toBe('Money check: needs review');
      expect(calls).toHaveLength(1);
      expect(calls[0].body.subject).toBe(title);
      expect(String(calls[0].body.html)).toContain(esc(body));
      expect(w.mail!.emailSendLog.rows).toEqual([expect.objectContaining({ status: 'sent' })]);
    },
  );

  it('case 8: owner present, inbox written, push queued, email sent: on time; one row, one push, one email; the row and the push as a run with no email', async () => {
    setAddress(RECIPIENT);
    const calls = resend('ok');
    const before = world();
    const w = world({ mail: 'resend' });
    await before.tick('2026-11-07T11:00:00Z');
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: true, counted: true });
    expect([w.inbox.rows.length, w.outbox.rows.length, calls.length, w.mail!.emailSendLog.rows.length]).toEqual([1, 1, 1, 1]);
    expect(w.inbox.rows).toEqual(before.inbox.rows);
    expect(w.outbox.rows).toEqual(before.outbox.rows);
    await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({ status: 'on_time', lastDay: '2026-11-07' });
  });

  it("case 9: once a day: two machines at one tick send one email; a second run the same UTC day sends none; the next day uses the next day's key", async () => {
    setAddress(RECIPIENT);
    const calls = resend('ok');
    const w = world({ mail: 'resend' });
    w.owner.present = false;
    const other = w.machine();
    w.clock.at = at('2026-11-07T11:00:00Z');
    const results = await Promise.all([
      w.cron.runOnce(at('2026-11-07T11:00:00Z'), 'machine-a', async () => undefined),
      other.runOnce(at('2026-11-07T11:00:00Z'), 'machine-b', async () => undefined),
    ]);
    expect(results.map((r) => (r.ran ? 'ran' : r.reason)).sort()).toEqual(['lock_held', 'ran']);
    await expect(w.tick('2026-11-07T15:00:00Z', other, 'machine-b')).resolves.toEqual({ ran: false, reason: 'lock_held' });
    expect(calls).toHaveLength(1);
    expect(w.mail!.emailSendLog.rows.map((r) => r.idempotency_key)).toEqual([`${EMAIL_KEY}2026-11-07`]);
    await expect(w.tick('2026-11-08T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: true, counted: true });
    expect(calls).toHaveLength(2);
    expect(w.mail!.emailSendLog.rows.map((r) => r.idempotency_key)).toEqual([
      `${EMAIL_KEY}2026-11-07`,
      `${EMAIL_KEY}2026-11-08`,
    ]);
    expect(calls[1].headers['Idempotency-Key']).toMatch(/^money-check-daily:2026-11-08:/);
  });

  it("case 10: the day's key was already used: send answers skipped, no fetch, not counted by the email (late with no owner)", async () => {
    setAddress(RECIPIENT);
    const calls = resend('ok');
    const w = world({ mail: 'resend' });
    w.owner.present = false;
    w.mail!.emailSendLog.rows.push({
      id: 'email-earlier',
      idempotency_key: `${EMAIL_KEY}2026-11-07`,
      template_key: 'money-check-daily',
      recipient_email: RECIPIENT,
      status: 'sending',
    });
    await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted: false, counted: false });
    expect(calls).toEqual([]);
    expect(w.mail!.emailSendLog.rows).toHaveLength(1);
    expect(emailLines()).toEqual([expect.stringMatching(/^MONEY_DAILY_EMAIL_FAILED status=skipped error=none\b/)]);
    await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual({ status: 'late', lastDay: null });
  });

  it("case 11: the email holds counts only: the subject is the title, the html the body, the day and the two closing lines; EmailService's sender; no reply-to", async () => {
    setAddress(RECIPIENT);
    const calls = resend('ok');
    const w = world({ mail: 'resend' });
    const r = await w.tick('2026-11-07T11:00:00Z');
    const { title, body } = dailyAlertCopy(tallyOf(r));
    expect(calls).toHaveLength(1);
    const sent = calls[0].body;
    expect(Object.keys(sent).sort()).toEqual(['from', 'html', 'subject', 'to']);
    expect(sent.subject).toBe(title);
    expect(sent.from).toBe(SENDER);
    const html = String(sent.html);
    expect(html).toContain(`>${esc(title)}</h1>`);
    expect(html).toContain(esc(body));
    expect(html).toContain('Day checked: 2026-11-07 (UTC).');
    expect(html).toContain(ME7);
    // No purchase id, no account id, no amount, no address.
    expect(html).not.toMatch(/pu-\d|owner-1|\$\d|@/);
  });

  it('case 12: Nest injects EmailService as the fifth, optional parameter', async () => {
    expect(Reflect.getMetadata('design:paramtypes', ReconciliationDailyCron)[4]).toBe(EmailService);
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, ReconciliationDailyCron)).toEqual([4]);
    const email = { send: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReconciliationDailyCron,
        { provide: CronLeaseService, useValue: {} },
        { provide: ReconciliationService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: EmailService, useValue: email },
      ],
    }).compile();
    expect((moduleRef.get(ReconciliationDailyCron) as any).email).toBe(email);
    await moduleRef.close();
  });

  it('case 13: OWNER_ALERT_EMAIL is registered (ENV_RULES feature row with a default; prod-switches.yml row) and the env scanner sees the read', async () => {
    const rule = ENV_RULES.find((r) => r.name === 'OWNER_ALERT_EMAIL');
    expect(rule).toMatchObject({ tier: 'feature' });
    expect(rule?.default?.trim()).toBeTruthy();
    expect(rule?.reason).toMatch(/MONEY-EMAIL-BE/);
    expect([rule?.values, rule?.unsetIs, rule?.launch, rule?.validate]).toEqual([undefined, undefined, undefined, undefined]);
    const registry = await loadRegistry(join(__dirname, '..', 'prod-switches.yml'));
    expect(registry.switches.find((s) => s.name === 'OWNER_ALERT_EMAIL')).toMatchObject({
      tier: 'feature',
      prod_default: 'ON',
      auto_flip_on_in_prod: false,
      owner: 'email',
    });
    const rel = 'src/checkout/reconciliation-daily.cron.ts';
    const reads = scanEnvReadsInSource(readFileSync(join(__dirname, '..', rel), 'utf8'), rel).names;
    expect([...reads]).toContain('OWNER_ALERT_EMAIL');
  });

  it('Q1: the admin run-sweeper sends no email, with OWNER_ALERT_EMAIL set', async () => {
    setAddress(RECIPIENT);
    const calls = resend('ok');
    const w = world({ mail: 'resend' });
    const ctl = Object.create(AdminPaymentOpsController.prototype) as AdminPaymentOpsController;
    (ctl as any).reconciliation = w.sweep;
    await expect(ctl.runReconciliationSweeper('50')).resolves.toEqual({ scanned: 2, drifted: 0, unknown: 0 });
    expect(calls).toEqual([]);
    expect(w.mail!.emailSendLog.rows).toEqual([]);
  });

  type Setup = (w: ReturnType<typeof world>) => void;
  const noOwner: Setup = (w) => {
    w.owner.present = false;
  };
  const inappOff: Setup = (w) => {
    w.outbox.prefs[OWNER] = { coach_alert_inapp: false };
  };
  const noPhone: Setup = (w) => {
    w.outbox.tokens[OWNER] = null;
  };
  const both =
    (...s: Setup[]): Setup =>
    (w) => {
      for (const f of s) f(w);
    };
  const usedKey: Setup = (w) => {
    w.mail!.emailSendLog.rows.push({
      id: 'email-earlier',
      idempotency_key: `${EMAIL_KEY}2026-11-07`,
      template_key: 'money-check-daily',
      recipient_email: RECIPIENT,
      status: 'sent',
    });
  };
  const recordWriteFails: Setup = (w) => {
    const real = w.db.cronLease.updateMany.getMockImplementation()!;
    w.db.cronLease.updateMany.mockImplementation(async (args: any) => {
      if (args?.data && 'cursor' in args.data) throw new Error('write failed');
      return real(args);
    });
  };
  const anotherHolder: Setup = (w) => {
    const real = w.sweep.runSweep.getMockImplementation()!;
    w.sweep.runSweep.mockImplementationOnce(async () => {
      w.leaseRows[0].holder = 'machine-z';
      return real();
    });
  };
  const nothingToCheck: Setup = (w) => {
    w.sweep.runSweep.mockImplementationOnce(async () => ({
      scanned: 0,
      drifted: 0,
      unknown: 0,
      failed: 0,
      outcomes: [],
      timedOut: false,
    }));
  };
  const mode =
    (m: SweepMode): Setup =>
    (w) => {
      w.sweep.mode = m;
    };
  const inboxThrows: Setup = (w) => {
    w.inbox.create.mockRejectedValueOnce(new Error('inbox write failed'));
  };
  const ON = { status: 'on_time', lastDay: '2026-11-07' };
  const LATE = { status: 'late', lastDay: null };
  it.each([
    // [row, setup, transport, address, Resend's answer, alerted, counted, the answer at 11:05]
    ['reached the end, no owner, email sent (moved)', noOwner, 'resend', RECIPIENT, 'ok', true, true, ON],
    ['no owner, Resend refuses', noOwner, 'resend', RECIPIENT, 'reject', false, false, LATE],
    ['no owner, Resend answers 2xx with no id', noOwner, 'resend', RECIPIENT, 'no-id', false, false, LATE],
    ['no owner, the call throws', noOwner, 'resend', RECIPIENT, 'throw', false, false, LATE],
    ['no owner, the log transport (logged)', noOwner, 'log', RECIPIENT, 'ok', false, false, LATE],
    ['no owner, the key already used (skipped)', both(noOwner, usedKey), 'resend', RECIPIENT, 'ok', false, false, LATE],
    ['no owner, OWNER_ALERT_EMAIL unset', noOwner, 'resend', undefined, 'ok', false, false, LATE],
    ['no owner, OWNER_ALERT_EMAIL two addresses', noOwner, 'resend', 'a.one@example.com, b.two@example.com', 'ok', false, false, LATE],
    ['inbox written, email refused', (_w: ReturnType<typeof world>) => undefined, 'resend', RECIPIENT, 'reject', true, true, ON],
    ['inbox written, OWNER_ALERT_EMAIL unset', (_w: ReturnType<typeof world>) => undefined, 'resend', undefined, 'ok', true, true, ON],
    ['in-app off, push queued, email refused (b#1268 arm, unchanged)', inappOff, 'resend', RECIPIENT, 'reject', true, true, ON],
    ['in-app off, push not queued, email sent (moved)', both(inappOff, noPhone), 'resend', RECIPIENT, 'ok', true, true, ON],
    ['in-app off, push not queued, email refused', both(inappOff, noPhone), 'resend', RECIPIENT, 'reject', false, false, LATE],
    ['the inbox write throws, email sent (moved)', inboxThrows, 'resend', RECIPIENT, 'ok', true, true, ON],
    ['the inbox write throws, email refused', inboxThrows, 'resend', RECIPIENT, 'reject', false, false, LATE],
    ['email sent, but the record write fails', both(noOwner, recordWriteFails), 'resend', RECIPIENT, 'ok', true, false, LATE],
    ['email sent, but another holder has the row', both(noOwner, anotherHolder), 'resend', RECIPIENT, 'ok', true, false, LATE],
    ['nothing to check (checked 0), no owner, email sent (moved)', both(noOwner, nothingToCheck), 'resend', RECIPIENT, 'ok', true, true, ON],
    ['stopped (error), no owner, email sent: rule (a)', both(noOwner, mode('error')), 'resend', RECIPIENT, 'ok', true, false, LATE],
    ['nothing read, no owner, email sent: rule (b)', both(noOwner, mode('unread')), 'resend', RECIPIENT, 'ok', true, false, LATE],
  ] as const)(
    'the class table: %s',
    async (_row, setup, transport, address, answer, alerted, counted, answerAt) => {
      setAddress(address);
      resend(answer);
      const w = world({ mail: transport });
      setup(w);
      await expect(w.tick('2026-11-07T11:00:00Z')).resolves.toMatchObject({ ran: true, alerted, counted });
      await expect(w.read('2026-11-07T11:05:00Z')).resolves.toEqual(answerAt);
    },
  );
});
