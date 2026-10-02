/**
 * S-SCHED-2 live proof on real Postgres: no double booking.
 *
 *  1. The migration (20270222000000_scheduling_lifecycle_integrity) applies
 *     on a Prisma-faithful schema and creates the exclusion constraint; its
 *     preflight refuses to run while overlapping active rows exist.
 *  2. Database floor: a writer that bypasses the service (no lock, no check)
 *     cannot store an overlapping active booking; terminal rows and
 *     back-to-back rows are allowed; the error is recognised by the service
 *     mapper (-> 409 SLOT_TAKEN).
 *  3. Service path: N clients booking the same slot concurrently through the
 *     real SchedulingService -> exactly one row, the rest 409 SLOT_TAKEN.
 *  4. Lock path, deterministic: a third transaction holds the per-coach
 *     advisory lock; two bookings for the same slot start and are observed
 *     waiting on it (pg_stat_activity wait_event = 'advisory'); after release
 *     exactly one commits.
 *  5. Approve vs cancel on one request: exactly one transition wins.
 *  6. S-SCHED-3: delivery-state columns, the range preflight, welcome
 *     restore against the real partial unique index, and keyset paging over
 *     tied start times with the database's own collation.
 *
 * Gated on MWB3_TEST_DATABASE_URL (the mwb-3-live-tests CI job); skipped with a
 * logged reason elsewhere.
 */
import { HttpException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AuditService } from '../src/audit/audit.service';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import {
  NotificationsService,
  type CreateNotificationInput,
} from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';
import { GoogleCalendarAdapter } from '../src/scheduling/providers/google-calendar.adapter';
import { GoogleMeetAdapter } from '../src/scheduling/providers/google-meet.adapter';
import { SchedulingProviderRegistry } from '../src/scheduling/providers/scheduling-provider.registry';
import { StubCalendarAdapter } from '../src/scheduling/providers/stub-calendar.adapter';
import { StubVideoAdapter } from '../src/scheduling/providers/stub-video.adapter';
import { ZoomVideoAdapter } from '../src/scheduling/providers/zoom-video.adapter';
import {
  ADVISORY_LOCK_NAMESPACE_COACH_CALENDAR,
  isOverlapConstraintViolation,
} from '../src/scheduling/scheduling-session-lifecycle.service';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import type { ActorContext } from '../src/scheduling/scheduling.types';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[scheduling-booking-concurrency.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.',
  );
}

const MIGRATION_SQL = path.resolve(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20270222000000_scheduling_lifecycle_integrity',
  'migration.sql',
);

const COACH_ID = 'ssched2-live-coach';
const TYPE_ID = '5a5c6e2d-0000-4000-8000-000000000001';
const CLIENT_IDS = Array.from({ length: 6 }, (_, i) => `ssched2-live-client-${i + 1}`);

function withPool(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return url.includes('connection_limit=') ? url : `${url}${sep}connection_limit=12`;
}

// Split a migration file into statements on top-level semicolons, keeping
// $$-quoted DO bodies intact.
function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (!inDollar && (trimmed.startsWith('--') || trimmed === '')) continue;
    buf += `${line}\n`;
    const dollars = (line.match(/\$\$/g) ?? []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    if (!inDollar && trimmed.endsWith(';')) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

class SilentNotifications {
  rows: CreateNotificationInput[] = [];
  createNotification = jest.fn(async (input: CreateNotificationInput) => {
    this.rows.push(input);
    return { id: `n-${this.rows.length}` };
  });
  getPreferences = jest.fn(async (userId: string) => ({
    user_id: userId,
    timezone: 'America/Los_Angeles',
    booking_push: true,
    muted: false,
  }));
  pushToUser = jest.fn(async () => ({ delivered: false, code: 'no-token' as const }));
}

function actor(id: string): ActorContext {
  return { id, role: 'student', email: null, coach_id: COACH_ID };
}
const COACH: ActorContext = { id: COACH_ID, role: 'coach', email: null, coach_id: null };

function codeOf(r: PromiseSettledResult<unknown>): string | null {
  if (r.status !== 'rejected') return null;
  const err: unknown = r.reason;
  if (!(err instanceof HttpException)) return `unexpected:${String(err)}`;
  const res = err.getResponse();
  const body: Record<string, unknown> = typeof res === 'object' && res !== null ? { ...res } : {};
  return String(body.code);
}

// A whole-minute start N days ahead at 10:00 UTC (availability is all day).
function slot(daysAhead: number, minuteOffset = 0): { start: Date; end: Date } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(10, minuteOffset, 0, 0);
  return { start: d, end: new Date(d.getTime() + 30 * 60_000) };
}

