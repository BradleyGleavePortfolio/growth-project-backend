#!/usr/bin/env ts-node
/**
 * scripts/seed-clinic-programs.ts  (C07)
 *
 * Idempotently seeds the clinic partner's three master programs, the
 * clinic-wide community space (all-members cohort + one cohort per program)
 * and the ClinicProgramSet row that POST /me/onboarding/complete reads.
 *
 * Input: seed/clinic-programs.v1.json (override with CLINIC_PROGRAMS_FIXTURE).
 * The fixture is validated (parseFixture): exactly three 4-week programs,
 * every exercise slug in the manifest, selection rules identical to
 * src/onboarding/program-rules.ts. Every slug must also exist in
 * ExerciseCatalogItem or the script aborts before writing anything.
 *
 * Idempotency: one ClinicProgramSet per (coach, fixture_version). Re-running
 * with the same fixture hash is a no-op. A different hash for the same
 * version is refused (bump fixture_version instead).
 *
 * Production guard: refuses to run against production unless BOTH
 *   - the fixture says "production_seed_authorized": true (owner approval), and
 *   - CLINIC_PROGRAMS_SEED_APPROVED="<fixture_version>:<sha256>" is set.
 * Production = NODE_ENV=production, APP_ENV=production, or
 * CLINIC_SEED_TARGET=production.
 *
 * Env:
 *   DATABASE_URL                 (required)
 *   CLINIC_OWNER_COACH_EMAIL     owner coach account that owns the masters
 *     or CLINIC_OWNER_COACH_ID
 *   CLINIC_SPACE_NAME            default "Clinic community"
 *   CLINIC_ALL_MEMBERS_NAME      default "All members"
 *
 * Run:  npx ts-node scripts/seed-clinic-programs.ts [--dry-run]
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { parseFixture, type ParsedFixture } from '../src/onboarding/clinic-programs';
import { writeProgramTree } from '../src/onboarding/program-writer';

export interface SeedEnv {
  NODE_ENV?: string;
  APP_ENV?: string;
  CLINIC_SEED_TARGET?: string;
  CLINIC_PROGRAMS_SEED_APPROVED?: string;
}

export function isProductionTarget(env: SeedEnv): boolean {
  return (
    env.NODE_ENV === 'production' ||
    env.APP_ENV === 'production' ||
    env.CLINIC_SEED_TARGET === 'production'
  );
}

/** Throws unless seeding is allowed for this environment and fixture. */
export function assertSeedAllowed(
  env: SeedEnv,
  fx: Pick<ParsedFixture, 'fixture_version' | 'sha256' | 'production_seed_authorized'>,
): void {
  if (!isProductionTarget(env)) return;
  if (!fx.production_seed_authorized) {
    throw new Error(
      `Refusing to seed production: fixture ${fx.fixture_version} is not owner-approved (production_seed_authorized=false).`,
    );
  }
  const expected = `${fx.fixture_version}:${fx.sha256}`;
  if (env.CLINIC_PROGRAMS_SEED_APPROVED !== expected) {
    throw new Error(
      `Refusing to seed production: set CLINIC_PROGRAMS_SEED_APPROVED=${expected} to confirm approval.`,
    );
  }
}

