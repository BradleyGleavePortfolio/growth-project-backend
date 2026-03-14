import { PrismaService } from '../prisma.service';
export declare class WorkoutService {
    private prisma;
    constructor(prisma: PrismaService);
    createWorkout(userId: string, data: any): Promise<{
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
    }>;
    getWorkouts(userId: string, limit?: number): Promise<({
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
    })[]>;
    getVolume(userId: string, period?: 'week' | 'month'): Promise<{
        muscle_group: string;
        total_volume: number;
        period: "week" | "month";
    }[]>;
    getRoutines(userId: string): Promise<({
        exercises: {
            id: string;
            exercise_name: string;
            muscle_group: import(".prisma/client").$Enums.MuscleGroup;
            video_url: string | null;
            order_index: number;
            routine_id: string;
            default_sets: number;
            default_reps: number;
            default_rest_seconds: number;
        }[];
    } & {
        id: string;
        name: string;
        created_at: Date;
        creator_id: string;
        description: string | null;
        is_template: boolean;
    })[]>;
    createRoutine(userId: string, data: any): Promise<{
        exercises: {
            id: string;
            exercise_name: string;
            muscle_group: import(".prisma/client").$Enums.MuscleGroup;
            video_url: string | null;
            order_index: number;
            routine_id: string;
            default_sets: number;
            default_reps: number;
            default_rest_seconds: number;
        }[];
    } & {
        id: string;
        name: string;
        created_at: Date;
        creator_id: string;
        description: string | null;
        is_template: boolean;
    }>;
    updateRoutine(userId: string, id: string, data: any): Promise<{
        id: string;
        name: string;
        created_at: Date;
        creator_id: string;
        description: string | null;
        is_template: boolean;
    }>;
    deleteRoutine(userId: string, id: string): Promise<{
        id: string;
        name: string;
        created_at: Date;
        creator_id: string;
        description: string | null;
        is_template: boolean;
    }>;
}
