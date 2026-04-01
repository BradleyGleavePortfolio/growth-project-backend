import { WeightService } from './weight.service';
export declare class WeightController {
    private weightService;
    constructor(weightService: WeightService);
    logWeight(req: any, body: any): Promise<{
        id: string;
        user_id: string;
        date: Date;
        notes: string | null;
        logged_at: Date;
        weight_lbs: number;
    }>;
    getHistory(req: any, days?: string): Promise<{
        logs: {
            id: string;
            user_id: string;
            date: Date;
            notes: string | null;
            logged_at: Date;
            weight_lbs: number;
        }[];
        height_cm: number;
    }>;
}
