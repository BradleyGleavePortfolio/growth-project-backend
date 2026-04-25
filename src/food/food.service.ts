import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface FoodSearchResponse {
  results: FoodResult[];
  suggestions: FoodResult[];
  did_you_mean: boolean;
  query: string;
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
}

@Injectable()
export class FoodService {
  private readonly logger = new Logger(FoodService.name);

  constructor(private prisma: PrismaService) {}

  async search(query: string, limit: number = 50): Promise<FoodSearchResponse> {
    const q = (query || '').trim();

    if (!q || q.length < 2) {
      const defaults = await this.prisma.foodItem.findMany({
        take: limit,
        orderBy: { name: 'asc' },
      });
      return {
        results: defaults.map(this.toResult),
        suggestions: [],
        did_you_mean: false,
        query: q,
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

    return {
      results,
      suggestions: [],
      did_you_mean: false,
      query: q,
    };
  }

  private async searchLocalDB(query: string, limit: number): Promise<FoodResult[]> {
    try {
      const trgmResults = await this.prisma.$queryRaw<any[]>`
        SELECT
          id, name, brand_or_restaurant, category, serving_description,
          serving_size_grams, calories, protein_g, carbs_g, fat_g,
          fiber_g, sugar_g, sodium_mg, tags, search_aliases, image_url,
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
        const ilikeResults = await this.prisma.$queryRaw<any[]>`
          SELECT DISTINCT
            id, name, brand_or_restaurant, category, serving_description,
            serving_size_grams, calories, protein_g, carbs_g, fat_g,
            fiber_g, sugar_g, sodium_mg, tags, search_aliases, image_url
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

      const data = await response.json();
      const foods: any[] = data?.foods || [];

      return foods
        .filter(f => f.description && f.description.trim())
        .slice(0, limit)
        .map(f => this.mapUSDAFood(f));
    } catch {
      clearTimeout(timeout);
      return [];
    }
  }

  private mapUSDAFood(food: any): FoodResult {
    const nutrients = food.foodNutrients || [];

    const getNutrient = (name: string, unit?: string): number => {
      const match = nutrients.find((n: any) =>
        n.nutrientName === name && (!unit || n.unitName === unit)
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

    return {
      id: `usda_${food.fdcId}`,
      name: food.description.trim(),
      brand_or_restaurant: food.brandOwner?.trim() || null,
      category: food.foodCategory || 'generic',
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

      const data = await response.json();
      const products: any[] = data?.products || [];

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

  private mapOpenFoodFactsProduct(product: any): FoodResult {
    const n = product.nutriments || {};
    const calories = n['energy-kcal_100g'] ?? (n['energy_100g'] ? n['energy_100g'] / 4.184 : 0);

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
      fiber_g: n['fiber_100g'] != null ? Math.round(n['fiber_100g'] * 10) / 10 : null,
      sugar_g: n['sugars_100g'] != null ? Math.round(n['sugars_100g'] * 10) / 10 : null,
      sodium_mg: n['sodium_100g'] != null ? Math.round(n['sodium_100g'] * 1000) : null,
      tags: [],
      search_aliases: [],
      image_url: product.image_front_small_url || null,
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
    let food: any;
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TheGrowthProject/1.0' },
      });
      if (!response.ok) throw new Error(`USDA fetch failed: ${response.status}`);
      food = await response.json();
    } finally {
      clearTimeout(timeout);
    }

    const mapped = this.mapUSDAFood(food);
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
  }

  private async upsertFromOpenFoodFacts(code: string): Promise<string> {
    // Barcode is unique in FoodItem — use upsert by barcode for idempotency.
    const existing = await this.prisma.foodItem.findUnique({ where: { barcode: code } });
    if (existing) return existing.id;

    const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let payload: any;
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TheGrowthProject/1.0' },
      });
      if (!response.ok) throw new Error(`OpenFoodFacts fetch failed: ${response.status}`);
      payload = await response.json();
    } finally {
      clearTimeout(timeout);
    }

    if (!payload?.product) throw new Error(`OpenFoodFacts product ${code} not found`);
    const mapped = this.mapOpenFoodFactsProduct(payload.product);

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
        tags: [`off:${code}`],
        search_aliases: [],
        image_url: mapped.image_url,
        barcode: code,
      },
    });
    return created.id;
  }

  /** Normalize a raw DB row or Prisma object to FoodResult shape */
  private toResult = (item: any): FoodResult => ({
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
  });
}
