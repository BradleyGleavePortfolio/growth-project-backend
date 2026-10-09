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
      // Applies { is_house } / { active } to rows matching the where shape the
      // seed uses ({ coach_id?, is_house?, id: { not } }).
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const not = (where.id as { not?: string } | undefined)?.not;
        const rows = sets.filter(
          (r) =>
            r.id !== not &&
            (where.coach_id === undefined || r.coach_id === where.coach_id) &&
            (where.is_house === undefined || r.is_house === where.is_house),
        );
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) =>
        Object.assign(
          sets.find((r) => r.id === where.id)!,
          data,
        ),
      ),
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

  it('refuses production for an unapproved draft even with the approval env', () => {
    const draft = { ...fx, production_seed_authorized: false };
    expect(() =>
      assertSeedAllowed(
        {
          NODE_ENV: 'production',
          CLINIC_PROGRAMS_SEED_APPROVED: `${fx.fixture_version}:${fx.sha256}`,
        },
        draft,
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
      is_house: false,
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
    expect(dry).toEqual({ status: 'dry_run', missing_slugs: ['cat-cow'], house: false });
  });
});

describe('--house (CONSULT-ALL-BE-133, owner decision 28)', () => {
  it('marks the new set as the house set and clears the flag on any other set', async () => {
    const w = fakeDb();
    w.sets.push({ id: 'old-house', coach_id: 'coach-9', is_house: true, active: true });
    const out = await seedClinicPrograms(asClient(w.db), RAW, { ...base, env: {}, house: true });
    expect(out).toMatchObject({ status: 'seeded', house: true });
    expect(w.sets.find((r) => r.coach_id === 'coach-1')).toMatchObject({ is_house: true });
    // The other coach's set stays active as that coach's own set.
    expect(w.sets.find((r) => r.id === 'old-house')).toMatchObject({
      is_house: false,
      active: true,
    });
  });

  it('on an already seeded set it only marks it; a dry run writes nothing', async () => {
    const w = fakeDb();
    await seedClinicPrograms(asClient(w.db), RAW, { ...base, env: {} });
    const dry = await seedClinicPrograms(asClient(w.db), RAW, {
      ...base,
      env: {},
      house: true,
      dryRun: true,
    });
    expect(dry).toEqual({ status: 'dry_run', missing_slugs: [], house: true });
    expect(w.sets[0].is_house).toBe(false);
    const out = await seedClinicPrograms(asClient(w.db), RAW, { ...base, env: {}, house: true });
    expect(out).toMatchObject({ status: 'already_seeded', house: true });
    expect(w.sets).toHaveLength(1);
    expect(w.sets[0].is_house).toBe(true);
    expect(w.programs).toHaveLength(3);
  });

  it('the production guard still applies with --house', async () => {
    const w = fakeDb();
    await expect(
      seedClinicPrograms(asClient(w.db), RAW, {
        ...base,
        env: { NODE_ENV: 'production' },
        house: true,
      }),
    ).rejects.toThrow(/Refusing/);
    expect(w.sets).toHaveLength(0);
  });
});
