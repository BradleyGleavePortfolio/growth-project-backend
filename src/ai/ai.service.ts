import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../prisma.service';
import { ClientAIContextService } from './client-ai-context.service';
import { AIGuardrailsService } from './ai-guardrails.service';
import { ClientAIContext } from './client-ai-context.types';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';

// Perplexity API uses OpenAI-compatible endpoint
const perplexity = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY || '',
  baseURL: 'https://api.perplexity.ai',
});

// Legacy payload kept exported because other code (e.g. /ai/context for the
// mobile debug screen) still types against this shape. Internally the
// ClientAIContext type is the source of truth.
export interface UserContextPayload {
  profile: {
    name: string;
    goal_type: string;
    current_weight_lbs: number;
    target_weight_lbs: number;
    height_cm: number;
    workout_experience: string;
    has_gym_membership: boolean;
    preferred_snacks: string[];
    activity_level: string;
  };
  macro_targets: {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  };
  today_summary: {
    total_calories: number;
    total_protein_g: number;
    total_carbs_g: number;
    total_fat_g: number;
    remaining_calories: number;
    remaining_protein_g: number;
  };
  recent_workouts: any[];
  recent_fasting: any[];
  todays_logs: any[];
}

export interface ChatResult {
  reply: string;
  guardrails_applied: string[];
  context_generated_at: string;
  model_used: 'perplexity' | 'fallback';
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  constructor(
    private prisma: PrismaService,
    private contextSvc: ClientAIContextService,
    private guardrails: AIGuardrailsService,
    private analytics: AnalyticsService,
  ) {}

  // System prompt is now built from the typed ClientAIContext. The prompt
  // explicitly forbids contradicting APP_PRESCRIBED values and references
  // the coach by first name when present, so the model has the same data
  // the user can see in their own app.
  buildSystemPrompt(ctx: ClientAIContext): string {
    const renderedContext = this.contextSvc.renderForPrompt(ctx);
    const id = ctx.identity;

    return `You are GP — the personal performance coach inside The Growth Project app.
You are a hybrid of:
- A registered dietician with 15 years clinical and performance experience
- A world-class personal trainer who has coached Olympians and executives
- A behavioral coach who understands discipline, identity, and high performance

The Growth Project serves ambitious clients who want strong, sustainable
results. Tone: direct, confident, zero fluff. No corporate wellness speak.
No em-dashes. No exclamation marks. No emoji.

ABSOLUTE RULES:
1. The CLIENT_CONTEXT block below is the ground truth about ${id.first_name}.
   Use it. Never invent macros, weights, or workouts you did not see there.
2. APP_PRESCRIBED values (calories, protein_g, carbs_g, fat_g, water_ml) are
   set by the coach or the app. Do not recommend numbers that contradict them.
3. ${ctx.coach.has_coach ? `${ctx.coach.coach_name ?? 'The coach'} is this client's coach. If asked anything medical, injury-related, dosage, or about extreme restriction, refer to ${ctx.coach.coach_name ?? 'the coach'}.` : 'If asked medical, injury-related, or mental-health questions, refer to a qualified professional.'}
4. Never recommend fewer than ${ctx.guardrails.forbid_calorie_recommendations_below} kcal/day for any client.
5. Never recommend anabolic steroids, SARMs, ECA stack, multi-day water fasts,
   HCG protocols, or other unsafe shortcuts.
6. ${ctx.coach.last_coach_message_excerpt ? 'The last coach message is included below. Do not contradict it.' : 'No recent coach message on file.'}
7. STATUS questions: lead with a 1-2 sentence read of today's numbers, then 1-2 specific actions.
8. CONCEPT questions: answer the concept first, then connect to the client's profile in 1-2 sentences.
9. MEAL_PLAN: build the day around APP_PRESCRIBED macros. Use foods this client would realistically eat (see preferred_snacks).
10. LOG_ASSIST: if the user names a food they ate, give the macros and how it lands against today's remaining_cal / remaining_protein_g.
11. Never claim to be human. If asked, disclose: "I am the AI assistant inside the app, trained on your coach's approach."

${renderedContext}

Now answer the user's next message using the rules above. Keep the answer under 220 words unless they explicitly asked for a meal plan.`;
  }

