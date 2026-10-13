/**
 * HIST3 (owner 4b, 139-13): the row layer under workout adjustment history,
 * on the replayed migration chain. A direct table read as the API role
 * `authenticated`, with app.current_user_id naming one person, after coach
 * A's client X moves to coach B: A reads none of X's proposals or their
 * events (20270417000000), A still reads the proposal of Y, who stayed, and
 * neither the new coach, the client nor an unrelated coach reads any. The
 * author reads X's proposal before the move (the control), so a zero after it
 * means the policy refused the row, not that it is missing.
 * The service read of the same rows: test/roman/roman-history-follows-client.live.spec.ts.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('adjustment-former-coach-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('HIST3 row layer: a former coach reads none of a moved client\'s adjustments', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  // Fictional people, fresh ids per run: coaches A, B, C; X moves A -> B, Y stays with A.
  const [a, b, c, x, y] = Array.from({ length: 5 }, () => randomUUID());
  const rows: Record<'x' | 'y', { proposal: string; event: string }> = {
    x: { proposal: '', event: '' },
    y: { proposal: '', event: '' },
  };

  /** Rows with this id in `table` that `who` sees as the API role `authenticated`. */
  const seen = (table: string, rowId: string, who: string, role = 'coach'): Promise<number> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role);
      const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1`,
        rowId,
      );
      return n;
    });
  const both = async (k: 'x' | 'y', who: string, role = 'coach') => [
    await seen('WorkoutAdjustmentProposal', rows[k].proposal, who, role),
    await seen('WorkoutAdjustmentEvent', rows[k].event, who, role),
  ];

  beforeAll(async () => {
    for (const [id, role, coach_id] of [
      [a, 'coach', null], [b, 'coach', null], [c, 'coach', null], [x, 'student', a], [y, 'student', a],
    ] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
    }
    const plan = await prisma.workoutPlan.create({ data: { coach_id: a, name: 'RLS plan', type: 'strength' } });
    for (const [k, client] of [['x', x], ['y', y]] as const) {
      const assignment = await prisma.clientWorkoutAssignment.create({
        data: { workout_plan_id: plan.id, client_id: client, assigned_by_coach_id: a, scheduled_for: new Date() },
      });
      const proposal = await prisma.workoutAdjustmentProposal.create({
        data: {
          coach_id: a, client_id: client, assignment_id: assignment.id, rule_key: 'high_rpe', rule_version: 1,
          status: 'approved', severity: 'medium', signals: {}, proposed_change: {}, base_fingerprint: 'fp',
          roman_text: 'RLS text', decided_at: new Date(),
        },
      });
      const event = await prisma.workoutAdjustmentEvent.create({
        data: { proposal_id: proposal.id, actor_id: a, action: 'approved' },
      });
      rows[k] = { proposal: proposal.id, event: event.id };
    }
  });
  afterAll(() => prisma.$disconnect());

  it("before the move: the author reads X's proposal and event; an unrelated coach reads neither", async () => {
    expect(await both('x', a)).toEqual([1, 1]);
    expect(await both('x', c)).toEqual([0, 0]);
  });

  describe("after X moves from coach A to coach B", () => {
    beforeAll(() => prisma.user.update({ where: { id: x }, data: { coach_id: b } }));

    it("the former coach reads none of X's proposal or its events", async () => {
      expect(await both('x', a)).toEqual([0, 0]);
    });

    it('the same coach still reads the proposal and events of Y, who stayed', async () => {
      expect(await both('y', a)).toEqual([1, 1]);
    });

    it('the new coach, the client and an unrelated coach read none (no branch is added)', async () => {
      expect(await both('x', b)).toEqual([0, 0]);
      expect(await both('x', x, 'student')).toEqual([0, 0]);
      expect(await both('x', c)).toEqual([0, 0]);
      expect(await both('y', c)).toEqual([0, 0]);
    });
  });
});
