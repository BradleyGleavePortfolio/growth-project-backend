/**
 * AUD-OPUS-PUSH4-121 (Claude Opus 5.5 lens, agent 121) LIVE probes on backend
 * #693 @ cc0a167f (tree includes #692 @ 346cf4a8): the PushOutbox worker on
 * real Postgres. Audit-only file: never merge.
 *
 *   L1-L6  replay of AUD-OPUS-PUSH-120 live probes (claim SQL, unique index,
 *          lease release/close, receipts, erasure manifest, twin backfill).
 *   L7     B-648-8 round 6: the handoff CAS is ONE UPDATE statement whose
 *          WHERE carries the fence (lease_token, status), lease_until and the
 *          User token sub-select (no select-ids-then-update split).
 *   L8a-f  B-648-8 round 6 on real SQL: a change committed while the FINAL
 *          token read is in flight (token replaced, sign-out, outbox row
 *          erased, user erased, lease lapsed, lease swept + replica re-claim)
 *          gives zero provider calls from the stalled worker; control sends once.
 *   L9     PII end-to-end: MessageReceivedEmitter with a free-form display
 *          name holding an email and a weight: the PushOutbox row and the Expo
 *          message carry neither.
 *   L10    push twin: hidden only behind an equal inapp row stored within 1 h.
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
import { NotificationsService } from '../src/notifications/notifications.service';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
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

type QueryEvent = { query: string; params: string };

/**
 * A view of `real` whose `user.findUnique` runs `hook` once the FINAL token
 * read (the second read selecting expo_push_token in one sendOne) has its
 * result and before it returns. Everything else is the real client.
 */
