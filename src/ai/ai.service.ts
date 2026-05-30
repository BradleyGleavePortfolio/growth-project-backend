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

// A1 (P1-a) — the daily cap must bound TOTAL tokens (prompt + completion), not
// just the 600-token output ceiling. Before any model call we cannot know the
// exact prompt-token count the provider will bill, so we estimate the input
// side from the assembled prompt + history and reserve
//   estimatedInputTokens + MAX_TOKENS_PER_CALL
// up front, then reconcile to the provider's reported TOTAL usage after the
// call. The estimate uses the common ~4-chars-per-token heuristic with a small
// safety multiplier so we err on over-reserving (which the post-call reconcile
// refunds) rather than under-reserving (which would let total usage overshoot
// the cap). A floor keeps tiny prompts from under-reserving.
export const CHARS_PER_TOKEN = 4;
export const INPUT_TOKEN_SAFETY = 1.15;
export const MIN_INPUT_TOKEN_ESTIMATE = 200;

// Estimate the prompt-side token count from the total character length of the
// text we will send to the provider (system prompt + history + user message).
// Deliberately conservative: rounds up and applies a safety multiplier so the
// up-front reservation is an upper bound on real input usage.
export function estimateInputTokens(text: string): number {
  const chars = text.length;
  const raw = Math.ceil((chars / CHARS_PER_TOKEN) * INPUT_TOKEN_SAFETY);
  return Math.max(MIN_INPUT_TOKEN_ESTIMATE, raw);
}

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
    // A1 — build context first (this performs NO provider calls and burns no
    // billable tokens) so we can estimate the prompt-side token count and
    // reserve a realistic TOTAL-token upper bound before any model call.
    const ctx = await this.contextSvc.build(userId);
    let modelUsed: 'perplexity' | 'anthropic' | 'fallback' = 'perplexity';

    // A1 (P1-a) — estimate the input (prompt) tokens from the exact text we
    // will send so the reservation bounds TOTAL tokens, not just output. The
    // system prompt + the last 10 history turns + the user message are what the
    // provider bills as input, so we size the estimate off that same text.
    const promptText = [
      this.buildSystemPrompt(ctx, userMessage),
      ...conversationHistory.slice(-10).map((m) => m.content),
      userMessage,
    ].join('\n');
    const estimatedInput = estimateInputTokens(promptText);
    const reservation = estimatedInput + MAX_TOKENS_PER_CALL;

    // A1 (P1) — enforce the per-user DAILY token quota as a HARD total-token
    // bound BEFORE we call any model, so an at-cap user never burns provider
    // tokens. RESERVE-then-RECONCILE: reserve the worst-case TOTAL per-call
    // budget (estimated input + max output) up front via an atomic, race-safe
    // guarded increment, then reconcile to the provider's actual TOTAL usage
    // after the call. reserveDailyTokens enforces three things:
    //  (a) PRE-CALL reject if the already-consumed daily total is at/over cap;
    //  (b) PRE-CALL reject if the estimated INPUT alone would blow the
    //      remaining budget (bounds single-call overshoot: with output capped
    //      at MAX_TOKENS_PER_CALL, no single call can run unless input fits);
    //  (c) the atomic guarded updateMany (tokens_used + reservation <= cap)
    //      which is the hard race-safe gate so concurrent calls cannot both
    //      pass. The reservation captures the day-bucket key (P2) ONCE here so
    //      the post-call reconcile/refund always hits the SAME row even across
    //      a midnight rollover.
    const quotaDate = await this.reserveDailyTokens(
      userId,
      reservation,
      estimatedInput,
    );

    // A1 (P1-a) — actual provider TOTAL token usage (prompt+completion) when
    // the provider reports it, for the post-call reconcile against the up-front
    // reservation. Null means the provider never ran or did not report usage
    // (e.g. the deterministic fallback), in which case the reservation is
    // refunded in full (P1-b) since no billable tokens were spent.
    let actualTokens: number | null = null;
    let rawReply = '';
    const perplexityKey = process.env.PERPLEXITY_API_KEY?.trim();
    const anthropicReady =
      this.anthropic && this.coachAIState && this.coachAIState.isReady();

    // A1 (P1-b) — reconcile/refund the reservation in a finally path so a
    // failed or fallback call never permanently leaks reserved quota. When the
    // provider reported real usage we reconcile the reservation to that TOTAL;
    // otherwise (exception, empty completion, or fallback) we refund the entire
    // reservation because no billable provider tokens were consumed.
    try {
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
        // P2 — the provider may report billable usage even when it returns no
        // text (e.g. a truncated/empty completion that still consumed prompt +
        // some output tokens). Capture the reported usage REGARDLESS of whether
        // there was text so the reconcile charges the TRUE usage instead of
        // refunding a call that genuinely spent tokens. Only a response with no
        // usage at all leaves actualTokens null (full refund in the finally).
        const reportedUsage = (result.tokensIn ?? 0) + (result.tokensOut ?? 0);
        if (reportedUsage > 0) {
          actualTokens = reportedUsage;
        }
        if (result.text) {
          rawReply = result.text;
          modelUsed = 'anthropic';
        } else {
          // No text to return to the user — serve the deterministic fallback,
          // but the daily ledger is reconciled to the real usage above (P2),
          // NOT refunded, because the provider still billed those tokens.
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
        // P2 — capture the reported TOTAL usage REGARDLESS of whether the
        // provider returned text. A response with empty content but a real
        // usage figure still billed those tokens, so we reconcile to the true
        // usage rather than refunding the reservation in full. Only a response
        // with no usage figure leaves actualTokens null (full refund).
        if (typeof response.usage?.total_tokens === 'number') {
          actualTokens = response.usage.total_tokens;
        }
        if (response.choices[0]?.message?.content) {
          rawReply = response.choices[0].message.content;
        } else {
          // No text — serve the deterministic fallback, but keep the real usage
          // (captured above) charged to the daily ledger (P2), not refunded.
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

    } finally {
      // A1 (P1 + P2) — settle the reservation against reality on the SAME
      // day-bucket row we reserved (P2). Three cases:
      //  1. Provider reported a real TOTAL usage => reconcile the reservation to
      //     that exact total (refund the over-reserved difference, or charge
      //     the remainder in the actual>reservation case) so the daily ledger
      //     bounds TRUE total tokens (P1). This branch fires whenever usage was
      //     reported, INCLUDING the P2 case of a usage-but-no-text response:
      //     we charge the real usage rather than refunding it, and because the
      //     ledger now reflects that real spend the NEXT call is correctly
      //     gated by the pre-call cap check.
      //  2. The call produced NO billable provider tokens — a thrown provider
      //     error, or an empty completion with NO usage reported, that fell
      //     back to the deterministic responder => refund the ENTIRE
      //     reservation (P1) so a genuinely free call never leaks quota.
      //  3. Provider ran successfully but did NOT report usage => keep the
      //     conservative reservation in place (we cannot know the true cost, so
      //     we must not refund a call that really did spend tokens).
      if (actualTokens != null) {
        await this.reconcileDailyTokens(userId, quotaDate, reservation, actualTokens);
      } else if (modelUsed === 'fallback') {
        await this.reconcileDailyTokens(userId, quotaDate, reservation, 0);
      }
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

  // A1 (P1) — atomically reserve `cost` tokens against the user's daily budget,
  // enforcing the DAILY_TOKEN_QUOTA as a HARD total-token bound.
  //
  // The cap is a HARD pre-call gate enforced in three layers:
  //  (a) PRE-CALL reject if the already-consumed daily total is at/over the
  //      cap — an at/over-cap user is blocked even for an individually tiny
  //      call, before any model is touched.
  //  (b) PRE-CALL reject if the estimated INPUT alone (`inputFloor`) would not
  //      fit in the remaining budget. Because the output side is hard-capped at
  //      MAX_TOKENS_PER_CALL, refusing a call whose input alone overflows the
  //      remaining budget bounds any single-call overshoot: no call can run
  //      unless at minimum its input fits, so the heuristic reservation can
  //      never let a wildly oversized prompt slip through and blow the cap.
  //  (c) the atomic guarded `updateMany` (tokens_used + cost <= cap, i.e.
  //      tokens_used <= cap - cost) which is the race-safe hard gate: N
  //      concurrent requests each either win the guarded update (count === 1)
  //      or are rejected (count === 0) with no read-modify-write race, so they
  //      can never collectively push tokens_used past the cap.
  //
  // Any rejection throws 429 BEFORE a model call, so an at/over-cap user never
  // burns provider tokens. The post-call reconcile then writes the TRUE total
  // usage back (even if it slightly exceeds the reservation), so the NEXT call
  // is correctly blocked by layer (a) once real consumption reaches the cap —
  // a user cannot keep issuing calls once they have hit it.
  //
  // P2 (day key) — returns the captured quota_date so the caller passes the
  // SAME day-bucket key to the post-call reconcile/refund. Recomputing the
  // bucket at reconcile time would mis-target the row for a request that
  // crosses midnight; reusing the reservation's key keeps reserve and reconcile
  // on the same ledger row.
  private async reserveDailyTokens(
    userId: string,
    cost: number,
    inputFloor: number,
  ): Promise<Date> {
    const quotaDate = this.getQuotaDate();

    // Upsert returns the current row so we can run the explicit pre-call checks
    // below. The @@unique makes the upsert idempotent under concurrency; we
    // create the day's row at zero so the guarded increment is the single
    // source of truth for the reservation (avoids a create that races a
    // concurrent reserve into double-charging).
    const row = await this.prisma.userAIQuota.upsert({
      where: { UserAIQuota_user_id_quota_date_key: { user_id: userId, quota_date: quotaDate } },
      create: { user_id: userId, quota_date: quotaDate, tokens_used: 0, request_count: 0 },
      update: {},
    });

    // (a) + (b) — explicit HARD pre-call checks. Reject when already at/over the
    // cap, or when the estimated input alone would not fit in the remaining
    // budget. These bound any single-call overshoot before the model runs.
    const consumed = row?.tokens_used ?? 0;
    if (
      consumed >= DAILY_TOKEN_QUOTA ||
      consumed + inputFloor > DAILY_TOKEN_QUOTA
    ) {
      throw new HttpException(
        {
          error: AI_DAILY_QUOTA_EXCEEDED,
          message:
            'You have reached your daily AI coaching limit. It refreshes tomorrow.',
        },
        HttpStatus.TOO_MANY_REQUESTS, // 429
      );
    }

    // (c) — the atomic race-safe hard gate. Only reserve the full cost if there
    // is room for it (tokens_used + cost <= cap). At/over the remaining budget
    // this matches 0 rows and we reject below.
    const guarded = await this.prisma.userAIQuota.updateMany({
      where: {
        user_id: userId,
        quota_date: quotaDate,
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

    return quotaDate;
  }

  // A1 — reconcile the up-front reservation to the provider's actual TOTAL
  // usage (prompt + completion). We reserved `reserved` tokens; the real cost
  // was `actual`. Adjust tokens_used by (actual - reserved) so the daily ledger
  // reflects TRUE total tokens (P1-a) and subsequent calls are gated on the
  // real consumption.
  //
  // P1-b — when the call spent no billable tokens (provider failure, empty
  // completion, or deterministic fallback) the caller passes actual=0, which
  // refunds the ENTIRE reservation so a failed call never permanently consumes
  // quota.
  //
  // P2 — the day-bucket key is the one CAPTURED AT RESERVATION TIME and passed
  // in here, so reserve and reconcile always hit the same row even across a
  // midnight rollover.
  //
  // Safety: the refund is a DB-side decrement guarded by tokens_used >= refund
  // so it can never underflow below zero, and it is atomic (single guarded
  // updateMany). A charge in the rare actual>reserved case is a DB-side
  // increment. Non-fatal: a failed reconcile leaves the conservative
  // reservation in place rather than throwing.
  private async reconcileDailyTokens(
    userId: string,
    quotaDate: Date,
    reserved: number,
    actual: number,
  ): Promise<void> {
    const delta = actual - reserved;
    if (delta === 0) return;
    try {
      if (delta > 0) {
        await this.prisma.userAIQuota.updateMany({
          where: { user_id: userId, quota_date: quotaDate },
          data: { tokens_used: { increment: delta } },
        });
      } else {
        // Refund the over-reserved (or, when actual=0, the full) reservation,
        // never below 0. The guard makes the decrement atomic and underflow-safe.
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
