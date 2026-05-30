import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import OpenAI from 'openai';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ClientAIContextService } from './client-ai-context.service';
import { AIGuardrailsService } from './ai-guardrails.service';
import { ClientAIContext } from './client-ai-context.types';
import { ChatRole } from './ai.dto';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { CoachAIStateService } from './coach/coach-ai-state.service';
import { COACH_AI_CAPABILITIES } from './coach/coach-ai.constants';

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
  recent_workouts: Prisma.WorkoutSessionGetPayload<{ include: { exercises: true } }>[];
  recent_fasting: Prisma.FastingWindowGetPayload<Record<string, never>>[];
  todays_logs: Prisma.LoggedFoodEntryGetPayload<{ include: { food_item: true } }>[];
}

// A1 — per-user DAILY AI token quota.
//
// Rationale for the cap value: /ai/chat already has a 20-requests-per-hour
// per-user throttle (defense-in-depth burst limit). The model call is bounded
// to max_tokens=600 per turn (MAX_TOKENS_PER_CALL below). We pick the daily
// token budget as 20 full-budget calls/day — i.e. one hour's worth of the
// burst limit spread across a day — which is generous for a legitimate client
// but caps a token-amplification attacker who slow-drips under the hourly
// throttle. 20 * 600 = 12000 tokens/day. Documented in the build report.
export const MAX_TOKENS_PER_CALL = 600;
export const DAILY_TOKEN_QUOTA = 20 * MAX_TOKENS_PER_CALL; // 12000

// Machine code returned (HTTP 429) when a user is at/over their daily budget.
export const AI_DAILY_QUOTA_EXCEEDED = 'AI_DAILY_QUOTA_EXCEEDED';

export interface ChatResult {
  reply: string;
  guardrails_applied: string[];
  context_generated_at: string;
  model_used: 'perplexity' | 'anthropic' | 'fallback';
  degraded: boolean;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  // Perplexity uses the OpenAI-compatible HTTP surface, so we reuse the
  // OpenAI SDK against the Perplexity baseURL. In SDK v5+ the constructor
  // throws synchronously when no apiKey is provided, so we lazy-init on
  // first use rather than at module load (which would break tests that
  // boot the AI module without PERPLEXITY_API_KEY set).
  private _perplexity: OpenAI | null = null;
  private getPerplexityClient(): OpenAI {
    if (!this._perplexity) {
      const apiKey = process.env.PERPLEXITY_API_KEY?.trim();
      if (!apiKey) {
        throw new Error('PERPLEXITY_API_KEY is required for this operation');
      }
      this._perplexity = new OpenAI({
        apiKey,
        baseURL: 'https://api.perplexity.ai',
      });
    }
    return this._perplexity;
  }

  constructor(
    private prisma: PrismaService,
    private contextSvc: ClientAIContextService,
    private guardrails: AIGuardrailsService,
    private analytics: AnalyticsService,
    // Coach AI v1 — when ANTHROPIC_API_KEY is set and the engine is
    // ready, we prefer Claude over the deterministic responder for the
    // client-facing /ai/chat fallback path (food audit §7). Optional so
    // tests that boot a stripped-down AiModule still construct.
    @Optional() private anthropic?: AnthropicAdapter,
    @Optional() private coachAIState?: CoachAIStateService,
  ) {}

  // M3 — Intent-based word budget. Returns the word cap to embed in the
  // system prompt based on the user's message intent. A flat 220-word limit
  // frustrated complex questions; this gives the model room to breathe on
  // planning and explanation intents while keeping quick Q&A snappy.
  getWordBudget(userMessage: string): number {
    const msg = userMessage.toLowerCase();
    // Explicit user override — honour requests for detailed responses.
    if (
      msg.endsWith('give me the detailed version') ||
      msg.endsWith('full breakdown') ||
      msg.endsWith('explain in detail') ||
      msg.includes('give me the detailed version') ||
      msg.includes('full breakdown') ||
      msg.includes('explain in detail')
    ) {
      return 600;
    }
    // Planning intents — meal plan and workout plan generation.
    if (msg.includes('meal_plan') || msg.includes('meal plan') || msg.includes('workout_plan') || msg.includes('workout plan') || msg.includes('program')) {
      return 600;
    }
    // Explanation / analysis intents.
    if (
      msg.includes('explain') ||
      msg.includes(' why ') ||
      msg.startsWith('why ') ||
      msg.includes('analyze') ||
      msg.includes('analyse') ||
      msg.includes('break down') ||
      msg.includes('breakdown') ||
      msg.includes('how does') ||
      msg.includes('what is the difference') ||
      msg.includes('compare')
    ) {
      return 350;
    }
    // Default — quick Q&A, status, log-assist.
    return 220;
  }

