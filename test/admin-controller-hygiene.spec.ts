import 'reflect-metadata';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { AdminController } from '../src/admin/admin.controller';
import { AdminService } from '../src/admin/admin.service';
import {
  AdminMetricsQueryDto,
  AuditLogQueryDto,
  BuildWeekEnrollmentsQueryDto,
  CoachAlertsQueryDto,
  CoachEffectivenessQueryDto,
  CoachOnboardingQueryDto,
  FederationSearchQueryDto,
  GdprScrubQueryDto,
  ListCoachesQueryDto,
  ListUsersQueryDto,
  StripeEventsQueryDto,
} from '../src/admin/admin.dto';

// Hygiene tests for the OWNER-only /admin surface:
//   #6 — raw parseInt is gone; numeric query params go through validated
//        DTOs and the global ValidationPipe (NaN/garbage → 400, not silent
//        NaN-fallthrough; valid strings coerce to int).
//   #2 — listCoaches / listUsers are cursor-paginated and forward a bounded
//        limit + cursor into the service (DB query), never slicing in memory.
//   #8 — every handler carries @ApiOperation metadata.

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function asQuery<T>(dto: new () => T, value: unknown): Promise<T> {
  return pipe.transform(value, { type: 'query', metatype: dto as any });
}

function buildAdminSvc(): jest.Mocked<Pick<AdminService, 'listCoaches' | 'listUsers'>> {
  return {
    listCoaches: jest.fn(async () => ({ coaches: [], next_cursor: null })),
    listUsers: jest.fn(async () => ({ users: [], next_cursor: null })),
  } as any;
}

