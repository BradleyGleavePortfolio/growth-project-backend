import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { volumeWeightsFor } from './food-density';
import { parseFoodQuery } from './food-query-parser';

export interface FoodSearchResponse {
  results: FoodResult[];
  suggestions: FoodResult[];
  did_you_mean: boolean;
  query: string;
  /** Quantity extracted from the natural-language query, if any (e.g. 6 for "6oz chicken"). */
  parsed_quantity?: number;
  /** Canonical unit extracted from the query (g, oz, cup, tbsp, tsp, slice, piece). */
  parsed_unit?: string;
}

interface UsdaNutrient {
  nutrientName?: string;
  name?: string;
  unitName?: string;
  value?: number;
  amount?: number;
  nutrient?: { name?: string; unitName?: string };
}

interface UsdaFood {
  fdcId: number | string;
  description: string;
  foodNutrients?: UsdaNutrient[];
  brandOwner?: string;
  foodCategory?: string | { id?: number; code?: string; description?: string };
  householdServingFullText?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  /** 'Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded'. */
  dataType?: string;
}

interface UsdaSearchResponse {
  foods?: UsdaFood[];
}

interface OpenFoodFactsNutriments {
  [key: string]: number | undefined;
}

interface OpenFoodFactsProduct {
  code?: string;
  _id?: string;
  product_name?: string;
  brands?: string;
  nutriments?: OpenFoodFactsNutriments;
  image_front_small_url?: string;
}

interface OpenFoodFactsSearchResponse {
  products?: OpenFoodFactsProduct[];
}

interface OpenFoodFactsProductResponse {
  product?: OpenFoodFactsProduct;
}

// Common shape produced by both Prisma's FoodItem rows and the raw $queryRaw
// results in searchLocalDB. Numeric columns may come back as Prisma.Decimal,
// number, or a string from the raw query path; toResult coerces with Number().
interface FoodItemRow {
  id: string;
  name: string;
  brand_or_restaurant: string | null;
  category: string;
  serving_description: string;
  serving_size_grams: number | string | { toString(): string };
  calories: number | string | { toString(): string };
  protein_g: number | string | { toString(): string };
  carbs_g: number | string | { toString(): string };
  fat_g: number | string | { toString(): string };
  fiber_g: number | string | { toString(): string } | null;
  sugar_g: number | string | { toString(): string } | null;
  sodium_mg: number | string | { toString(): string } | null;
  tags?: string[] | null;
  search_aliases?: string[] | null;
  image_url?: string | null;
  nutrient_basis?: 'PER_100G' | 'PER_SERVING' | null;
}

export interface FoodResult {
  id: string;
  name: string;
  brand_or_restaurant: string | null;
  category: string;
  serving_description: string;
  serving_size_grams: number;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  tags: string[];
  search_aliases: string[];
  image_url: string | null;
  /**
   * Canonical basis for the macro fields above. PER_100G is the default for all
   * USDA + OpenFoodFacts hits and for seeded local entries; PER_SERVING is
   * reserved for legacy/hand-curated rows. Mobile uses this to choose between
   * (grams / 100) * macro and (qty * macro) at log time.
   */
  nutrient_basis: 'PER_100G' | 'PER_SERVING';
  /**
   * Whether the category has a density entry in food-density.ts — mobile uses
   * this to enable/disable the cup/tbsp/tsp unit chips. False means the
   * picker should fall back to g/oz/serving only.
   */
  supports_volume_units: boolean;
  cup_grams?: number;
  tbsp_grams?: number;
  tsp_grams?: number;
  /**
   * FOOD-1-BE (R3): a basic food — USDA Foundation or SR Legacy, or the seeded
   * common-foods catalog. Search ranks its whole-word matches first.
   */
  basic_food: boolean;
}

// Tags on stored rows: the seed importer's and the USDA importer's marks.
const SEED_TAG = 'seed:common-foods';
const BASIC_TAG = 'basic-food';
const CATEGORY_TAG = 'category:';

/**
 * R1 (no guessed portions): volume chips only with a weight from the food's
 * own household measure or the density table for its real category.
 */
function portionFields(measure: string, grams: number, category: string | null, name: string | null) {
  const w = volumeWeightsFor(measure, grams, category, name);
  return {
    supports_volume_units: w !== null,
    cup_grams: w?.cup_grams,
    tbsp_grams: w?.tbsp_grams,
    tsp_grams: w?.tsp_grams,
  };
}

