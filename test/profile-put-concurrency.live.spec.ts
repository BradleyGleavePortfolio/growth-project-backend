/**
 * B606-3 live proof on real Postgres: concurrent partial PUT /profile writes
 * are serialised per user, so the stored targets always equal a fresh
 * calculation over the final stored row.
 *
 * Deterministic interleaving: a third transaction holds the profile row lock
 * while the two writers (weight -> 200, activity -> moderate) start; the test
 * waits until BOTH writers are blocked on that lock (pg_stat_activity
 * wait_event_type = 'Lock'), then releases it.
 *   - With the fix, each writer blocks on `SELECT ... FOR UPDATE` BEFORE it
 *     reads, so each one reads the committed row of the writer before it.
 *   - Without it (the audited head 3c707694), both writers read the same
 *     stale row first and block only at UPDATE; the last one stores targets
 *     computed from its stale snapshot (the audit's 1,789 vs 1,986 kcal).
 *
 * Gated on MWB3_TEST_DATABASE_URL (the mwb-3-live-tests CI job); skipped with a
 * logged reason elsewhere. Builds a Prisma-faithful schema with the shared
 * bootstrap helper on a throwaway database.
 */
import { PrismaService } from '../src/prisma.service';
import { ProfileService } from '../src/profile/profile.service';
import { computeMacros, resolveMacroInputs } from '../src/macros/macro-calculator';
import type { UpdateProfileDto } from '../src/profile/profile.dto';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[profile-put-concurrency.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.',
  );
}

const NOW = new Date('2026-10-01T12:00:00Z');
const USER_ID = 'b606-3-live-client';
const NEW_USER_ID = 'b606-3-live-new-client';

function withPool(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return url.includes('connection_limit=') ? url : `${url}${sep}connection_limit=8`;
}

function dto(v: object): UpdateProfileDto {
  return v as UpdateProfileDto;
}

function fresh(row: {
  current_weight_lbs: number | null;
  target_weight_lbs: number | null;
  height_cm: number | null;
  date_of_birth: Date | null;
  sex: string;
  activity_level: string;
  goal_type: string;
}) {
  const r = resolveMacroInputs(row, NOW);
  if (!r.ok) throw new Error(`not computable: ${r.missing.join(',')}`);
  return computeMacros(r.inputs);
}

liveDescribe('B606-3 live: PUT /profile writers are serialised per user (Postgres)', () => {
  let prisma: PrismaService;
  let svc: ProfileService;

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL) } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    svc = new ProfileService(prisma);
    for (const id of [USER_ID, NEW_USER_ID]) {
      await prisma.user.create({
        data: { id, supabase_id: `sb-${id}`, email: `${id}@example.test`, name: 'Client' },
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function lockWaiters(): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    return Number(rows[0]?.n ?? 0);
  }

  it('audit reproduction: weight -> 200 || activity -> moderate behind a held row lock -> final targets equal a fresh calculation (1,986 kcal)', async () => {
    await prisma.userProfile.create({
      data: {
        user_id: USER_ID,
        sex: 'female',
        date_of_birth: new Date('1988-04-01T00:00:00Z'),
        height_cm: 167.64,
        current_weight_lbs: 172,
        target_weight_lbs: 150,
        activity_level: 'sedentary',
        goal_type: 'fat_loss',
      },
    });

    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "UserProfile" WHERE "user_id" = ${USER_ID} FOR UPDATE`;
        lockHeld();
        await released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await held;

    const weight = svc.updateProfile(USER_ID, dto({ current_weight_lbs: 200 }), NOW);
    const activity = svc.updateProfile(USER_ID, dto({ activity_level: 'moderate' }), NOW);

    const deadline = Date.now() + 20_000;
    while ((await lockWaiters()) < 2) {
      if (Date.now() > deadline) throw new Error('writers never blocked on the row lock');
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await blocker;
    await Promise.all([weight, activity]);

    const final = await prisma.userProfile.findUniqueOrThrow({ where: { user_id: USER_ID } });
    expect(final.current_weight_lbs).toBe(200);
    expect(final.activity_level).toBe('moderate');
    const m = fresh(final);
    expect(final.macro_target_calories).toBe(m.calories);
    expect(final.macro_target_protein_g).toBe(m.protein_g);
    expect(final.macro_target_carbs_g).toBe(m.carbs_g);
    expect(final.macro_target_fat_g).toBe(m.fat_g);
    expect(final.macro_target_calories).toBe(1986);
  }, 60_000);

  it('first-row creation race: two simultaneous first PUTs both succeed and the stored targets match the stored row', async () => {
    const base = {
      sex: 'female',
      date_of_birth: '1988-04-01',
      height_cm: 167.64,
      current_weight_lbs: 172,
      target_weight_lbs: 150,
      activity_level: 'sedentary',
      goal_type: 'fat_loss',
    };
    const results = await Promise.allSettled([
      svc.updateProfile(NEW_USER_ID, dto({ ...base, current_weight_lbs: 200 }), NOW),
      svc.updateProfile(NEW_USER_ID, dto({ ...base, activity_level: 'moderate' }), NOW),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const final = await prisma.userProfile.findUniqueOrThrow({ where: { user_id: NEW_USER_ID } });
    expect(final.macro_target_calories).toBe(fresh(final).calories);
    expect(await prisma.userProfile.count({ where: { user_id: NEW_USER_ID } })).toBe(1);
  }, 60_000);
});
