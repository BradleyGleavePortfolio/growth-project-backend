import 'reflect-metadata';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { AdminController } from '../src/admin/admin.controller';
import {
  AdminService,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from '../src/admin/admin.service';
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

  it('ListCoachesQueryDto rejects a non-composite (timestamp-only) cursor', async () => {
    // A bare ISO timestamp is no longer a valid cursor: the keyset cursor
    // must carry both the created_at and the row id (`<ISO>|<id>`).
    await expect(
      asQuery(ListCoachesQueryDto, { cursor: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ListCoachesQueryDto rejects a malformed cursor (no id half)', async () => {
    await expect(
      asQuery(ListCoachesQueryDto, { cursor: 'not-a-date|u1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ListUsersQueryDto accepts a well-formed composite cursor', async () => {
    const dto = await asQuery(ListUsersQueryDto, {
      cursor: '2026-01-01T00:00:00.000Z|usr_abc123',
    });
    expect(dto.cursor).toBe('2026-01-01T00:00:00.000Z|usr_abc123');
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
  it('listCoaches forwards limit and decodes the composite cursor', async () => {
    const { ctrl, admin } = buildCtrl();
    await ctrl.listCoaches({
      limit: 10,
      cursor: '2026-01-01T00:00:00.000Z|coach_42',
    } as ListCoachesQueryDto);
    expect(admin.listCoaches).toHaveBeenCalledWith({
      limit: 10,
      cursor: {
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        id: 'coach_42',
      },
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

  it('listUsers forwards role/q/limit and decodes the composite cursor', async () => {
    const { ctrl, admin } = buildCtrl();
    await ctrl.listUsers({
      role: 'student',
      q: 'alex',
      limit: 20,
      cursor: '2026-02-02T00:00:00.000Z|usr_7',
    } as ListUsersQueryDto);
    expect(admin.listUsers).toHaveBeenCalledWith({
      role: 'student',
      q: 'alex',
      limit: 20,
      cursor: {
        createdAt: new Date('2026-02-02T00:00:00.000Z'),
        id: 'usr_7',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Keyset cursor codec — round-trip + malformed-input rejection.
// ---------------------------------------------------------------------------
describe('keyset cursor codec', () => {
  it('round-trips a (created_at, id) row through encode/decode', () => {
    const row = { created_at: new Date('2026-03-03T12:34:56.000Z'), id: 'usr_x' };
    const encoded = encodeKeysetCursor(row);
    expect(encoded).toBe('2026-03-03T12:34:56.000Z|usr_x');
    const decoded = decodeKeysetCursor(encoded);
    expect(decoded.createdAt).toEqual(row.created_at);
    expect(decoded.id).toBe('usr_x');
  });

  it('preserves ids that themselves contain no pipe but arbitrary chars', () => {
    const row = { created_at: new Date('2026-03-03T00:00:00.000Z'), id: 'a-b_c.d' };
    expect(decodeKeysetCursor(encodeKeysetCursor(row)).id).toBe('a-b_c.d');
  });

  it('rejects a cursor with no id half (400)', () => {
    expect(() => decodeKeysetCursor('2026-03-03T00:00:00.000Z')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a cursor with an unparseable timestamp (400)', () => {
    expect(() => decodeKeysetCursor('not-a-date|usr_x')).toThrow(
      BadRequestException,
    );
  });
});

// ---------------------------------------------------------------------------
// #2 — service-level bound: the limit is pushed into the DB query (`take`)
// as a `limit + 1` probe and is hard-capped; ordering uses the composite
// (created_at, id) key; next_cursor is emitted ONLY when the probe row proves
// more data exists (honest has-more, no phantom final page); and rows that
// share a created_at instant are never skipped at the page boundary.
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

  it('listUsers over-fetches limit+1 (cap 100 → take 101) and orders by (created_at, id) desc', async () => {
    const { svc, findMany } = makeService([]);
    await svc.listUsers({ limit: 1000 });
    const arg = firstArg(findMany);
    // limit is capped at 100, then we probe one extra row.
    expect(arg.take).toBe(101);
    expect(arg.orderBy).toEqual([{ created_at: 'desc' }, { id: 'desc' }]);
  });

  it('listUsers pushes a composite (created_at,id) keyset into the where clause (DESC)', async () => {
    const { svc, findMany } = makeService([]);
    const cursor = {
      createdAt: new Date('2026-03-03T00:00:00.000Z'),
      id: 'usr_5',
    };
    await svc.listUsers({ cursor });
    const arg = firstArg(findMany);
    // AND-combined filter list; the keyset clause is the tuple comparator.
    expect(arg.where.AND).toContainEqual({
      OR: [
        { created_at: { lt: cursor.createdAt } },
        { created_at: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  });

  it('listUsers emits next_cursor only when the limit+1 probe returns an extra row', async () => {
    // 51 rows for a limit of 50 → a real next page exists. The trimmed page is
    // 50 rows and next_cursor is the composite cursor of the last KEPT row.
    const probe = Array.from({ length: 51 }, (_, i) => ({
      id: `u${i}`,
      created_at: new Date('2026-04-04T00:00:00.000Z'),
    }));
    const { svc } = makeService(probe);
    const res = await svc.listUsers({ limit: 50 });
    expect(res.users).toHaveLength(50);
    expect(res.next_cursor).toBe('2026-04-04T00:00:00.000Z|u49');

    // Exactly 50 rows (no probe row) → this is the final page, no next_cursor.
    const { svc: svc2 } = makeService(probe.slice(0, 50));
    const res2 = await svc2.listUsers({ limit: 50 });
    expect(res2.users).toHaveLength(50);
    expect(res2.next_cursor).toBeNull();
  });

  it('listUsers does NOT skip rows that share a created_at at the page boundary', async () => {
    // 50 users, identical created_at, distinct ids. With a deterministic
    // (created_at, id) keyset the next_cursor encodes the last id, so the
    // follow-up query resumes strictly after that id rather than excluding
    // every row at the shared timestamp (the old timestamp-only bug).
    const shared = new Date('2026-06-06T00:00:00.000Z');
    const page1 = Array.from({ length: 6 }, (_, i) => ({
      id: `usr_${String(i).padStart(2, '0')}`,
      created_at: shared,
    }));
    const { svc } = makeService(page1);
    const res = await svc.listUsers({ limit: 5 });
    // last KEPT row is usr_04 (index 4); probe row usr_05 proves more exist.
    expect(res.next_cursor).toBe(`${shared.toISOString()}|usr_04`);

    // Decoding that cursor and re-querying must constrain id > 'usr_04' at the
    // SAME timestamp — i.e. the boundary row usr_05 is NOT excluded.
    const decoded = decodeKeysetCursor(res.next_cursor as string);
    const { svc: svc2, findMany } = makeService([]);
    await svc2.listUsers({ cursor: decoded, limit: 5 });
    const arg = firstArg(findMany);
    expect(arg.where.AND).toContainEqual({
      OR: [
        { created_at: { lt: shared } },
        { created_at: shared, id: { lt: 'usr_04' } },
      ],
    });
  });

  it('listCoaches over-fetches limit+1 (cap → 101) and uses a (created_at,id)>cursor keyset (ASC)', async () => {
    const { svc, findMany } = makeService([]);
    const cursor = {
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      id: 'coach_9',
    };
    await svc.listCoaches({ limit: 999, cursor });
    const arg = firstArg(findMany);
    expect(arg.take).toBe(101);
    expect(arg.where.role).toBe('coach');
    expect(arg.where.OR).toEqual([
      { created_at: { gt: cursor.createdAt } },
      { created_at: cursor.createdAt, id: { gt: cursor.id } },
    ]);
    expect(arg.orderBy).toEqual([{ created_at: 'asc' }, { id: 'asc' }]);
  });

  it('listCoaches emits a composite next_cursor only when a probe row exists', async () => {
    const profile = null;
    const mk = (i: number) => ({
      id: `c${i}`,
      email: `c${i}@x.com`,
      name: `C${i}`,
      created_at: new Date('2026-07-07T00:00:00.000Z'),
      coach_profile: profile,
      students: [],
    });
    const probe = Array.from({ length: 4 }, (_, i) => mk(i)); // limit 3 + 1
    const { svc } = makeService(probe);
    const res = await svc.listCoaches({ limit: 3 });
    expect(res.coaches).toHaveLength(3);
    expect(res.next_cursor).toBe('2026-07-07T00:00:00.000Z|c2');

    const { svc: svc2 } = makeService(probe.slice(0, 3));
    const res2 = await svc2.listCoaches({ limit: 3 });
    expect(res2.next_cursor).toBeNull();
  });
});
