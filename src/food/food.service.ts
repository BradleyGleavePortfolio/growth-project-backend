import { Injectable } from '@nestjs/common';
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
  constructor(private prisma: PrismaService) {}

  async search(query: string, limit: number = 20): Promise<FoodSearchResponse> {
    const q = (query || '').trim();

    // Empty query — return default top foods
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
    // 1. Try pg_trgm similarity search (best quality)
    // -------------------------------------------------------
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

      if (trgmResults.length > 0) {
        return {
          results: trgmResults.map(this.toResult),
          suggestions: [],
          did_you_mean: false,
          query: q,
        };
      }

      // Zero trgm results — get top-5 similarity as "Did you mean?" suggestions
      const suggestions = await this.prisma.$queryRaw<any[]>`
        SELECT
          id, name, brand_or_restaurant, category, serving_description,
          serving_size_grams, calories, protein_g, carbs_g, fat_g,
          fiber_g, sugar_g, sodium_mg, tags, search_aliases, image_url,
          similarity(
            lower(name) || ' ' || lower(coalesce(brand_or_restaurant, '')),
            lower(${q})
          ) AS score
        FROM "FoodItem"
        ORDER BY score DESC
        LIMIT 5
      `;

      return {
        results: [],
        suggestions: suggestions.map(this.toResult),
        did_you_mean: suggestions.length > 0,
        query: q,
      };
    } catch (_pgError) {
      // pg_trgm not installed — fall through to multi-field ILIKE
    }

    // -------------------------------------------------------
    // 2. ILIKE fallback (works without pg_trgm extension)
    //    Searches: name, brand_or_restaurant, AND search_aliases
    // -------------------------------------------------------
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

    if (ilikeResults.length > 0) {
      return {
        results: ilikeResults.map(this.toResult),
        suggestions: [],
        did_you_mean: false,
        query: q,
      };
    }

    // -------------------------------------------------------
    // 3. Nothing found — give helpful suggestions using
    //    Prisma ORM partial match on just name/brand
    // -------------------------------------------------------
    const words = q.split(/\s+/).filter((w) => w.length >= 3);
    const orClauses = words.map((word) => [
      { name: { contains: word, mode: 'insensitive' as const } },
      { brand_or_restaurant: { contains: word, mode: 'insensitive' as const } },
    ]).flat();

    const fallbackItems = orClauses.length > 0
      ? await this.prisma.foodItem.findMany({
          where: { OR: orClauses },
          take: 5,
        })
      : await this.prisma.foodItem.findMany({ take: 5, orderBy: { name: 'asc' } });

    return {
      results: [],
      suggestions: fallbackItems.map(this.toResult),
      did_you_mean: fallbackItems.length > 0,
      query: q,
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
