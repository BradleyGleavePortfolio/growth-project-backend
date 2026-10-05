import { BroadcastHttpError } from '../../src/broadcasts/broadcast-errors';
import type { CoachScope } from '../../src/broadcasts/broadcast-scope.service';
import { SegmentResolverService } from '../../src/broadcasts/segment-resolver.service';
import type { Segment } from '../../src/broadcasts/segment';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from './_stub';

/** Applies the Prisma where shapes the resolver uses to plain rows. */
type Row = Record<string, unknown>;
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
    if (want && typeof want === 'object') {
      const f = want as Row;
      if ('in' in f) return (f.in as unknown[]).includes(row[key]);
      const child = row[key];
      return !!child && typeof child === 'object' && matches(child as Row, f);
    }
    return row[key] === want;
  });
}

const HEAD = 'head-1';
const SUB = 'sub-1';
const program = (id: string, extra: Row = {}): Row => ({
  id,
  coach_id: HEAD,
  owner_user_id: HEAD,
  visibility: 'owner_only',
  is_template: true,
  archived_at: null,
  cloned_from_id: null,
  ...extra,
});
const PROGRAMS: Row[] = [
  program('master'),
  program('copy-c1', { is_template: false, cloned_from_id: 'master' }),
  program('copy-c2', { is_template: false, cloned_from_id: 'master', archived_at: new Date() }),
  program('shared', { visibility: 'tenant_shared' }),
  program('mine', { owner_user_id: SUB }),
  program('sibling', { owner_user_id: 'sub-2' }),
];
const byId = new Map(PROGRAMS.map((p) => [p.id as string, p]));
const day = (programId: string): Row => ({ program_id: programId, program: byId.get(programId) });
const ASSIGNMENTS: Row[] = [
  { client_id: 'c1', workout_plan: day('copy-c1') },
  { client_id: 'c2', workout_plan: day('copy-c2') },
];

function resolver() {
  const where = (a: { where: Row }) => a.where;
  return new SegmentResolverService(
    stub<PrismaService>({
      workoutProgram: {
        count: async (a: { where: Row }) => PROGRAMS.filter((p) => matches(p, where(a))).length,
      },
      clientWorkoutAssignment: {
        findMany: async (a: { where: Row }) =>
          ASSIGNMENTS.filter((r) => matches(r, where(a))).map((r) => ({ client_id: r.client_id })),
      },
      userBlock: { findMany: async () => [] },
    }),
  );
}
const segment = (values: string[]): Segment => ({
  match: 'all',
  rules: [{ field: 'program', op: 'in', values }],
  exclude_client_ids: [],
});
async function code(p: Promise<unknown>) {
  return p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof BroadcastHttpError ? e.code : String(e)),
  );
}

describe('SegmentResolverService program rule', () => {
  const head: CoachScope = { actorId: HEAD, tenantId: HEAD, clientIds: ['c1', 'c2', 'c3'] };

  it('B-727-1: a master reaches the clients holding a live copy of it, not an archived copy', async () => {
    const aud = await resolver().resolve(head, segment(['master']));
    expect(aud.recipientIds).toEqual(['c1']);
  });

  it('B-728-1: a sub-coach can target only their own or team-shared masters', async () => {
    const sub: CoachScope = { actorId: SUB, tenantId: HEAD, clientIds: ['c1'] };
    expect(await code(resolver().resolve(sub, segment(['mine', 'shared'])))).toBe('resolved');
    for (const id of ['master', 'sibling', 'copy-c1']) {
      expect(await code(resolver().resolve(sub, segment([id])))).toBe(
        'broadcast.segment_ref_not_found',
      );
    }
  });
});
