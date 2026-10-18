import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { clientWeek } from '../src/coach/client-week';
import { CoachController } from '../src/coach/coach.controller';
import { CoachService } from '../src/coach/coach.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { CoachGuard } from '../src/auth/coach.guard';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { AuditService } from '../src/audit/audit.service';
import { ConsentService } from '../src/consent/consent.service';
import { PrismaService } from '../src/prisma.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

/**
 * K1WEEK: GET /coach/clients/:id/week, the client file's This week ring
 * (planning/MOCKUP3/K1, Style C). The week edges and time zones of the pure
 * helper, the route's gates, and the zone fallbacks. The live suite with real
 * coaches, a sub-coach, a move and the row layer: test/rls/k1-client-week.spec.ts.
 */
describe('K1WEEK clientWeek: Monday to Sunday in the given zone', () => {
  const at = (iso: string) => new Date(iso);
  const iso = (d: Date) => d.toISOString();
  const LA = 'America/Los_Angeles';
  const NY = 'America/New_York';

  it('a Wednesday in Los Angeles: the week from local Monday midnight to the next', () => {
    const w = clientWeek(at('2026-10-14T16:41:00Z'), LA);
    expect([w.start, w.today, iso(w.from), iso(w.to)]).toEqual([
      '2026-10-12', '2026-10-14', '2026-10-12T07:00:00.000Z', '2026-10-19T07:00:00.000Z',
    ]);
  });

  it('Sunday 23:59 is still this week; Monday 00:00 starts the next', () => {
    expect(clientWeek(at('2026-10-19T03:59:00Z'), NY)).toMatchObject({ start: '2026-10-12', today: '2026-10-18' });
    expect(clientWeek(at('2026-10-19T04:00:00Z'), NY)).toMatchObject({ start: '2026-10-19', today: '2026-10-19' });
  });

  it('one instant is a new week in New York and still last week in Los Angeles', () => {
    const now = at('2026-10-19T05:30:00Z');
    expect(clientWeek(now, NY).start).toBe('2026-10-19');
    expect(clientWeek(now, LA).start).toBe('2026-10-12');
  });

  it('a DST week runs midnight to midnight: 169 hours in the fall, 167 in the spring', () => {
    const fall = clientWeek(at('2026-10-28T19:00:00Z'), LA);
    expect([fall.start, iso(fall.from), iso(fall.to)]).toEqual(['2026-10-26', '2026-10-26T07:00:00.000Z', '2026-11-02T08:00:00.000Z']);
    expect(fall.to.getTime() - fall.from.getTime()).toBe(169 * 3_600_000);
    const spring = clientWeek(at('2026-03-04T20:00:00Z'), LA);
    expect([spring.start, iso(spring.from), iso(spring.to)]).toEqual(['2026-03-02', '2026-03-02T08:00:00.000Z', '2026-03-09T07:00:00.000Z']);
  });

  it('dayOf gives the local day: a program day stored at 12:00 UTC keeps its date across US zones', () => {
    const w = clientWeek(at('2026-10-14T13:41:00Z'), NY);
    expect(w.dayOf(at('2026-10-12T04:00:00Z'))).toBe('2026-10-12');
    expect(w.dayOf(at('2026-10-19T03:59:00Z'))).toBe('2026-10-18');
    for (const tz of [LA, NY, 'Pacific/Honolulu']) {
      expect(clientWeek(at('2026-10-14T13:41:00Z'), tz).dayOf(at('2026-10-13T12:00:00Z'))).toBe('2026-10-13');
    }
  });
});

describe('K1WEEK route: coaches only, through the coach guards', () => {
  it('is GET clients/:id/week with @Roles(coach, owner) under JwtAuthGuard and CoachGuard', () => {
    const handler = CoachController.prototype.getClientWeek;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('clients/:id/week');
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['coach', 'owner']);
    expect(Reflect.getMetadata(GUARDS_METADATA, CoachController)).toEqual(
      expect.arrayContaining([JwtAuthGuard, CoachGuard]),
    );
  });

  it('a client (student) is refused before the service runs', () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'c1', role: 'student' } }),
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
    } as ExecutionContext;
    expect(() => new CoachGuard().canActivate(ctx)).toThrow(ForbiddenException);
  });
});