function finalReadHook(real: PrismaService, hook: () => Promise<void>): PrismaService {
  let tokenReads = 0;
  const user = new Proxy(real.user, {
    get(t, p) {
      if (p === 'findUnique') {
        return async (args: { select?: { expo_push_token?: boolean } }) => {
          const out = await (t as unknown as { findUnique: (a: unknown) => Promise<unknown> }).findUnique(args);
          if (args?.select?.expo_push_token && ++tokenReads === 2) await hook();
          return out;
        };
      }
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return new Proxy(real, {
    get(t, p) {
      if (p === 'user') return user;
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

liveDescribe('AUD-OPUS-PUSH4-121 live: PushOutbox worker on real Postgres (#693 @ cc0a167f)', () => {
  let a: PrismaService;
  let b: PrismaService;
  let q: PrismaService;
  const queries: QueryEvent[] = [];
  const USERS = Array.from({ length: 12 }, (_, i) => `opus-live-u${i}`);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    a = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL, 4) } } });
    b = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL, 4) } } });
    q = new PrismaService({
      datasources: { db: { url: withPool(TEST_DB_URL, 2) } },
      log: [{ emit: 'event', level: 'query' }],
    });
    (q as unknown as { $on: (e: 'query', cb: (ev: QueryEvent) => void) => void }).$on('query', (ev) =>
      queries.push({ query: ev.query, params: ev.params }),
    );
    await a.$connect();
    await b.$connect();
    await q.$connect();
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
    await q?.$disconnect();
  });

  beforeEach(async () => {
    await a.pushOutbox.deleteMany({});
    for (const [i, id] of USERS.entries()) {
      await a.user.updateMany({ where: { id }, data: { expo_push_token: token(i) } });
    }
  });

  // ── Replay: AUD-OPUS-PUSH-120 L1-L6 ──────────────────────────────────────

  it('L1: two workers on two connection pools drain 30 rows; the real claim SQL sends each row exactly once', async () => {
    const ea = slowExpo(15);
    const eb = slowExpo(15);
    const wa = new PushDeliveryService(a, ea.client);
    const wb = new PushDeliveryService(b, eb.client);
    wa.autoDrain = false;
    wb.autoDrain = false;
    for (const u of USERS.slice(0, 10)) {
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
    expect(rows.every((r) => r.attempts === 1 && r.handed_off_at)).toBe(true);
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

  it("L5: the erasure manifest entry removes the deleted user's outbox rows and nobody else's", async () => {
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

  // ── New at PUSH4: B-648-8 round 6 on real SQL ────────────────────────────

  it('L7: the handoff CAS is one UPDATE whose WHERE holds the fence, the lease deadline and the User token sub-select', async () => {
    const e = slowExpo(0);
    const w = new PushDeliveryService(q, e.client);
    w.autoDrain = false;
    await w.enqueue({
      userId: USERS[8],
      kind: NotificationKind.MESSAGE_RECEIVED,
      title: 'New message',
      body: 'x',
      data: {},
      collapseKey: 'message_received:tgp://messages/l7',
      timeZone: null,
    });
    queries.length = 0;
    expect(await w.drain()).toBe(1);
    const handoff = queries.filter((x) => /^UPDATE/i.test(x.query.trim()) && /"handed_off_at"\s*=/.test(x.query.split(/WHERE/i)[0]));
    // The claim UPDATE also mentions handed_off_at (= NULL) in SET; the handoff is the one with the token sub-select.
    const cas = handoff.filter((x) => /expo_push_token/.test(x.query));
    expect(cas).toHaveLength(1);
    const where = cas[0].query.slice(cas[0].query.search(/WHERE/i));
    expect(where).toMatch(/"lease_token"/);
    expect(where).toMatch(/"status"/);
    expect(where).toMatch(/"lease_until"\s*>/);
    expect(where).toMatch(/"User"/);
    // Evidence for the verdict: the exact statement Prisma 6.19 sends.
    // eslint-disable-next-line no-console
    console.log(`L7 handoff CAS SQL: ${cas[0].query}`);
    expect(e.sent).toHaveLength(1);
  });

  const L8_CASES: Array<[string, (rowId: string, user: string) => Promise<void>, 'sending' | 'gone']> = [
    ['a new device token is registered', async (_id, u) => {
      await b.user.update({ where: { id: u }, data: { expo_push_token: 'ExponentPushToken[opusprobeNEWDEVICE01]' } });
    }, 'sending'],
    ['sign-out clears the token', async (_id, u) => {
      await b.user.update({ where: { id: u }, data: { expo_push_token: null } });
    }, 'sending'],
    ['the outbox row is erased', async (id) => {
      await b.pushOutbox.delete({ where: { id } });
    }, 'gone'],
    ['the lease lapses (another clock already past lease_until)', async (id) => {
      await b.pushOutbox.update({ where: { id }, data: { lease_until: new Date(Date.now() - 1_000) } });
    }, 'sending'],
  ];

  it.each(L8_CASES)('L8: %s while the final token read is in flight: zero provider calls', async (_name, change, after) => {
    const u = USERS[9];
    const e = slowExpo(0);
    let rowId = '';
    const db = finalReadHook(a, async () => change(rowId, u));
    const w = new PushDeliveryService(db, e.client);
    w.autoDrain = false;
    await w.enqueue({
      userId: u,
      kind: NotificationKind.MESSAGE_RECEIVED,
      title: 'New message',
      body: 'x',
      data: {},
      collapseKey: `message_received:tgp://messages/l8-${_name.length}`,
      timeZone: null,
    });
    rowId = (await a.pushOutbox.findFirstOrThrow({ where: { user_id: u } })).id;
    expect(await w.drain()).toBe(0);
    expect(e.sent).toHaveLength(0);
    const row = await a.pushOutbox.findUnique({ where: { id: rowId } });
    if (after === 'gone') expect(row).toBeNull();
    else expect(row).toMatchObject({ status: 'sending', handed_off_at: null, sent_at: null });
  });

  it('L8e: the user is erased (cascade) while the final token read is in flight: zero provider calls', async () => {
    const u = 'opus-live-erased';
    await a.user.create({ data: { id: u, supabase_id: `sb-${u}`, email: `${u}@example.test`, name: 'Probe', expo_push_token: token(99) } });
    const e = slowExpo(0);
    const db = finalReadHook(a, async () => {
      await b.user.delete({ where: { id: u } });
    });
    const w = new PushDeliveryService(db, e.client);
    w.autoDrain = false;
    await w.enqueue({ userId: u, kind: NotificationKind.MILESTONE_REACHED, title: 't', body: 'b', data: {}, collapseKey: 'milestone_reached:l8e', timeZone: null });
    expect(await w.drain()).toBe(0);
    expect(e.sent).toHaveLength(0);
    expect(await a.pushOutbox.count({ where: { user_id: u } })).toBe(0);
  });

  it('L8f: the lease is swept back to pending and a replica re-claims and sends while the final read is in flight: the stalled worker sends 0, the replica once', async () => {
    const u = USERS[10];
    const ea = slowExpo(0);
    const eb = slowExpo(0);
    const replica = new PushDeliveryService(b, eb.client);
    replica.autoDrain = false;
    let replicaSent = -1;
    const db = finalReadHook(a, async () => {
      // What expireLeases() does to an unstarted lapsed lease, then the replica drains it.
      await b.pushOutbox.updateMany({
        where: { user_id: u, status: 'sending', handed_off_at: null },
        data: { status: 'pending', lease_until: null, lease_token: null, result_code: 'lease-released', attempts: { decrement: 1 } },
      });
      replicaSent = await replica.drain();
    });
    const w = new PushDeliveryService(db, ea.client);
    w.autoDrain = false;
    await w.enqueue({ userId: u, kind: NotificationKind.COACH_ALERT, title: 't', body: 'b', data: {}, collapseKey: 'coach_alert:l8f', timeZone: null });
    expect(await w.drain()).toBe(0);
    expect(ea.sent).toHaveLength(0);
    expect(replicaSent).toBe(1);
    expect(eb.sent).toHaveLength(1);
    const rows = await a.pushOutbox.findMany({ where: { user_id: u } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', result_code: 'sent', attempts: 1 });
  });

  it('L8 control: no change during the final read: sent exactly once with handed_off_at set', async () => {
    const u = USERS[11];
    const e = slowExpo(0);
    const db = finalReadHook(a, async () => undefined);
    const w = new PushDeliveryService(db, e.client);
    w.autoDrain = false;
    await w.enqueue({ userId: u, kind: NotificationKind.MESSAGE_RECEIVED, title: 't', body: 'b', data: {}, collapseKey: 'message_received:ctl', timeZone: null });
    expect(await w.drain()).toBe(1);
    expect(e.sent.map((m) => m.to)).toEqual([token(11)]);
    const row = await a.pushOutbox.findFirstOrThrow({ where: { user_id: u } });
    expect(row.status).toBe('sent');
    expect(row.handed_off_at).not.toBeNull();
  });

  // ── New at PUSH4: PII end-to-end and the 1 h twin window ─────────────────

  it('L9: a display name holding an email and a weight never reaches the outbox row or the Expo message', async () => {
    const u = USERS[0];
    const e = slowExpo(0);
    const push = new PushDeliveryService(a, e.client);
    push.autoDrain = false;
    const svc = new NotificationsService(a, undefined, undefined, push);
    const emitter = new MessageReceivedEmitter(svc);
    await emitter.emit(u, { senderName: 'jane.doe@example.com 181 lb', threadId: 'thread-l9' } as never);
    const rows = await a.pushOutbox.findMany({ where: { user_id: u } });
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toMatch(/jane|example\.com|181/i);
    expect(await push.drain()).toBe(1);
    const shown = `${e.sent[0].title} ${e.sent[0].body} ${JSON.stringify(e.sent[0].data)}`;
    expect(shown).not.toMatch(/jane|example\.com|181/i);
    expect(e.sent[0].channelId).toBe('coach-messages');
    // The inbox row (inside the app) still names the sender.
    const inbox = await a.notification.findFirstOrThrow({ where: { user_id: u, channel: 'inapp', kind: 'message_received' } });
    expect(inbox.body).toContain('jane.doe@example.com');
  });

  it('L10: a declared push twin is hidden only behind an equal inapp row stored within 1 hour', async () => {
    const u = USERS[1];
    const svc = new NotificationsService(a, undefined, undefined, undefined);
    const base = { user_id: u, kind: NotificationKind.COACH_ALERT, deep_link: 'tgp://coach/alerts', body: 'Payout notice probe' };
    // inapp 59 minutes ago -> twin hidden
    await a.notification.create({ data: { ...base, body: 'p59', channel: 'inapp', created_at: new Date(Date.now() - 59 * 60_000) } });
    const h59 = await svc.createNotification({ ...base, body: 'p59', channel: 'push', push_twin: true, throttle_key: 'p59' });
    // inapp 61 minutes ago -> visible
    await a.notification.create({ data: { ...base, body: 'p61', channel: 'inapp', created_at: new Date(Date.now() - 61 * 60_000) } });
    const h61 = await svc.createNotification({ ...base, body: 'p61', channel: 'push', push_twin: true, throttle_key: 'p61' });
    // fresh inapp but push_twin false -> visible
    await a.notification.create({ data: { ...base, body: 'pno', channel: 'inapp' } });
    const hno = await svc.createNotification({ ...base, body: 'pno', channel: 'push', throttle_key: 'pno' });
    // declared twin, no inapp counterpart -> visible
    const hsole = await svc.createNotification({ ...base, body: 'psole', channel: 'push', push_twin: true, throttle_key: 'psole' });
    expect(h59?.inbox_hidden).toBe(true);
    expect(h61?.inbox_hidden).toBe(false);
    expect(hno?.inbox_hidden).toBe(false);
    expect(hsole?.inbox_hidden).toBe(false);
    const listed = await svc.listNotifications(u, {} as never);
    const bodies = (listed as unknown as { items: Array<{ body: string; channel: string }> }).items
      .filter((n) => n.channel === 'push')
      .map((n) => n.body)
      .sort();
    expect(bodies).toEqual(['p61', 'pno', 'psole']);
  });
});
