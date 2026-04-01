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
var FoodService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FoodService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let FoodService = FoodService_1 = class FoodService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(FoodService_1.name);
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
    async search(query, limit = 50) {
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
        const [usdaResults, offResults, localResults] = await Promise.allSettled([
            this.searchUSDA(q, 20),
            this.searchOpenFoodFacts(q, 20),
            this.searchLocalDB(q, 10),
        ]);
        const usda = usdaResults.status === 'fulfilled' ? usdaResults.value : [];
        const off = offResults.status === 'fulfilled' ? offResults.value : [];
        const local = localResults.status === 'fulfilled' ? localResults.value : [];
        const merged = [];
        const seen = new Set();
        const addUnique = (items) => {
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
        const scoreResult = (item, rawQuery) => {
            const normalize = (s) => s.toLowerCase().trim().replace(/\s+/g, ' ').replace(/s$/, '');
            const normalizedName = normalize(item.name);
            const normalizedQuery = normalize(rawQuery);
            let score;
            if (normalizedName === normalizedQuery) {
                score = 100;
            }
            else if (normalizedName.startsWith(normalizedQuery)) {
                score = 80;
            }
            else if (normalizedName.includes(normalizedQuery)) {
                score = 60;
            }
            else {
                const tokens = normalizedQuery.split(' ');
                if (tokens.every((t) => normalizedName.includes(t))) {
                    score = 30;
                }
                else {
                    const allText = [
                        ...(item.tags || []),
                        ...(item.search_aliases || []),
                    ]
                        .join(' ')
                        .toLowerCase();
                    if (tokens.some((t) => allText.includes(normalize(t)))) {
                        score = 10;
                    }
                    else {
                        score = 5;
                    }
                }
            }
            const wordCount = item.name.trim().split(/\s+/).length;
            if (item.category === 'generic' || wordCount <= 3) {
                score += 20;
            }
            return score;
        };
        const scored = merged.map((item) => ({
            item,
            score: scoreResult(item, q),
        }));
        scored.sort((a, b) => {
            if (b.score !== a.score)
                return b.score - a.score;
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
    async searchLocalDB(query, limit) {
        try {
            const trgmResults = await this.prisma.$queryRaw `
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
        }
        catch {
            try {
                const likeQ = `%${query}%`;
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
                return ilikeResults.map(this.toResult);
            }
            catch {
                return [];
            }
        }
    }
    async searchUSDA(query, limit = 20) {
        const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=${Math.min(limit, 25)}&api_key=DEMO_KEY`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'TheGrowthProject/1.0' },
            });
            clearTimeout(timeout);
            if (!response.ok)
                return [];
            const data = await response.json();
            const foods = data?.foods || [];
            return foods
                .filter(f => f.description && f.description.trim())
                .slice(0, limit)
                .map(f => this.mapUSDAFood(f));
        }
        catch {
            clearTimeout(timeout);
            return [];
        }
    }
    mapUSDAFood(food) {
        const nutrients = food.foodNutrients || [];
        const getNutrient = (name, unit) => {
            const match = nutrients.find((n) => n.nutrientName === name && (!unit || n.unitName === unit));
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
    async searchOpenFoodFacts(query, limit = 20) {
        const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=${Math.min(limit, 40)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'TheGrowthProject/1.0' },
            });
            clearTimeout(timeout);
            if (!response.ok)
                return [];
            const data = await response.json();
            const products = data?.products || [];
            return products
                .filter((p) => {
                if (!p.product_name || !p.product_name.trim())
                    return false;
                const n = p.nutriments || {};
                const cals = n['energy-kcal_100g'] ?? (n['energy_100g'] ? n['energy_100g'] / 4.184 : null);
                return cals != null && cals > 0;
            })
                .slice(0, limit)
                .map((p) => this.mapOpenFoodFactsProduct(p));
        }
        catch {
            clearTimeout(timeout);
            return [];
        }
    }
    mapOpenFoodFactsProduct(product) {
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
    async getById(id) {
        const item = await this.prisma.foodItem.findUnique({ where: { id } });
        return item ? this.toResult(item) : null;
    }
    async create(data) {
        return this.prisma.foodItem.create({ data });
    }
};
exports.FoodService = FoodService;
exports.FoodService = FoodService = FoodService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], FoodService);
//# sourceMappingURL=food.service.js.map