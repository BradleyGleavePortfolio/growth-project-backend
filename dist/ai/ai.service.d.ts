import { PrismaService } from '../prisma.service';
export interface UserContextPayload {
    profile: {
        name: string;
        goal_type: string;
        current_weight_lbs: number;
        target_weight_lbs: number;
        height_cm: number;
        workout_experience: string;
        has_gym_membership: boolean;
        preferred_snacks: string[];
        activity_level: string;
    };
    macro_targets: {
        calories: number;
        protein_g: number;
        carbs_g: number;
        fat_g: number;
    };
    today_summary: {
        total_calories: number;
        total_protein_g: number;
        total_carbs_g: number;
        total_fat_g: number;
        remaining_calories: number;
        remaining_protein_g: number;
    };
    recent_workouts: any[];
    recent_fasting: any[];
    todays_logs: any[];
}
export declare class AiService {
    private prisma;
    constructor(prisma: PrismaService);
    buildDietitianSystemPrompt(userContext: UserContextPayload): string;
    getUserContext(userId: string): Promise<UserContextPayload>;
    chat(userId: string, userMessage: string, conversationHistory: Array<{
        role: string;
        content: string;
    }>): Promise<string>;
}
