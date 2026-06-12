/**
 * v3-1 R2 — REAL repository-level completion concurrency spec (Finding 1).
 *
 * The service-level concurrency test in community-challenges.service.spec.ts
 * mocks the repository, so it pins the service contract but cannot prove the
 * raw SQL is race-safe. This spec exercises the ACTUAL
 * CommunityChallengesRepository.applyProgressAtomically SQL against a live
 * Postgres: it seeds one participation row just below target, then fires two
 * target-reaching writes concurrently through Promise.all and asserts that
 * EXACTLY ONE reports completionTransitioned === true. That is the property the
 * milestone push depends on (community-challenges.service.ts) — the completion
 * claim is a single conditional UPDATE whose WHERE clause only the first writer
 * can satisfy, so the loser matches zero rows and reports false.
 *
 * GATE INTENT (R66/R69): env-gated on COMMUNITY_TEST_DATABASE_URL, mirroring the
 * other test/community/** live suites. Unset → the whole block is describe.skip
 * with a logged reason (never a silent pass). It applies the existing v1-1
 * community migration via the shared harness and introduces NO schema.
 *
 * To run locally (see test/community/_support/community-db.ts header):
 *   1. docker run -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16
 *   2. npm i -D pg
 *   3. COMMUNITY_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres \
 *        npx jest test/community/challenges/community-challenges-progress.live.spec.ts --runInBand
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../src/prisma.service';
import { CommunityChallengesRepository } from '../../../src/community/challenges/community-challenges.repository';
import {
  liveDbUrl,
  connect,
  applyMigration,
  migrationDown,
  type LiveClient,
} from '../_support/community-db';

const describeLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-challenges-progress] COMMUNITY_TEST_DATABASE_URL not set — live concurrency spec skipped.',
  );
}

describeLive('community v3-1 challenge progress — completion exactly-once (live DB)', () => {
  let admin: LiveClient;
  let prisma: PrismaService;
  let repo: CommunityChallengesRepository;

  // Seeded each test so the race always starts from a clean, just-below-target row.
  let workspaceId: string;
  let challengeId: string;
  let userId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = liveDbUrl() as string;

    const client = await connect(liveDbUrl() as string);
    if (!client) {
      // connect() already logged the missing optional `pg` driver.
      return;
    }
    admin = client;
    await applyMigration(admin);

    prisma = new PrismaService();
    await prisma.$connect();
    repo = new CommunityChallengesRepository(prisma);
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (admin) {
      await migrationDown(admin);
      await admin.end();
    }
  });

  // Seed a fresh workspace / challenge / participation just below a target of
  // 100, with completed_at NULL, before each race.
  async function seed(): Promise<void> {
    workspaceId = randomUUID();
    challengeId = randomUUID();
    userId = randomUUID();
    const now = new Date().toISOString();

    await admin.query('INSERT INTO "User" ("id") VALUES ($1)', [userId]);
    await admin.query(
      `INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [workspaceId, userId, 'WS', `ws-${workspaceId.slice(0, 8)}`, now],
    );
    await admin.query(
      `INSERT INTO "community_challenges"
         ("id", "workspace_id", "cohort_id", "created_by_id", "title", "status",
          "target_value", "leaderboard_enabled", "created_at", "updated_at")
       VALUES ($1, $2, NULL, $3, $4, 'active', 100, false, $5, $5)`,
      [challengeId, workspaceId, userId, 'Race Challenge', now],
    );
    await admin.query(
      `INSERT INTO "community_challenge_participations"
         ("id", "workspace_id", "challenge_id", "user_id", "progress_value",
          "completed_at", "last_logged_at", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, 90, NULL, NULL, $5, $5)`,
      [randomUUID(), workspaceId, challengeId, userId, now],
    );
  }

  it('two concurrent target-reaching writes transition completion exactly once', async () => {
    if (!repo) {
      // pg driver not installed — connect() returned null and logged a reason.
      return;
    }
    await seed();

    const now = new Date();
    const target = new Prisma.Decimal(100);

    // Both writers push the row over the target at the same time.
    const [a, b] = await Promise.all([
      repo.applyProgressAtomically({
        challengeId,
        userId,
        incoming: new Prisma.Decimal(120),
        target,
        now,
      }),
      repo.applyProgressAtomically({
        challengeId,
        userId,
        incoming: new Prisma.Decimal(110),
        target,
        now,
      }),
    ]);

    // EXACTLY ONE writer claimed the completion transition.
    const transitions = [a, b].filter((r) => r.completionTransitioned).length;
    expect(transitions).toBe(1);

    // Both reads observe the monotonic value and a single, persisted completion.
    expect(a.participation.progress_value.toNumber()).toBeGreaterThanOrEqual(120);
    expect(b.participation.progress_value.toNumber()).toBeGreaterThanOrEqual(120);

    const rows = await admin.query(
      'SELECT progress_value, completed_at FROM "community_challenge_participations" WHERE challenge_id = $1 AND user_id = $2',
      [challengeId, userId],
    );
    expect(rows.rowCount).toBe(1);
    const stored = rows.rows[0] as {
      progress_value: string;
      completed_at: Date | null;
    };
    expect(Number(stored.progress_value)).toBe(120);
    expect(stored.completed_at).not.toBeNull();
  });

  it('a later write on an already-completed row does NOT re-transition', async () => {
    if (!repo) return;
    await seed();
    const target = new Prisma.Decimal(100);

    // First write completes the row.
    const first = await repo.applyProgressAtomically({
      challengeId,
      userId,
      incoming: new Prisma.Decimal(100),
      target,
      now: new Date(),
    });
    expect(first.completionTransitioned).toBe(true);

    // A subsequent higher log advances progress but must not re-fire completion.
    const second = await repo.applyProgressAtomically({
      challengeId,
      userId,
      incoming: new Prisma.Decimal(150),
      target,
      now: new Date(),
    });
    expect(second.completionTransitioned).toBe(false);
    expect(second.participation.progress_value.toNumber()).toBe(150);
    expect(second.participation.completed_at).not.toBeNull();
  });
});