/**
 * UX-FOOD-PRIV-124: rows a signed-in caller may see — the shared catalog
 * (no creator) and their own custom foods. A custom food is private.
 */
function visibleFoodsWhere(viewerId: string): Prisma.FoodItemWhereInput {
  return { OR: [{ created_by_user_id: null }, { created_by_user_id: viewerId }] };
}

function canSeeFood(item: { created_by_user_id?: string | null }, viewerId: string): boolean {
  return item.created_by_user_id == null || item.created_by_user_id === viewerId;
}

/** Words of a name or query, lowercased, a plain plural folded ("eggs" -> "egg"). */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}%]+/u)
    .filter(Boolean)
    .map((w) => {
      if (w.length <= 3) return w;
      if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
      if (w.endsWith('oes')) return w.slice(0, -2);
      return w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
    });
}

const startsWithWords = (list: string[], q: string[]) => q.every((w, i) => list[i] === w);
const sameWords = (list: string[], q: string[]) => list.length === q.length && startsWithWords(list, q);
const containsRun = (list: string[], q: string[]) =>
  list.some((_, i) => startsWithWords(list.slice(i), q));

function isBranded(item: FoodResult): boolean {
  return !!item.brand_or_restaurant || item.id.startsWith('off_') || (item.tags ?? []).some((t) => t.startsWith('off:'));
}

/**
 * Match quality of a name for the query. `whole`: every query word is a whole
 * word of the name ("egg" is not in "eggplant"). USDA names lead with the food
 * ("Bananas, raw"), so the part before the first comma counts as the name.
 */
function matchOf(item: FoodResult, rawQuery: string): { score: number; whole: boolean } {
  const q = words(rawQuery);
  const name = words(item.name);
  const head = words(item.name.split(',')[0]);
  const whole = q.length > 0 && q.every((w) => name.includes(w));
  if (sameWords(name, q) || sameWords(head, q)) return { score: 100, whole };
  if (startsWithWords(head, q)) return { score: 80, whole };
  if (containsRun(name, q)) return { score: 60, whole };
  if (whole) return { score: 40, whole };
  const text = item.name.toLowerCase();
  if (text.includes(rawQuery.toLowerCase().trim())) return { score: 20, whole };
  if (q.every((w) => text.includes(w))) return { score: 15, whole };
  const aliases = words([...(item.tags || []), ...(item.search_aliases || [])].join(' '));
  return { score: q.some((w) => aliases.includes(w)) ? 10 : 5, whole };
}

/**
 * R5 (LS-FOOD B5): one food, not one name. Same name with another brand,
 * barcode / USDA id or calories is another food. A stored import carries its
 * source tag (usda:<fdcId>, off:<barcode>), so it still meets its upstream row.
 */
function identityOf(item: FoodResult): string {
  // FR-1198 (LS-1198 B2): a stored row with no upstream source (a custom or
  // seeded food) is its own food, so its id is its identity; two custom foods
  // with one name and calories but other macros both stay.
  const source = /^(usda|off)_/.test(item.id)
    ? item.id.replace('_', ':')
    : (item.tags ?? []).find((t) => /^(usda|off):/.test(t)) ?? `id:${item.id}`;
  const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return [norm(item.name), norm(item.brand_or_restaurant), Math.round(Number(item.calories)), source].join('|');
}

// USDA names the plain form of a food "..., raw" or "..., whole" ("Bananas, raw",
// "Eggs, Grade A, Large, egg whole"); among equal matches it comes before a part
// of the food ("egg yolk") or a prepared form. FR-1198 (LO-1198 C3): "whole"
// counts only as its own comma part ("Milk, whole") or "egg whole", not inside
// "whole grain" or "whole milk".
const PLAIN_PARTS = new Set(['whole', 'egg whole']);
const plainForm = (item: FoodResult) =>
  words(item.name).includes('raw') || item.name.split(',').some((part) => PLAIN_PARTS.has(words(part).join(' ')))
    ? 1
    : 0;

/**
 * De-duplicate by food identity (the first source listed wins), then rank.
 * R3 (LO-FOOD B1): whole-word matches come first, a basic food before any
 * other unbranded food before a branded one, then the rest by match quality.
 * FR-1198 (LS-1198 B1, LO-1198 B1): ahead of all of those, an unbranded row
 * named for the food (score 80 or more: the query leads the name before its
 * first comma) comes before an unbranded row that only mentions it
 * ("Oatmeal, NFS" before "Bread, oatmeal"), whatever its USDA data type. The
 * plain form, shorter names and then A-Z break ties.
 */