  // Legacy method retained for /ai/context endpoint (used by the mobile
  // debug surface). Internally proxies to the new typed context and remaps.
  async getUserContext(userId: string): Promise<UserContextPayload> {
    const ctx = await this.contextSvc.build(userId);
    const recentWorkouts = await this.prisma.workoutSession.findMany({
      where: { user_id: userId },
      orderBy: { date: 'desc' },
      take: 3,
      include: { exercises: true },
    });
    const recentFasting = await this.prisma.fastingWindow.findMany({
      where: { user_id: userId },
      orderBy: { start_time: 'desc' },
      take: 3,
    });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todaysLogs = await this.prisma.loggedFoodEntry.findMany({
      where: { user_id: userId, date: today },
      include: { food_item: true },
    });
    return {
      profile: {
        name: ctx.identity.first_name,
        goal_type: ctx.profile.goal_type,
        current_weight_lbs: ctx.profile.current_weight_lbs ?? 0,
        target_weight_lbs: ctx.profile.target_weight_lbs ?? 0,
        height_cm: ctx.profile.height_cm ?? 0,
        workout_experience: ctx.profile.workout_experience,
        has_gym_membership: ctx.profile.has_gym_membership,
        preferred_snacks: ctx.profile.preferred_snacks,
        activity_level: ctx.profile.activity_level,
      },
      macro_targets: {
        calories: ctx.prescribed.calories ?? 2000,
        protein_g: ctx.prescribed.protein_g ?? 180,
        carbs_g: ctx.prescribed.carbs_g ?? 200,
        fat_g: ctx.prescribed.fat_g ?? 60,
      },
      today_summary: {
        total_calories: ctx.today.calories,
        total_protein_g: ctx.today.protein_g,
        total_carbs_g: ctx.today.carbs_g,
        total_fat_g: ctx.today.fat_g,
        remaining_calories: ctx.today.remaining_calories ?? 0,
        remaining_protein_g: ctx.today.remaining_protein_g ?? 0,
      },
      recent_workouts: recentWorkouts,
      recent_fasting: recentFasting,
      todays_logs: todaysLogs,
    };
  }

  // Returns the typed context to the controller (used by /ai/structured-context).
  async getStructuredContext(userId: string): Promise<ClientAIContext> {
    return this.contextSvc.build(userId);
  }

