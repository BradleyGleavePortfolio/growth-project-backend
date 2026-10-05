import 'reflect-metadata';
import {
  RomanClientContextService,
  ROMAN_CTX_LIMITS,
  ROMAN_CONTEXT_MEMO_MAX_ENTRIES,
} from '../../src/roman/context/roman-client-context.service';
import { RomanContextController } from '../../src/roman/context/roman-context.controller';
import {
  makePersonaDb, FakeSafetyIntakeSource, NOW, P1, P4,
} from './fixtures/roman-personas';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { RomanClientContextBundle } from '../../src/roman/context/roman-client-context.types';
import type { PrismaService } from '../../src/prisma.service';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

const caller = { id: P1, role: 'student' };
function setup() {
  const db = makePersonaDb();
  return { db, svc: new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource()) };
}

describe('AUD-SOL-RA-121 A2 independent source completeness and local-date probes', () => {
  it('B-665-1 two providers describing one night do not become sixteen hours', async () => {
    const { db, svc } = setup();
    db.raw.wearableSamples.length = 0;
    const night = {
      user_id: P1,
      metric: 'SLEEP_TOTAL_MIN',
      value: 480,
      start_at: new Date('2026-09-30T05:00:00Z'),
      end_at: new Date('2026-09-30T13:00:00Z'),
      source_tz: 'America/Los_Angeles',
    };
    db.raw.wearableSamples.push(
      { ...night, provider: 'OURA' },
      { ...night, provider: 'APPLE_HEALTH' },
    );
    Object.assign(db.prisma, {
      wearableUserMetricPreference: {
        findUnique: jest.fn(async () => ({ preferred_provider: 'APPLE_HEALTH' })),
        findMany: jest.fn(async () => [{ metric: 'SLEEP_TOTAL_MIN', preferred_provider: 'APPLE_HEALTH' }]),
      },
    });
    Object.assign(db.prisma.wearableSample, {
      findFirst: jest.fn(async () => ({ provider: 'APPLE_HEALTH' })),
    });
    const { context } = await svc.build(caller, NOW);
    console.log('two-provider last-night sleep', context.wearables.last_night_sleep_hours);
    expect(context.wearables.last_night_sleep_hours).toBe(8);
    expect(context.wearables.avg_7d.sleep_hours).toBe(8);
  });

  it('B-665-2 a capped raw stream cannot be published as a complete daily total', async () => {
    const { db, svc } = setup();
    db.raw.wearableSamples.length = 0;
    for (let i = 0; i < 1000; i += 1) {
      db.raw.wearableSamples.push({
        user_id: P1, provider: 'APPLE_HEALTH', metric: 'STEPS', value: 1,
        start_at: new Date(Date.parse('2026-09-30T07:00:00Z') + i * 1000),
        end_at: new Date(Date.parse('2026-09-30T07:00:00Z') + (i + 1) * 1000),
        source_tz: 'America/Los_Angeles',
      });
    }
    const { context } = await svc.build(caller, NOW);
    const steps = context.wearables.days.find((d) => d.date === '2026-09-30')?.steps;
    console.log('1000 one-step samples, cap', ROMAN_CTX_LIMITS.wearable_samples,
      'published daily steps', steps, 'truncated', context.data_quality.truncated);
    const accurate = steps === 1000;
    const explicitlyUnknown = steps == null && context.data_quality.truncated.some((x) => x.includes('wearable'));
    expect(accurate || explicitlyUnknown).toBe(true);
  });

  it('B-665-3 an evening PT workout scheduled after UTC midnight is today, not tomorrow', async () => {
    const { db, svc } = setup();
    const future = db.raw.assignments.find((a) => a.client_id === P1 && a.completed_at === null)!;
    db.raw.assignments.length = 0;
    db.raw.assignments.push({
      ...future,
      scheduled_for: new Date('2026-10-01T02:00:00Z'), // Sep 30 19:00 PT.
    });
    const { context } = await svc.build(caller, NOW); // Sep 30 17:30 PT.
    console.log('local evening workout', context.plan);
    expect(context.plan?.today_session?.date).toBe('2026-09-30');
    expect(context.plan?.next_session).toBeNull();
  });

  it('B-665-4 forty past assignments cannot silently hide the next real session', async () => {
    const { db, svc } = setup();
    const future = db.raw.assignments.find((a) => a.client_id === P1 && a.completed_at === null)!;
    const completed = db.raw.assignments.find((a) => a.client_id === P1 && a.completed_at !== null)!;
    db.raw.assignments.length = 0;
    for (let i = 0; i < 40; i += 1) {
      db.raw.assignments.push({
        ...completed,
        id: `completed-${i}`,
        scheduled_for: new Date(Date.parse('2026-09-25T14:00:00Z') + i * 60000),
      });
    }
    db.raw.assignments.push({ ...future, id: 'future-real' });
    const { context } = await svc.build(caller, NOW);
    console.log('41 rows (40 past, one future), published next session', context.plan?.next_session,
      'truncated', context.data_quality.truncated);
    expect(context.plan?.next_session?.date === '2026-10-01' ||
      context.data_quality.truncated.some((x) => x.includes('plan'))).toBe(true);
  });

  it('control: booking select excludes private notes and all other clients', async () => {
    const { db, svc } = setup();
    db.raw.coachingSessions.push({
      coach_id: 'coach-A', client_id: P4, status: 'scheduled',
      title: 'OTHER-CLIENT-BOOKING',
      start_at: new Date('2026-10-06T17:00:00Z'),
      end_at: new Date('2026-10-06T17:45:00Z'),
      coach_notes_md: 'OTHER-PRIVATE-NOTES',
    });
    const bundle = await svc.buildFresh(caller, NOW);
    expect(bundle.rendered).not.toMatch(/OTHER-CLIENT|PRIVATE-CANARY|OTHER-PRIVATE/);
    expect(db.prisma.coachingSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ client_id: P1, coach_id: 'coach-A' }),
      select: { title: true, start_at: true, end_at: true, status: true },
    }));
  });

  it('control: disclosure data owner comes only from authenticated caller, not injected request parameters', async () => {
    const { svc } = setup();
    const out = await new RomanContextController(svc).me(fakeOf<AuthedRequest>({
      user: caller,
      params: { userId: P4 },
      query: { userId: P4 },
      body: { userId: P4 },
    }));
    expect(out.context.identity.first_name).toBe('Maya');
    expect(JSON.stringify(out)).not.toContain('Zelda');
  });

  it('control: two in-flight builds invalidated together leave no cache entry or generation fence', async () => {
    const { svc } = setup();
    const releases: Array<(b: RomanClientContextBundle) => void> = [];
    const real = await svc.buildFresh(caller, NOW);
    jest.spyOn(svc, 'buildFresh').mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
    const a = svc.getBundle(caller, NOW);
    const b = svc.getBundle(caller, NOW);
    expect(releases).toHaveLength(2);
    svc.invalidateForUser(P1);
    releases[1](real);
    await b;
    releases[0](real);
    await a;
    expect(svc.retainedEntryCounts()).toEqual({ memo: 0, generation: 0, inFlight: 0 });
  });

  it('C-665-1 the documented hard memo limit also holds immediately after insertion', async () => {
    const svc = new RomanClientContextService(
      fakeOf<PrismaService>({}),
      { summarize: jest.fn() },
    );
    jest.spyOn(svc, 'buildFresh').mockImplementation(async () => fakeOf<RomanClientContextBundle>({
      context: { identity: { timezone: 'UTC', local_date: '2026-10-01' } },
    }));
    for (let i = 0; i <= ROMAN_CONTEXT_MEMO_MAX_ENTRIES; i += 1) {
      await svc.getBundle({ id: `user-${i}`, role: 'student' }, NOW);
    }
    console.log('memo immediately after insertion', svc.retainedEntryCounts().memo);
    expect(svc.retainedEntryCounts().memo).toBeLessThanOrEqual(ROMAN_CONTEXT_MEMO_MAX_ENTRIES);
  });
});
