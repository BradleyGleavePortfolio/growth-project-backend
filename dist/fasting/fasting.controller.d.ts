import { FastingService } from './fasting.service';
export declare class FastingController {
    private fastingService;
    constructor(fastingService: FastingService);
    startFast(req: any, body: any): Promise<{
        id: string;
        user_id: string;
        notes: string | null;
        start_time: Date;
        end_time: Date | null;
        protocol: string | null;
    }>;
    endFast(req: any, body: any): Promise<{
        id: string;
        user_id: string;
        notes: string | null;
        start_time: Date;
        end_time: Date | null;
        protocol: string | null;
    }>;
    getHistory(req: any, limit?: string): Promise<{
        id: string;
        user_id: string;
        notes: string | null;
        start_time: Date;
        end_time: Date | null;
        protocol: string | null;
    }[]>;
}
