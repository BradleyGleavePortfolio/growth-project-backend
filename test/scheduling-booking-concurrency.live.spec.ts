/**
 * S-SCHED live proof on real Postgres: concurrent bookings of ONE open slot
 * produce exactly one session; every loser gets 409 (SLOT_TAKEN). Also
 * proves a reschedule racing a booking into the same slot cannot double
 * book.
 *
 * Gated on MWB3_TEST_DATABASE_URL (the mwb-3-live-tests CI job); skipped with
 * a logged reason elsewhere. Builds a Prisma-faithful schema with the shared
 * bootstrap helper on a throwaway database.
 */
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';
import { GoogleCalendarAdapter } from '../src/scheduling/providers/google-calendar.adapter';
import { GoogleMeetAdapter } from '../src/scheduling/providers/google-meet.adapter';
import { SchedulingProviderRegistry } from '../src/scheduling/providers/scheduling-provider.registry';
import { StubCalendarAdapter } from '../src/scheduling/providers/stub-calendar.adapter';
import { StubVideoAdapter } from '../src/scheduling/providers/stub-video.adapter';
import { ZoomVideoAdapter } from '../src/scheduling/providers/zoom-video.adapter';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';
import { auditDouble, bookingEmitterDouble } from './utils/scheduling-test-doubles';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn('[scheduling-booking-concurrency.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.');
}

const COACH_ID = 'ssched-live-coach';
const CLIENTS = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => `ssched-live-client-${k}`);

function withPool(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return url.includes('connection_limit=') ? url : `${url}${sep}connection_limit=10`;
}

// Next Monday at least 2 days out, 16:00Z (09:00 PDT / 08:00 PST).
function nextMondayUtc(hour: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

liveDescribe('S-SCHED live: one slot, many bookers (Postgres)', () => {
  let prisma: PrismaService;
  let svc: SchedulingService;
  let typeId: string;

  const actor = (id: string) => ({
    id,
    role: 'student' as const,
    email: null,
    coach_id: COACH_ID,
    ip: null,
    userAgent: null,
  });

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL) } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    const audit = auditDouble({ write: async () => undefined });
    const emitter = bookingEmitterDouble({
      emitRequested: async () => undefined,
      emitConfirmed: async () => undefined,
      emitDeclined: async () => undefined,
      emitCancelled: async () => undefined,
      emitRescheduled: async () => undefined,
    });
    svc = new SchedulingService(
      prisma,
      audit,
      new SchedulingProviderRegistry(
        new StubCalendarAdapter(),
        new GoogleCalendarAdapter(),
        new StubVideoAdapter(),
        new GoogleMeetAdapter(),
        new ZoomVideoAdapter(),
      ),
      emitter,
    );
    await prisma.user.create({
      data: { id: COACH_ID, supabase_id: `sb-${COACH_ID}`, email: `${COACH_ID}@example.test`, name: 'Coach', role: 'coach' },
    });
    await prisma.coachProfile.create({
      data: { user_id: COACH_ID, invite_code: 'SSCHED-LIVE', timezone: 'UTC' },
    });
    for (const id of CLIENTS) {
      await prisma.user.create({
        data: { id, supabase_id: `sb-${id}`, email: `${id}@example.test`, name: id, coach_id: COACH_ID },
      });
    }
    // Every day 00:00-24:00 UTC so any test slot is inside open time.
    await prisma.coachAvailability.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        coach_id: COACH_ID,
        day_of_week: d,
        start_minute: 0,
        end_minute: 1440,
      })),
    });
    const t = await prisma.sessionType.create({
      data: { coach_id: COACH_ID, name: 'Check-in', duration_minutes: 30, auto_approve: true, default_video_provider: 'stub' },
    });
    typeId = t.id;
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it('six clients book the same slot at once -> exactly one session, five 409s', async () => {
    const start = nextMondayUtc(16);
    const end = new Date(start.getTime() + 30 * 60_000);
    const results = await Promise.allSettled(
      CLIENTS.map((id) =>
        svc.requestSession(actor(id), {
          coach_id: COACH_ID,
          session_type_id: typeId,
          title: 'Check-in',
          start_at: start.toISOString(),
          end_at: end.toISOString(),
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(5);
    for (const f of failed) expect(f.reason).toBeInstanceOf(ConflictException);
    const rows = await prisma.coachingSession.count({
      where: { coach_id: COACH_ID, start_at: start, status: { in: ['requested', 'scheduled', 'pending_provider'] } },
    });
    expect(rows).toBe(1);
  }, 60_000);

  it('a reschedule and a booking racing into one slot -> exactly one occupies it', async () => {
    const original = nextMondayUtc(18);
    const target = nextMondayUtc(19);
    const s = await svc.requestSession(actor(CLIENTS[0]), {
      coach_id: COACH_ID,
      session_type_id: typeId,
      title: 'Check-in',
      start_at: original.toISOString(),
      end_at: new Date(original.getTime() + 30 * 60_000).toISOString(),
    });
    const targetEnd = new Date(target.getTime() + 30 * 60_000).toISOString();
    const results = await Promise.allSettled([
      svc.rescheduleSession(actor(CLIENTS[0]), s.id, { start_at: target.toISOString(), end_at: targetEnd }),
      svc.requestSession(actor(CLIENTS[1]), {
        coach_id: COACH_ID,
        session_type_id: typeId,
        title: 'Check-in',
        start_at: target.toISOString(),
        end_at: targetEnd,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const occupying = await prisma.coachingSession.count({
      where: { coach_id: COACH_ID, start_at: target, status: { in: ['requested', 'scheduled', 'pending_provider'] } },
    });
    expect(occupying).toBe(1);
  }, 60_000);
});
