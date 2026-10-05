/**
 * AUD-OPUS-PUSH-120 (Claude Opus 5.5 lens) LIVE probes on backend #693 @
 * 13417e7b: the PushOutbox worker against real Postgres. Every unit spec in
 * the PR drives the worker through test/utils/push-outbox-fake.ts, so the raw
 * claim statement (UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
 * RETURNING ...), the (user_id, dedupe_key) unique index, the lease release,
 * the receipt compare-and-set, retention, the erasure manifest entry and the
 * migration's twin backfill never ran on a database in CI. Audit-only file.
 *
 * Gated on MWB3_TEST_DATABASE_URL (throwaway Postgres in the audit lane).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import { PrismaService } from '../src/prisma.service';
import {
  ExpoPushClient,
  PushDeliveryService,
  RECEIPT_MIN_AGE_MS,
  RETENTION_MS,
} from '../src/notifications/push/push-delivery.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  ERASURE_MANIFEST,
  executeErasureManifest,
} from '../src/account-deletion/account-deletion.manifest';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;

function withPool(url: string, n: number): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}connection_limit=${n}`;
}

const token = (i: number) => `ExponentPushToken[opusprobe${String(i).padStart(12, '0')}]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slowExpo(delayMs: number) {
  const sent: ExpoPushMessage[] = [];
  let n = 0;
  const client: ExpoPushClient = {
    send: async (m: ExpoPushMessage[]) => {
      await sleep(delayMs);
      sent.push(...m);
      return m.map(() => ({ status: 'ok', id: `tk-${Math.random().toString(36).slice(2)}-${++n}` }) as ExpoPushTicket);
    },
    getReceipts: async () => ({}) as Record<string, ExpoPushReceipt>,
  };
  return { client, sent };
}

liveDescribe('AUD-OPUS-PUSH-120 live: PushOutbox worker on real Postgres', () => {
  let a: PrismaService;
  let b: PrismaService;
  const USERS = Array.from({ length: 10 }, (_, i) => `opus-live-u${i}`);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    a = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL, 4) } } });
    b = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL, 4) } } });
    await a.$connect();
    await b.$connect();
    await resetPublicSchema(a);
    await bootstrapTestSchema(a);
    for (const [i, id] of USERS.entries()) {
      await a.user.create({
        data: { id, supabase_id: `sb-${id}`, email: `${id}@example.test`, name: 'Probe', expo_push_token: token(i) },
      });
    }
  }, 240_000);

  afterAll(async () => {
    await a?.$disconnect();
    await b?.$disconnect();
  });

  beforeEach(async () => {
    await a.pushOutbox.deleteMany({});
  });

  it('L1: two workers on two connection pools drain 30 rows; the real claim SQL sends each row exactly once', async () => {
    const ea = slowExpo(15);
    const eb = slowExpo(15);
    const wa = new PushDeliveryService(a, ea.client);
    const wb = new PushDeliveryService(b, eb.client);
    wa.autoDrain = false;
    wb.autoDrain = false;
    for (const u of USERS) {
      for (let k = 0; k < 3; k += 1) {
        const r = await wa.enqueue({
          userId: u,
          kind: NotificationKind.BOOKING_CONFIRMED,
          title: 'Session confirmed',
          body: 'Probe confirmed your session.',
          data: { probeRow: `${u}:${k}` },
          dedupeKey: `probe:${u}:${k}`,
          collapseKey: `probe:${u}:${k}`,
          timeZone: null,
        });
        expect(r.code).toBe('queued');
      }
    }
    const [na, nb] = await Promise.all([wa.drain(), wb.drain()]);
    const all = [...ea.sent, ...eb.sent].map((m) => String((m.data as Record<string, unknown>).probeRow));
    expect(all).toHaveLength(30);
    expect(new Set(all).size).toBe(30);
    expect(na + nb).toBe(30);
    expect(ea.sent.length).toBeGreaterThan(0);
    expect(eb.sent.length).toBeGreaterThan(0);
    const rows = await a.pushOutbox.findMany({});
    expect(rows.every((r) => r.status === 'sent' && r.ticket_id && r.sent_at && r.lease_until === null)).toBe(true);
    expect(new Set(rows.map((r) => r.ticket_id)).size).toBe(30);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  }, 120_000);

  it('L2: five concurrent enqueues of one event on two pools leave one row (real unique index)', async () => {
    const wa = new PushDeliveryService(a, slowExpo(0).client);
    const wb = new PushDeliveryService(b, slowExpo(0).client);
    wa.autoDrain = false;
    wb.autoDrain = false;
    const push = {
      userId: USERS[0],
      kind: NotificationKind.BOOKING_REMINDER_1H,
      title: 'Session starting soon',
      body: 'x',
      data: {},
      dedupeKey: 'booking_reminder_1h:s-1:2026-06-02T19:00:00.000Z',
      collapseKey: 'booking_reminder_1h:tgp://sessions/s-1',
      timeZone: null,
    };
    const res = await Promise.all([0, 1, 2, 3, 4].map((i) => (i % 2 ? wb : wa).enqueue(push)));
    expect(res.filter((r) => r.code === 'queued')).toHaveLength(1);
    expect(res.filter((r) => r.code === 'duplicate')).toHaveLength(4);
    expect(await a.pushOutbox.count({})).toBe(1);
  });

  it('L3: a row due later is not claimed; an unstarted lapsed lease is released and sent once; a handed-off lapsed lease is closed', async () => {
    const e = slowExpo(0);
    const w = new PushDeliveryService(a, e.client);
    w.autoDrain = false;
    const now = Date.now();
    const base = {
      user_id: USERS[1],
      kind: NotificationKind.BOOKING_CONFIRMED,
      collapse_key: 'k',
      title: 't',
      body: 'b',
      data: {},
    };
    await a.pushOutbox.create({ data: { ...base, dedupe_key: 'later', not_before: new Date(now + 3_600_000) } });
    await a.pushOutbox.create({
      data: { ...base, dedupe_key: 'unstarted', status: 'sending', attempts: 1, lease_token: 'dead', lease_until: new Date(now - 1_000) },
    });
    await a.pushOutbox.create({
      data: {
        ...base,
        dedupe_key: 'handed',
        status: 'sending',
        attempts: 1,
        lease_token: 'dead2',
        lease_until: new Date(now - 1_000),
        handed_off_at: new Date(now - 130_000),
      },
    });
    const out = await w.sweep();
    expect(out).toEqual({ sent: 1, expired: 2 });
    const byKey = Object.fromEntries((await a.pushOutbox.findMany({})).map((r) => [r.dedupe_key, r]));
    expect(byKey.later.status).toBe('pending');
    expect(byKey.unstarted).toMatchObject({ status: 'sent', attempts: 1 });
    expect(byKey.handed).toMatchObject({ status: 'dropped', result_code: 'lease-expired' });
    expect(e.sent).toHaveLength(1);
  });

  it('L4: receipts are read once across two replicas; DeviceNotRegistered clears only that exact token; old rows are pruned', async () => {
    const sentAt = new Date(Date.now() - RECEIPT_MIN_AGE_MS - 60_000);
    const base = { kind: NotificationKind.MESSAGE_RECEIVED, collapse_key: 'k', title: 't', body: 'b', data: {}, status: 'sent' };
    await a.pushOutbox.create({ data: { ...base, user_id: USERS[2], ticket_id: 'r-1', token: token(2), sent_at: sentAt } });
    await a.pushOutbox.create({ data: { ...base, user_id: USERS[3], ticket_id: 'r-2', token: token(3), sent_at: sentAt } });
    await a.pushOutbox.create({
      data: { ...base, user_id: USERS[4], ticket_id: 'r-old', token: token(4), sent_at: sentAt, not_before: new Date(Date.now() - RETENTION_MS - 60_000) },
    });
    const receipts = async () =>
      ({
        'r-1': { status: 'error', details: { error: 'DeviceNotRegistered' } },
        'r-2': { status: 'ok' },
      }) as unknown as Record<string, ExpoPushReceipt>;
    const ra: ExpoPushClient = { send: async () => [], getReceipts: receipts };
    const wa = new PushDeliveryService(a, ra);
    const wb = new PushDeliveryService(b, ra);
    const [x, y] = await Promise.all([wa.checkReceipts(), wb.checkReceipts()]);
    expect(x.checked + y.checked).toBe(2);
    const u2 = await a.user.findUnique({ where: { id: USERS[2] } });
    const u3 = await a.user.findUnique({ where: { id: USERS[3] } });
    expect(u2?.expo_push_token).toBeNull();
    expect(u3?.expo_push_token).toBe(token(3));
    const left = await a.pushOutbox.findMany({});
    expect(left.map((r) => r.ticket_id).sort()).toEqual(['r-1', 'r-2']);
    expect(left.every((r) => r.receipt_checked_at)).toBe(true);
  });

  it('L5: the erasure manifest entry removes the deleted user\'s outbox rows and nobody else\'s', async () => {
    const base = { kind: NotificationKind.MESSAGE_RECEIVED, collapse_key: 'k', title: 't', body: 'b', data: {} };
    await a.pushOutbox.create({ data: { ...base, user_id: USERS[5] } });
    await a.pushOutbox.create({ data: { ...base, user_id: USERS[5], status: 'sent', token: token(5) } });
    await a.pushOutbox.create({ data: { ...base, user_id: USERS[6] } });
    const entries = ERASURE_MANIFEST.filter((e) => e.model === 'PushOutbox');
    expect(entries).toHaveLength(1);
    await a.$transaction((tx) =>
      executeErasureManifest(
        tx,
        { userId: USERS[5], email: `${USERS[5]}@example.test`, tombstoneEmail: 'x@deleted.invalid', now: new Date() },
        entries,
      ),
    );
    expect(await a.pushOutbox.count({ where: { user_id: USERS[5] } })).toBe(0);
    expect(await a.pushOutbox.count({ where: { user_id: USERS[6] } })).toBe(1);
  });

  it('L6: the migration backfill hides only a proven twin (push within 10 s of an equal inapp row, never coach-AI)', async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'prisma', 'migrations', '20270307000000_push_outbox_quiet_hours', 'migration.sql'),
      'utf8',
    );
    const update = sql.slice(sql.indexOf('UPDATE "Notification"'), sql.indexOf(';', sql.indexOf('UPDATE "Notification"')) + 1);
    expect(update.length).toBeGreaterThan(50);
    const u = USERS[7];
    const t0 = new Date('2026-06-01T12:00:00Z');
    const mk = (id: string, channel: string, created: Date, extra: Record<string, unknown> = {}) =>
      a.notification.create({
        data: { id, user_id: u, kind: 'message_received', body: 'New message from Coach K', deep_link: 'tgp://messages/x', channel, created_at: created, ...extra },
      });
    await mk('n-inapp', 'inapp', t0);
    await mk('n-twin', 'push', new Date(t0.getTime() + 5_000));
    await mk('n-late', 'push', new Date(t0.getTime() + 11_000));
    await mk('n-ai', 'push', new Date(t0.getTime() + 2_000), { ai_draft_id: 'draft-1' });
    await a.notification.create({
      data: { id: 'n-sole', user_id: u, kind: 'coach_alert', body: 'sole', channel: 'push', created_at: t0 },
    });
    await a.$executeRawUnsafe(update);
    const hidden = (await a.notification.findMany({ where: { user_id: u, inbox_hidden: true } })).map((n) => n.id);
    expect(hidden).toEqual(['n-twin']);
  });
});
