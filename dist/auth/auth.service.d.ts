import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
export declare class AuthService {
    private prisma;
    private jwtService;
    private supabaseAdmin;
    constructor(prisma: PrismaService, jwtService: JwtService);
    register(data: {
        email: string;
        password: string;
        name: string;
        phone?: string;
    }): Promise<{
        message: string;
        user_id: string;
        access_token?: undefined;
        is_new_user?: undefined;
        user?: undefined;
    } | {
        message: string;
        access_token: string;
        is_new_user: boolean;
        user: {
            id: string;
            email: string;
            name: string;
            role: import(".prisma/client").$Enums.Role;
            coach_id: string;
        };
        user_id?: undefined;
    }>;
    login(email: string, password: string): Promise<{
        access_token: string;
        user: {
            id: string;
            email: string;
            name: string;
            role: import(".prisma/client").$Enums.Role;
            coach_id: string;
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
        };
    }>;
    googleAuth(googleToken: string): Promise<{
        access_token: string;
        is_new_user: boolean;
        user: {
            id: string;
            email: string;
            name: string;
            role: import(".prisma/client").$Enums.Role;
            coach_id: string;
        };
    }>;
    selectRole(userId: string, role: 'coach' | 'student', coachCode?: string): Promise<{
        role: import(".prisma/client").$Enums.Role;
    }>;
    getMe(userId: string): Promise<{
        id: string;
        email: string;
        name: string;
        role: import(".prisma/client").$Enums.Role;
        coach_id: string;
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
    }>;
    validateSupabaseToken(supabaseId: string): Promise<{
        id: string;
        supabase_id: string;
        email: string;
        name: string;
        phone: string | null;
        role: import(".prisma/client").$Enums.Role;
        coach_id: string | null;
        created_at: Date;
    }>;
}
