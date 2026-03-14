import { NotificationsService } from './notifications.service';
export declare class NotificationsController {
    private notificationsService;
    constructor(notificationsService: NotificationsService);
    getPreferences(req: any): Promise<{
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
    updatePreferences(req: any, body: any): Promise<{
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