  // Fallback used when the AI provider is unavailable or returns an error.
  // Speaks the new context shape directly so it stays consistent with what
  // the model would have seen.
  private generateFallbackResponse(userMessage: string, ctx: ClientAIContext): string {
    const msg = userMessage.toLowerCase().trim();
    const tx = ctx.prescribed;
    const today = ctx.today;
    const cal = tx.calories ?? 2000;
    const pro = tx.protein_g ?? 180;
    const remaining = today.remaining_calories ?? cal - today.calories;
    const pct = today.pct_calories ?? Math.round((today.calories / cal) * 100);

    if (/(on track|how am i|my progress|doing (well|good|okay)|calorie|macros today)/.test(msg)) {
      const tail =
        pct < 40
          ? `You have ${remaining} kcal left. Front-load the day; biggest meal before 2pm.`
          : pct > 95
          ? `You are close to your limit. Keep dinner lean: grilled protein and vegetables.`
          : `You are on pace. Hit your protein before worrying about anything else.`;
      return `Today: ${today.calories}/${cal} kcal (${pct}%), ${today.protein_g}/${pro}g protein. ${tail}`;
    }
    if (/(meal plan|what should i eat|what to eat|plan (my|for) day|food today)/.test(msg)) {
      return `Your ${cal} kcal / ${pro}g protein plan for today:\n\nBreakfast (~${Math.round(cal * 0.25)} kcal): 4-5 eggs scrambled with oatmeal and black coffee. ~${Math.round(pro * 0.22)}g protein.\n\nLunch (~${Math.round(cal * 0.35)} kcal): chicken breast or 2 cans tuna with rice and any vegetables.\n\nDinner (~${Math.round(cal * 0.3)} kcal): salmon or 90% lean beef with sweet potato.\n\nSnack (~${Math.round(cal * 0.1)} kcal): Greek yogurt and almonds.\n\nTotal hits your prescribed targets.`;
    }
    if (/(protein|how much protein|protein target|hit (my |my daily )?protein)/.test(msg)) {
      const left = pro - today.protein_g;
      return `Your prescribed target is ${pro}g protein. You have logged ${today.protein_g}g, ${left > 0 ? `${left}g remaining` : 'on target'}. Best per-gram sources: chicken breast, 90% lean beef, eggs, Greek yogurt, canned tuna.`;
    }

    const goalMsg =
      ctx.profile.goal_type === 'fat_loss'
        ? `You are in a fat loss phase (${cal} kcal target). Protect muscle by hitting ${pro}g protein and training hard.`
        : ctx.profile.goal_type === 'muscle_gain'
        ? `You are in a muscle gain phase (${cal} kcal target). Hit your protein, train progressively, sleep 7-9 hours.`
        : `You are maintaining (${cal} kcal target). Focus on body recomposition.`;
    return `${goalMsg}\n\nToday you logged ${today.calories} kcal and ${today.protein_g}g protein. Ask me anything specific about nutrition, training, or training schedule and I will give you a direct answer.`;
  }

  // Single entry point used by /ai/chat. The controller passes the
  // authenticated userId; the message and conversation history come from
  // the client. Profile / macros / logs are NEVER taken from the request
  // body — anti-spoof.
  async chat(
    userId: string,
    userMessage: string,
    conversationHistory: Array<{ role: string; content: string }>,
  ): Promise<ChatResult> {
    const ctx = await this.contextSvc.build(userId);
    let modelUsed: 'perplexity' | 'fallback' = 'perplexity';

    let rawReply: string;
    if (!process.env.PERPLEXITY_API_KEY || process.env.PERPLEXITY_API_KEY.trim() === '') {
      rawReply = this.generateFallbackResponse(userMessage, ctx);
      modelUsed = 'fallback';
    } else {
      const systemPrompt = this.buildSystemPrompt(ctx);
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...conversationHistory.slice(-10).map((m) => ({ role: m.role as any, content: m.content })),
        { role: 'user' as const, content: userMessage },
      ];
      try {
        const response = await perplexity.chat.completions.create({
          model: 'sonar-pro',
          messages,
          temperature: 0.7,
          max_tokens: 600,
        });
        rawReply =
          response.choices[0]?.message?.content || this.generateFallbackResponse(userMessage, ctx);
        if (!response.choices[0]?.message?.content) modelUsed = 'fallback';
      } catch (error) {
        this.logger.warn(
          `Perplexity chat failed; falling back: ${error instanceof Error ? error.message : String(error)}`,
        );
        rawReply = this.generateFallbackResponse(userMessage, ctx);
        modelUsed = 'fallback';
      }
    }

    const result = this.guardrails.validate(userMessage, rawReply, ctx);
    this.analytics.capture(userId, Events.AI_CHAT_INVOKED, {
      model_used: modelUsed,
      guardrails_applied_count: result.applied.length,
      message_length: userMessage.length,
      has_coach: ctx.coach.has_coach,
    });
    return {
      reply: result.reply,
      guardrails_applied: result.applied,
      context_generated_at: ctx.generated_at,
      model_used: modelUsed,
    };
  }
}
