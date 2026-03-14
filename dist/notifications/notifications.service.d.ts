import { PrismaService } from '../prisma.service';
export declare class NotificationsService {
    private prisma;
    constructor(prisma: PrismaService);
    getPreferences(userId: string): Promise<{
        id: string;
        user_id: string;
        water_enabled: boolean;
        workout_enabled: boolean;
        eat_enabled: boolean;
        mindset_enabled: boolean;
        fasting_enabled: boolean;
        quiet_hours_start: string;
        quiet_hours_end: string;
        timezone: string;
    } | {
        user_id: string;
        water_enabled: boolean;
        workout_enabled: boolean;
        eat_enabled: boolean;
        mindset_enabled: boolean;
        fasting_enabled: boolean;
        quiet_hours_start: string;
        quiet_hours_end: string;
        timezone: string;
    }>;
    updatePreferences(userId: string, data: any): Promise<{
        id: string;
        user_id: string;
        water_enabled: boolean;
        workout_enabled: boolean;
        eat_enabled: boolean;
        mindset_enabled: boolean;
        fasting_enabled: boolean;
        quiet_hours_start: string;
        quiet_hours_end: string;
        timezone: string;
    }>;
}