liveDescribe('S-SCHED-2 live: no double booking (Postgres)', () => {
  let prisma: PrismaService;
  let svc: SchedulingService;
  let statements: string[];

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL) } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    statements = splitSql(fs.readFileSync(MIGRATION_SQL, 'utf8'));
    for (const stmt of statements) await prisma.$executeRawUnsafe(stmt);

    await prisma.user.create({
      data: {
        id: COACH_ID,
        supabase_id: `sb-${COACH_ID}`,
        email: `${COACH_ID}@example.test`,
        name: 'Coach Live',
        role: 'coach',
      },
    });
    for (const id of CLIENT_IDS) {
      await prisma.user.create({
        data: {
          id,
          supabase_id: `sb-${id}`,
          email: `${id}@example.test`,
          name: id,
          role: 'student',
          coach_id: COACH_ID,
        },
      });
    }
    await prisma.sessionType.create({
      data: {
        id: TYPE_ID,
        coach_id: COACH_ID,
        name: 'Quick Q/A Call',
        duration_minutes: 30,
        auto_approve: false,
      },
    });
    await prisma.coachAvailability.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        coach_id: COACH_ID,
        day_of_week: day,
        start_minute: 0,
        end_minute: 24 * 60,
      })),
    });

    const notifications = new SilentNotifications();
    const emitter = new BookingEmitter(
      Object.assign(
        Object.create(NotificationsService.prototype) as NotificationsService,
        notifications,
      ),
    );
    const audit = Object.assign(Object.create(AuditService.prototype) as AuditService, {
      write: jest.fn(async () => undefined),
    });
    const registry = new SchedulingProviderRegistry(
      new StubCalendarAdapter(),
      new GoogleCalendarAdapter(),
      new StubVideoAdapter(),
      new GoogleMeetAdapter(),
      new ZoomVideoAdapter(),
    );
    svc = new SchedulingService(prisma, audit, registry, emitter);
  }, 240_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.coachingSession.deleteMany({ where: { coach_id: COACH_ID } });
  });

  async function advisoryWaiters(): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
    return Number(rows[0]?.n ?? 0);
  }

  it('migration created the exclusion constraint and the welcome index', async () => {
    const rows = await prisma.$queryRaw<Array<{ conname: string; contype: string }>>`
      SELECT conname, contype::text AS contype FROM pg_constraint
      WHERE conname IN ('CoachingSession_no_overlapping_active_booking', 'SessionType_default_meeting_url_https')
      ORDER BY conname`;
    expect(rows).toEqual([
      { conname: 'CoachingSession_no_overlapping_active_booking', contype: 'x' },
      { conname: 'SessionType_default_meeting_url_https', contype: 'c' },
    ]);
    const idx = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE indexname = 'SessionType_one_active_welcome_per_coach'`;
    expect(idx).toHaveLength(1);
  });

  it('migration is re-runnable and its preflight refuses existing overlaps', async () => {
    for (const stmt of statements) await prisma.$executeRawUnsafe(stmt);
    const { start, end } = slot(3);
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "CoachingSession" DROP CONSTRAINT "CoachingSession_no_overlapping_active_booking"',
    );
    try {
      for (const id of ['pre-a', 'pre-b']) {
        await prisma.coachingSession.create({
          data: {
            id,
            coach_id: COACH_ID,
            status: 'scheduled',
            start_at: start,
            end_at: end,
            title: 'x',
          },
        });
      }
      const preflight = statements.find((s) => s.includes('S-SCHED-2 preflight'));
      expect(preflight).toBeDefined();
      await expect(prisma.$executeRawUnsafe(preflight ?? '')).rejects.toThrow(
        /S-SCHED-2 preflight: 1 pair/,
      );
    } finally {
      await prisma.coachingSession.deleteMany({ where: { id: { in: ['pre-a', 'pre-b'] } } });
      for (const stmt of statements) await prisma.$executeRawUnsafe(stmt);
    }
  });

  it('database floor: a direct overlapping insert is rejected and recognised; terminal and back-to-back rows are fine', async () => {
    const { start, end } = slot(4);
    await prisma.coachingSession.create({
      data: { coach_id: COACH_ID, status: 'requested', start_at: start, end_at: end, title: 'a' },
    });
    let caught: unknown = null;
    try {
      await prisma.coachingSession.create({
        data: {
          coach_id: COACH_ID,
          status: 'scheduled',
          start_at: new Date(start.getTime() + 10 * 60_000),
          end_at: new Date(end.getTime() + 10 * 60_000),
          title: 'b',
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(isOverlapConstraintViolation(caught)).toBe(true);

    await prisma.coachingSession.create({
      data: { coach_id: COACH_ID, status: 'canceled', start_at: start, end_at: end, title: 'c' },
    });
    await prisma.coachingSession.create({
      data: {
        coach_id: COACH_ID,
        status: 'scheduled',
        start_at: end,
        end_at: new Date(end.getTime() + 30 * 60_000),
        title: 'd',
      },
    });
    // Re-activating a cancelled row onto a held slot is also refused.
    const cancelled = await prisma.coachingSession.findFirstOrThrow({ where: { title: 'c' } });
    let reactivateErr: unknown = null;
    try {
      await prisma.coachingSession.update({
        where: { id: cancelled.id },
        data: { status: 'scheduled' },
      });
    } catch (err) {
      reactivateErr = err;
    }
    expect(isOverlapConstraintViolation(reactivateErr)).toBe(true);
  });

  it('service path: six concurrent requests for one slot -> one row, five SLOT_TAKEN', async () => {
    const { start, end } = slot(5);
    const results = await Promise.allSettled(
      CLIENT_IDS.map((id) =>
        svc.requestSession(actor(id), {
          coach_id: COACH_ID,
          session_type_id: TYPE_ID,
          title: 'Quick Q/A Call',
          start_at: start.toISOString(),
          end_at: end.toISOString(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(codeOf).filter((c) => c !== null)).toEqual(Array(5).fill('SLOT_TAKEN'));
    expect(
      await prisma.coachingSession.count({
        where: {
          coach_id: COACH_ID,
          status: { in: ['requested', 'scheduled', 'pending_provider'] },
        },
      }),
    ).toBe(1);
  });

  it('lock path: bookings wait on the per-coach advisory lock, then exactly one commits', async () => {
    const { start, end } = slot(6);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE_COACH_CALENDAR}::int4, hashtext(${COACH_ID}))`;
        lockHeld();
        await released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await held;
    const a = svc.requestSession(actor(CLIENT_IDS[0]), {
      coach_id: COACH_ID,
      session_type_id: TYPE_ID,
      title: 'A',
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    });
    const b = svc.requestSession(actor(CLIENT_IDS[1]), {
      coach_id: COACH_ID,
      session_type_id: TYPE_ID,
      title: 'B',
      start_at: new Date(start.getTime() + 15 * 60_000).toISOString(),
      end_at: new Date(end.getTime() + 15 * 60_000).toISOString(),
    });
    const settled = Promise.allSettled([a, b]);
    const deadline = Date.now() + 20_000;
    while ((await advisoryWaiters()) < 2) {
      if (Date.now() > deadline) throw new TypeError('bookings never waited on the advisory lock');
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await blocker;
    const results = await settled;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(codeOf).filter((c) => c !== null)).toEqual(['SLOT_TAKEN']);
  });

  it('approve vs cancel on one request: exactly one transition wins', async () => {
    const { start, end } = slot(7);
    const s = await svc.requestSession(actor(CLIENT_IDS[2]), {
      coach_id: COACH_ID,
      session_type_id: TYPE_ID,
      title: 'Race',
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    });
    const results = await Promise.allSettled([
      svc.approveSession(COACH, s.id),
      svc.cancelSession(actor(CLIENT_IDS[2]), s.id, { reason: 'race' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(codeOf).filter((c) => c !== null)).toEqual(['SESSION_STATE_CHANGED']);
    const row = await prisma.coachingSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(['scheduled', 'canceled']).toContain(row.status);
  });
  // ── S-SCHED-3 fix round, against the real schema ──────────────────────

  it('S-SCHED-3: migration added the reminder delivery-state columns and their status check', async () => {
    const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'NotificationDeliveryLog'
        AND column_name IN ('status', 'attempts', 'lease_until', 'claim_token', 'session_start_at',
                            'inapp_done_at', 'push_done_at', 'notification_id', 'last_error')
      ORDER BY column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'attempts',
      'claim_token',
      'inapp_done_at',
      'last_error',
      'lease_until',
      'notification_id',
      'push_done_at',
      'session_start_at',
      'status',
    ]);
    const check = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conname = 'NotificationDeliveryLog_status_check'`;
    expect(check).toHaveLength(1);
  });

  it('S-SCHED-3 C-634-2: the range preflight names active rows that end before they start', async () => {
    const rangePreflight = statements.find((st) => st.includes('S-SCHED-2 range preflight'));
    expect(rangePreflight).toBeDefined();
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "CoachingSession" DROP CONSTRAINT "CoachingSession_no_overlapping_active_booking"',
    );
    try {
      const { start } = slot(9);
      await prisma.coachingSession.create({
        data: {
          id: 'ssched3-inverted',
          coach_id: COACH_ID,
          status: 'scheduled',
          start_at: start,
          end_at: new Date(start.getTime() - 60_000),
          title: 'inverted',
        },
      });
      await expect(prisma.$executeRawUnsafe(rangePreflight ?? '')).rejects.toThrow(
        /range preflight: 1 active CoachingSession row/,
      );
    } finally {
      await prisma.coachingSession.deleteMany({ where: { id: 'ssched3-inverted' } });
      for (const stmt of statements) await prisma.$executeRawUnsafe(stmt);
    }
  });

  it('S-SCHED-3 B-634-5: restoring an archived former welcome type passes the real one-welcome index', async () => {
    const oldId = '5a5c6e2d-0000-4000-8000-0000000000a1';
    await prisma.sessionType.create({
      data: {
        id: oldId,
        coach_id: COACH_ID,
        name: 'Quick initialization',
        duration_minutes: 15,
        auto_approve: true,
        is_welcome: true,
      },
    });
    try {
      await svc.updateSessionType(COACH, oldId, { archived: true });
      const fresh = await svc.createSessionType(COACH, {
        name: 'New welcome',
        duration_minutes: 15,
        auto_approve: true,
        is_welcome: true,
      });
      const restored = await svc.updateSessionType(COACH, oldId, { archived: false });
      expect(restored).toMatchObject({ archived_at: null, is_welcome: false });
      const welcome = await prisma.sessionType.findMany({
        where: { coach_id: COACH_ID, is_welcome: true, archived_at: null },
        select: { id: true },
      });
      expect(welcome.map((w) => w.id)).toEqual([fresh.id]);
    } finally {
      await prisma.sessionType.deleteMany({ where: { coach_id: COACH_ID, id: { not: TYPE_ID } } });
    }
  });

  it('S-SCHED-3 B-634-4: past pages walk rows that share a start time with no gaps or repeats', async () => {
    const who = actor(CLIENT_IDS[3]);
    const start = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    start.setUTCSeconds(0, 0);
    const ids = ['ssched3-tie-1', 'ssched3-tie-2', 'ssched3-tie-3'];
    for (const id of ids) {
      await prisma.coachingSession.create({
        data: {
          id,
          coach_id: COACH_ID,
          client_id: who.id,
          status: 'canceled',
          start_at: start,
          end_at: new Date(start.getTime() + 30 * 60_000),
          title: id,
        },
      });
    }
    const seen: string[] = [];
    let cursor: { before: string; before_id: string } | null = null;
    for (let i = 0; i < 6; i++) {
      const page = await svc.listSessionsForActor(who, {
        scope: 'past',
        limit: 1,
        ...(cursor ?? {}),
      });
      if (page.length === 0) break;
      seen.push(page[0].id);
      cursor = { before: new Date(page[0].start_at).toISOString(), before_id: page[0].id };
    }
    expect(seen.slice().sort()).toEqual(ids);
    expect(new Set(seen).size).toBe(3);
  });
});
