/**
 * FOOD-SEED-BE — live proof of scripts/release.sh step 5 (built-in foods) on the replayed migration chain.
 *
 * Runs the real scripts/release.sh (steps 0–5, real Prisma CLI, the compiled copy from tsconfig.food-seed.json the
 * runtime image carries) against this suite's copy of rls_replay, with DATABASE_URL = DIRECT_URL = that copy, the
 * way Fly's release machine runs it against production. Proves, in order:
 *   1. the rows the release adds are the rows `npm run seed:foods` (prisma/seed-foods.ts) makes, field for field;
 *   2. first release: a member's own food with a seed food's name is not counted, read-for-presence or changed; an
 *      existing shared row with a seed food's name + brand is not updated; every other seed food is added once;
 *   3. second release adds 0 and changes nothing;
 *   4. an insert the database refuses fails the release visibly (exit non-zero, abort banner, no success line);
 *   5. a seed food still missing after the insert (a trigger that drops it) fails the release, naming how many;
 *   6. once the cause is gone the next release adds what was missing;
 *   7. two runs of the step at once add each missing food once (advisory lock; FoodItem has no name + brand key).
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { foodKey, parseSeedFoods, SEED_TAG } from '../../scripts/seed-built-in-foods';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('food-seed-release-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const ROOT = join(__dirname, '..', '..');
const foods = parseSeedFoods(readFileSync(join(ROOT, 'prisma/data/seed-foods.json'), 'utf8'));
const N = foods.length;
const STEP_MS = 300_000;

interface Run {
  code: number | null;
  out: string;
}

function run(cmd: string, args: string[]): Run {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, DATABASE_URL: DB_URL, DIRECT_URL: DB_URL },
  });
  return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

let releaseNo = 0;
// Runs the real release script and echoes its step 5 lines and exit code into the job log (the READY evidence).
const release = (): Run => {
  const r = run('bash', ['scripts/release.sh']);
  releaseNo += 1;
  const lines = r.out.split('\n').filter((l) => /^\[release\] (step 5|built-in foods)/.test(l));
  // eslint-disable-next-line no-console
  console.log([`release run ${releaseNo}: exit ${r.code}`, ...lines].join('\n'));
  return r;
};

(DB_URL ? describe : describe.skip)('FOOD-SEED-BE: release.sh step 5 adds the built-in foods the shared catalog lacks', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const member = randomUUID();
  let privateId = '';
  let existingId = '';
  const privateFood = foods[0];
  const existingFood = foods[1];
  const refusedFood = foods[2];
  const droppedFood = foods[3];
  // Every column a seed row sets, without id and created_at.
  const COLUMNS = {
    name: true, brand_or_restaurant: true, category: true, serving_description: true, serving_size_grams: true,
    calories: true, protein_g: true, carbs_g: true, fat_g: true, saturated_fat_g: true, mono_fat_g: true,
    poly_fat_g: true, fiber_g: true, sugar_g: true, sodium_mg: true, tags: true, search_aliases: true, image_url: true,
    barcode: true, nutrient_basis: true, created_by_user_id: true,
  } as const;
  // FOOD-USDA-BE: release step 6 adds the 7,980 USDA foods (shared, tagged basic-food) after this step; they are
  // test/rls/food-usda-release-rls.spec.ts's, so these counts leave them out.
  const NOT_USDA = { NOT: { tags: { has: 'basic-food' } } };
  const shared = () => prisma.foodItem.findMany({ where: { created_by_user_id: null, ...NOT_USDA }, select: COLUMNS });
  const sharedOf = (name: string) =>
    prisma.foodItem.findMany({ where: { created_by_user_id: null, name, brand_or_restaurant: null, ...NOT_USDA } });
  const allRows = () => prisma.foodItem.findMany({ orderBy: { id: 'asc' } });
  let seedFoodsRows = new Map<string, unknown>();

  beforeAll(async () => {
    const compiled = run('npx', ['tsc', '-p', 'tsconfig.food-seed.json']);
    if (compiled.code !== 0) throw new Error(`tsc -p tsconfig.food-seed.json failed:\n${compiled.out}`);
    expect(foods.every((f) => f.brand === null)).toBe(true); // the helpers below key on a NULL brand
  }, STEP_MS);

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS food_seed_test_trigger ON "FoodItem"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS food_seed_test_fn()');
    await prisma.$disconnect();
  });

  it('the replayed chain starts with no built-in foods', async () => {
    expect(await prisma.foodItem.count({ where: { tags: { has: SEED_TAG } } })).toBe(0);
    expect(await prisma.foodItem.count({ where: { created_by_user_id: null, name: { in: foods.map((f) => f.name) } } })).toBe(0);
  });

  it('oracle: `npm run seed:foods` rows, recorded and then removed so the release starts from none', async () => {
    const seeded = run('npx', ['ts-node', 'prisma/seed-foods.ts']);
    expect(seeded.out).toContain(`seed-foods: ${N} inserted, 0 updated, 0 skipped (${N} total)`);
    expect(seeded.code).toBe(0);
    const rows = await shared();
    expect(rows).toHaveLength(N);
    seedFoodsRows = new Map(rows.map((r) => [foodKey(r.name, r.brand_or_restaurant), r]));
    expect(seedFoodsRows.size).toBe(N);
    await prisma.foodItem.deleteMany({ where: { created_by_user_id: null, tags: { has: SEED_TAG } } });
    expect(await prisma.foodItem.count({ where: { tags: { has: SEED_TAG } } })).toBe(0);
  }, STEP_MS);

  it('first release: adds every missing seed food once, as seed:foods makes it; member food and existing row untouched', async () => {
    await prisma.user.create({
      data: { id: member, supabase_id: randomUUID(), email: `${member}@example.test`, name: 'Food seed member', role: 'student' },
    });
    // A member's own food with a seed food's name: private, so it does not make the shared food present.
    privateId = (await prisma.foodItem.create({
      data: { name: privateFood.name, serving_description: 'my bowl', serving_size_grams: 50, calories: 1, protein_g: 0,
        carbs_g: 0, fat_g: 0, tags: ['mine'], search_aliases: [], created_by_user_id: member },
    })).id;
    // A shared row already present with a seed food's name + brand but other values: never updated.
    existingId = (await prisma.foodItem.create({
      data: { name: existingFood.name, serving_description: 'older row', serving_size_grams: 10, calories: 2, protein_g: 0,
        carbs_g: 0, fat_g: 0, tags: [], search_aliases: [] },
    })).id;
    const privateBefore = await prisma.foodItem.findUniqueOrThrow({ where: { id: privateId } });
    const existingBefore = await prisma.foodItem.findUniqueOrThrow({ where: { id: existingId } });

    const r = release();
    expect(r.out).toMatch(new RegExp(`^\\[release\\] built-in foods: ${N} present, ${N - 1} added$`, 'm'));
    expect(r.out).toContain('release_command completed successfully');
    expect(r.code).toBe(0);
    expect(r.out.indexOf('verifiers_passed = ')).toBeLessThan(r.out.indexOf('built-in foods:'));

    expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: privateId } })).toEqual(privateBefore);
    expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: existingId } })).toEqual(existingBefore);
    expect(await prisma.foodItem.count({ where: { created_by_user_id: member } })).toBe(1);
    const rows = await shared();
    expect(rows).toHaveLength(N);
    for (const row of rows) {
      const key = foodKey(row.name, row.brand_or_restaurant);
      if (key === foodKey(existingFood.name, null)) continue;
      expect([key, row]).toEqual([key, seedFoodsRows.get(key)]);
    }
  }, STEP_MS);

  it('second release adds 0 and changes no row', async () => {
    const before = await allRows();
    const r = release();
    expect(r.out).toMatch(new RegExp(`^\\[release\\] built-in foods: ${N} present, 0 added$`, 'm'));
    expect(r.code).toBe(0);
    expect(await allRows()).toEqual(before);
  }, STEP_MS);

  it('an insert the database refuses fails the release visibly; nothing is half-written', async () => {
    await prisma.foodItem.deleteMany({ where: { created_by_user_id: null, name: refusedFood.name, tags: { has: SEED_TAG } } });
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION food_seed_test_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'food seed test refusal'; END $f$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER food_seed_test_trigger BEFORE INSERT ON "FoodItem" FOR EACH ROW EXECUTE FUNCTION food_seed_test_fn()',
    );
    const before = await allRows();
    const r = release();
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/^\[release\] built-in foods FAILED: .*food seed test refusal/m);
    expect(r.out).toContain('built-in foods step FAILED');
    expect(r.out).toContain('Deploy ABORTED by release_command');
    expect(r.out).not.toContain('release_command completed successfully');
    expect(await allRows()).toEqual(before);
    await prisma.$executeRawUnsafe('DROP TRIGGER food_seed_test_trigger ON "FoodItem"');
    await prisma.$executeRawUnsafe('DROP FUNCTION food_seed_test_fn()');
  }, STEP_MS);

  it('a seed food still missing after the insert fails the release, naming how many', async () => {
    await prisma.foodItem.deleteMany({ where: { created_by_user_id: null, name: droppedFood.name, tags: { has: SEED_TAG } } });
    // The refused food from the previous case and this one are both missing; the trigger silently drops this one.
    const dropped = `'${droppedFood.name.replace(/'/g, "''")}'`;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION food_seed_test_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.name = ${dropped} THEN RETURN NULL; END IF; RETURN NEW; END $f$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER food_seed_test_trigger BEFORE INSERT ON "FoodItem" FOR EACH ROW EXECUTE FUNCTION food_seed_test_fn()',
    );
    const r = release();
    expect(r.out).toMatch(new RegExp(`^\\[release\\] built-in foods: ${N - 1} present, 1 added$`, 'm'));
    expect(r.out).toContain(`[release] built-in foods FAILED: 1 of ${N} still missing from the shared catalog`);
    expect(r.out).toContain('Deploy ABORTED by release_command');
    expect(r.out).not.toContain('release_command completed successfully');
    expect(r.code).toBe(1);
    expect(await sharedOf(refusedFood.name)).toHaveLength(1);
    expect(await sharedOf(droppedFood.name)).toHaveLength(0);
    await prisma.$executeRawUnsafe('DROP TRIGGER food_seed_test_trigger ON "FoodItem"');
    await prisma.$executeRawUnsafe('DROP FUNCTION food_seed_test_fn()');
  }, STEP_MS);

  it('with the cause gone, the next release adds the missing food and is green; the member food is still untouched', async () => {
    const r = release();
    expect(r.out).toMatch(new RegExp(`^\\[release\\] built-in foods: ${N} present, 1 added$`, 'm'));
    expect(r.code).toBe(0);
    expect(await shared()).toHaveLength(N);
    for (const f of foods) expect(await sharedOf(f.name)).toHaveLength(1);
    const mine = await prisma.foodItem.findUniqueOrThrow({ where: { id: privateId } });
    expect([mine.created_by_user_id, mine.calories, mine.serving_description]).toEqual([member, 1, 'my bowl']);
  }, STEP_MS);

  it('two runs of the step at once add each missing food exactly once', async () => {
    const gone = foods.slice(10, 15).map((f) => f.name);
    await prisma.foodItem.deleteMany({ where: { created_by_user_id: null, name: { in: gone }, tags: { has: SEED_TAG } } });
    const step = () =>
      new Promise<Run>((resolve) => {
        const child = spawn('node', ['dist/food-seed/scripts/seed-built-in-foods.js', 'prisma/data/seed-foods.json'], {
          cwd: ROOT,
          env: { ...process.env, DIRECT_URL: DB_URL },
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (code) => resolve({ code, out }));
      });
    const [a, b] = await Promise.all([step(), step()]);
    // eslint-disable-next-line no-console
    console.log(`concurrent step runs: ${a.out.trim()} | ${b.out.trim()}`);
    expect([a.code, b.code]).toEqual([0, 0]);
    const addedBy = (r: Run) => Number(/^\[release\] built-in foods: \d+ present, (\d+) added$/m.exec(r.out)?.[1]);
    expect(addedBy(a) + addedBy(b)).toBe(gone.length);
    expect(await shared()).toHaveLength(N);
    for (const name of gone) expect(await sharedOf(name)).toHaveLength(1);
  }, STEP_MS);
});
