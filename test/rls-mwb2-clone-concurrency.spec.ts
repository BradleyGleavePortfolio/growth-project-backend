/**
 * MWB-2 (§3.3, audit G9) — REAL concurrency control for cloneProgramToClient.
 *
 * This is the integration-lane proof the audit demanded: it fires TWO real
 * `WorkoutBuilderService.cloneProgramToClient` calls in parallel via
 * `Promise.all` against a LIVE Postgres (no mocked transaction, no injected
 * P2034) and asserts the operator-stated bar:
 *
 *   - exactly ONE call commits a new clone program,
 *   - the OTHER rejects with a TYPED `ConflictException` (the loser path), and
 *   - querying `WorkoutProgram` by (cloned_from_id, owner_user_id) returns
 *     EXACTLY ONE clone row — never a silent double-create.
 *
 * The guarantee comes from the in-transaction `pg_advisory_xact_lock`
 * (keyed on (masterProgramId, clientId)) acquired as the first DB op, followed
 * by an existing-clone probe: the lock serialises the two transactions, the
 * winner commits, and the loser \u2014 unblocked only after the winner commits \u2014
 * observes the existing clone and throws `ConflictException`. A racing P2002 is
 * also coerced to the same typed conflict.
 *
 * Live-DB gating (mirrors the repo's community / RLS live-suite pattern, R66):
 * this suite is matched by `jest.rls.config.js` (test/rls-*.spec.ts) and runs
 * ONLY in the `rls-live-tests` CI job, which provisions a postgres service.
 * It connects when `MWB2_CLONE_TEST_DATABASE_URL` (or `DATABASE_URL`) is set;
 * otherwise it `describe.skip`s with a logged reason \u2014 never a silent pass.
 * The full schema is materialised in beforeAll via
 * `test/utils/bootstrap-test-schema.ts`, which applies the canonical DDL Prisma
 * generates from prisma/schema.prisma (so every model is byte-faithful to the
 * generated client, including all User columns), so the test exercises the real
 * WorkoutProgram / WorkoutProgramRevision tables, not a hand-rolled subset.
 *
 * To run locally:
 *   1. docker run -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
 *   2. MWB2_CLONE_TEST_DATABASE_URL=postgresql://postgres:pw@localhost:55432/postgres \
 *        npx jest --config jest.rls.config.js test/rls-mwb2-clone-concurrency --runInBand
 */

import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';

// A DEDICATED env var (never the app's DATABASE_URL) — beforeAll runs
// `prisma db push --accept-data-loss`, which would wipe a real DB. Requiring an
// explicit throwaway URL makes that impossible by accident.
const RAW_TEST_DB_URL = process.env.MWB2_CLONE_TEST_DATABASE_URL || '';

