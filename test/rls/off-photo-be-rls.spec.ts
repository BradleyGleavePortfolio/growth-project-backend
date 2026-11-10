/**
 * OFF-PHOTO-BE, live: an Open Food Facts product logged by its off_<code> id is one shared FoodItem row for that code,
 * with the product's photo, the same row for every client and every log, on the replayed migration chain. The real
 * FoodService, LogService, SavedFoodsService, FoodController, MealPhotoService and CoachService run on the superuser
 * connection, as the API does. Open Food Facts is a fixture (fetch spied), never a live call; its answer is built key
 * for key from what the mappers read (food.service.ts at 647c671: code :963, product_name :938 and :964, brands :965,
 * nutriments :952 and :970-972, image_front_small_url :978). Unit twins of cases 3 and 4: test/off-photo-be.spec.ts.
 * Shaped like test/rls/food-seed-fold-rls.spec.ts:17-21 and test/rls/food-saved-rls.spec.ts.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { PrismaService } from '../../src/prisma.service';
import { FoodService } from '../../src/food/food.service';
import { FoodController } from '../../src/food/food.controller';
import type { CreateFoodDto } from '../../src/food/food.dto';
import { LogService } from '../../src/log/log.service';
import type { LogFoodDto } from '../../src/log/log.dto';
import { SavedFoodsService } from '../../src/log/saved-foods.service';
import { MealPhotoService } from '../../src/log/meal-photo.service';
import { CoachService } from '../../src/coach/coach.service';
import type { CommunityImageStore } from '../../src/community/images/community-image-store';
import type { AuditService } from '../../src/audit/audit.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { PtmService } from '../../src/ptm/ptm.service';
import type { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('off-photo-be-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

function stub<T>(value: unknown): T {
  return value as T;
}

/** An entry as GET /log/daily and the coach's summary return it (the food row included, and b#1237's photo). */
interface DayEntry {
  id: string;
  food_item_id: string;
  food_item: { image_url: string | null };
  photo?: { url: string | null; width: number; height: number } | null;
}

const DAY = new Date().toISOString().split('T')[0];
const CODE = `40${String(Date.now()).slice(-11)}`;
const IMG = `https://images.example.test/offbe/${CODE}/front_small.jpg`;
const SIGNED = 'https://storage.example.test/signed/meal.jpg';
// 250 kcal = 4 * 10 + 4 * 30 + 9 * 10: numbers that can be true (offNumbersUsable :517-524).
const product = { code: CODE, product_name: 'Offbe live granola', brands: 'Offbe Farm',
  nutriments: { 'energy-kcal_100g': 250, proteins_100g: 10, carbohydrates_100g: 30, fat_100g: 10 },
  image_front_small_url: IMG };
// The phone's POST /foods payload today (buildFoodPayload's keys, logSubmit.ts:68-84 at mobile 93de2cbd).
const phonePayload = { name: 'Offbe live granola', brand_or_restaurant: 'Offbe Farm', category: 'generic',
  serving_description: '100g', serving_size_grams: 100, nutrient_basis: 'PER_100G', calories: 250, protein_g: 10,
  carbs_g: 30, fat_g: 10, tags: [], search_aliases: [] };

