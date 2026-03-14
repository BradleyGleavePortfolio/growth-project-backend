import { ProfileService } from './profile.service';
export declare class ProfileController {
    private profileService;
    constructor(profileService: ProfileService);
    getProfile(req: any): Promise<{
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
    } | {
        user_id: string;
    }>;
    updateProfile(req: any, body: any): Promise<{
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
    }>;
}
