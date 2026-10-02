// C07 — clinic program seed loader: production guard, idempotency, catalog check.
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';
import {
  assertSeedAllowed,
  isProductionTarget,
  seedClinicPrograms,
} from '../scripts/seed-clinic-programs';
import { parseFixture } from '../src/onboarding/clinic-programs';

const RAW = readFileSync(join(__dirname, '..', 'seed', 'clinic-programs.v1.json'), 'utf8');
const fx = parseFixture(RAW);

function asClient(m: object): PrismaClient {
  return m as PrismaClient;
}

type Row = Record<string, unknown>;

function fakeDb(opts: { missingSlug?: string } = {}) {
  let seq = 0;
  const sets: Row[] = [];
  const programs: Row[] = [];
  const cohorts: Row[] = [];
  const workspaces: Row[] = [];
  const db = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: Row }) =>
        where.email === 'owner@example.com' || where.id === 'coach-1'
          ? { id: 'coach-1', role: 'coach', coach_id: null }
          : null,
      ),
    },
    clinicProgramSet: {
      findUnique: jest.fn(
        async ({ where }: { where: { coach_id_fixture_version: Row } }) =>
          sets.find(
            (s) =>
              s.coach_id === where.coach_id_fixture_version.coach_id &&
              s.fixture_version === where.coach_id_fixture_version.fixture_version,
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: `set-${++seq}`, ...data };
        sets.push(row);
        return row;
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    exerciseCatalogItem: {
      findMany: jest.fn(async ({ where }: { where: { slug: { in: string[] } } }) =>
        where.slug.in.filter((s) => s !== opts.missingSlug).map((slug) => ({ slug })),
      ),
    },
    communityWorkspace: {
      findUnique: jest.fn(
        async ({ where }: { where: Row }) => workspaces.find((w) => w.slug === where.slug) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: `ws-${++seq}`, ...data };
        workspaces.push(row);
        return row;
      }),
    },
    communityCohort: {
      upsert: jest.fn(async ({ create }: { create: Row }) => {
        const ex = cohorts.find(
          (c) => c.workspace_id === create.workspace_id && c.name === create.name,
        );
        if (ex) return ex;
        const row = { id: `cohort-${++seq}`, ...create };
        cohorts.push(row);
        return row;
      }),
    },
    workoutProgram: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: `prog-${++seq}`, ...data };
        programs.push(row);
        return row;
      }),
      update: jest.fn(async () => ({})),
    },
    workoutPlan: {
      create: jest.fn(async ({ data }: { data: Row }) => ({ id: `plan-${++seq}`, ...data })),
      update: jest.fn(async () => ({})),
    },
    workoutPlanExercise: { createMany: jest.fn(async () => ({ count: 1 })) },
    workoutPlanRevision: { create: jest.fn(async () => ({ id: `rev-${++seq}` })) },
    workoutProgramRevision: { create: jest.fn(async () => ({ id: `grev-${++seq}` })) },
  };
  Object.assign(db, {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(db)),
  });
  return { db, sets, programs, cohorts, workspaces };
}

const base = {
  coachEmail: 'owner@example.com',
  spaceName: 'Clinic community',
  allMembersName: 'All members',
  dryRun: false,
};

describe('production guard', () => {
  it('detects production targets', () => {
    expect(isProductionTarget({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionTarget({ APP_ENV: 'production' })).toBe(true);
    expect(isProductionTarget({ CLINIC_SEED_TARGET: 'production' })).toBe(true);
    expect(isProductionTarget({ NODE_ENV: 'development' })).toBe(false);
  });

  it('refuses production for the unapproved draft even with the approval env', () => {
    expect(() =>
      assertSeedAllowed(
        {
          NODE_ENV: 'production',
          CLINIC_PROGRAMS_SEED_APPROVED: `${fx.fixture_version}:${fx.sha256}`,
        },
        fx,
      ),
    ).toThrow(/not owner-approved/);
  });

  it('refuses an approved fixture without the exact approval env, allows it with', () => {
    const approved = { ...fx, production_seed_authorized: true };
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' }, approved)).toThrow(
      /CLINIC_PROGRAMS_SEED_APPROVED/,
    );
    expect(() =>
      assertSeedAllowed(
        { NODE_ENV: 'production', CLINIC_PROGRAMS_SEED_APPROVED: 'clinic-programs.v1:wrong' },
        approved,
      ),
    ).toThrow();
    expect(() =>
      assertSeedAllowed(
        {
          NODE_ENV: 'production',
          CLINIC_PROGRAMS_SEED_APPROVED: `${fx.fixture_version}:${fx.sha256}`,
        },
        approved,
      ),
    ).not.toThrow();
  });

  it('the seed itself refuses production before touching the database', async () => {
    const w = fakeDb();
    await expect(
      seedClinicPrograms(asClient(w.db), RAW, { ...base, env: { NODE_ENV: 'production' } }),
    ).rejects.toThrow(/Refusing/);
    expect(w.db.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('seedClinicPrograms', () => {
  it('seeds three 4-week masters, one space with four cohorts, and the program set', async () => {
    const w = fakeDb();
    const out = await seedClinicPrograms(asClient(w.db), RAW, { ...base, env: {} });
    expect(out.status).toBe('seeded');
    expect(w.programs).toHaveLength(3);
    w.programs.forEach((p) =>
      expect(p).toMatchObject({
        is_template: true,
        owner_user_id: 'coach-1',
        weeks: 4,
        cloned_from_id: null,
      }),
    );
    expect(w.workspaces).toHaveLength(1);
    expect(w.cohorts.map((c) => c.name)).toEqual([
      'All members',
      'Steady Foundations',
      'Considered Strength',
      'Strength & Balance',
    ]);
    expect(w.sets[0]).toMatchObject({
      coach_id: 'coach-1',
      fixture_version: 'clinic-programs.v1',
      fixture_sha256: fx.sha256,
    });
    expect(w.db.workoutPlan.create).toHaveBeenCalledTimes(8 + 12 + 16);
  });

  it('is idempotent: a second run is a no-op', async () => {
    const w = fakeDb();
    await seedClinicPrograms(asClient(w.db), RAW, { ...base, env: {} });
    const again = await seedClinicPrograms(asClient(w.db), RAW, { ...base, env: {} });
    expect(again.status).toBe('already_seeded');
    expect(w.programs).toHaveLength(3);
  });

  it('refuses a changed fixture under the same version', async () => {
    const w = fakeDb();
    await seedClinicPrograms(asClient(w.db), RAW, { ...base, env: {} });
    const changed = JSON.parse(RAW);
    changed.programs[0].data.description = 'edited';
    await expect(
      seedClinicPrograms(asClient(w.db), JSON.stringify(changed), { ...base, env: {} }),
    ).rejects.toThrow(/different fixture hash/);
  });

  it('aborts before writing when a catalog slug is missing; dry run reports it', async () => {
    const w = fakeDb({ missingSlug: 'cat-cow' });
    await expect(seedClinicPrograms(asClient(w.db), RAW, { ...base, env: {} })).rejects.toThrow(
      /cat-cow/,
    );
    expect(w.programs).toHaveLength(0);
    const dry = await seedClinicPrograms(asClient(w.db), RAW, { ...base, env: {}, dryRun: true });
    expect(dry).toEqual({ status: 'dry_run', missing_slugs: ['cat-cow'] });
  });
});
