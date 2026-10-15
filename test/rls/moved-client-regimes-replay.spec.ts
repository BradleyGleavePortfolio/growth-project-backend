/**
 * HIST2A-2 (owner 4, 139-13): once a client moves to another coach, the former
 * coach cannot reach the client's program copy through named regimes (promote,
 * list, revisions, rename, archive) or by repeating a saved request with the
 * same idempotency key. Each call first succeeds before the move (the control),
 * then is the existing not-found with no write. Masters, a staying client's
 * copy and the new coach's own work, replays included, go on as before.
 * Real services on the superuser connection (service_role, as the API runs),
 * so the service rule is what decides, not row security.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../src/prisma.service';
import {
  RegimeRevisionRetentionService,
} from '../../src/regimes/regime-revision-retention.service';
import { RegimesService } from '../../src/regimes/regimes.service';
import { WorkoutBuilderService } from '../../src/workout-builder/workout-builder.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('moved-client-regimes-replay: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)("A moved client's copy leaves regimes and replays", () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const retention = new RegimeRevisionRetentionService(prisma);
  const regimes = new RegimesService(prisma, retention);
  const builder = new WorkoutBuilderService(prisma);
  // Fictional people, fresh ids per run. Coaches a and b. c: a's client who
  // moves to b. d: a's client who stays.
  const [a, b, c, d] = Array.from({ length: 4 }, () => randomUUID());
  const ids: Record<string, string> = {};
  const key: Record<string, string> = {};
  const first: Record<string, unknown> = {};
  /** The existing not-found of that endpoint. */
  const notFound = async (call: Promise<unknown>, message: string) => {
    await expect(call).rejects.toBeInstanceOf(NotFoundException);
    await expect(call).rejects.toThrow(message);
  };
  /** Every row these calls could write, the idempotency ledger included. */
  const rows = async () => [
    await prisma.workoutProgramRevision.count(),
    await prisma.workoutPlanExercise.count(),
    await prisma.workoutPlanRevision.count(),
    await prisma.clientWorkoutAssignment.count(),
    await prisma.workoutBuilderIdempotencyKey.count(),
  ];
  /** A program of `coach` with one day; a client copy when `client` is given. */
  const program = async (name: string, coach: string, client?: string) => {
    const kind = { coach_id: coach, is_template: !client };
    const shape = { name: 'Block', weeks: 1, days_per_week: 1 };
    const p = await prisma.workoutProgram.create({
      data: { ...kind, ...shape, owner_user_id: coach, client_id: client },
    });
    const day = { ...kind, name: 'Day 1', type: 'strength' as const, week_index: 0, day_index: 0 };
    ids[name] = p.id;
    const plan = await prisma.workoutPlan.create({ data: { ...day, program_id: p.id } });
    ids[`${name}Day`] = plan.id;
  };
  const listed = async (coach: string) => (await regimes.listRegimes(coach)).map((r) => r.id);
  const json = (body: unknown) => JSON.parse(JSON.stringify(body));
  const sets = [{ exercise_external_id: 'ex-1', order: 1, sets: 3, reps_or_duration_seconds: 10 }];
  const exercises = [{ ...sets[0], weight_lbs: 135, notes: 'Slow lowering' }];
  const at = { scheduled_for: '2027-06-07T09:00:00Z' };
  const start = { start_date: '2027-06-07' };
  /** Each saved request, always sent with its own fixed key. */
  const saves: Record<string, () => Promise<unknown>> = {
    copyDay: () => builder.setExercises(a, ids.copyDay, exercises, key.copyDay),
    copyAssign: () => builder.assignPlan(a, ids.copyDay, { client_id: c, ...at }, key.copyAssign),
    copyProgram: () =>
      builder.assignProgramToClient(a, ids.copy, { client_id: c, ...start }, key.copyProgram),
    libraryDay: () => builder.setExercises(a, ids.libraryDay, exercises, key.libraryDay),
  };
  // Sol B3 at 16faf200: each assignment route that caches a client's rows,
  // on A's own library source, so only the replay's cached-client check decides.
  const push = { createNotification: jest.fn(async () => undefined), sendPush: jest.fn() };
  const pushing = new WorkoutBuilderService(prisma, undefined, undefined, push as never);
  const assigns: Array<[string, (client_id: string, k: string) => Promise<unknown>]> = [
    ['assignPlan', (client_id, k) => pushing.assignPlan(a, ids.sourceDay, { client_id, ...at }, k)],
    [
      'assignProgramToClient',
      (client_id, k) => pushing.assignProgramToClient(a, ids.source, { client_id, ...start }, k),
    ],
  ];

  beforeAll(async () => {
    const people: Array<[string, 'coach' | 'student', string | null]> = [
      [a, 'coach', null],
      [b, 'coach', null],
      [c, 'student', a],
      [d, 'student', a],
    ];
    for (const [id, role, coach_id] of people) {
      const email = `hist2a2-${id}`;
      await prisma.user.create({
        data: { id, supabase_id: id, email, name: 'Live person', role, coach_id },
      });
    }
    await program('library', a);
    await program('copy', a, c);
    await program('archiveControl', a, c);
    await program('stayCopy', a, d);
    await program('libraryB', b);
    await program('source', a);
    for (const name of Object.keys(saves)) key[name] = randomUUID();
    process.env.FEATURE_MWB_TEMPLATES = 'true';
  });
  afterAll(() => prisma.$disconnect());

  it("before the move: regimes and saved replays reach the client's copy", async () => {
    expect((await regimes.promoteFromProgram(a, ids.copy, 'Copy regime')).id).toBe(ids.copy);
    await regimes.promoteFromProgram(a, ids.library, 'Library regime');
    expect(await listed(a)).toEqual(expect.arrayContaining([ids.copy, ids.library]));
    await regimes.updateRegime(a, ids.copy, 'Copy regime 2');
    expect(await regimes.getRegimeRevisions(a, ids.copy)).toHaveLength(1);
    await regimes.promoteFromProgram(a, ids.archiveControl);
    expect((await regimes.archiveRegime(a, ids.archiveControl)).archived_at).toBeInstanceOf(Date);

    for (const [name, save] of Object.entries(saves)) first[name] = json(await save());
    const ledger = { user_id: a, status: 'completed' };
    expect(await prisma.workoutBuilderIdempotencyKey.count({ where: ledger })).toBe(4);
    const before = await rows();
    // Same key, same body, no second write.
    for (const [name, save] of Object.entries(saves)) {
      expect(json(await save())).toEqual(first[name]);
    }
    expect(await rows()).toEqual(before);
  });

  it('after the move: each is not found or left out, with nothing written', async () => {
    await prisma.user.update({ where: { id: c }, data: { coach_id: b } });
    const copy = await prisma.workoutProgram.findUniqueOrThrow({ where: { id: ids.copy } });
    const before = await rows();

    await notFound(regimes.promoteFromProgram(a, ids.copy, 'Taken'), 'Program not found');
    expect(await listed(a)).toEqual([ids.library]);
    await notFound(regimes.getRegimeRevisions(a, ids.copy), 'Regime not found');
    await notFound(regimes.updateRegime(a, ids.copy, 'Renamed'), 'Regime not found');
    await notFound(regimes.archiveRegime(a, ids.copy), 'Regime not found');

    await notFound(saves.copyDay(), 'Workout plan not found');
    await notFound(saves.copyAssign(), 'Workout plan not found');
    await notFound(saves.copyProgram(), 'Program not found');
    // The former coach's own library day still replays its saved body.
    expect(json(await saves.libraryDay())).toEqual(first.libraryDay);

    const after = await prisma.workoutProgram.findUniqueOrThrow({ where: { id: ids.copy } });
    expect(after).toEqual(copy);
    expect(await rows()).toEqual(before);
  });

  it.each(assigns)(
    "%s: a moved client's cached assignment never replays, whatever client the retry names",
    async (_route, assign) => {
      const mover = randomUUID();
      const person = { supabase_id: mover, email: `hist2a2-${mover}`, name: 'Live person' };
      await prisma.user.create({ data: { id: mover, ...person, role: 'student', coach_id: a } });
      const [moverKey, stayKey] = [randomUUID(), randomUUID()];
      const [revs, exs, planRevs, assigned, ledger] = await rows();
      push.createNotification.mockClear();
      // Control: A assigns to the mover, and the same key replays the stored body.
      const stored = json(await assign(mover, moverKey));
      expect(json(await assign(mover, moverKey))).toEqual(stored);
      const filled = [revs, exs, planRevs, assigned + 1, ledger + 1];
      expect(await rows()).toEqual(filled);

      await prisma.user.update({ where: { id: mover }, data: { coach_id: b } });
      for (const client of [d, mover]) {
        const replay = assign(client, moverKey);
        await expect(replay).rejects.toBeInstanceOf(ForbiddenException);
        await expect(replay).rejects.toThrow('Client does not belong to this coach');
      }
      expect(await rows()).toEqual(filled);
      expect(push.createNotification).toHaveBeenCalledTimes(1);

      // A permitted replay (staying client d) returns the stored body; one write.
      const kept = json(await assign(d, stayKey));
      expect(json(await assign(d, stayKey))).toEqual(kept);
      expect(await rows()).toEqual([revs, exs, planRevs, assigned + 2, ledger + 2]);
      expect(push.createNotification).toHaveBeenCalledTimes(2);
    },
  );

  it("masters, a staying client's copy and the new coach go on as before", async () => {
    const renamed = await regimes.updateRegime(a, ids.library, 'Library 2');
    expect(renamed.regime_display_name).toBe('Library 2');
    expect(await regimes.getRegimeRevisions(a, ids.library)).toHaveLength(1);
    await regimes.promoteFromProgram(a, ids.stayCopy);
    expect(await listed(a)).toEqual(expect.arrayContaining([ids.library, ids.stayCopy]));
    expect((await regimes.archiveRegime(a, ids.library)).archived_at).toBeInstanceOf(Date);

    await regimes.promoteFromProgram(b, ids.libraryB, 'B regime');
    expect(await listed(b)).toEqual([ids.libraryB]);
    await regimes.updateRegime(b, ids.libraryB, 'B regime 2');
    expect(await regimes.getRegimeRevisions(b, ids.libraryB)).toHaveLength(1);

    // The new coach saves once and the same key replays: one write only.
    const before = await rows();
    const bKey = randomUUID();
    const saved = json(await builder.setExercises(b, ids.libraryBDay, sets, bKey));
    expect(json(await builder.setExercises(b, ids.libraryBDay, sets, bKey))).toEqual(saved);
    const [revs, exs, planRevs, assigned, ledger] = before;
    expect(await rows()).toEqual([revs, exs + 1, planRevs + 1, assigned, ledger + 1]);
    expect((await regimes.archiveRegime(b, ids.libraryB)).archived_at).toBeInstanceOf(Date);
  });
});
