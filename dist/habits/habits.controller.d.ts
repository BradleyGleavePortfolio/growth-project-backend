import { HabitsService } from './habits.service';
export declare class HabitsController {
    private habitsService;
    constructor(habitsService: HabitsService);
    getHabits(req: any): Promise<({
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
    createHabit(req: any, body: any): Promise<{
        id: string;
        name: string;
        user_id: string;
        category: string;
        target_value: number | null;
        unit: string | null;
    }>;
    logHabit(req: any, id: string, body: any): Promise<{
        id: string;
        date: Date;
        logged_at: Date;
        habit_id: string;
        value: number | null;
        completed: boolean;
    }>;
    getStreaks(req: any): Promise<{
        habit_id: string;
        habit_name: string;
        streak: number;
    }[]>;
}
