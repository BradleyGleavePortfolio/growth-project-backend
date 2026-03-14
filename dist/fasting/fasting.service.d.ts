import { PrismaService } from '../prisma.service';
export declare class FastingService {
    private prisma;
    constructor(prisma: PrismaService);
    startFast(userId: string, data: {
        protocol?: string;
        notes?: string;
    }): Promise<{
        id: string;
        user_id: string;
        notes: string | null;
        start_time: Date;
        end_time: Date | null;
        protocol: string | null;
    }>;
    endFast(userId: string, notes?: string): Promise<{
        id: string;
        user_id: string;
        notes: string | null;
        start_time: Date;
        end_time: Date | null;
        protocol: string | null;
    }>;
    getHistory(userId: string, limit?: number): Promise<{
        id: string;
        user_id: string;
        notes: string | null;
        start_time: Date;
        end_time: Date | null;
        protocol: string | null;
    }[]>;
}
