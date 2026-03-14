import { FoodService } from './food.service';
export declare class FoodController {
    private foodService;
    constructor(foodService: FoodService);
    search(q: string, limit?: string): Promise<import("./food.service").FoodSearchResponse>;
    getById(id: string): Promise<import("./food.service").FoodResult>;
    create(body: any): Promise<{
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
}
