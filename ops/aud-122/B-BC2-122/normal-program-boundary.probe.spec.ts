import { BroadcastsService } from '../../src/broadcasts/broadcasts.service';
import { SegmentResolverService } from '../../src/broadcasts/segment-resolver.service';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { BroadcastScopeService, CoachScope } from '../../src/broadcasts/broadcast-scope.service';
import type { CardsService } from '../../src/broadcasts/cards.service';

function stub<T>(v: unknown): T {
  return v as T;
}

type Row = Record<string, unknown>;

/** Small query evaluator: executes the Prisma predicates against ordinary rows. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (value as Row[]).every((w) => matches(row, w));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const filter = value as Row;
      if ('in' in filter) return (filter.in as unknown[]).includes(row[key]);
      if ('not' in filter) return row[key] !== filter.not;
      if ('is' in filter) return !!row[key] && matches(row[key] as Row, filter.is as Row);
      return !!row[key] && typeof row[key] === 'object' && matches(row[key] as Row, filter);
    }
    return row[key] === value;
  });
}

const HEAD = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const OTHER_SUB = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const MASTER = '55555555-5555-4555-8555-555555555555';
const COPY = '66666666-6666-4666-8666-666666666666';
const OWN_MASTER = '77777777-7777-4777-8777-777777777777';
const SHARED_MASTER = '88888888-8888-4888-8888-888888888888';
const SIBLING_MASTER = '99999999-9999-4999-8999-999999999999';

function service(scope: CoachScope, programs: Row[], assignments: Row[] = []) {
  const queryPrograms = (a: { where: Row }) => programs.filter((p) => matches(p, a.where));
  const db = {
    workoutProgram: {
      count: jest.fn(async (a: { where: Row }) => queryPrograms(a).length),
      findMany: jest.fn(async (a: { where: Row }) => queryPrograms(a)),
    },
    clientWorkoutAssignment: {
      findMany: jest.fn(async (a: { where: Row }) =>
        assignments.filter((p) => matches(p, a.where)).map((p) => ({ client_id: p.client_id })),
      ),
    },
    userBlock: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => [{ id: CLIENT, name: 'Assigned Client' }]) },
    coachPackage: { findMany: jest.fn(async () => []) },
    coachClientTag: { groupBy: jest.fn(async () => []) },
    coachBroadcast: {
      count: jest.fn(async () => 0),
      create: jest.fn(async (a: { data: Row }) => ({
        id: 'broadcast-normal',
        occurrences_sent: 0,
        created_at: new Date(),
        updated_at: new Date(),
        ...a.data,
      })),
    },
  };
  const prisma = stub<PrismaService>(db);
  return {
    db,
    svc: new BroadcastsService(
      prisma,
      stub<BroadcastScopeService>({ resolve: async () => scope }),
      new SegmentResolverService(prisma),
      stub<CardsService>({}),
      stub<AuditService>({ write: async () => undefined }),
    ),
  };
}

describe('AUD-SOL-BC1-122 ordinary program boundaries', () => {
  it('B-727-1: a program assigned through a client copy is included when the coach selects its master', async () => {
    const master = {
      id: MASTER,
      coach_id: HEAD,
      owner_user_id: HEAD,
      visibility: 'owner_only',
      is_template: true,
      archived_at: null,
      name: 'Strength Foundations',
    };
    const copy = {
      id: COPY,
      coach_id: HEAD,
      owner_user_id: HEAD,
      visibility: 'owner_only',
      is_template: false,
      archived_at: null,
      client_id: CLIENT,
      cloned_from_id: MASTER,
      name: 'Strength Foundations',
    };
    const assignment = {
      client_id: CLIENT,
      workout_plan: { id: 'day-copy', program_id: COPY, program: copy, archived_at: null },
    };
    const { svc } = service(
      { actorId: HEAD, tenantId: HEAD, clientIds: [CLIENT] },
      [master, copy],
      [assignment],
    );
    const segment = { match: 'all', rules: [{ field: 'program', op: 'in', values: [MASTER] }] };
    const options = await svc.segmentOptions(HEAD);
    expect(options.programs.map((p) => p.id)).toContain(MASTER);
    const preview = await svc.preview(HEAD, segment);
    expect(preview.recipient_count).toBe(1);
    expect(preview.sample.map((p) => p.id)).toEqual([CLIENT]);
    await expect(
      svc.create(HEAD, { body: 'New block starts Monday.', segment, timezone: 'UTC' }, undefined),
    ).resolves.toMatchObject({ status: 'scheduled' });
  });

  it('B-728-1: the normal sub-coach audience picker returns only own or tenant-shared program names', async () => {
    const common = { coach_id: HEAD, is_template: true, archived_at: null };
    const { svc } = service(
      { actorId: SUB, tenantId: HEAD, clientIds: [CLIENT] },
      [
        { ...common, id: MASTER, owner_user_id: HEAD, visibility: 'owner_only', name: 'Private head-coach program' },
        { ...common, id: SIBLING_MASTER, owner_user_id: OTHER_SUB, visibility: 'owner_only', name: 'Private sibling program' },
        { ...common, id: OWN_MASTER, owner_user_id: SUB, visibility: 'owner_only', name: 'My program' },
        { ...common, id: SHARED_MASTER, owner_user_id: HEAD, visibility: 'tenant_shared', name: 'Shared program' },
      ],
    );
    const options = await svc.segmentOptions(SUB);
    expect(options.programs.map((p) => p.id).sort()).toEqual([OWN_MASTER, SHARED_MASTER].sort());
    expect(JSON.stringify(options)).not.toContain('Private head-coach program');
    expect(JSON.stringify(options)).not.toContain('Private sibling program');
  });
});