function buildCtrl(overrides: Partial<Record<string, any>> = {}) {
  const admin = buildAdminSvc();
  const metrics = { getOverview: jest.fn(async () => ({})) };
  const federation = {
    unifiedSearch: jest.fn(async () => ({ results: [] })),
    unifiedClient: jest.fn(async () => ({})),
    unifiedCoach: jest.fn(async () => ({})),
  };
  const ctrl = new AdminController(
    admin as any,
    metrics as any,
    federation as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { ctrl, admin, metrics, federation, ...overrides };
}

// ---------------------------------------------------------------------------
// #8 — Swagger coverage. Every handler must carry @ApiOperation metadata.
// ---------------------------------------------------------------------------
describe('AdminController — #8 every handler carries @ApiOperation', () => {
  // All public route handlers on the controller (27).
  const handlers = [
    'getMetrics',
    'listCoaches',
    'getCoach',
    'listUsers',
    'promoteUser',
    'listAuditLog',
    'listStripeEvents',
    'federationSearch',
    'federationClientLookup',
    'federationCoachLookup',
    'consoleSearch',
    'consoleCoachOverview',
    'consoleClient',
    'consoleClientUnified',
    'consoleClientEntitlements',
    'consoleCoachEntitlements',
    'consoleFinanceHealth',
    'consoleIntegrationsStatus',
    'consoleProductUsage',
    'getClientConsent',
    'runGdprScrub',
    'listCoachEffectiveness',
    'getCoachEffectiveness',
    'listCoachOnboarding',
    'listCoachAlerts',
    'listBuildWeekEnrollments',
    'getBuildWeekFunnel',
  ];

  it('covers all 27 route handlers', () => {
    expect(handlers).toHaveLength(27);
  });

  it.each(handlers)('%s has a non-empty @ApiOperation summary', (name) => {
    const fn = (AdminController.prototype as any)[name];
    expect(typeof fn).toBe('function');
    // @ApiOperation stores its metadata under the swagger DECORATORS key.
    const meta = Reflect.getMetadata('swagger/apiOperation', fn);
    expect(meta).toBeDefined();
    expect(typeof meta.summary).toBe('string');
    expect(meta.summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #6 — validated query DTOs replace raw parseInt.
// ---------------------------------------------------------------------------
describe('AdminController — #6 validated numeric query params', () => {
  it('AdminMetricsQueryDto coerces a numeric string to int', async () => {
    const dto = await asQuery(AdminMetricsQueryDto, { since_days: '90' });
    expect(dto.since_days).toBe(90);
    expect(typeof dto.since_days).toBe('number');
  });

  it('AdminMetricsQueryDto rejects a non-numeric since_days (400, not NaN)', async () => {
    await expect(
      asQuery(AdminMetricsQueryDto, { since_days: 'abc' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('AdminMetricsQueryDto rejects out-of-range since_days', async () => {
    await expect(
      asQuery(AdminMetricsQueryDto, { since_days: '9999' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ListUsersQueryDto coerces limit and accepts a valid role', async () => {
    const dto = await asQuery(ListUsersQueryDto, { role: 'coach', limit: '25' });
    expect(dto.limit).toBe(25);
    expect(dto.role).toBe('coach');
  });

  it('ListUsersQueryDto rejects a bad limit (NaN-prone input → 400)', async () => {
    await expect(
      asQuery(ListUsersQueryDto, { limit: 'lots' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ListUsersQueryDto rejects an unknown role', async () => {
    await expect(
      asQuery(ListUsersQueryDto, { role: 'superuser' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ListUsersQueryDto rejects limit above the hard cap (100)', async () => {
    await expect(
      asQuery(ListUsersQueryDto, { limit: '101' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ListCoachesQueryDto rejects an invalid ISO cursor', async () => {
    await expect(
      asQuery(ListCoachesQueryDto, { cursor: 'not-a-date' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('StripeEventsQueryDto rejects a bad limit but allows the wide cap (200)', async () => {
    await expect(
      asQuery(StripeEventsQueryDto, { limit: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const ok = await asQuery(StripeEventsQueryDto, { limit: '200' });
    expect(ok.limit).toBe(200);
  });

  it('AuditLogQueryDto coerces limit and keeps string filters', async () => {
    const dto = await asQuery(AuditLogQueryDto, {
      action: 'USER_ROLE_CHANGED',
      limit: '10',
    });
    expect(dto.limit).toBe(10);
    expect(dto.action).toBe('USER_ROLE_CHANGED');
  });

  it('FederationSearchQueryDto rejects a non-numeric limit', async () => {
    await expect(
      asQuery(FederationSearchQueryDto, { limit: 'nope' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('GdprScrubQueryDto coerces limit and keeps dry_run as string', async () => {
    const dto = await asQuery(GdprScrubQueryDto, { dry_run: 'true', limit: '5' });
    expect(dto.limit).toBe(5);
    expect(dto.dry_run).toBe('true');
  });

  it('CoachEffectivenessQueryDto rejects a non-numeric limit', async () => {
    await expect(
      asQuery(CoachEffectivenessQueryDto, { limit: 'oops' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('CoachOnboardingQueryDto rejects a non-boolean completed flag', async () => {
    await expect(
      asQuery(CoachOnboardingQueryDto, { completed: 'maybe' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('CoachAlertsQueryDto rejects a non-numeric limit', async () => {
    await expect(
      asQuery(CoachAlertsQueryDto, { limit: 'bad' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('BuildWeekEnrollmentsQueryDto rejects an invalid before cursor', async () => {
    await expect(
      asQuery(BuildWeekEnrollmentsQueryDto, { before: 'not-iso' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forbidNonWhitelisted rejects an injected unknown query field', async () => {
    await expect(
      asQuery(ListUsersQueryDto, { role: 'coach', evil: '1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// #2 — listCoaches / listUsers forward bounded limit + cursor to the service.
// ---------------------------------------------------------------------------
describe('AdminController — #2 cursor pagination forwarding', () => {
  it('listCoaches forwards limit and parses the cursor to a Date', async () => {
    const { ctrl, admin } = buildCtrl();
    await ctrl.listCoaches({
      limit: 10,
      cursor: '2026-01-01T00:00:00.000Z',
    } as ListCoachesQueryDto);
    expect(admin.listCoaches).toHaveBeenCalledWith({
      limit: 10,
      cursor: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('listCoaches passes undefined cursor when absent', async () => {
    const { ctrl, admin } = buildCtrl();
    await ctrl.listCoaches({ limit: 5 } as ListCoachesQueryDto);
    expect(admin.listCoaches).toHaveBeenCalledWith({
      limit: 5,
      cursor: undefined,
    });
  });

  it('listUsers forwards role/q/limit and parses cursor to a Date', async () => {
    const { ctrl, admin } = buildCtrl();
    await ctrl.listUsers({
      role: 'student',
      q: 'alex',
      limit: 20,
      cursor: '2026-02-02T00:00:00.000Z',
    } as ListUsersQueryDto);
    expect(admin.listUsers).toHaveBeenCalledWith({
      role: 'student',
      q: 'alex',
      limit: 20,
      cursor: new Date('2026-02-02T00:00:00.000Z'),
    });
  });
});

// ---------------------------------------------------------------------------
// #2 — service-level bound: the limit is pushed into the DB query (`take`)
// and is hard-capped; next_cursor advances only on a full page.
// ---------------------------------------------------------------------------
describe('AdminService — #2 bounded DB-level pagination', () => {
  function makeService(rows: any[]) {
    const findMany = jest.fn(async (_args: any) => rows);
    const prisma = { user: { findMany } } as any;
    const svc = new AdminService(prisma, {} as any, {} as any);
    return { svc, findMany };
  }

  function firstArg(findMany: jest.Mock): any {
    return findMany.mock.calls[0]![0];
  }

  it('listUsers caps take at the hard max (100) and orders created_at desc', async () => {
    const { svc, findMany } = makeService([]);
    await svc.listUsers({ limit: 1000 });
    const arg = firstArg(findMany);
    expect(arg.take).toBe(100);
    expect(arg.orderBy).toEqual({ created_at: 'desc' });
  });

  it('listUsers pushes the cursor into the where clause (keyset, not in-memory)', async () => {
    const { svc, findMany } = makeService([]);
    const cursor = new Date('2026-03-03T00:00:00.000Z');
    await svc.listUsers({ cursor });
    const arg = firstArg(findMany);
    expect(arg.where.created_at).toEqual({ lt: cursor });
  });

  it('listUsers returns next_cursor only when a full page is returned', async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({
      id: `u${i}`,
      created_at: new Date('2026-04-04T00:00:00.000Z'),
    }));
    const { svc } = makeService(full);
    const res = await svc.listUsers({ limit: 50 });
    expect(res.next_cursor).toBe('2026-04-04T00:00:00.000Z');

    const { svc: svc2 } = makeService(full.slice(0, 10));
    const res2 = await svc2.listUsers({ limit: 50 });
    expect(res2.next_cursor).toBeNull();
  });

  it('listCoaches caps take at 100 and uses a created_at > cursor keyset', async () => {
    const { svc, findMany } = makeService([]);
    const cursor = new Date('2026-05-05T00:00:00.000Z');
    await svc.listCoaches({ limit: 999, cursor });
    const arg = firstArg(findMany);
    expect(arg.take).toBe(100);
    expect(arg.where.role).toBe('coach');
    expect(arg.where.created_at).toEqual({ gt: cursor });
    expect(arg.orderBy).toEqual({ created_at: 'asc' });
  });
});