function rankFoodResults(items: FoodResult[], q: string, limit: number): FoodResult[] {
  const byIdentity = new Map<string, FoodResult>();
  for (const item of items) {
    const key = identityOf(item);
    const kept = byIdentity.get(key);
    if (!kept) byIdentity.set(key, item);
    else if (item.basic_food && !kept.basic_food) byIdentity.set(key, { ...kept, basic_food: true });
  }

  const scored = [...byIdentity.values()].map((item) => {
    const { score, whole } = matchOf(item, q);
    const tier = item.basic_food ? 2 : isBranded(item) ? 0 : 1;
    const named = whole && tier > 0 && score >= 80 ? 1 : 0;
    return { item, score, named, group: whole ? tier : 0 };
  });
  scored.sort(
    (a, b) =>
      b.named - a.named ||
      b.group - a.group ||
      b.score - a.score ||
      plainForm(b.item) - plainForm(a.item) ||
      a.item.name.length - b.item.name.length ||
      a.item.name.localeCompare(b.item.name),
  );

  return scored.slice(0, limit).map((s) => s.item);
}

// 24h TTL on cached search results — USDA/OFF data is effectively static at
// the per-day level and the upstream APIs are slow + rate-limited.
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// v2 (FOOD-1-BE): new order, portions and basic_food; v1 entries are ignored.
const SEARCH_CACHE_KEY_PREFIX = 'food:search:v2:';
// R2's label "100 g", with a no-break space so the number and unit stay on one line.
export const HUNDRED_GRAMS = '100\u00a0g';

/** Throws on an upstream answer we must not keep; a 404 is "nothing found", as before. */
function upstreamFailed(response: Response, source: string): void {
  if (!response.ok && response.status !== 404) throw new Error(`${source} search failed: ${response.status}`);
}

@Injectable()
export class FoodService implements OnModuleInit {
  private readonly logger = new Logger(FoodService.name);

  /** ioredis client when REDIS_URL is set; null otherwise (in-memory fallback only). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any | null = null;

  /**
   * In-process fallback cache for environments without Redis (unit tests, dev
   * boxes without a local Redis). Capped at 200 entries.
   */
  private readonly memoryCache = new Map<string, { value: FoodSearchResponse; expiresAt: number }>();
  private readonly memoryCacheMax = 200;

