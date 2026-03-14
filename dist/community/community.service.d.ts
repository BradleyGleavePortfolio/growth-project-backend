import { PrismaService } from '../prisma.service';
export declare class CommunityService {
    private prisma;
    constructor(prisma: PrismaService);
    getLeaderboard(userId: string, period?: 'week' | 'month'): Promise<{
        user_id: string;
        name: string;
        workouts_completed: number;
    }[]>;
    getFeed(userId: string): Promise<{
        id: string;
        coach_id: string;
        created_at: Date;
        tags: string[];
        video_url: string | null;
        description: string | null;
        order_index: number;
        title: string;
        article_url: string | null;
        goal_tags: import(".prisma/client").$Enums.GoalType[];
    }[]>;
    postWin(userId: string, data: {
        title: string;
        description: string;
    }): Promise<{
        message: string;
        data: {
            title: string;
            description: string;
        };
    }>;
}
