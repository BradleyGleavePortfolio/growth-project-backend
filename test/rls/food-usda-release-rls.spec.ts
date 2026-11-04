/**
 * FOOD-USDA-BE — live proof of scripts/release.sh step 6 (USDA foods) and the catalog's word search, on the replayed
 * migration chain, with prisma/data/usda-foods.jsonl.gz (7,980 USDA SR Legacy and Foundation foods).
 *
 * Proves, in order:
 *   1. the first release adds every USDA food the shared catalog lacks once, as usdaFoodRow makes it (the live import's
 *      row); a shared row the live import already stored for a food (its usda:<fdcId> tag) is present and untouched;
 *      a member's own food with a usda tag is neither read for presence nor changed;
 *   2. a second run adds 0 and changes no row;
 *   3. (U5) a fix to a loaded row (its calories) survives the next run;
 *   4. an insert the database refuses fails the step (exit 1, nothing written); a food still missing fails it, naming
 *      how many; with the cause gone the next run adds what was missing;
 *   5. two runs at once add each missing food once;
 *   6. (U3, U4) over the loaded catalog, with USDA and Open Food Facts stubbed to fail, eggs, white rice, 2% milk,
 *      green beans, chicken breast, scrambled eggs and strawberries each find their USDA food, chick finds chicken,
 *      quotes, colons, ampersands, backslashes and emoji are only words, and the empty-query list holds no USDA row;
 *   7. the word search's time on this Postgres without and with a GIN index (printed for the PR, not asserted).
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { parseUsdaFoods, usdaFoodRow } from '../../scripts/load-usda-foods';
import { FoodService } from '../../src/food/food.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('food-usda-release-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const ROOT = join(__dirname, '..', '..');
const FILE = 'prisma/data/usda-foods.jsonl.gz';
const foods = parseUsdaFoods(readFileSync(join(ROOT, FILE)));
const N = foods.length;
const STEP_MS = 300_000;
const byId = new Map(foods.map((f) => [f.fdc_id, f]));

interface Run {
  code: number | null;
  out: string;
}

const env = () => ({ ...process.env, DATABASE_URL: DB_URL, DIRECT_URL: DB_URL });

function run(cmd: string, args: string[]): Run {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 280_000, env: env() });
  return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

const echo = (label: string, r: Run) => {
  const lines = r.out.split('\n').filter((l) => /^\[release\] (step 6|USDA foods)/.test(l));
  // eslint-disable-next-line no-console
  console.log([`${label}: exit ${r.code}`, ...lines].join('\n'));
};

/** Step 6 alone, as release.sh runs it (the compiled copy the runtime image carries). */
function step(): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/food-seed/scripts/load-usda-foods.js', FILE], { cwd: ROOT, env: env() });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const line = (present: number, added: number) =>
  new RegExp(`^\\[release\\] USDA foods: ${present} present, ${added} added \\(\\d+ ms\\)$`, 'm');

