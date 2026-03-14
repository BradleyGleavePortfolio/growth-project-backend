import { PrismaService } from '../prisma.service';
export declare class WeightService {
    private prisma;
    constructor(prisma: PrismaService);
    logWeight(userId: string, data: {
        weight_lbs: number;
        date?: string;
        notes?: string;
    }): Promise<{
        id: string;
        user_id: string;
        date: Date;
        notes: string | null;
        logged_at: Date;
        weight_lbs: number;
        userId: string | null;
    }>;
    getHistory(userId: string, days?: number): Promise<{
        logs: {
            id: string;
            user_id: string;
            date: Date;
            notes: string | null;
            logged_at: Date;
            weight_lbs: number;
            userId: string | null;
        }[];
        height_cm: number;
    }>;
}