describe('K1WEEK service: the zone that defines the week, and the gates', () => {
  const NOW = new Date('2026-10-14T13:41:00Z');
  type Bounds = { where: { scheduled_for: { gte: Date; lt: Date } } };
  type Opts = { found?: boolean; shared?: boolean; zones?: Record<string, string>; profiles?: Record<string, string> };
  async function build(opts: Opts) {
    const findMany = jest.fn(async (_args: Bounds) => []);
    const prisma = {
      user: {
        findFirst: jest.fn(async () => (opts.found === false ? null : { id: 'client' })),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({ coach_id: where.id === 'client' ? 'head' : null })),
      },
      notificationPreferences: {
        findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) => {
          const tz = opts.zones?.[where.user_id];
          return tz ? { timezone: tz, timezone_updated_at: NOW } : null;
        }),
      },
      coachProfile: {
        findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) => {
          const tz = opts.profiles?.[where.user_id];
          return tz ? { timezone: tz } : null;
        }),
      },
      clientWorkoutAssignment: { findMany },
    };
    const audit = { write: jest.fn(async () => undefined) };
    const mod = await Test.createTestingModule({
      providers: [
        CoachService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: ConsentService, useValue: { coachCanAccess: jest.fn(async () => opts.shared !== false) } },
        { provide: SubCoachScopeService, useValue: { isSubCoach: jest.fn(async () => false) } },
      ],
    }).compile();
    const bounds = () => {
      const { gte, lt } = findMany.mock.calls[0][0].where.scheduled_for;
      return [gte.toISOString(), lt.toISOString()];
    };
    return { service: mod.get(CoachService), findMany, audit, bounds };
  }

  it('the client\'s own zone wins over their coach\'s and the caller\'s', async () => {
    const { service, bounds } = await build({
      zones: { client: 'America/New_York', caller: 'Asia/Tokyo' }, profiles: { head: 'America/Los_Angeles' },
    });
    const out = await service.getClientWeek('caller', 'client', 'coach', {}, NOW);
    expect(out).toEqual({ week_start: '2026-10-12', today: '2026-10-14', shared: true, assignments: [] });
    expect(bounds()).toEqual(['2026-10-12T04:00:00.000Z', '2026-10-19T04:00:00.000Z']);
  });

  it('C1V2-C1: a shared week reads each day\'s skipped_at, so a skipped day is not read as missed', async () => {
    const { service, findMany } = await build({});
    await service.getClientWeek('caller', 'client', 'coach', {}, NOW);
    expect(findMany.mock.calls[0][0]).toMatchObject({ select: { completed_at: true, skipped_at: true } });
  });

  it('no zone of their own: the client\'s coach\'s profile zone', async () => {
    const { service, bounds } = await build({ zones: { caller: 'Asia/Tokyo' }, profiles: { head: 'America/Chicago' } });
    await service.getClientWeek('caller', 'client', 'coach', {}, NOW);
    expect(bounds()).toEqual(['2026-10-12T05:00:00.000Z', '2026-10-19T05:00:00.000Z']);
  });

  it('nothing known for the client: the caller\'s zone, then Pacific', async () => {
    const tokyo = await build({ zones: { caller: 'Asia/Tokyo' } });
    await tokyo.service.getClientWeek('caller', 'client', 'coach', {}, NOW);
    expect(tokyo.bounds()).toEqual(['2026-10-11T15:00:00.000Z', '2026-10-18T15:00:00.000Z']);
    const none = await build({});
    await none.service.getClientWeek('caller', 'client', 'coach', {}, NOW);
    expect(none.bounds()).toEqual(['2026-10-12T07:00:00.000Z', '2026-10-19T07:00:00.000Z']);
  });

  it('Workouts not shared: shared false, no assignment read', async () => {
    const { service, findMany } = await build({ shared: false, zones: { client: 'America/New_York' } });
    const out = await service.getClientWeek('caller', 'client', 'coach', {}, NOW);
    expect(out).toEqual({ week_start: '2026-10-12', today: '2026-10-14', shared: false, assignments: [] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('not the caller\'s client now: 404, nothing read and no view audited', async () => {
    const { service, findMany, audit } = await build({ found: false });
    await expect(service.getClientWeek('caller', 'client', 'coach', {}, NOW)).rejects.toThrow(NotFoundException);
    expect(findMany).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });
});