(DB_URL ? describe : describe.skip)('OFF-PHOTO-BE: an off_ id logs as one shared food with its photo (live)', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const deps = [
    stub<AnalyticsService>({ capture: jest.fn() }),
    stub<PtmService>({ emit: jest.fn() }),
    stub<ClientAIContextService>({ invalidateForUser: jest.fn() }),
  ] as const;
  const food = new FoodService(prisma);
  const store = stub<CommunityImageStore>({ createSignedDownload: jest.fn(async () => SIGNED) });
  const log = new LogService(prisma, food, ...deps, new MealPhotoService(prisma, store));
  const saved = new SavedFoodsService(prisma, food, ...deps);
  const controller = new FoodController(food);
  // Built as test/audit-phase10.spec.ts:345 builds it: the database and an audit writer.
  const coach = new CoachService(prisma, stub<AuditService>({ write: jest.fn(async () => undefined) }));
  const [K, A, B] = [randomUUID(), randomUUID(), randomUUID()];
  const productFetches: string[] = [];
  let fetchSpy: jest.SpyInstance | undefined;
  let rowId = '';
  let firstEntryId = '';
  let firstKey = '';
  let copy: { food: unknown; entry: unknown; id: string; entryId: string } = { food: null, entry: null, id: '', entryId: '' };

  const logOff = (userId: string, client_uuid: string, meal_type = 'lunch') =>
    log.logFood(userId, stub<LogFoodDto>({ food_item_id: `off_${CODE}`, date: DAY, meal_type, client_uuid }));
  const offRows = () => prisma.foodItem.findMany({ where: { barcode: CODE } });

  beforeAll(async () => {
    for (const [id, role, coach_id] of [[K, 'coach', null], [A, 'student', K], [B, 'student', K]] as const) {
      await prisma.user.create({ data: { id, supabase_id: randomUUID(), email: `${id}@example.test`, name: 'Offbe person',
        role, coach_id } });
    }
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const u = new URL(String(url));
      const answer = (body: unknown, status = 200) => stub<Response>({ ok: status < 400, status, json: async () => body });
      if (u.hostname !== 'world.openfoodfacts.org' || !u.pathname.startsWith('/api/v2/product/')) return answer({}, 404);
      const code = decodeURIComponent(u.pathname.replace('/api/v2/product/', '').replace(/\.json$/, ''));
      productFetches.push(code);
      return code === CODE ? answer({ product }) : answer({ status: 0 }, 404);
    });
    // Case 12's private copy, made the way the phone makes one today, and its entry.
    const made = await food.create(stub<CreateFoodDto>(phonePayload), A);
    const entry = await log.logFood(A, stub<LogFoodDto>({ food_item_id: made.id, date: DAY, meal_type: 'breakfast',
      client_uuid: randomUUID() }));
    copy = {
      id: made.id,
      entryId: entry.id,
      food: await prisma.foodItem.findUniqueOrThrow({ where: { id: made.id } }),
      entry: await prisma.loggedFoodEntry.findUniqueOrThrow({ where: { id: entry.id } }),
    };
  });

  // The suite's database is its own copy of rls_replay (run-rls-suites.mjs), so no row is deleted here.
  afterAll(async () => {
    fetchSpy?.mockRestore();
    await prisma.$disconnect();
  });

  it('case 3: two logs by A (two keys) store one shared row with the photo; fetched once; no row made for A', async () => {
    firstKey = randomUUID();
    const first = await logOff(A, firstKey);
    const second = await logOff(A, randomUUID(), 'dinner');
    const rows = await offRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ created_by_user_id: null, image_url: IMG, barcode: CODE, name: 'Offbe live granola' });
    rowId = rows[0].id;
    firstEntryId = first.id;
    expect(second.id).not.toBe(first.id);
    expect([first.food_item_id, second.food_item_id]).toEqual([rowId, rowId]);
    expect(first.food_item).toMatchObject({ id: rowId, image_url: IMG });
    expect(productFetches).toEqual([CODE]);
    expect(await prisma.foodItem.count({ where: { created_by_user_id: A } })).toBe(1); // case 12's copy only
  });

  it('case 4: B logs the same off_ id and gets the same row; still one row for the code; none made for B', async () => {
    const entry = await logOff(B, randomUUID());
    expect(entry.food_item_id).toBe(rowId);
    expect(await offRows()).toHaveLength(1);
    expect(await prisma.foodItem.count({ where: { created_by_user_id: B } })).toBe(0);
    expect(productFetches).toEqual([CODE]);
  });

  it("case 5: GET /log/daily returns each entry's food_item.image_url as stored, beside its meal photo", async () => {
    const stored = async (id: string) => (await prisma.foodItem.findUniqueOrThrow({ where: { id } })).image_url;
    const day = { entries: stub<DayEntry[]>((await log.getDaily(A, DAY)).entries) };
    expect(day.entries).toHaveLength(3);
    for (const e of day.entries) {
      expect(e.food_item.image_url).toBe(await stored(e.food_item_id));
      expect(e.photo).toBeNull();
    }
    expect(day.entries.filter((e) => e.food_item_id === rowId).map((e) => e.food_item.image_url)).toEqual([IMG, IMG]);
    expect(day.entries.find((e) => e.id === copy.entryId)?.food_item.image_url).toBeNull();

    // A meal photo on the first entry (b#1237's row): that entry's photo is set; its food's photo is unchanged.
    await prisma.$executeRaw`INSERT INTO "food_entry_photos" ("entry_id", "user_id", "storage_key", "width", "height", "size_bytes", "mime")
      VALUES (${firstEntryId}, ${A}, ${`${A}/${randomUUID()}-0000000000000-0000000000000000-00000000000000000000000000000000.sent.jpg`}, 1200, 900, 4000, 'image/jpeg')`;
    const after = { entries: stub<DayEntry[]>((await log.getDaily(A, DAY)).entries) };
    const withPhoto = after.entries.find((e) => e.id === firstEntryId);
    expect(withPhoto?.photo).toMatchObject({ url: SIGNED, width: 1200, height: 900 });
    expect(withPhoto?.food_item.image_url).toBe(IMG);
    expect(after.entries.filter((e) => e.id !== firstEntryId).every((e) => e.photo === null)).toBe(true);
  });

  it("case 6: the coach's summary for A returns the same food_item.image_url", async () => {
    const summary = await coach.getClientSummary(K, A, DAY);
    const today = 'today' in summary ? summary.today : undefined;
    if (!today) throw new Error('summary refused');
    const ours = stub<DayEntry[]>(today.entries).filter((e) => e.food_item_id === rowId);
    expect(ours).toHaveLength(2);
    expect(ours.map((e) => e.food_item.image_url)).toEqual([IMG, IMG]);
  });

  it("case 7: a keyed resend of case 3's first log returns the stored entry and fetches nothing", async () => {
    const before = await prisma.loggedFoodEntry.count({ where: { user_id: A } });
    const again = await logOff(A, firstKey);
    expect(again.id).toBe(firstEntryId);
    expect(again.food_item_id).toBe(rowId);
    expect(await prisma.loggedFoodEntry.count({ where: { user_id: A } })).toBe(before);
    expect(productFetches).toEqual([CODE]);
  });

  it("case 8: a favourite, a saved meal and GET /foods/barcode from the code all resolve to case 3's row", async () => {
    const fav = await saved.addFavorite(A, `off_${CODE}`);
    expect(fav.food_item_id).toBe(rowId);
    expect(fav.food_item.image_url).toBe(IMG);
    const meal = await saved.createSavedMeal(A, { name: 'Offbe lunch', items: [{ food_item_id: `off_${CODE}` }] });
    expect(meal.items.map((i) => i.food_item_id)).toEqual([rowId]);
    const scanned = await controller.getByBarcode(stub<AuthedRequest>({ user: { id: A } }), CODE);
    expect(scanned).toMatchObject({ id: rowId, image_url: IMG });
    expect(await offRows()).toHaveLength(1);
    expect(productFetches).toEqual([CODE]);
  });

  it("case 12: A's private copy made before and its entry read back the same", async () => {
    expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: copy.id } })).toEqual(copy.food);
    expect(await prisma.loggedFoodEntry.findUniqueOrThrow({ where: { id: copy.entryId } })).toEqual(copy.entry);
    expect(await prisma.foodItem.count({ where: { created_by_user_id: A } })).toBe(1);
  });
});
