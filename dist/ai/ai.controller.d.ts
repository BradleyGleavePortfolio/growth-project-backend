import { AiService } from './ai.service';
export declare class AiController {
    private aiService;
    constructor(aiService: AiService);
    chat(req: any, body: {
        message: string;
        conversation_history?: Array<{
            role: string;
            content: string;
        }>;
    }): Promise<{
        reply: string;
        timestamp: string;
    }>;
    getContext(req: any): Promise<import("./ai.service").UserContextPayload>;
}