(DB_URL ? describe : describe.skip)('FOOD-USDA-BE: release step 6 adds the USDA foods the shared catalog lacks', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const member = randomUUID();
  const COLUMNS = {
    name: true, brand_or_restaurant: true, category: true, serving_description: true, serving_size_grams: true,
    calories: true, protein_g: true, carbs_g: true, fat_g: true, saturated_fat_g: true, mono_fat_g: true,
    poly_fat_g: true, fiber_g: true, sugar_g: true, sodium_mg: true, tags: true, search_aliases: true, image_url: true,
    nutrient_basis: true, created_by_user_id: true,
  } as const;
  const loaded = () => prisma.foodItem.findMany({ where: { created_by_user_id: null, tags: { has: 'basic-food' } }, select: COLUMNS });
  const sharedOf = (fdcId: number) => prisma.foodItem.findMany({ where: { created_by_user_id: null, tags: { has: `usda:${fdcId}` } } });
  const allRows = () => prisma.foodItem.findMany({ orderBy: { id: 'asc' } });
  // The live import already stored this food (its own 100 g row); this member logged their own copy of another.
  const liveFood = byId.get(172187)!; // Egg, whole, cooked, scrambled
  const memberFood = byId.get(169961)!; // Beans, snap, green, raw
  let liveId = '';
  let memberId = '';

  beforeAll(async () => {
    const compiled = run('npx', ['tsc', '-p', 'tsconfig.food-seed.json']);
    if (compiled.code !== 0) throw new Error(`tsc -p tsconfig.food-seed.json failed:\n${compiled.out}`);
  }, STEP_MS);

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS food_usda_test_trigger ON "FoodItem"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS food_usda_test_fn()');
    await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS food_usda_test_words_idx');
    await prisma.$disconnect();
  });

  it('the replayed chain starts with no USDA rows', async () => {
    expect(await prisma.foodItem.count({ where: { tags: { has: 'basic-food' } } })).toBe(0);
  });

  it('first release: every missing USDA food added once, as the live import row; live row and member food untouched', async () => {
    await prisma.user.create({
      data: { id: member, supabase_id: randomUUID(), email: `${member}@example.test`, name: 'Food USDA member', role: 'student' },
    });
    liveId = (await prisma.foodItem.create({
      data: { ...usdaFoodRow(liveFood), serving_description: '100\u00a0g', serving_size_grams: 100, calories: liveFood.calories + 3 },
    })).id;
    memberId = (await prisma.foodItem.create({
      data: { ...usdaFoodRow(memberFood), serving_description: 'my bowl', calories: 1, created_by_user_id: member },
    })).id;
    const liveBefore = await prisma.foodItem.findUniqueOrThrow({ where: { id: liveId } });
    const memberBefore = await prisma.foodItem.findUniqueOrThrow({ where: { id: memberId } });

    const r = run('bash', ['scripts/release.sh']);
    echo('release run 1', r);
    expect(r.out).toMatch(line(N, N - 1));
    expect(r.out).toContain('release_command completed successfully');
    expect(r.code).toBe(0);
    expect(r.out.indexOf('built-in foods:')).toBeLessThan(r.out.indexOf('USDA foods:'));

    expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: liveId } })).toEqual(liveBefore);
    expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: memberId } })).toEqual(memberBefore);
    expect(await prisma.foodItem.count({ where: { created_by_user_id: member } })).toBe(1);
    const rows = await loaded();
    expect(rows).toHaveLength(N);
    const byTag = new Map(rows.map((row) => [row.tags[0], row]));
    for (const f of foods) {
      if (f.fdc_id === liveFood.fdc_id) continue;
      const row = byTag.get(`usda:${f.fdc_id}`);
      expect([f.fdc_id, row]).toEqual([f.fdc_id, { ...usdaFoodRow(f), created_by_user_id: null }]);
    }
    expect(await sharedOf(memberFood.fdc_id)).toHaveLength(1);
  }, STEP_MS);

  it('a second run adds 0 and changes no row', async () => {
    const before = await allRows();
    const r = await step();
    echo('step 6 run 2', r);
    expect(r.out).toMatch(line(N, 0));
    expect(r.code).toBe(0);
    expect(await allRows()).toEqual(before);
  }, STEP_MS);

  it('U5: a fix to a loaded row (its calories) survives the next run', async () => {
    const [row] = await sharedOf(byId.get(170893)!.fdc_id);
    await prisma.foodItem.update({ where: { id: row.id }, data: { calories: row.calories + 11 } });
    const r = await step();
    expect(r.out).toMatch(line(N, 0));
    expect(r.code).toBe(0);
    expect((await prisma.foodItem.findUniqueOrThrow({ where: { id: row.id } })).calories).toBe(row.calories + 11);
    expect(await sharedOf(170893)).toHaveLength(1);
  }, STEP_MS);

  it('an insert the database refuses fails the step; nothing is half-written', async () => {
    const gone = [foods[0], foods[1500], foods[N - 1]].map((f) => f.fdc_id);
    await prisma.foodItem.deleteMany({ where: { created_by_user_id: null, tags: { hasSome: gone.map((id) => `usda:${id}`) } } });
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION food_usda_test_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'food usda test refusal'; END $f$`,
    );
    await prisma.$executeRawUnsafe('CREATE TRIGGER food_usda_test_trigger BEFORE INSERT ON "FoodItem" FOR EACH ROW EXECUTE FUNCTION food_usda_test_fn()');
    const before = await allRows();
    const r = await step();
    echo('step 6 refused', r);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^\[release\] USDA foods FAILED: .*food usda test refusal/m);
    expect(await allRows()).toEqual(before);
    await prisma.$executeRawUnsafe('DROP TRIGGER food_usda_test_trigger ON "FoodItem"');
    await prisma.$executeRawUnsafe('DROP FUNCTION food_usda_test_fn()');

    // A trigger that silently drops one: still missing afterwards, so the step fails, naming how many.
    const dropped = `'usda:${gone[1]}'`;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION food_usda_test_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF ${dropped} = ANY(NEW.tags) THEN RETURN NULL; END IF; RETURN NEW; END $f$`,
    );
    await prisma.$executeRawUnsafe('CREATE TRIGGER food_usda_test_trigger BEFORE INSERT ON "FoodItem" FOR EACH ROW EXECUTE FUNCTION food_usda_test_fn()');
    const missing = await step();
    echo('step 6 one dropped', missing);
    expect(missing.out).toMatch(line(N - 1, 2));
    expect(missing.out).toContain(`[release] USDA foods FAILED: 1 of ${N} still missing from the shared catalog`);
    expect(missing.code).toBe(1);
    await prisma.$executeRawUnsafe('DROP TRIGGER food_usda_test_trigger ON "FoodItem"');
    await prisma.$executeRawUnsafe('DROP FUNCTION food_usda_test_fn()');

    const healed = await step();
    expect(healed.out).toMatch(line(N, 1));
    expect(healed.code).toBe(0);
    for (const id of gone) expect(await sharedOf(id)).toHaveLength(1);
  }, STEP_MS);

  it('two runs at once add each missing food exactly once', async () => {
    const gone = foods.slice(100, 105).map((f) => f.fdc_id);
    await prisma.foodItem.deleteMany({ where: { created_by_user_id: null, tags: { hasSome: gone.map((id) => `usda:${id}`) } } });
    const [a, b] = await Promise.all([step(), step()]);
    // eslint-disable-next-line no-console
    console.log(`concurrent step 6 runs: ${a.out.trim()} | ${b.out.trim()}`);
    expect([a.code, b.code]).toEqual([0, 0]);
    const addedBy = (r: Run) => Number(/^\[release\] USDA foods: \d+ present, (\d+) added/m.exec(r.out)?.[1]);
    expect(addedBy(a) + addedBy(b)).toBe(gone.length);
    for (const id of gone) expect(await sharedOf(id)).toHaveLength(1);
    expect(await loaded()).toHaveLength(N);
  }, STEP_MS);

  describe('the word search over the loaded catalog, USDA and Open Food Facts stubbed to fail', () => {
    let fetchSpy: jest.SpyInstance;
    const service = () => new FoodService(prisma as never);
    beforeEach(() => {
      process.env.USDA_API_KEY = 'test-key';
      fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('USDA and Open Food Facts stubbed to fail'));
    });
    afterEach(() => fetchSpy.mockRestore());

    it.each([
      ['eggs', /^Egg, whole/],
      ['white rice', /^Rice, white/],
      ['2% milk', /^Milk, reduced fat, fluid, 2% milkfat/],
      ['green beans', /^Beans, snap, green/],
      ['chicken breast', /^Chicken, broilers? or fryers?, breast/],
      ['scrambled eggs', /^Egg, whole, cooked, scrambled/],
      ['strawberries', /^Strawberries/],
      ['chick', /^Chicken/],
    ])('%s finds its USDA food from the catalog alone', async (typed, name) => {
      const s = service();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((s as any).searchCatalog(typed, 40, null)).resolves.toHaveProperty('rows');
      const res = await s.search(typed, 50, member);
      const hit = res.results.find((r) => name.test(r.name) && r.tags.some((t) => t.startsWith('usda:')));
      expect([typed, hit?.name ?? null]).toEqual([typed, expect.any(String)]);
    });

    it.each([`'; DROP TABLE "FoodItem"; --`, `"chicken" breast`, 'chicken: breast', 'mac & cheese', 'milk\\', 'egg\\s', '🍓 strawberries', '%_%'])(
      '%s is words only: the search answers and the catalog is whole',
      async (typed) => {
        const s = service();
        // The catalog query itself answers (search() would hide a refused query by asking USDA and Open Food Facts).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect((s as any).searchCatalog(typed, 40, null)).resolves.toHaveProperty('rows');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect((s as any).searchCatalog(typed, 40, member)).resolves.toHaveProperty('rows');
        const res = await s.search(typed, 50, member);
        expect(Array.isArray(res.results)).toBe(true);
        expect(await loaded()).toHaveLength(N);
      },
    );

    it('quotes and emoji around words still find them', async () => {
      const res = await service().search('🍓 "strawberries"', 50, member);
      expect(res.results.some((r) => /^Strawberries/.test(r.name))).toBe(true);
    });

    it('the empty-query list holds built-in foods and the member\'s own, no USDA row', async () => {
      const res = await service().search('', 200, member);
      expect(res.results.length).toBeGreaterThan(0);
      expect(res.results.filter((r) => r.tags.includes('basic-food')).map((r) => r.id)).toEqual([memberId]);
    });

    it('a member food is found by its owner only', async () => {
      const other = randomUUID();
      const mine = await service().search('green beans', 50, member);
      expect(mine.results.some((r) => r.id === memberId)).toBe(true);
      const theirs = await service().search('green beans', 50, other);
      expect(theirs.results.some((r) => r.id === memberId)).toBe(false);
    });
  });

  it('timing: the word search on this Postgres, and what a GIN index would give instead (printed, not asserted)', async () => {
    const words = ['eggs', 'chicken breast', 'white rice', '2% milk', 'chick', 'of'];
    const ms = async (fn: () => Promise<unknown>) => {
      await fn();
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 5; i += 1) await fn();
      return (Number(process.hrtime.bigint() - t0) / 5e6).toFixed(1);
    };
    const s = new FoodService(prisma as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const searchCatalog = (s as any).searchCatalog.bind(s) as (q: string, l: number, o: string | null) => Promise<unknown>;
    // The alternative: a plain to_tsvector match over name + brand, which a GIN expression index can serve.
    const plain = (typing: string) =>
      prisma.$queryRaw`SELECT count(*) FROM "FoodItem" WHERE "created_by_user_id" IS NULL AND
        to_tsvector('english'::regconfig, "name" || ' ' || coalesce("brand_or_restaurant", '')) @@ to_tsquery('english', ${typing})`;
    const typingOf = (w: string) => {
      const parts = w.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      return parts.map((p, i) => (i === parts.length - 1 ? `${p}:*` : p)).join(' & ');
    };
    const shipped: string[] = [];
    const plainNo: string[] = [];
    for (const w of words) {
      shipped.push(`${w} ${await ms(() => searchCatalog(w, 40, null))} ms`);
      plainNo.push(`${w} ${await ms(() => plain(typingOf(w)))} ms`);
    }
    await prisma.$executeRawUnsafe(
      `CREATE INDEX food_usda_test_words_idx ON "FoodItem" USING gin (to_tsvector('english'::regconfig, "name" || ' ' || coalesce("brand_or_restaurant", '')))`,
    );
    await prisma.$executeRawUnsafe('ANALYZE "FoodItem"');
    const plainGin: string[] = [];
    for (const w of words) plainGin.push(`${w} ${await ms(() => plain(typingOf(w)))} ms`);
    await prisma.$executeRawUnsafe('DROP INDEX food_usda_test_words_idx');
    const version = await prisma.$queryRawUnsafe<{ v: string }[]>('SELECT version() AS v');
    // eslint-disable-next-line no-console
    console.log(
      [
        `word search timing (${await prisma.foodItem.count()} rows, ${version[0].v.split(' on ')[0]}), mean of 5 after one warm-up:`,
        `  shipped searchCatalog, no index: ${shipped.join(', ')}`,
        `  plain to_tsvector match, no index: ${plainNo.join(', ')}`,
        `  plain to_tsvector match, GIN index: ${plainGin.join(', ')}`,
      ].join('\n'),
    );
  }, STEP_MS);
});