// Pin the Prisma connection pool to >= 2 connections so the two parallel
// clones run on SEPARATE pooled connections — i.e. genuine DB-level
// concurrency. With a single pooled connection the pool (not the advisory
// lock) serialises the transactions, so the loser would hit the existence
// probe instead of a real Serializable write-conflict; that bypasses the
// concurrency-control mechanism entirely and proves nothing. At >= 2 the loser
// aborts with a serialization failure (Postgres 40001 -> Prisma P2034) which
// the service must coerce to a typed ConflictException. We force 5 to keep a
// comfortable margin; any pre-existing connection_limit in the URL is replaced.
function pinMultiConnection(url: string): string {
  if (!url) return url;
  const MIN_POOL = 5;
  // Read any existing connection_limit WITHOUT mutating the rest of the URL:
  // URLSearchParams.toString() percent-encodes reserved characters, which
  // corrupts a Postgres unix-socket URL (e.g. `?host=/tmp` -> `host=%2Ftmp`).
  // So we inspect with a regex and append/replace only the one param, leaving
  // every other byte of the operator-supplied URL untouched.
  const existing = /[?&]connection_limit=(\d+)/.exec(url);
  const current = existing ? Number(existing[1]) : NaN;
  if (Number.isInteger(current) && current >= 2) {
    return url;
  }
  if (existing) {
    // Bump an explicit-but-too-low value (e.g. connection_limit=1) up to MIN.
    return url.replace(
      /([?&]connection_limit=)\d+/,
      `$1${MIN_POOL}`,
    );
  }
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}connection_limit=${MIN_POOL}`;
}

const TEST_DB_URL = pinMultiConnection(RAW_TEST_DB_URL);

const liveDescribe = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[mwb2-clone-concurrency] MWB2_CLONE_TEST_DATABASE_URL not set — live ' +
      'concurrency suite skipped (point it at a throwaway Postgres to run).',
  );
}

const COACH_ID = 'mwb2-coach-1';
const CLIENT_ID = 'mwb2-client-1';
const MASTER_ID = 'mwb2-master-1';

liveDescribe('cloneProgramToClient — real concurrent clones (MWB-2 §3.3, G9)', () => {
  let prisma: PrismaClient;
  let service: WorkoutBuilderService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();

    // Materialise the FULL schema exactly as `prisma db push` would, generated
    // by Prisma from prisma/schema.prisma, so every model (and every User
    // column the generated client serialises — e.g. show_on_leaderboard) is
    // byte-faithful to the client. See test/utils/bootstrap-test-schema.ts for
    // the Option-A rationale and the single tolerated pre-existing community
    // uuid<->text FK mismatch (out of PR scope, never on the clone path).
    await bootstrapTestSchema(prisma);

    service = new WorkoutBuilderService(prisma as unknown as PrismaService);
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    process.env.FEATURE_MWB_TEMPLATES = 'true';
    // Clean slate. Children first (FK order).
    await prisma.workoutProgramRevision.deleteMany({});
    await prisma.workoutPlanRevision.deleteMany({});
    await prisma.workoutPlanExercise.deleteMany({});
    await prisma.workoutPlan.deleteMany({});
    await prisma.workoutProgram.deleteMany({});
    await prisma.user.deleteMany({
      where: { id: { in: [COACH_ID, CLIENT_ID] } },
    });

    // Head coach + their client (client.coach_id = coach => in scope).
    await prisma.user.create({
      data: {
        id: COACH_ID,
        supabase_id: `sb-${COACH_ID}`,
        email: `${COACH_ID}@example.test`,
        name: 'MWB2 Coach',
        role: 'coach',
      },
    });
    await prisma.user.create({
      data: {
        id: CLIENT_ID,
        supabase_id: `sb-${CLIENT_ID}`,
        email: `${CLIENT_ID}@example.test`,
        name: 'MWB2 Client',
        role: 'student',
        coach_id: COACH_ID,
      },
    });

    // Master template program owned by the coach, with one plan day.
    await prisma.workoutProgram.create({
      data: {
        id: MASTER_ID,
        coach_id: COACH_ID,
        owner_user_id: COACH_ID,
        visibility: 'owner_only',
        name: 'Hypertrophy Master',
        description: '12-week build',
        weeks: 12,
        days_per_week: 4,
        is_template: true,
        goal_tag: 'hypertrophy',
      },
    });
    await prisma.workoutPlan.create({
      data: {
        coach_id: COACH_ID,
        name: 'Day 1 — Push',
        type: 'strength',
        program_id: MASTER_ID,
        week_index: 0,
        day_index: 0,
        is_template: true,
      },
    });
  });

  it('two parallel clones: exactly one commit + one typed ConflictException, one row total', async () => {
    const settle = (p: Promise<unknown>) =>
      p.then(
        (r) => ({ ok: true as const, r }),
        (e) => ({ ok: false as const, e }),
      );

    const [a, b] = await Promise.all([
      settle(service.cloneProgramToClient(MASTER_ID, CLIENT_ID, COACH_ID)),
      settle(service.cloneProgramToClient(MASTER_ID, CLIENT_ID, COACH_ID)),
    ]);

    const outcomes = [a, b];
    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);

    // Exactly one commit, exactly one rejection.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The loser is a TYPED ConflictException (409), never a leaked Prisma error.
    const loser = losers[0];
    expect(loser.ok).toBe(false);
    if (!loser.ok) {
      expect(loser.e).toBeInstanceOf(ConflictException);
    }

    // The DB holds EXACTLY ONE clone of this master for this coach — no silent
    // double-create. (WorkoutProgram has no client_id column on main; the clone
    // is keyed on (cloned_from_id, owner_user_id) and the advisory lock is keyed
    // on (master, client), so the double-tap collapses to one row.)
    const clones = await prisma.workoutProgram.findMany({
      where: {
        cloned_from_id: MASTER_ID,
        owner_user_id: COACH_ID,
        is_template: false,
        archived_at: null,
      },
    });
    expect(clones).toHaveLength(1);

    // The single surviving clone is a real, non-template program with its own
    // fresh head revision (Decision A v1 anchor).
    expect(clones[0].is_template).toBe(false);
    expect(clones[0].head_revision_id).toBeTruthy();
    const revisions = await prisma.workoutProgramRevision.findMany({
      where: { program_id: clones[0].id },
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revision_index).toBe(0);
    expect(revisions[0].cause).toBe('clone');
  }, 60_000);
});
