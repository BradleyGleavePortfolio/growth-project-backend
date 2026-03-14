import { LessonsService } from './lessons.service';
export declare class LessonsController {
    private lessonsService;
    constructor(lessonsService: LessonsService);
    getLessons(req: any): Promise<({
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
    createLesson(req: any, body: any): Promise<{
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
    updateLesson(req: any, id: string, body: any): Promise<{
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
    completeLesson(req: any, id: string): Promise<{
        id: string;
        user_id: string;
        lesson_id: string;
        completed_at: Date;
    }>;
    getRecommended(req: any): Promise<{
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
