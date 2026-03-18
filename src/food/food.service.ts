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

  async search(query: string, limit: number = 20): Promise<FoodSearchResponse> {
    const q = (query || '').trim();

    // Empty query — return default top foods from local DB or external
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

    // -------------------------------------------------------
    // 1. Try local DB search first (pg_trgm similarity)
    // -------------------------------------------------------
    let localResults: FoodResult[] = [];
    try {
      const trgmResults = await this.prisma.$queryRaw<any[]>`
        SELECT
          id,
          name,
          brand_or_restaurant,
          category,
          serving_description,
          serving_size_grams,
          calories,
          protein_g,
          carbs_g,
          fat_g,
          fiber_g,
          sugar_g,
          sodium_mg,
          tags,
          search_aliases,
          image_url,
          similarity(
            lower(name) || ' ' ||
            lower(coalesce(brand_or_restaurant, '')) || ' ' ||
            lower(array_to_string(search_aliases, ' ')),
            lower(${q})
          ) AS score
        FROM "FoodItem"
        WHERE
          similarity(
            lower(name) || ' ' ||
            lower(coalesce(brand_or_restaurant, '')) || ' ' ||
            lower(array_to_string(search_aliases, ' ')),
            lower(${q})
          ) > 0.08
        ORDER BY score DESC
        LIMIT ${limit}
      `;
      localResults = trgmResults.map(this.toResult);
    } catch (_pgError) {
      // pg_trgm not installed — try ILIKE fallback
      try {
        const likeQ = `%${q}%`;
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
        localResults = ilikeResults.map(this.toResult);
      } catch {
        // DB search failed entirely
      }
    }

    // -------------------------------------------------------
    // 2. If local DB has < 3 results, supplement with OpenFoodFacts
    // -------------------------------------------------------
    if (localResults.length < 3) {
      try {
        const externalResults = await this.searchOpenFoodFacts(q, limit - localResults.length);
        // Deduplicate by name (case-insensitive)
        const localNames = new Set(localResults.map((r) => r.name.toLowerCase()));
        const unique = externalResults.filter(
          (r) => !localNames.has(r.name.toLowerCase()),
        );
        localResults = [...localResults, ...unique].slice(0, limit);
      } catch (err) {
        this.logger.warn('OpenFoodFacts search failed', err);
      }
    }

    if (localResults.length > 0) {
      return {
        results: localResults,
        suggestions: [],
        did_you_mean: false,
        query: q,
      };
    }

    return {
      results: [],
      suggestions: [],
      did_you_mean: false,
      query: q,
    };
  }

  /**
   * Search OpenFoodFacts API and map results to FoodResult shape.
   */
  private async searchOpenFoodFacts(query: string, limit: number = 20): Promise<FoodResult[]> {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=${Math.min(limit, 40)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

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

  async create(data: any) {
    return this.prisma.foodItem.create({ data });
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