  constructor(
    private prisma: PrismaService,
    private readonly config?: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config?.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.log('FoodService: REDIS_URL unset — using in-memory search cache (200 entries, 24h TTL)');
      return;
    }
    try {
      // Lazy import so unit tests and dev boots without ioredis still work.
      const { default: Redis } = await import('ioredis');
      this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await this.redis.connect();
      this.logger.log('FoodService: Redis search cache connected');
    } catch (err) {
      this.logger.warn(`FoodService: Redis unavailable, falling back to in-memory cache: ${(err as Error).message}`);
      this.redis = null;
    }
  }

  /**
   * UX-FOOD-PRIV-124: `viewerId` is the signed-in caller. They see the shared
   * catalog (created_by_user_id null: seeded, USDA, OpenFoodFacts) plus their
   * own custom foods, never another person's. The search cache holds shared
   * results only; the caller's own foods are read per request.
   */
  async search(query: string, limit: number, viewerId: string): Promise<FoodSearchResponse> {
    const rawQ = (query || '').trim();

    if (!rawQ || rawQ.length < 2) {
      const defaults = await this.prisma.foodItem.findMany({
        where: visibleFoodsWhere(viewerId),
        take: limit,
        orderBy: { name: 'asc' },
      });
      return {
        results: defaults.map(this.toResult),
        suggestions: [],
        did_you_mean: false,
        query: rawQ,
      };
    }

    // 1) Parse natural-language quantity/unit out of the query so users can
    //    type "6oz chicken breast" and get usable results.
    const parsed = parseFoodQuery(rawQ);
    const q = parsed.foodName || rawQ;

    // 2) The caller's own custom foods: per request, never cached.
    const ownPromise = this.searchLocalDB(q, 10, viewerId);

    // 3) Shared results, cache first — keyed off the *parsed* food name so
    //    "chicken breast" and "6oz chicken breast" share a cache entry.
    const cacheKey = `${SEARCH_CACHE_KEY_PREFIX}${q.toLowerCase()}`;
    const cached = await this.getCachedSearch(cacheKey);
    const shared = cached ? cached.results : await this.searchShared(q, limit, cacheKey);

    // Own foods first on a name tie, then the same relevance order as before.
    const results = rankFoodResults([...(await ownPromise), ...shared], q, limit);

    return {
      results,
      suggestions: [],
      did_you_mean: false,
      query: rawQ,
      parsed_quantity: parsed.quantity,
      parsed_unit: parsed.unit,
    };
  }

  /** USDA + OpenFoodFacts + the shared local catalog, ranked and cached. */
  private async searchShared(q: string, limit: number, cacheKey: string): Promise<FoodResult[]> {
    // Run all 3 sources in parallel
    const settled = await Promise.allSettled([
      this.searchUSDA(q, 20),
      this.searchOpenFoodFacts(q, 20),
      this.searchLocalDB(q, 10, null),
    ]);
    const [usda, off, local] = settled.map((r) => (r.status === 'fulfilled' ? r.value : []));

    // Merge: local catalog first, then USDA (reliable nutrition), then OFF (images)
    const results = rankFoodResults([...local, ...usda, ...off], q, limit);

    // R4 (LS-FOOD B4): a failed or timed-out upstream is not an answer. Keep
    // this list out of the cache so the next search asks again; a real
    // (possibly empty) answer from every source is cached as before.
    if (settled.some((r) => r.status === 'rejected')) return results;

    // Cache the merged+scored shared list (sans the query echo / parsed_*
    // fields, which are rebuilt per-call so callers with different leading
    // quantities still see their own parse). Never holds a custom food.
    await this.setCachedSearch(cacheKey, {
      results,
      suggestions: [],
      did_you_mean: false,
      query: q,
    });

    return results;
  }

  /** Redis GET with in-memory fallback. Returns null on miss or any error. */
  private async getCachedSearch(key: string): Promise<FoodSearchResponse | null> {
    try {
      if (this.redis) {
        const raw = await this.redis.get(key);
        if (raw) return JSON.parse(raw) as FoodSearchResponse;
        return null;
      }
      const entry = this.memoryCache.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        this.memoryCache.delete(key);
        return null;
      }
      return entry.value;
    } catch {
      return null;
    }
  }

  /** Redis SETEX with in-memory fallback. Failures are non-fatal. */
  private async setCachedSearch(key: string, value: FoodSearchResponse): Promise<void> {
    try {
      if (this.redis) {
        await this.redis.set(key, JSON.stringify(value), 'PX', SEARCH_CACHE_TTL_MS);
        return;
      }
      if (this.memoryCache.size >= this.memoryCacheMax) {
        const oldest = this.memoryCache.keys().next().value;
        if (oldest !== undefined) this.memoryCache.delete(oldest);
      }
      this.memoryCache.set(key, { value, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
    } catch {
      // Cache writes are best-effort.
    }
  }

  /**
   * Local rows matching the query. `ownerId` null: the shared catalog only
   * (cacheable); a user id: that user's own custom foods only.
   */
  private async searchLocalDB(query: string, limit: number, ownerId: string | null): Promise<FoodResult[]> {
    const owner =
      ownerId === null
        ? Prisma.sql`"created_by_user_id" IS NULL`
        : Prisma.sql`"created_by_user_id" = ${ownerId}`;
    try {
      const trgmResults = await this.prisma.$queryRaw<FoodItemRow[]>`
        SELECT
          id, name, brand_or_restaurant, category, serving_description,
          serving_size_grams, calories, protein_g, carbs_g, fat_g,
          fiber_g, sugar_g, sodium_mg, tags, search_aliases, image_url,
          nutrient_basis,
          similarity(
            lower(name) || ' ' ||
            lower(coalesce(brand_or_restaurant, '')) || ' ' ||
            lower(array_to_string(search_aliases, ' ')),
            lower(${query})
          ) AS score
        FROM "FoodItem"
        WHERE ${owner} AND
          similarity(
            lower(name) || ' ' ||
            lower(coalesce(brand_or_restaurant, '')) || ' ' ||
            lower(array_to_string(search_aliases, ' ')),
            lower(${query})
          ) > 0.08
        ORDER BY score DESC
        LIMIT ${limit}
      `;
      return trgmResults.map(this.toResult);
    } catch {
      // pg_trgm not installed — try ILIKE fallback
      try {
        const likeQ = `%${query}%`;
        const ilikeResults = await this.prisma.$queryRaw<FoodItemRow[]>`
          SELECT DISTINCT
            id, name, brand_or_restaurant, category, serving_description,
            serving_size_grams, calories, protein_g, carbs_g, fat_g,
            fiber_g, sugar_g, sodium_mg, tags, search_aliases, image_url,
            nutrient_basis
          FROM "FoodItem"
          WHERE ${owner} AND (
            lower(name) LIKE lower(${likeQ})
            OR lower(coalesce(brand_or_restaurant, '')) LIKE lower(${likeQ})
            OR EXISTS (
              SELECT 1 FROM unnest(search_aliases) AS alias
              WHERE lower(alias) LIKE lower(${likeQ})
            )
          )
          ORDER BY
            CASE WHEN lower(name) LIKE lower(${likeQ}) THEN 0 ELSE 1 END,
            name
          LIMIT ${limit}
        `;
        return ilikeResults.map(this.toResult);
      } catch {
        return [];
      }
    }
  }

  private async searchUSDA(query: string, limit: number = 20): Promise<FoodResult[]> {
    // USDA_API_KEY is required — validated at boot in main.ts. DEMO_KEY was a shared
    // 30-req/hr-per-IP bucket that silently returned [] under any real user volume.
    const apiKey = process.env.USDA_API_KEY;
    if (!apiKey) return [];
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=${Math.min(limit, 25)}&api_key=${apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    // A failure or timeout throws (R4): searchShared then skips the cache.
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TheGrowthProject/1.0' },
      });
      upstreamFailed(response, 'USDA');
      if (!response.ok) return [];

      const data = (await response.json()) as UsdaSearchResponse;
      const foods: UsdaFood[] = data?.foods || [];

      return foods
        .filter((f) => f.description && f.description.trim())
        .slice(0, limit)
        .map((f) => this.mapUSDAFood(f));
    } finally {
      clearTimeout(timeout);
    }
  }

  private mapUSDAFood(food: UsdaFood): FoodResult {
    const nutrients: UsdaNutrient[] = food.foodNutrients || [];

    const getNutrient = (name: string, unit?: string): number => {
      const match = nutrients.find(
        (n) => {
          const nutrientName = n.nutrientName ?? n.name ?? n.nutrient?.name;
          const nutrientUnit = n.unitName ?? n.nutrient?.unitName;
          const nameMatches = nutrientName === name ||
            (name === 'Carbohydrate, by difference' && nutrientName === 'Carbohydrates, by difference');
          return nameMatches && (!unit || nutrientUnit?.toLowerCase() === unit.toLowerCase());
        },
      );
      return match ? Math.round((match.value ?? match.amount ?? 0) * 10) / 10 : 0;
    };

    const calories = getNutrient('Energy', 'KCAL') ||
      getNutrient('Energy (Atwater General Factors)', 'KCAL') ||
      getNutrient('Energy (Atwater Specific Factors)', 'KCAL') ||
      Math.round(getNutrient('Energy', 'kJ') / 4.184);
    const protein = getNutrient('Protein');
    const carbs = getNutrient('Carbohydrate, by difference');
    const fat = getNutrient('Total lipid (fat)');
    const fiber = getNutrient('Fiber, total dietary');
    const sugar = getNutrient('Sugars, total including NLEA') || getNutrient('Sugars, total');
    const sodium = getNutrient('Sodium, Na');

    // R2 (LO-FOOD B2): with no package serving the portion is 100 g, so it is
    // called "100 g", never "1 serving".
    const servingDesc = food.householdServingFullText ||
      (food.servingSize ? `${food.servingSize}${food.servingSizeUnit || 'g'}` : HUNDRED_GRAMS);

    // CANONICAL BASIS: USDA FDC's `foodNutrients[].value` is reported per 100g
    // for Foundation / SR Legacy / Branded entries. We keep that basis verbatim
    // (nutrient_basis = PER_100G) and store `serving_size_grams` separately so
    // mobile can multiply (grams_consumed / 100) * macros. The previous bug was
    // that mobile assumed the macros were per-serving, which 3.5x'd almonds.
    // Do NOT scale macros here — that's mobile's job, based on nutrient_basis.
    const category = (typeof food.foodCategory === 'string'
      ? food.foodCategory
      : food.foodCategory?.description) || 'generic';
    return {
      id: `usda_${food.fdcId}`,
      name: food.description.trim(),
      brand_or_restaurant: food.brandOwner?.trim() || null,
      category,
      serving_description: servingDesc,
      serving_size_grams: food.servingSize || 100,
      calories: Math.round(calories),
      protein_g: protein,
      carbs_g: carbs,
      fat_g: fat,
      fiber_g: fiber || null,
      sugar_g: sugar || null,
      sodium_mg: sodium ? Math.round(sodium) : null,
      tags: [],
      search_aliases: [],
      image_url: null,
      nutrient_basis: 'PER_100G',
      // R1: its own household measure ("1/2 cup" of servingSize g), else its
      // USDA category's density, else no volume.
      ...portionFields(servingDesc, food.servingSize || 100, category, food.description),
      basic_food: food.dataType === 'Foundation' || food.dataType === 'SR Legacy',
    };
  }

  /**
   * Search OpenFoodFacts API and map results to FoodResult shape.
   */
  private async searchOpenFoodFacts(query: string, limit: number = 20): Promise<FoodResult[]> {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=${Math.min(limit, 40)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    // A failure or timeout throws (R4): searchShared then skips the cache.
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TheGrowthProject/1.0' },
      });
      upstreamFailed(response, 'OpenFoodFacts');
      if (!response.ok) return [];

      const data = (await response.json()) as OpenFoodFactsSearchResponse;
      const products: OpenFoodFactsProduct[] = data?.products || [];

      return products
        .filter((p) => {
          // Filter out products with no name or no nutrition data
          if (!p.product_name || !p.product_name.trim()) return false;
          const n = p.nutriments || {};
          const cals = n['energy-kcal_100g'] ?? (n['energy_100g'] ? n['energy_100g'] / 4.184 : null);
          return cals != null && cals > 0;
        })
        .slice(0, limit)
        .map((p) => this.mapOpenFoodFactsProduct(p));
    } finally {
      clearTimeout(timeout);
    }
  }

  private mapOpenFoodFactsProduct(product: OpenFoodFactsProduct): FoodResult {
    const n: OpenFoodFactsNutriments = product.nutriments || {};
    const energyKcal = n['energy-kcal_100g'];
    const energyKj = n['energy_100g'];
    const calories = energyKcal ?? (energyKj != null ? energyKj / 4.184 : 0);
    const fiber = n['fiber_100g'];
    const sugars = n['sugars_100g'];
    const sodium = n['sodium_100g'];

    // CANONICAL BASIS: OpenFoodFacts returns *_100g fields per 100g. Same
    // contract as mapUSDAFood — store the per-100g macro verbatim, set
    // nutrient_basis = PER_100G, and let mobile scale by grams_consumed.
    return {
      id: `off_${product.code || product._id || Math.random().toString(36).slice(2)}`,
      name: (product.product_name || '').trim(),
      brand_or_restaurant: product.brands?.split(',')[0]?.trim() || null,
      category: 'generic',
      serving_description: '100g',
      serving_size_grams: 100,
      calories: Math.round(calories),
      protein_g: Math.round((n['proteins_100g'] ?? 0) * 10) / 10,
      carbs_g: Math.round((n['carbohydrates_100g'] ?? 0) * 10) / 10,
      fat_g: Math.round((n['fat_100g'] ?? 0) * 10) / 10,
      fiber_g: fiber != null ? Math.round(fiber * 10) / 10 : null,
      sugar_g: sugars != null ? Math.round(sugars * 10) / 10 : null,
      sodium_mg: sodium != null ? Math.round(sodium * 1000) : null,
      tags: [],
      search_aliases: [],
      image_url: product.image_front_small_url || null,
      nutrient_basis: 'PER_100G',
      // R1 (LO-FOOD B3): a product row has no household measure or category
      // density here, so no cup / tbsp / tsp — grams and ounces only.
      ...portionFields('100g', 100, null, null),
      basic_food: false,
    };
  }

  /** Another person's custom food reads as not found (null), like a missing id. */
  async getById(id: string, viewerId: string) {
    const item = await this.prisma.foodItem.findUnique({ where: { id } });
    return item && canSeeFood(item, viewerId) ? this.toResult(item) : null;
  }

  /**
   * Look up a food by UPC barcode via OpenFoodFacts.
   * Caches the result in FoodItem so subsequent lookups are instant.
   * Returns the resolved FoodItem.id.
   */
  async lookupByBarcode(upc: string, viewerId: string): Promise<string> {
    return this.upsertFromOpenFoodFacts(upc, viewerId);
  }

  /**
   * POST /foods — a custom food, private to `creatorId` (UX-FOOD-PRIV-124).
   * The only path that sets created_by_user_id; imports stay shared.
   */
  async create(data: import('./food.dto').CreateFoodDto, creatorId: string) {
    // Explicit field mapping — previously spread the whole body into
    // prisma.foodItem.create, which would let a client set `id`, `created_at`,
    // or arbitrary extra columns. See audit C4. Only DTO-whitelisted fields
    // reach the database.
    return this.prisma.foodItem.create({
      data: {
        name: data.name,
        brand_or_restaurant: data.brand_or_restaurant,
        category: data.category ?? 'generic',
        serving_description: data.serving_description,
        serving_size_grams: data.serving_size_grams,
        nutrient_basis: data.nutrient_basis ?? 'PER_100G',
        calories: data.calories,
        protein_g: data.protein_g,
        carbs_g: data.carbs_g,
        fat_g: data.fat_g,
        saturated_fat_g: data.saturated_fat_g,
        mono_fat_g: data.mono_fat_g,
        poly_fat_g: data.poly_fat_g,
        fiber_g: data.fiber_g,
        sugar_g: data.sugar_g,
        sodium_mg: data.sodium_mg,
        tags: data.tags ?? [],
        search_aliases: data.search_aliases ?? [],
        image_url: data.image_url,
        barcode: data.barcode,
        created_by_user_id: creatorId,
      },
    });
  }

  /**
   * Resolve a (possibly synthetic) food id to a real FoodItem.id.
   *
   * The mobile client can hand us:
   *  - a real uuid from our FoodItem table (pass-through after existence check)
   *  - "usda_<fdcId>"  — USDA FDC external id (fetched + upserted)
   *  - "off_<code>"    — OpenFoodFacts barcode (fetched + upserted)
   *
   * Synthetic ids broke LoggedFoodEntry.food_item_id's FK to FoodItem. Upserting
   * into FoodItem first (keyed by barcode for OFF, by a "usda_*" alias for USDA)
   * gives us a real primary key we can reference without schema changes.
   */
  async resolveOrImportId(id: string, viewerId: string): Promise<string> {
    if (!id) throw new Error('food_item_id is required');

    if (id.startsWith('usda_')) {
      const fdcId = id.slice(5);
      return this.upsertFromUSDA(fdcId);
    }

    if (id.startsWith('off_')) {
      const code = id.slice(4);
      return this.upsertFromOpenFoodFacts(code, viewerId);
    }

    // Assume real uuid — verify it exists to surface a clean 404 before the FK explodes.
    // Another person's custom food is reported exactly like a missing id.
    const existing = await this.prisma.foodItem.findUnique({ where: { id } });
    if (!existing || !canSeeFood(existing, viewerId)) throw new Error(`FoodItem ${id} not found`);
    return existing.id;
  }

  private async upsertFromUSDA(fdcId: string): Promise<string> {
    // Use tags array with "usda:<fdcId>" as the idempotency key — no schema change needed.
    const tag = `usda:${fdcId}`;
    // Shared rows only: a custom food may carry any tag, so it never stands in
    // for a USDA import.
    const existing = await this.prisma.foodItem.findFirst({
      where: { tags: { has: tag }, created_by_user_id: null },
    });
    if (existing) return existing.id;

    const apiKey = process.env.USDA_API_KEY;
    if (!apiKey) throw new Error('USDA_API_KEY is not configured');

    const url = `https://api.nal.usda.gov/fdc/v1/food/${encodeURIComponent(fdcId)}?api_key=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let food: UsdaFood;
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TheGrowthProject/1.0' },
      });
      if (!response.ok) throw new Error(`USDA fetch failed: ${response.status}`);
      food = (await response.json()) as UsdaFood;
    } finally {
      clearTimeout(timeout);
    }

    const mapped = this.mapUSDAFood(food);
    // Guard against mid-flush races: if two concurrent flush calls try to
    // create the same USDA item, the second create will throw a unique
    // constraint violation on the tags GIN index (not available as a Prisma
    // upsert key). Catch that case and fall back to a fresh findFirst.
    try {
      const created = await this.prisma.foodItem.create({
        data: {
          name: mapped.name,
          brand_or_restaurant: mapped.brand_or_restaurant,
          category: 'generic',
          serving_description: mapped.serving_description,
          serving_size_grams: mapped.serving_size_grams,
          calories: mapped.calories,
          protein_g: mapped.protein_g,
          carbs_g: mapped.carbs_g,
          fat_g: mapped.fat_g,
          fiber_g: mapped.fiber_g,
          sugar_g: mapped.sugar_g,
          sodium_mg: mapped.sodium_mg,
          // The USDA category and basic mark, so the stored row offers the
          // same portions and rank as its search row (R1, R3).
          tags: [
            tag,
            ...(mapped.category !== 'generic' ? [`${CATEGORY_TAG}${mapped.category}`] : []),
            ...(mapped.basic_food ? [BASIC_TAG] : []),
          ],
          search_aliases: [],
          image_url: mapped.image_url,
        },
      });
      return created.id;
    } catch (err) {
      // P2002 = Prisma unique constraint violation — a concurrent flush already
      // inserted this row. Re-query to get the winning row's id.
      if ((err as { code?: string }).code === 'P2002') {
        const race = await this.prisma.foodItem.findFirst({
          where: { tags: { has: tag }, created_by_user_id: null },
        });
        if (race) return race.id;
      }
      throw err;
    }
  }

  private async upsertFromOpenFoodFacts(code: string, viewerId: string): Promise<string> {
    // Barcode is unique across shared and custom rows. A row already holding it
    // answers directly; another person's custom food reads as not found.
    const held = await this.prisma.foodItem.findUnique({ where: { barcode: code } });
    if (held) {
      if (!canSeeFood(held, viewerId)) throw new Error(`OpenFoodFacts product ${code} not found`);
      return held.id;
    }

    // Barcode is unique in FoodItem — use a true Prisma upsert so concurrent
    // flush calls don't race to create a duplicate row (Fix 3).
    const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let payload: OpenFoodFactsProductResponse;
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TheGrowthProject/1.0' },
      });
      if (!response.ok) throw new Error(`OpenFoodFacts fetch failed: ${response.status}`);
      payload = (await response.json()) as OpenFoodFactsProductResponse;
    } finally {
      clearTimeout(timeout);
    }

    if (!payload?.product) throw new Error(`OpenFoodFacts product ${code} not found`);
    const mapped = this.mapOpenFoodFactsProduct(payload.product);

    // upsert on barcode (unique) — no-op update so a race just returns the
    // existing row's id rather than throwing a unique constraint violation.
    const upserted = await this.prisma.foodItem.upsert({
      where: { barcode: code },
      create: {
        name: mapped.name,
        brand_or_restaurant: mapped.brand_or_restaurant,
        category: 'generic',
        serving_description: mapped.serving_description,
        serving_size_grams: mapped.serving_size_grams,
        calories: mapped.calories,
        protein_g: mapped.protein_g,
        carbs_g: mapped.carbs_g,
        fat_g: mapped.fat_g,
        fiber_g: mapped.fiber_g,
        sugar_g: mapped.sugar_g,
        sodium_mg: mapped.sodium_mg,
        tags: [`off:${code}`],
        search_aliases: [],
        image_url: mapped.image_url,
        barcode: code,
      },
      update: {}, // no-op if the row already exists
    });
    return upserted.id;
  }

  /** Normalize a raw DB row or Prisma object to FoodResult shape */
  private toResult = (item: FoodItemRow): FoodResult => {
    const tags = item.tags ?? [];
    const grams = Number(item.serving_size_grams);
    // R2: a USDA import stored before FOOD-1-BE says "1 serving" for 100 g.
    const serving =
      item.serving_description === '1 serving' && grams === 100 && tags.some((t) => t.startsWith('usda:'))
        ? HUNDRED_GRAMS
        : item.serving_description;
    // R1: the row's own household measure, else its real category (seeded and
    // USDA-imported rows keep it as a category:<name> tag), else none.
    const category = tags.find((t) => t.startsWith(CATEGORY_TAG))?.slice(CATEGORY_TAG.length) ?? item.category;
    return {
      id: item.id,
      name: item.name,
      brand_or_restaurant: item.brand_or_restaurant ?? null,
      category: item.category,
      serving_description: serving,
      serving_size_grams: grams,
      calories: Number(item.calories),
      protein_g: Number(item.protein_g),
      carbs_g: Number(item.carbs_g),
      fat_g: Number(item.fat_g),
      fiber_g: item.fiber_g != null ? Number(item.fiber_g) : null,
      sugar_g: item.sugar_g != null ? Number(item.sugar_g) : null,
      sodium_mg: item.sodium_mg != null ? Number(item.sodium_mg) : null,
      tags,
      search_aliases: item.search_aliases ?? [],
      image_url: item.image_url ?? null,
      // Default for legacy rows / raw query paths that don't select the column:
      // PER_100G matches the assumption the rest of the system already makes.
      nutrient_basis: item.nutrient_basis ?? 'PER_100G',
      ...portionFields(item.serving_description, grams, category, item.name),
      basic_food: tags.includes(SEED_TAG) || tags.includes(BASIC_TAG),
    };
  };
}