export function workspaceSlug(coachId: string, fixtureVersion: string): string {
  return `clinic-${coachId
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 12)
    .toLowerCase()}-${fixtureVersion.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
}

export type SeedOutcome =
  | { status: 'already_seeded'; set_id: string }
  | { status: 'dry_run'; missing_slugs: string[] }
  | { status: 'seeded'; set_id: string; programs: Record<string, string> };

export async function seedClinicPrograms(
  prisma: PrismaClient,
  raw: string,
  opts: {
    env: SeedEnv;
    coachEmail?: string;
    coachId?: string;
    spaceName: string;
    allMembersName: string;
    dryRun: boolean;
  },
): Promise<SeedOutcome> {
  const fx = parseFixture(raw);
  assertSeedAllowed(opts.env, fx);

  const coach = opts.coachId
    ? await prisma.user.findUnique({ where: { id: opts.coachId } })
    : opts.coachEmail
      ? await prisma.user.findUnique({ where: { email: opts.coachEmail } })
      : null;
  if (!coach)
    throw new Error(
      'Owner coach not found (set CLINIC_OWNER_COACH_EMAIL or CLINIC_OWNER_COACH_ID).',
    );
  if (coach.role !== 'coach' && coach.role !== 'owner')
    throw new Error('The owner account must have role coach or owner.');

  const existing = await prisma.clinicProgramSet.findUnique({
    where: {
      coach_id_fixture_version: { coach_id: coach.id, fixture_version: fx.fixture_version },
    },
  });
  if (existing) {
    if (existing.fixture_sha256 !== fx.sha256) {
      throw new Error(
        `ClinicProgramSet ${fx.fixture_version} already seeded with a different fixture hash; bump fixture_version for new content.`,
      );
    }
    return { status: 'already_seeded', set_id: existing.id };
  }

  const found = await prisma.exerciseCatalogItem.findMany({
    where: { slug: { in: fx.exercise_slugs } },
    select: { slug: true },
  });
  const have = new Set(found.map((f) => f.slug));
  const missing = fx.exercise_slugs.filter((s) => !have.has(s));
  if (opts.dryRun) return { status: 'dry_run', missing_slugs: missing };
  if (missing.length > 0)
    throw new Error(
      `Exercise catalog is missing slugs: ${missing.join(', ')} (run seed-exercise-catalog first).`,
    );

  const tenantId = coach.coach_id ?? coach.id;
  const slug = workspaceSlug(coach.id, fx.fixture_version);
  return prisma.$transaction(
    async (tx) => {
      const workspace =
        (await tx.communityWorkspace.findUnique({ where: { slug } })) ??
        (await tx.communityWorkspace.create({
          data: { coach_id: coach.id, name: opts.spaceName, slug },
        }));
      if (workspace.coach_id !== coach.id)
        throw new Error(`Workspace slug ${slug} belongs to another coach.`);

      const cohortFor = async (name: string, sort: number) =>
        tx.communityCohort.upsert({
          where: { workspace_id_name: { workspace_id: workspace.id, name } },
          create: { workspace_id: workspace.id, name, sort_order: sort },
          update: {},
        });
      const allMembers = await cohortFor(opts.allMembersName, 0);

      const programs: Record<string, { program_id: string; cohort_id: string; name: string }> = {};
      let sort = 1;
      for (const p of fx.programs) {
        const master = await writeProgramTree(tx, {
          tenantCoachId: tenantId,
          ownerUserId: coach.id,
          name: p.data.name,
          description: p.data.description,
          weeks: p.data.weeks,
          daysPerWeek: p.data.days_per_week,
          goalTag: p.data.goal_tag,
          isTemplate: true,
          clonedFromId: null,
          plans: p.plans,
          revisionMeta: { fixture_version: fx.fixture_version, fixture_key: p.fixture_key },
        });
        const cohort = await cohortFor(p.data.name, sort++);
        programs[p.fixture_key] = {
          program_id: master.id,
          cohort_id: cohort.id,
          name: p.data.name,
        };
      }

      const set = await tx.clinicProgramSet.create({
        data: {
          coach_id: coach.id,
          fixture_version: fx.fixture_version,
          fixture_sha256: fx.sha256,
          approval_status: fx.approval_status,
          workspace_id: workspace.id,
          all_members_cohort_id: allMembers.id,
          programs: JSON.parse(JSON.stringify(programs)),
          materialisation: JSON.parse(JSON.stringify(fx.materialisation)),
        },
      });
      // Only the newest set is active for this coach.
      await tx.clinicProgramSet.updateMany({
        where: { coach_id: coach.id, id: { not: set.id } },
        data: { active: false },
      });
      return {
        status: 'seeded' as const,
        set_id: set.id,
        programs: Object.fromEntries(Object.entries(programs).map(([k, v]) => [k, v.program_id])),
      };
    },
    { timeout: 120_000 },
  );
}

async function main(): Promise<void> {
  const path =
    process.env.CLINIC_PROGRAMS_FIXTURE ?? join(__dirname, '..', 'seed', 'clinic-programs.v1.json');
  const raw = readFileSync(path, 'utf8');
  const prisma = new PrismaClient();
  try {
    const out = await seedClinicPrograms(prisma, raw, {
      env: process.env,
      coachEmail: process.env.CLINIC_OWNER_COACH_EMAIL,
      coachId: process.env.CLINIC_OWNER_COACH_ID,
      spaceName: process.env.CLINIC_SPACE_NAME ?? 'Clinic community',
      allMembersName: process.env.CLINIC_ALL_MEMBERS_NAME ?? 'All members',
      dryRun: process.argv.includes('--dry-run'),
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
