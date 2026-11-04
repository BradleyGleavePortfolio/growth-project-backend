/** Independent LS-1212R2 review proof. Tests/fixtures only; never merge this branch. */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import * as ts from 'typescript';
import { FoodService, type FoodResult } from '../src/food/food.service';
import { loadUsdaFoods, parseUsdaFoods } from '../scripts/load-usda-foods';

const ROOT = join(__dirname, '..');
const source = readFileSync(join(ROOT, 'src/food/food.service.ts'), 'utf8');
type Rank = (items: FoodResult[], query: string, limit: number) => FoodResult[];
const rank = (helpers: string): Rank => {
  const js = ts.transpileModule(
    `const SEED_TAG = 'seed:common-foods'; const CATEGORY_TAG = 'category:';\n${helpers}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  return new Function(`${js}\nreturn rankFoodResults;`)() as Rank;
};
const beforeRank = rank(readFileSync(join(__dirname, 'fixtures/ls-1212r2-ranker-before.txt'), 'utf8'));
const afterRank = rank(source.slice(source.indexOf('function words('), source.indexOf('// 24h TTL')));
const recorded = {
  ...Object.fromEntries(
    ['ls-1198r2/everyday.json', 'ls-1198r2/prefix-dishes.json'].flatMap((file) => {
      const entries = JSON.parse(readFileSync(join(__dirname, 'fixtures', file), 'utf8')) as Array<{ query: string; foods: unknown[] }>;
      return entries.map((entry) => [entry.query, entry.foods]);
    }),
  ),
  ...JSON.parse(readFileSync(join(__dirname, 'fixtures/fr-1198r3/usda-words.json'), 'utf8')),
  ...JSON.parse(readFileSync(join(__dirname, 'fixtures/lo-1198r3/b1-usda-words.json'), 'utf8')),
  oatmeal: JSON.parse(readFileSync(join(__dirname, 'fixtures/lo-1198-usda-oatmeal.json'), 'utf8')),
  'rolled oats': JSON.parse(readFileSync(join(__dirname, 'fixtures/lo-1198-usda-rolled-oats.json'), 'utf8')),
} as Record<string, unknown[]>;
const noDb = new FoodService({} as never);
const mapper = noDb as unknown as { mapUSDAFood(food: unknown): FoodResult };
const loaded = parseUsdaFoods(readFileSync(join(ROOT, 'prisma/data/usda-foods.jsonl.gz')));

describe('LS-1212R2 independent recorded-answer regression', () => {
  it('all 24 recorded USDA answers retain exactly their prior first three identities', () => {
    expect(Object.keys(recorded)).toHaveLength(24);
    for (const [query, foods] of Object.entries(recorded)) {
      const rows = foods.map((f) => mapper.mapUSDAFood(f));
      const oldTop = beforeRank(rows, query, 3).map((f) => [f.id, f.name]);
      const newTop = afterRank(rows, query, 3).map((f) => [f.id, f.name]);
      console.log('RECORDED', JSON.stringify({ query, oldTop, newTop }));
      expect([query, newTop]).toEqual([query, oldTop]);
    }
  });
});

const container = `ls1212r2-${process.pid}`;
const admin = 'postgresql://postgres@127.0.0.1:15432/postgres';
const db = 'postgresql://postgres@127.0.0.1:15432/rls_replay';
function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 300_000): string {
  const r = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.status !== 0) throw new Error(`${command}: exit ${r.status}: ${output.slice(-14000)}`);
  return output;
}
const liveEnv = { ...process.env, RLS_ADMIN_DATABASE_URL: admin, DATABASE_URL: db, DIRECT_URL: db, TEST_DATABASE_URL: db };

describe('LS-1212R2 independent real Postgres review', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    run('docker', ['run', '-d', '--rm', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p', '15432:5432', 'postgres:15']);
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      const r = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
      if (r.status === 0) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(ready).toBe(true);
    const replay = run('bash', ['scripts/ci/replay-migrations.sh', 'rls_replay'], liveEnv);
    console.log(replay.split('\n').filter((l) => l.startsWith('[replay]')).join('\n'));
    prisma = new PrismaClient({ datasourceUrl: db });
  }, 300_000);
  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
  });

  it('reruns all 26 unchanged USDA live-release/search cases on the replayed schema', () => {
    const out = run('npx', ['jest', '--config', 'jest.rls.config.js', '--runInBand', '--runTestsByPath', 'test/rls/food-usda-release-rls.spec.ts',
      '--forceExit'], liveEnv);
    console.log(out.split('\n').filter((l) => /USDA foods:|Test Suites:|Tests:|word search timing|shipped searchCatalog/.test(l)).join('\n'));
    expect(out).toMatch(/26 passed/);
    expect(out).toMatch(/7980 present, 7979 added/);
    expect(out).toMatch(/7980 present, 0 added/);
  }, 300_000);

  it('runs actual SQL and actual ranking for common words, both sources offline', async () => {
    const oldKey = process.env.USDA_API_KEY;
    process.env.USDA_API_KEY = 'fixture-only';
    const spy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline review fixture'));
    try {
      for (const query of [...Object.keys(recorded), 'yogurt', 'cereal', '2% milk', '1% milk', 'green beans',
        'coffee', 'beer', 'carrots', 'peas', 'corn', 'spinach', 'tomatoes', 'chick', 'chicken bre', 'breast chicken']) {
        const before = spy.mock.calls.length;
        const result = await new FoodService(prisma as never).search(query, 50, '00000000-0000-0000-0000-000000000195');
        console.log('LIVE', JSON.stringify({ query, names: result.results.slice(0, 3).map((f) => f.name),
          upstreamCalls: spy.mock.calls.length - before }));
        expect(result.results.length).toBeGreaterThan(0);
        if (['yogurt', 'cereal'].includes(query)) expect(result.results[0].name).not.toMatch(/\b[A-Z]{3,}\b/);
        if (['2% milk', '1% milk'].includes(query)) expect(result.results[0].name).toMatch(/^Milk\b/i);
        if (query === 'green beans') expect(result.results[0].name).toMatch(/^Beans\b/i);
      }
    } finally {
      spy.mockRestore();
      if (oldKey === undefined) delete process.env.USDA_API_KEY;
      else process.env.USDA_API_KEY = oldKey;
    }
  }, 120_000);

  it('oatmeal asks the source and finds recorded plain oatmeal with the actual catalog SQL', async () => {
    const oldKey = process.env.USDA_API_KEY;
    process.env.USDA_API_KEY = 'fixture-only';
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => ({
      ok: true, status: 200,
      json: async () => new URL(String(url)).hostname === 'api.nal.usda.gov'
        ? { foods: recorded.oatmeal } : { products: [] },
    } as Response));
    try {
      const result = await new FoodService(prisma as never).search('oatmeal', 50, '00000000-0000-0000-0000-000000000195');
      expect(result.results[0].name).toMatch(/^Oatmeal\b/i);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      if (oldKey === undefined) delete process.env.USDA_API_KEY;
      else process.env.USDA_API_KEY = oldKey;
    }
  });

  it('an already-loaded 8056 catalog keeps its old rows, and the 7980 loader adds nothing twice', async () => {
    // Exact old gzip extracted from the prior reviewed commit, not regenerated by the new builder.
    const old = parseUsdaFoods(readFileSync(join(__dirname, 'fixtures/ls-1212r2-old-catalog.jsonl.gz')));
    expect(old).toHaveLength(8056);
    await loadUsdaFoods(prisma, old);
    const before = await prisma.foodItem.findMany({ orderBy: { id: 'asc' } });
    const a = await loadUsdaFoods(prisma, loaded);
    const b = await loadUsdaFoods(prisma, loaded);
    console.log('OLD_CATALOG', JSON.stringify({ a, b }));
    expect(a).toEqual({ total: 7980, present: 7980, added: 0, missing: 0 });
    expect(b).toEqual(a);
    expect(await prisma.foodItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await prisma.foodItem.count({ where: { created_by_user_id: null, tags: { has: 'basic-food' } } })).toBe(8056);
  }, 120_000);
});
