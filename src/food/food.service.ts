import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { supportsVolumeUnits } from './food-density';
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
  unitName?: string;
  value?: number;
}

interface UsdaFood {
  fdcId: number | string;
  description: string;
  foodNutrients?: UsdaNutrient[];
  brandOwner?: string;
  foodCategory?: string;
  householdServingFullText?: string;
  servingSize?: number;
  servingSizeUnit?: string;
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
}

// 24h TTL on cached search results — USDA/OFF data is effectively static at
// the per-day level and the upstream APIs are slow + rate-limited.
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_CACHE_KEY_PREFIX = 'food:search:v1:';

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

  async search(query: string, limit: number = 50): Promise<FoodSearchResponse> {
    const rawQ = (query || '').trim();

    if (!rawQ || rawQ.length < 2) {
      const defaults = await this.prisma.foodItem.findMany({
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

    // 2) Cache check — keyed off the *parsed* food name so "chicken breast"
    //    and "6oz chicken breast" share a cache entry.
    const cacheKey = `${SEARCH_CACHE_KEY_PREFIX}${q.toLowerCase()}`;
    const cached = await this.getCachedSearch(cacheKey);
    if (cached) {
      // Splice parser output back in even on a cache hit so mobile can pre-fill.
      return {
        ...cached,
        query: rawQ,
        parsed_quantity: parsed.quantity,
        parsed_unit: parsed.unit,
      };
    }

    // Run all 3 sources in parallel
    const [usdaResults, offResults, localResults] = await Promise.allSettled([
      this.searchUSDA(q, 20),
      this.searchOpenFoodFacts(q, 20),
      this.searchLocalDB(q, 10),
    ]);

    const usda = usdaResults.status === 'fulfilled' ? usdaResults.value : [];
    const off = offResults.status === 'fulfilled' ? offResults.value : [];
    const local = localResults.status === 'fulfilled' ? localResults.value : [];

    // Merge: local first (user's own foods), then USDA (reliable nutrition), then OFF (images)
    const merged: FoodResult[] = [];
    const seen = new Set<string>();

    const addUnique = (items: FoodResult[]) => {
      for (const item of items) {
        const key = item.name.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(item);
        }
      }
    };

    addUnique(local);
    addUnique(usda);
    addUnique(off);

    // ── Weighted relevance scoring ──────────────────────────────────────────
    const scoreResult = (item: FoodResult, rawQuery: string): number => {
      // Singular/plural normalization: strip trailing 's' for comparison
      const normalize = (s: string) =>
        s.toLowerCase().trim().replace(/\s+/g, ' ').replace(/s$/, '');

      const normalizedName = normalize(item.name);
      const normalizedQuery = normalize(rawQuery);

      let score: number;

      // Exact match
      if (normalizedName === normalizedQuery) {
        score = 100;
      } else if (normalizedName.startsWith(normalizedQuery)) {
        // Starts with
        score = 80;
      } else if (normalizedName.includes(normalizedQuery)) {
        // Contains as whole phrase
        score = 60;
      } else {
        const tokens = normalizedQuery.split(' ');
        if (tokens.every((t) => normalizedName.includes(t))) {
          // All query tokens found in name
          score = 30;
        } else {
          // Found in tags/aliases
          const allText = [
            ...(item.tags || []),
            ...(item.search_aliases || []),
          ]
            .join(' ')
            .toLowerCase();
          if (tokens.some((t) => allText.includes(normalize(t)))) {
            score = 10;
          } else {
            score = 5;
          }
        }
      }

      // Single-ingredient boost: category 'generic' or name is <= 3 words
      const wordCount = item.name.trim().split(/\s+/).length;
      if (item.category === 'generic' || wordCount <= 3) {
        score += 20;
      }

      return score;
    };

    // Score, then sort by score DESC, then alphabetically for ties
    const scored = merged.map((item) => ({
      item,
      score: scoreResult(item, q),
    }));

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.name.localeCompare(b.item.name);
    });

    const results = scored.slice(0, limit).map((s) => s.item);

    const response: FoodSearchResponse = {
      results,
      suggestions: [],
      did_you_mean: false,
      query: rawQ,
      parsed_quantity: parsed.quantity,
      parsed_unit: parsed.unit,
    };

    // Cache the merged+scored list (sans the query echo / parsed_* fields,
    // which are rebuilt per-call so callers with different leading quantities
    // still see their own parse).
    await this.setCachedSearch(cacheKey, {
      results,
      suggestions: [],
      did_you_mean: false,
      query: q,
    });

    return response;
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

  private async searchLocalDB(query: string, limit: number): Promise<FoodResult[]> {
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
        WHERE
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
          WHERE
            lower(name) LIKE lower(${likeQ})
            OR lower(coalesce(brand_or_restaurant, '')) LIKE lower(${likeQ})
            OR EXISTS (
              SELECT 1 FROM unnest(search_aliases) AS alias
              WHERE lower(alias) LIKE lower(${likeQ})
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

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TheGrowthProject/1.0' },
      });
      clearTimeout(timeout);

      if (!response.ok) return [];

      const data = (await response.json()) as UsdaSearchResponse;
      const foods: UsdaFood[] = data?.foods || [];

      return foods
        .filter((f) => f.description && f.description.trim())
        .slice(0, limit)
        .map((f) => this.mapUSDAFood(f));
    } catch {
      clearTimeout(timeout);
      return [];
    }
  }

  private mapUSDAFood(food: UsdaFood): FoodResult {
    const nutrients: UsdaNutrient[] = food.foodNutrients || [];

    const getNutrient = (name: string, unit?: string): number => {
      const match = nutrients.find(
        (n) => n.nutrientName === name && (!unit || n.unitName === unit),
      );
      return match ? Math.round((match.value || 0) * 10) / 10 : 0;
    };

    const calories = getNutrient('Energy', 'KCAL') || Math.round(getNutrient('Energy', 'kJ') / 4.184);
    const protein = getNutrient('Protein');
    const carbs = getNutrient('Carbohydrates, by difference');
    const fat = getNutrient('Total lipid (fat)');
    const fiber = getNutrient('Fiber, total dietary');
    const sugar = getNutrient('Sugars, total including NLEA') || getNutrient('Sugars, total');
    const sodium = getNutrient('Sodium, Na');

    const servingDesc = food.householdServingFullText ||
      (food.servingSize ? `${food.servingSize}${food.servingSizeUnit || 'g'}` : '1 serving');

    // CANONICAL BASIS: USDA FDC's `foodNutrients[].value` is reported per 100g
    // for Foundation / SR Legacy / Branded entries. We keep that basis verbatim
    // (nutrient_basis = PER_100G) and store `serving_size_grams` separately so
    // mobile can multiply (grams_consumed / 100) * macros. The previous bug was
    // that mobile assumed the macros were per-serving, which 3.5x'd almonds.
    // Do NOT scale macros here — that's mobile's job, based on nutrient_basis.
    const category = food.foodCategory || 'generic';
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
      supports_volume_units: supportsVolumeUnits(category),
    };
  }

  /**
   * Search OpenFoodFacts API and map results to FoodResult shape.
   */
  private async searchOpenFoodFacts(query: string, limit: number = 20): Promise<FoodResult[]> {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=${Math.min(limit, 40)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TheGrowthProject/1.0' },
      });
      clearTimeout(timeout);

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
    } catch {
      clearTimeout(timeout);
      return [];
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
      supports_volume_units: supportsVolumeUnits('generic'),
    };
  }

  async getById(id: string) {
    const item = await this.prisma.foodItem.findUnique({ where: { id } });
    return item ? this.toResult(item) : null;
  }

  /**
   * Look up a food by UPC barcode via OpenFoodFacts.
   * Caches the result in FoodItem so subsequent lookups are instant.
   * Returns the resolved FoodItem.id.
   */
  async lookupByBarcode(upc: string): Promise<string> {
    return this.upsertFromOpenFoodFacts(upc);
  }

  async create(data: import('./food.dto').CreateFoodDto) {
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
  async resolveOrImportId(id: string): Promise<string> {
    if (!id) throw new Error('food_item_id is required');

    if (id.startsWith('usda_')) {
      const fdcId = id.slice(5);
      return this.upsertFromUSDA(fdcId);
    }

    if (id.startsWith('off_')) {
      const code = id.slice(4);
      return this.upsertFromOpenFoodFacts(code);
    }

    // Assume real uuid — verify it exists to surface a clean 404 before the FK explodes.
    const existing = await this.prisma.foodItem.findUnique({ where: { id } });
    if (!existing) throw new Error(`FoodItem ${id} not found`);
    return existing.id;
  }

  private async upsertFromUSDA(fdcId: string): Promise<string> {
    // Use tags array with "usda:<fdcId>" as the idempotency key — no schema change needed.
    const tag = `usda:${fdcId}`;
    const existing = await this.prisma.foodItem.findFirst({ where: { tags: { has: tag } } });
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
          tags: [tag],
          search_aliases: [],
          image_url: mapped.image_url,
        },
      });
      return created.id;
    } catch (err) {
      // P2002 = Prisma unique constraint violation — a concurrent flush already
      // inserted this row. Re-query to get the winning row's id.
      if ((err as { code?: string }).code === 'P2002') {
        const race = await this.prisma.foodItem.findFirst({ where: { tags: { has: tag } } });
        if (race) return race.id;
      }
      throw err;
    }
  }

  private async upsertFromOpenFoodFacts(code: string): Promise<string> {
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
  private toResult = (item: FoodItemRow): FoodResult => ({
    id: item.id,
    name: item.name,
    brand_or_restaurant: item.brand_or_restaurant ?? null,
    category: item.category,
    serving_description: item.serving_description,
    serving_size_grams: Number(item.serving_size_grams),
    calories: Number(item.calories),
    protein_g: Number(item.protein_g),
    carbs_g: Number(item.carbs_g),
    fat_g: Number(item.fat_g),
    fiber_g: item.fiber_g != null ? Number(item.fiber_g) : null,
    sugar_g: item.sugar_g != null ? Number(item.sugar_g) : null,
    sodium_mg: item.sodium_mg != null ? Number(item.sodium_mg) : null,
    tags: item.tags ?? [],
    search_aliases: item.search_aliases ?? [],
    image_url: item.image_url ?? null,
    // Default for legacy rows / raw query paths that don't select the column:
    // PER_100G matches the assumption the rest of the system already makes.
    nutrient_basis: item.nutrient_basis ?? 'PER_100G',
    supports_volume_units: supportsVolumeUnits(item.category),
  });
}
