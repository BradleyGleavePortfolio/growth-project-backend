import { LogService } from './log.service';
export declare class LogController {
    private logService;
    constructor(logService: LogService);
    logFood(req: any, body: any): Promise<{
        food_item: {
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
        };
    } & {
        id: string;
        user_id: string;
        date: Date;
        meal_type: import(".prisma/client").$Enums.MealType;
        quantity_multiplier: number;
        notes: string | null;
        logged_at: Date;
        food_item_id: string;
    }>;
    getDaily(req: any, date: string): Promise<{
        date: string;
        entries: ({
            food_item: {
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
            };
        } & {
            id: string;
            user_id: string;
            date: Date;
            meal_type: import(".prisma/client").$Enums.MealType;
            quantity_multiplier: number;
            notes: string | null;
            logged_at: Date;
            food_item_id: string;
        })[];
        total_calories: number;
        total_protein_g: number;
        total_carbs_g: number;
        total_fat_g: number;
        remaining_calories: number;
        remaining_protein_g: number;
        remaining_carbs_g: number;
        remaining_fat_g: number;
        macro_targets: {
            calories: number;
            protein_g: number;
            carbs_g: number;
            fat_g: number;
        };
    }>;
    updateEntry(req: any, id: string, body: any): Promise<{
        id: string;
        user_id: string;
        date: Date;
        meal_type: import(".prisma/client").$Enums.MealType;
        quantity_multiplier: number;
        notes: string | null;
        logged_at: Date;
        food_item_id: string;
    }>;
    deleteEntry(req: any, id: string): Promise<{
        id: string;
        user_id: string;
        date: Date;
        meal_type: import(".prisma/client").$Enums.MealType;
        quantity_multiplier: number;
        notes: string | null;
        logged_at: Date;
        food_item_id: string;
    }>;
    getWeekly(req: any, weekStart: string): Promise<any[]>;
}
