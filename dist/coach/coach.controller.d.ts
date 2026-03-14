import { CoachService } from './coach.service';
export declare class CoachController {
    private coachService;
    constructor(coachService: CoachService);
    getClients(req: any): Promise<({
        profile: {
            id: string;
            user_id: string;
            height_cm: number | null;
            current_weight_lbs: number | null;
            target_weight_lbs: number | null;
            date_of_birth: Date | null;
            sex: import(".prisma/client").$Enums.Sex;
            activity_level: import(".prisma/client").$Enums.ActivityLevel;
            goal_type: import(".prisma/client").$Enums.GoalType;
            workout_experience: import(".prisma/client").$Enums.WorkoutExperience;
            has_gym_membership: boolean;
            preferred_snacks: string[];
            macro_target_calories: number | null;
            macro_target_protein_g: number | null;
            macro_target_carbs_g: number | null;
            macro_target_fat_g: number | null;
            avatar_url: string | null;
            updated_at: Date;
        };
    } & {
        id: string;
        supabase_id: string;
        email: string;
        name: string;
        phone: string | null;
        role: import(".prisma/client").$Enums.Role;
        coach_id: string | null;
        created_at: Date;
    })[]>;
    getClientTimeline(req: any, id: string): Promise<{
        error: string;
        client?: undefined;
        meals?: undefined;
        workouts?: undefined;
        weights?: undefined;
        checkIns?: undefined;
    } | {
        client: {
            id: string;
            supabase_id: string;
            email: string;
            name: string;
            phone: string | null;
            role: import(".prisma/client").$Enums.Role;
            coach_id: string | null;
            created_at: Date;
        };
        meals: ({
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
        workouts: ({
            exercises: {
                id: string;
                notes: string | null;
                exercise_name: string;
                muscle_group: import(".prisma/client").$Enums.MuscleGroup;
                sets_completed: number;
                reps_per_set: number[];
                weight_per_set: number[];
                rpe: number | null;
                video_url: string | null;
                workout_id: string;
            }[];
        } & {
            id: string;
            created_at: Date;
            user_id: string;
            date: Date;
            notes: string | null;
            workout_name: string;
            workout_type: string;
            duration_minutes: number | null;
            intensity: import(".prisma/client").$Enums.Intensity;
        })[];
        weights: {
            id: string;
            user_id: string;
            date: Date;
            notes: string | null;
            logged_at: Date;
            weight_lbs: number;
            userId: string | null;
        }[];
        checkIns: {
            id: string;
            user_id: string;
            date: Date;
            notes: string | null;
            logged_at: Date;
            mood: number;
            energy: number;
            soreness: number;
            type: import(".prisma/client").$Enums.CheckInType;
        }[];
        error?: undefined;
    }>;
    postGuidelines(req: any, clientId: string, body: {
        guidelines: string;
    }): Promise<{
        id: string;
        coach_id: string;
        created_at: Date;
        tags: string[];
        video_url: string | null;
        description: string | null;
        order_index: number;
        title: string;
        article_url: string | null;
        goal_tags: import(".prisma/client").$Enums.GoalType[];
    }>;
    getAlerts(req: any): Promise<any[]>;
}
