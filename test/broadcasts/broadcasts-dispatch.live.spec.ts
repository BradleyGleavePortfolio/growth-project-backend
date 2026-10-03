/**
 * A4-MSG-BROADCAST live proof on a database migrated with the real chain
 * (`prisma migrate deploy`, CI job community-live-tests):
 *
 *  - no duplicate sends: three dispatcher instances (separate Prisma
 *    clients, as on separate machines) tick concurrently, then "restarted"
 *    instances tick again; every recipient has exactly one CoachMessage per
 *    occurrence and one delivery row;
 *  - a delivery leased by an instance that died mid-send is not touched
 *    until its lease expires, then sent exactly once;
 *  - quiet hours across time zones: at 03:30Z a New York recipient is
 *    deferred to 08:00 New York while Tokyo and Los Angeles recipients get
 *    the message; the deferred one lands after 08:00 local;
 *  - the segment preview count equals the delivered recipients; blocked
 *    clients and another tenant's clients are never messaged;
 *  - member privacy: each copy lives in the recipient's own 1:1 thread;
 *  - RLS: as anon and authenticated, all six A4 tables read zero rows and
 *    refuse writes (server-only posture of 20270304000000).
 *
 * GATE: env-gated on COMMUNITY_TEST_DATABASE_URL (skips with a logged
 * reason when unset; CI sets it, so the suite always runs there).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Role } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { BroadcastScopeService } from '../../src/broadcasts/broadcast-scope.service';
import { SegmentResolverService } from '../../src/broadcasts/segment-resolver.service';
import { CardsService } from '../../src/broadcasts/cards.service';
import { BroadcastsService } from '../../src/broadcasts/broadcasts.service';
import { BroadcastDispatcherService } from '../../src/broadcasts/broadcast-dispatcher.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import type { MessageReceivedEmitter } from '../../src/notifications/emitters/message-received.emitter';
import { liveDbUrl } from '../community/_support/community-db';
import { insertLiveUser } from '../community/_support/community-live-seed';
import { stub } from './_stub';

const itLive = liveDbUrl() ? describe : describe.skip;
if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[broadcasts-dispatch.live] COMMUNITY_TEST_DATABASE_URL not set — live spec skipped.',
  );
}

const TABLES = [
  'coach_broadcasts',
  'coach_broadcast_runs',
  'coach_broadcast_deliveries',
  'coach_message_cards',
  'coach_saved_replies',
  'coach_client_tags',
];

itLive('A4 broadcasts on a live database', () => {
  const clients: PrismaService[] = [];
  let db: PrismaService;
  const tag = randomUUID().slice(0, 8);
  const id = {
    coach: randomUUID(),
    otherCoach: randomUUID(),
    ny: randomUUID(),
    tokyo: randomUUID(),
    la: randomUUID(),
    blocker: randomUUID(),
    untagged: randomUUID(),
    otherClient: randomUUID(),
  };
  /** Push attempts (recipient ids) across all dispatcher instances. */
  const emits: string[] = [];

  function build(p: PrismaService) {
    const scopes = new BroadcastScopeService(new SubCoachScopeService(p));
    const segments = new SegmentResolverService(p);
    const audit = stub<AuditService>({ write: async () => undefined });
    const service = new BroadcastsService(p, scopes, segments, new CardsService(p), audit);
    const dispatcher = new BroadcastDispatcherService(
      p,
      scopes,
      segments,
      stub<SupabaseService>({ broadcastNewMessage: async () => undefined }),
      stub<MessageReceivedEmitter>({ emit: async (uid: string) => void emits.push(uid) }),
    );
    return { service, dispatcher };
  }

  function newClient(): PrismaService {
    const p = new PrismaService({ datasources: { db: { url: liveDbUrl() as string } } });
    clients.push(p);
    return p;
  }

  async function messagesFor(clientId: string): Promise<number> {
    return db.coachMessage.count({ where: { coach_id: id.coach, client_id: clientId } });
  }

  // Tomorrow 03:30Z: 22:30/23:30 New York (quiet), 12:30 Tokyo, 19:30/20:30 Los Angeles.
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 1);
  base.setUTCHours(3, 30, 0, 0);
  const at = (mins: number) => new Date(base.getTime() + mins * 60_000);

  beforeAll(async () => {
    db = newClient();
    await db.$connect();
    const users: Array<[string, Role, string | null, string]> = [
      [id.coach, 'coach', null, 'Coach Live'],
      [id.otherCoach, 'coach', null, 'Coach Other'],
      [id.ny, 'student', id.coach, 'Nora York'],
      [id.tokyo, 'student', id.coach, 'Taro Kyo'],
      [id.la, 'student', id.coach, 'Lena Angeles'],
      [id.blocker, 'student', id.coach, 'Blake Blocker'],
      [id.untagged, 'student', id.coach, 'Una Tagless'],
      [id.otherClient, 'student', id.otherCoach, 'Oscar Other'],
    ];
    for (const [uid, role, coachId, name] of users) {
      await insertLiveUser(db, { id: uid, role, name: `${name} ${tag}`, coachId });
    }
    const tz: Array<[string, string]> = [
      [id.ny, 'America/New_York'],
      [id.tokyo, 'Asia/Tokyo'],
      [id.la, 'America/Los_Angeles'],
      [id.blocker, 'Asia/Tokyo'],
    ];
    for (const [uid, zone] of tz)
      await db.notificationPreferences.create({ data: { user_id: uid, timezone: zone } });
    for (const c of [id.ny, id.tokyo, id.la, id.blocker]) {
      await db.coachClientTag.create({ data: { coach_id: id.coach, client_id: c, tag: 'vip' } });
    }
    // Another tenant uses the same tag name; it must never leak in.
    await db.coachClientTag.create({
      data: { coach_id: id.otherCoach, client_id: id.otherClient, tag: 'vip' },
    });
    await db.userBlock.create({ data: { blocker_id: id.blocker, blocked_id: id.coach } });
  });

  afterAll(async () => {
    if (db) {
      const all = Object.values(id);
      await db.coachBroadcast.deleteMany({
        where: { coach_id: { in: [id.coach, id.otherCoach] } },
      });
      await db.coachMessage.deleteMany({ where: { coach_id: { in: [id.coach, id.otherCoach] } } });
      await db.coachClientTag.deleteMany({
        where: { coach_id: { in: [id.coach, id.otherCoach] } },
      });
      await db.coachSavedReply.deleteMany({ where: { owner_user_id: { in: all } } });
      await db.userBlock.deleteMany({ where: { blocker_id: { in: all } } });
      await db.notificationPreferences.deleteMany({ where: { user_id: { in: all } } });
      await db.user.deleteMany({
        where: { id: { in: [id.ny, id.tokyo, id.la, id.blocker, id.untagged, id.otherClient] } },
      });
      await db.user.deleteMany({ where: { id: { in: [id.coach, id.otherCoach] } } });
    }
    for (const c of clients) await c.$disconnect();
  });

  it('preview count matches recipients; blocks and other tenants are excluded', async () => {
    const { service } = build(db);
    const preview = await service.preview(id.coach, {
      match: 'all',
      rules: [{ field: 'tag', op: 'in', values: ['vip'] }],
    });
    expect(preview.recipient_count).toBe(3);
    expect(preview.excluded_blocked_count).toBe(1);
    expect(preview.sample.map((s) => s.id).sort()).toEqual([id.ny, id.tokyo, id.la].sort());
  });

  it('three concurrent instances and two restarts send each recipient exactly once; quiet hours defer New York only', async () => {
    const { service } = build(db);
    const created = await service.create(
      id.coach,
      {
        body: 'Hi {first_name}, the new block starts Monday.',
        card: { type: 'check_in', note: 'Two minutes, before Sunday' },
        segment: { match: 'all', rules: [{ field: 'tag', op: 'in', values: ['vip'] }] },
        timezone: 'America/Los_Angeles',
      },
      `live-${tag}`,
    );
    // Same Idempotency-Key replays the same broadcast, never a second one.
    const replay = await service.create(
      id.coach,
      {
        body: 'Hi {first_name}, the new block starts Monday.',
        segment: {},
        timezone: 'America/Los_Angeles',
      },
      `live-${tag}`,
    );
    expect(replay.id).toBe(created.id);

    const [a, b, c] = [build(newClient()), build(newClient()), build(newClient())];
    await Promise.all([a.dispatcher.tick(base), b.dispatcher.tick(base), c.dispatcher.tick(base)]);

    expect(await db.coachBroadcastRun.count({ where: { broadcast_id: created.id } })).toBe(1);
    const rows = await db.coachBroadcastDelivery.findMany({ where: { broadcast_id: created.id } });
    const byRecipient = new Map(rows.map((r) => [r.recipient_id, r]));
    expect(rows).toHaveLength(4);
    expect(byRecipient.get(id.tokyo)?.status).toBe('delivered');
    expect(byRecipient.get(id.la)?.status).toBe('delivered');
    expect(byRecipient.get(id.ny)?.status).toBe('deferred');
    expect(byRecipient.get(id.ny)?.defer_reason).toBe('quiet_hours');
    expect(byRecipient.get(id.blocker)?.status).toBe('skipped_blocked');
    expect(byRecipient.has(id.otherClient)).toBe(false);
    expect(byRecipient.has(id.untagged)).toBe(false);

    // Deferred to 08:00 in New York (12:00Z or 13:00Z depending on DST).
    const nyLocal = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(byRecipient.get(id.ny)?.deliver_after as Date);
    expect(nyLocal).toBe('08:00');

    // Restarted instances at the same and a later minute: nothing new.
    const d = build(newClient());
    await Promise.all([d.dispatcher.tick(at(1)), a.dispatcher.tick(at(1))]);
    expect(await messagesFor(id.tokyo)).toBe(1);
    expect(await messagesFor(id.la)).toBe(1);
    expect(await messagesFor(id.ny)).toBe(0);
    expect(await messagesFor(id.blocker)).toBe(0);
    expect(await db.coachMessage.count({ where: { client_id: id.otherClient } })).toBe(0);
    // One push per delivered message, never one per instance.
    expect(emits.filter((u) => u === id.tokyo)).toHaveLength(1);

    // After 08:00 New York the deferred delivery lands, once.
    await Promise.all([d.dispatcher.tick(at(10 * 60)), b.dispatcher.tick(at(10 * 60))]);
    expect(await messagesFor(id.ny)).toBe(1);
    expect(await messagesFor(id.tokyo)).toBe(1);

    const run = await db.coachBroadcastRun.findFirst({ where: { broadcast_id: created.id } });
    expect(run?.status).toBe('complete');
    expect(run?.recipient_count).toBe(3);
    expect((await db.coachBroadcast.findUnique({ where: { id: created.id } }))?.status).toBe(
      'sent',
    );

    // Member privacy: each copy sits in the recipient's own thread, with the
    // card snapshot, and nothing on the message names other recipients.
    const msg = await db.coachMessage.findFirst({
      where: { client_id: id.tokyo, coach_id: id.coach },
      include: { card: true },
    });
    expect(msg?.body).toBe('Hi Taro, the new block starts Monday.');
    expect(msg?.card?.card_type).toBe('check_in');
    expect(JSON.stringify(msg)).not.toContain(id.la);
    expect(JSON.stringify(msg)).not.toContain(id.ny);

    const detail = await service.get(id.coach, created.id);
    expect(detail.stats).toMatchObject({
      total: 4,
      delivered: 3,
      skipped_blocked: 1,
      deferred: 0,
      pending: 0,
    });
  });

  it('a delivery held by an instance that died mid-send waits for its lease, then sends once', async () => {
    const { service } = build(db);
    const created = await service.create(
      id.coach,
      {
        body: 'Gym closes early today.',
        urgent: true,
        segment: { match: 'all', rules: [{ field: 'tag', op: 'in', values: ['vip'] }] },
        timezone: 'America/Los_Angeles',
      },
      `live-urgent-${tag}`,
    );
    const a = build(newClient());
    await a.dispatcher.claimDue(base);
    await a.dispatcher.fanOutRuns(base);
    const victim = await db.coachBroadcastDelivery.findFirstOrThrow({
      where: { broadcast_id: created.id, recipient_id: id.ny },
    });
    // Instance "dead" claimed it and crashed before writing anything.
    await db.coachBroadcastDelivery.update({
      where: { id: victim.id },
      data: { lease_holder: 'dead', lease_until: at(2), attempts: 1 },
    });

    const b = build(newClient());
    await b.dispatcher.deliverDue(base);
    const before = await db.coachMessage.count({
      where: { client_id: id.ny, body: 'Gym closes early today.' },
    });
    expect(before).toBe(0); // lease respected (and urgent bypassed quiet hours for the others)
    expect(
      await db.coachMessage.count({
        where: { client_id: id.tokyo, body: 'Gym closes early today.' },
      }),
    ).toBe(1);

    await Promise.all([b.dispatcher.deliverDue(at(3)), a.dispatcher.deliverDue(at(3))]);
    expect(
      await db.coachMessage.count({ where: { client_id: id.ny, body: 'Gym closes early today.' } }),
    ).toBe(1);
    // Re-running fan-out over a finished run adds nobody.
    await a.dispatcher.fanOutRun(
      (await db.coachBroadcastRun.findFirstOrThrow({ where: { broadcast_id: created.id } })).id,
      at(4),
    );
    expect(await db.coachBroadcastDelivery.count({ where: { broadcast_id: created.id } })).toBe(4);
  });

  it('RLS: anon and authenticated read nothing and write nothing on every A4 table', async () => {
    await db.coachSavedReply.create({
      data: { owner_user_id: id.coach, title: `Welcome ${tag}`, body: 'Glad you are here.' },
    });
    await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO anon, authenticated');
    for (const t of TABLES)
      await db.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${t}" TO anon, authenticated`,
      );
    for (const role of ['anon', 'authenticated']) {
      for (const t of TABLES) {
        const rows = await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          await tx.$queryRaw`SELECT set_config('app.current_user_id', ${id.coach}, true)`;
          return tx.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT count(*)::bigint AS n FROM "${t}"`,
          );
        });
        expect([role, t, Number(rows[0].n)]).toEqual([role, t, 0]);
      }
      const write = db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
        await tx.$executeRawUnsafe(
          `INSERT INTO "coach_saved_replies" (id, owner_user_id, title, body, updated_at) VALUES ('${randomUUID()}', '${id.coach}', 'x${role}', 'y', now())`,
        );
      });
      await expect(write).rejects.toThrow(/42501|row-level security/);
    }
    // The service role still sees the rows (the API path).
    expect(await db.coachSavedReply.count({ where: { owner_user_id: id.coach } })).toBe(1);
  });
});
