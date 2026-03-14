import { PrismaService } from '../prisma.service';
export declare class LessonsService {
    private prisma;
    constructor(prisma: PrismaService);
    getLessons(userId: string): Promise<({
        completions: {
            id: string;
            user_id: string;
            lesson_id: string;
            completed_at: Date;
        }[];
    } & {
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
    })[]>;
    createLesson(userId: string, data: any): Promise<{
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
    }>;
    updateLesson(userId: string, id: string, data: any): Promise<{
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
    }>;
    completeLesson(userId: string, lessonId: string): Promise<{
        id: string;
        user_id: string;
        lesson_id: string;
        completed_at: Date;
    }>;
    getRecommended(userId: string): Promise<{
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
}
