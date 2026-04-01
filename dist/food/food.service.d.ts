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
export declare class FoodService {
    private prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    search(query: string, limit?: number): Promise<FoodSearchResponse>;
    private searchLocalDB;
    private searchUSDA;
    private mapUSDAFood;
    private searchOpenFoodFacts;
    private mapOpenFoodFactsProduct;
    getById(id: string): Promise<FoodResult>;
    create(data: any): Promise<{
        id: string;
        name: string;
        created_at: Date;
        brand_or_restaurant: string | null;
        category: import(".prisma/client").$Enums.FoodCategory;
        serving_description: string;
        serving_size_grams: number;
        calories: number;
        protein_g: number;
        carbs_g: number;
        fat_g: number;
        saturated_fat_g: number | null;
        mono_fat_g: number | null;
        poly_fat_g: number | null;
        fiber_g: number | null;
        sugar_g: number | null;
        sodium_mg: number | null;
        tags: string[];
        search_aliases: string[];
        image_url: string | null;
        barcode: string | null;
    }>;
    private toResult;
}
