import { PrismaService } from '../prisma.service';
export declare class HabitsService {
    private prisma;
    constructor(prisma: PrismaService);
    getHabits(userId: string): Promise<({
        logs: {
            id: string;
            date: Date;
            logged_at: Date;
            habit_id: string;
            value: number | null;
            completed: boolean;
        }[];
    } & {
        id: string;
        name: string;
        user_id: string;
        category: string;
        target_value: number | null;
        unit: string | null;
    })[]>;
    createHabit(userId: string, data: any): Promise<{
        id: string;
        name: string;
        user_id: string;
        category: string;
        target_value: number | null;
        unit: string | null;
    }>;
    logHabit(userId: string, habitId: string, data: any): Promise<{
        id: string;
        date: Date;
        logged_at: Date;
        habit_id: string;
        value: number | null;
        completed: boolean;
    }>;
    getLogs(userId: string, date: string): Promise<{
        id: string;
        date: Date;
        logged_at: Date;
        habit_id: string;
        value: number | null;
        completed: boolean;
    }[]>;
    getStreaks(userId: string): Promise<{
        habit_id: string;
        habit_name: string;
        streak: number;
    }[]>;
}