  // System prompt is now built from the typed ClientAIContext. The prompt
  // explicitly forbids contradicting APP_PRESCRIBED values and references
  // the coach by first name when present, so the model has the same data
  // the user can see in their own app.
  buildSystemPrompt(ctx: ClientAIContext, userMessage = ''): string {
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

Now answer the user's next message using the rules above. Keep the answer under ${this.getWordBudget(userMessage)} words.`;
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
  // Returns an object with text + degraded marker so callers can propagate
  // the degraded flag without an out-of-band boolean.
  private generateFallbackResponse(userMessage: string, ctx: ClientAIContext): { text: string; degraded: true } {
    const msg = userMessage.toLowerCase().trim();
    const tx = ctx.prescribed;
    const today = ctx.today;
    const cal = tx.calories ?? 2000;
    const pro = tx.protein_g ?? 180;
    const remaining = today.remaining_calories ?? cal - today.calories;
    const pct = today.pct_calories ?? Math.round((today.calories / cal) * 100);

    let text: string;
    if (/(on track|how am i|my progress|doing (well|good|okay)|calorie|macros today)/.test(msg)) {
      const tail =
        pct < 40
          ? `You have ${remaining} kcal left. Front-load the day; biggest meal before 2pm.`
          : pct > 95
          ? `You are close to your limit. Keep dinner lean: grilled protein and vegetables.`
          : `You are on pace. Hit your protein before worrying about anything else.`;
      text = `Today: ${today.calories}/${cal} kcal (${pct}%), ${today.protein_g}/${pro}g protein. ${tail}`;
    } else if (/(meal plan|what should i eat|what to eat|plan (my|for) day|food today)/.test(msg)) {
      text = `Your ${cal} kcal / ${pro}g protein plan for today:\n\nBreakfast (~${Math.round(cal * 0.25)} kcal): 4-5 eggs scrambled with oatmeal and black coffee. ~${Math.round(pro * 0.22)}g protein.\n\nLunch (~${Math.round(cal * 0.35)} kcal): chicken breast or 2 cans tuna with rice and any vegetables.\n\nDinner (~${Math.round(cal * 0.3)} kcal): salmon or 90% lean beef with sweet potato.\n\nSnack (~${Math.round(cal * 0.1)} kcal): Greek yogurt and almonds.\n\nTotal hits your prescribed targets.`;
    } else if (/(protein|how much protein|protein target|hit (my |my daily )?protein)/.test(msg)) {
      const left = pro - today.protein_g;
      text = `Your prescribed target is ${pro}g protein. You have logged ${today.protein_g}g, ${left > 0 ? `${left}g remaining` : 'on target'}. Best per-gram sources: chicken breast, 90% lean beef, eggs, Greek yogurt, canned tuna.`;
    } else {
      const goalMsg =
        ctx.profile.goal_type === 'fat_loss'
          ? `You are in a fat loss phase (${cal} kcal target). Protect muscle by hitting ${pro}g protein and training hard.`
          : ctx.profile.goal_type === 'muscle_gain'
          ? `You are in a muscle gain phase (${cal} kcal target). Hit your protein, train progressively, sleep 7-9 hours.`
          : `You are maintaining (${cal} kcal target). Focus on body recomposition.`;
      text = `${goalMsg}\n\nToday you logged ${today.calories} kcal and ${today.protein_g}g protein. Ask me anything specific about nutrition, training, or training schedule and I will give you a direct answer.`;
    }
    return { text, degraded: true };
  }

  // Single entry point used by /ai/chat. The controller passes the
  // authenticated userId; the message and conversation history come from
  // the client. Profile / macros / logs are NEVER taken from the request
  // body — anti-spoof.
  async chat(
    userId: string,
    userMessage: string,
    // A9 — the wire role is validated to the 'user'|'assistant' union by
    // ChatRequestDto at the controller (the global ValidationPipe rejects a
    // forged 'system' role before it reaches here). We keep the param typed
    // to that strict union — and the two provider branches below still defend
    // in depth by narrowing any non-'assistant' role to 'user' so a 'system'
    // entry can never be folded into the prompt WITH a system role.
    conversationHistory: Array<{ role: ChatRole; content: string }>,
  ): Promise<ChatResult> {
    // A1 — enforce the per-user DAILY token quota BEFORE we build context or
    // call any model, so an at-cap user never burns provider tokens. We use a
    // RESERVE-then-RECONCILE strategy: reserve the worst-case per-call budget
    // (MAX_TOKENS_PER_CALL) up front via an atomic, race-safe increment, then
    // reconcile down to the provider's actual usage after the call. This is
    // the safe choice against token-amplification: concurrent in-flight
    // requests are each charged the full max before they run, so they cannot
    // collectively race past the cap. If the model returns real usage we
    // refund the difference; if it never ran (e.g. would have exceeded) the
    // reservation is what stands.
    await this.reserveDailyTokens(userId, MAX_TOKENS_PER_CALL);

    const ctx = await this.contextSvc.build(userId);
    let modelUsed: 'perplexity' | 'anthropic' | 'fallback' = 'perplexity';

    // Actual provider token usage, when the provider reports it, for the
    // post-call reconcile against the up-front MAX_TOKENS_PER_CALL reservation.
    let actualTokens: number | null = null;
    let rawReply: string;
    const perplexityKey = process.env.PERPLEXITY_API_KEY?.trim();
    const anthropicReady =
      this.anthropic && this.coachAIState && this.coachAIState.isReady();

    if (!perplexityKey && anthropicReady && this.anthropic) {
      // Coach AI v1 — Claude Sonnet fallback for the client chat surface.
      // We hand it the same system prompt the Perplexity branch would
      // see so guardrails / APP_PRESCRIBED defense apply identically.
      try {
        const systemPrompt = this.buildSystemPrompt(ctx, userMessage);
        const historyText = conversationHistory
          .slice(-10)
          .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
          .join('\n');
        const result = await this.anthropic.complete(
          {
            system: systemPrompt,
            user: historyText
              ? `${historyText}\nUser: ${userMessage}`
              : userMessage,
          },
          {
            maxTokens: 600,
            temperature: 0.7,
            capability: COACH_AI_CAPABILITIES.CLIENT_CHAT_FALLBACK,
            clientId: userId,
          },
        );
        if (result.text) {
          rawReply = result.text;
          modelUsed = 'anthropic';
          actualTokens = (result.tokensIn ?? 0) + (result.tokensOut ?? 0);
        } else {
          const fb = this.generateFallbackResponse(userMessage, ctx);
          rawReply = fb.text;
          modelUsed = 'fallback';
        }
      } catch (error) {
        this.logger.warn(
          `Anthropic chat fallback failed; using deterministic: ${error instanceof Error ? error.message : String(error)}`,
        );
        const fb = this.generateFallbackResponse(userMessage, ctx);
        rawReply = fb.text;
        modelUsed = 'fallback';
      }
    } else if (!perplexityKey) {
      const fb = this.generateFallbackResponse(userMessage, ctx);
      rawReply = fb.text;
      modelUsed = 'fallback';
    } else {
      const systemPrompt = this.buildSystemPrompt(ctx, userMessage);
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory.slice(-10).map((m) => {
          // A9 defense-in-depth: the role is already validated to
          // 'user'|'assistant' by ChatRequestDto, but we still narrow here so
          // any non-'assistant' value collapses to 'user' — a 'system' role
          // can never reach Perplexity even if this method is called directly.
          const role: 'assistant' | 'user' = m.role === 'assistant' ? 'assistant' : 'user';
          return { role, content: m.content };
        }),
        { role: 'user', content: userMessage },
      ];
      try {
        const response = await this.getPerplexityClient().chat.completions.create({
          model: 'sonar-pro',
          messages,
          temperature: 0.7,
          max_tokens: MAX_TOKENS_PER_CALL,
        });
        if (response.choices[0]?.message?.content) {
          rawReply = response.choices[0].message.content;
          if (typeof response.usage?.total_tokens === 'number') {
            actualTokens = response.usage.total_tokens;
          }
        } else {
          const fb = this.generateFallbackResponse(userMessage, ctx);
          rawReply = fb.text;
          modelUsed = 'fallback';
        }
      } catch (error) {
        this.logger.warn(
          `Perplexity chat failed; falling back: ${error instanceof Error ? error.message : String(error)}`,
        );
        const fb = this.generateFallbackResponse(userMessage, ctx);
        rawReply = fb.text;
        modelUsed = 'fallback';
      }
    }

    // A1 — reconcile the up-front reservation to actual provider usage when
    // available. We reserved MAX_TOKENS_PER_CALL; if the provider reported a
    // smaller (or larger) total_tokens, adjust tokens_used by the delta so the
    // daily ledger reflects reality. Non-fatal: a failed reconcile leaves the
    // conservative reservation in place.
    if (actualTokens != null) {
      await this.reconcileDailyTokens(userId, MAX_TOKENS_PER_CALL, actualTokens);
    }

    const isFallback = modelUsed === 'fallback';
    const result = this.guardrails.validate(userMessage, rawReply, ctx);
    this.analytics.capture(userId, Events.AI_CHAT_INVOKED, {
      model_used: modelUsed,
      guardrails_applied_count: result.applied.length,
      message_length: userMessage.length,
      has_coach: ctx.coach.has_coach,
    });

    // Audit log — non-fatal. Write every legacy /ai/chat call to AiRequestAudit
    // so fallback usage is visible to operators alongside the gateway path.
    try {
      await this.prisma.aiRequestAudit.create({
        data: {
          request_id: `chat-${userId}-${Date.now()}`,
          capability: 'chat.client_coach',
          requester_id: userId,
          subject_user_id: userId,
          provider: isFallback ? 'stub' : modelUsed,
          model: modelUsed === 'perplexity' ? 'sonar-pro' : modelUsed === 'anthropic' ? 'claude-sonnet' : 'disabled',
          enabled: !isFallback,
        },
      });
    } catch { /* non-fatal */ }

    return {
      reply: result.reply,
      guardrails_applied: result.applied,
      context_generated_at: ctx.generated_at,
      model_used: modelUsed,
      degraded: isFallback,
    };
  }

