/**
 * v2-1 plan-context tags — Row-Level Security regression.
 *
 * The v2-1 slice adds NO new table and NO new RLS policy: the typed plan-
 * context tag is persisted in the existing `community_messages.plan_context_payload`
 * JsonB column (added by migration 20261216000100_add_plan_context_payload),
 * and the tag's authorization gate ("a coach may only tag a plan item they
 * own") is enforced at the APPLICATION layer in PlanContextService — the app
 * connects as the Supabase service_role (BYPASSRLS), mirroring the established
 * community doctrine (see test/rls/community-coach-rls.spec.ts).
 *
 * This suite proves the gate two ways:
 *
 *  1. STATIC assertions (always run): the underlying entity tables the resolver
 *     reads (WorkoutPlan, CoachPackage, CheckIn, community_messages) carry the
 *     coach-ownership / server-only RLS the application gate is defence-in-depth
 *     for. A non-service-role connection (Supabase authenticated/anon) cannot
 *     reach another coach's plan item even if the app gate were bypassed.
 *  2. LIVE assertions (run only when COMMUNITY_TEST_DATABASE_URL + `pg` are
 *     available): the real PlanContextService, against a real Postgres, refuses
 *     to validate a foreign-coach workout_plan_id (403) and refuses to resolve
 *     it (404, existence non-leak), while accepting the owning coach's own plan.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
// Type-only imports: erased at compile time, so they do not defeat the lazy
// require() of these modules inside the live block (which keeps the static
// layer free of every DB/Prisma-engine dependency).
import type { PrismaService } from '../../src/prisma.service';
import type { PlanContextService } from '../../src/community/plan-context/plan-context.service';
import { liveDbUrl } from '../community/_support/community-db';

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

function readMigration(dir: string, file = 'migration.sql'): string {
  return readFileSync(join(MIGRATIONS, dir, file), 'utf8');
}

// ── Layer 1: static policy-coverage assertions (always run) ────────────────

describe('v2-1 plan-context RLS — static policy coverage (no new migration)', () => {
  it('the v2-1 column is an additive JsonB on community_messages (no policy churn)', () => {
    const sql = readMigration('20261216000100_add_plan_context_payload');
    expect(sql).toContain(
      'ALTER TABLE "community_messages" ADD COLUMN     "plan_context_payload" JSONB',
    );
    // Additive only: the migration adds a nullable column and touches nothing
    // else — no DROP, no policy, no index churn.
    expect(sql).not.toMatch(/CREATE POLICY|DROP POLICY|DROP COLUMN/);
  });

  it('WorkoutPlan carries a coach-owner FOR ALL policy backing the ownership gate', () => {
    const sql = readMigration('20260508000001_rls_workout_builder');
    const idx = sql.indexOf('CREATE POLICY "WorkoutPlan_coach_owner"');
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    expect(stmt).toContain('ON "WorkoutPlan"');
    expect(stmt).toContain('FOR ALL');
    // Ownership keys off coach_id resolved from the authenticated user.
    expect(stmt).toContain('"coach_id" =');
    expect(stmt).toContain('USING');
    expect(stmt).toContain('WITH CHECK');
  });

  it('CoachPackage is server-only (the resolver is the sole reader path)', () => {
    const sql = readMigration('20260618000000_add_rls_payment_revenue_tables');
    const idx = sql.indexOf('CREATE POLICY "CoachPackage_server_only"');
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    expect(stmt).toContain('ON "CoachPackage"');
    expect(stmt).toContain('USING (false)');
  });

  it('CheckIn carries a coach-scoped SELECT policy keyed on coach_id = current user', () => {
    const sql = readMigration('20260607000000_rls_remaining_gaps');
    const idx = sql.indexOf('CREATE POLICY "check_in_coach_select"');
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    expect(stmt).toContain('ON "CheckIn"');
    expect(stmt).toContain('FOR SELECT');
    expect(stmt).toContain('"coach_id" = app.current_user_id()');
  });

  it('community_messages RLS is ENABLED + FORCED and the author-insert policy stands', () => {
    const sql = readMigration('20261212000000_community_v1_1_schema');
    expect(sql).toContain(
      'ALTER TABLE "community_messages"                  ENABLE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'ALTER TABLE "community_messages"                  FORCE ROW LEVEL SECURITY;',
    );
    const idx = sql.indexOf(
      'CREATE POLICY "community_messages_author_insert"',
    );
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    // The insert (which now carries plan_context_payload) is still bounded to
    // the authoring sender within their own workspace/cohort/DM — adding the
    // JsonB column does not widen who may write a message row.
    expect(stmt).toContain('"sender_id"::text = app.current_user_id()');
    expect(stmt).toContain('app.is_community_workspace_coach("workspace_id")');
  });
});

// ── Layer 2: live application-layer ownership gate (gated on a real DB) ─────

const liveDescribe = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-plan-context-rls] COMMUNITY_TEST_DATABASE_URL not set — live ownership-gate layer skipped.',
  );
}

liveDescribe('v2-1 plan-context — live application-layer ownership gate', () => {
  // Imported lazily so the static layer above never requires a DB or the
  // Prisma engine to be reachable.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaService } = require('../../src/prisma.service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    PlanContextService,
  } = require('../../src/community/plan-context/plan-context.service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    PlanContextRepository,
  } = require('../../src/community/plan-context/plan-context.repository');
  const { randomUUID } = require('crypto') as typeof import('crypto');

  let prisma: PrismaService;
  let service: PlanContextService;
  const ids = { coachA: '', coachB: '', planA: '', planB: '' };

  const coachA = (): User =>
    ({ id: ids.coachA, role: 'coach' } as unknown as User);

  beforeAll(async () => {
    process.env.DATABASE_URL = liveDbUrl() as string;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new PlanContextService(new PlanContextRepository(prisma));

    ids.coachA = randomUUID();
    ids.coachB = randomUUID();
    for (const [id, name] of [
      [ids.coachA, 'RLS Coach A'],
      [ids.coachB, 'RLS Coach B'],
    ]) {
      await prisma.$executeRaw`
        INSERT INTO "User" (id, role, name) VALUES (${id}, 'coach'::"Role", ${name})
      `;
    }
    const planA = await prisma.workoutPlan.create({
      data: { coach_id: ids.coachA, name: 'Owned Plan', type: 'strength' },
    });
    ids.planA = planA.id;
    const planB = await prisma.workoutPlan.create({
      data: { coach_id: ids.coachB, name: 'Foreign Plan', type: 'cardio' },
    });
    ids.planB = planB.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.workoutPlan.deleteMany({
      where: { id: { in: [ids.planA, ids.planB].filter(Boolean) } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [ids.coachA, ids.coachB].filter(Boolean) } },
    });
    await prisma.$disconnect();
  });

  it('validate() accepts the owning coach own plan', async () => {
    await expect(
      service.validate(coachA(), {
        type: 'workout',
        workout_plan_id: ids.planA,
      }),
    ).resolves.toMatchObject({ workout_plan_id: ids.planA });
  });

  it('validate() rejects a foreign-coach workout_plan_id with 403', async () => {
    await expect(
      service.validate(coachA(), {
        type: 'workout',
        workout_plan_id: ids.planB,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('resolve() 404s a foreign-coach workout_plan_id (existence non-leak)', async () => {
    await expect(
      service.resolve(coachA(), { type: 'workout', id: ids.planB }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
