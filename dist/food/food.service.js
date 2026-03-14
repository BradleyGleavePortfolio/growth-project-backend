"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FoodService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let FoodService = class FoodService {
    constructor(prisma) {
        this.prisma = prisma;
        this.toResult = (item) => ({
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
    async search(query, limit = 20) {
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
        try {
            const trgmResults = await this.prisma.$queryRaw `
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
            const suggestions = await this.prisma.$queryRaw `
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
        }
        catch (_pgError) {
        }
        const likeQ = `%${q}%`;
        const ilikeResults = await this.prisma.$queryRaw `
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
        const words = q.split(/\s+/).filter((w) => w.length >= 3);
        const orClauses = words.map((word) => [
            { name: { contains: word, mode: 'insensitive' } },
            { brand_or_restaurant: { contains: word, mode: 'insensitive' } },
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
    async getById(id) {
        const item = await this.prisma.foodItem.findUnique({ where: { id } });
        return item ? this.toResult(item) : null;
    }
    async create(data) {
        return this.prisma.foodItem.create({ data });
    }
};
exports.FoodService = FoodService;
exports.FoodService = FoodService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], FoodService);
//# sourceMappingURL=food.service.js.map