  // A1 — "today" as a UTC date bucket (midnight UTC), matching the
  // UserAIQuota.quota_date @db.Date column. Pulled out as a protected method
  // so tests can stub the day boundary without coupling to the wall clock
  // (e.g. to exercise the day-rollover path deterministically).
  protected getQuotaDate(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  // A1 — atomically reserve `cost` tokens against the user's daily budget.
  //
  // Race-safety: we first upsert the (user_id, quota_date) row so it exists
  // (the @@unique makes the upsert idempotent under concurrency), then issue a
  // single conditional `updateMany` that increments tokens_used ONLY while the
  // post-increment total would stay within DAILY_TOKEN_QUOTA
  // (where tokens_used <= cap - cost). The increment and the guard are
  // evaluated atomically by the database, so N concurrent requests can never
  // collectively push tokens_used past the cap: each one either wins the
  // guarded update (count === 1) or is rejected (count === 0) without a
  // read-modify-write race. A rejected reservation throws 429 BEFORE any model
  // call, so an at/over-cap user never burns provider tokens.
  private async reserveDailyTokens(userId: string, cost: number): Promise<void> {
    const quotaDate = this.getQuotaDate();

    await this.prisma.userAIQuota.upsert({
      where: { UserAIQuota_user_id_quota_date_key: { user_id: userId, quota_date: quotaDate } },
      // Create the day's row at zero so the guarded increment below is the
      // single source of truth for the reservation (avoids a create that
      // races a concurrent reserve into double-charging).
      create: { user_id: userId, quota_date: quotaDate, tokens_used: 0, request_count: 0 },
      update: {},
    });

    const guarded = await this.prisma.userAIQuota.updateMany({
      where: {
        user_id: userId,
        quota_date: quotaDate,
        // Only reserve if there is room for the full cost. At/over cap => 0 rows.
        tokens_used: { lte: DAILY_TOKEN_QUOTA - cost },
      },
      data: {
        tokens_used: { increment: cost },
        request_count: { increment: 1 },
      },
    });

    if (guarded.count === 0) {
      throw new HttpException(
        {
          error: AI_DAILY_QUOTA_EXCEEDED,
          message:
            'You have reached your daily AI coaching limit. It refreshes tomorrow.',
        },
        HttpStatus.TOO_MANY_REQUESTS, // 429
      );
    }
  }

  // A1 — reconcile the up-front reservation to the provider's actual usage.
  // We reserved `reserved` tokens; the real cost was `actual`. Adjust
  // tokens_used by (actual - reserved) so the ledger reflects reality. We
  // clamp the floor of tokens_used at 0 in the over-refund edge case by never
  // decrementing below the row's value via a guarded updateMany. Non-fatal.
  private async reconcileDailyTokens(
    userId: string,
    reserved: number,
    actual: number,
  ): Promise<void> {
    const delta = actual - reserved;
    if (delta === 0) return;
    const quotaDate = this.getQuotaDate();
    try {
      if (delta > 0) {
        await this.prisma.userAIQuota.updateMany({
          where: { user_id: userId, quota_date: quotaDate },
          data: { tokens_used: { increment: delta } },
        });
      } else {
        // Refund the unused reservation, never below 0.
        const refund = -delta;
        await this.prisma.userAIQuota.updateMany({
          where: { user_id: userId, quota_date: quotaDate, tokens_used: { gte: refund } },
          data: { tokens_used: { decrement: refund } },
        });
      }
    } catch (error) {
      this.logger.warn(
        `Daily token reconcile failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
