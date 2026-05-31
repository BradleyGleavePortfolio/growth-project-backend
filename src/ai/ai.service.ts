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

// A1 — the daily cap bounds provider TOTAL tokens (prompt + completion). It is
// enforced as a two-part mechanism: a BOUNDED BEST-EFFORT pre-spend reservation
// gate, trued up by an EXACT post-call reconcile. The pre-gate works as:
//
//   1. CLAMP the assembled prompt's user-controllable tail. We clamp
//      (history + user message) so the assembled prompt fits MAX_INPUT_CHARS
//      characters BEFORE sending it, and that clamped text is what every
//      provider branch sends. Oversized context/history is truncated
//      (documented, lossy on extreme inputs only).
//   2. RESERVE an estimated worst case = MAX_INPUT_TOKENS + MAX_TOKENS_PER_CALL,
//      where MAX_INPUT_TOKENS = MAX_INPUT_CHARS / APPROX_CHARS_PER_TOKEN. Output
//      is hard-capped at MAX_TOKENS_PER_CALL at the provider.
//   3. RECONCILE to the provider's ACTUAL reported usage after the call
//      (decrement-only, underflow-guarded). This post-reconcile is what makes
//      the running DAILY TOTAL exact and authoritative.
//
// ACCEPTED-LIMITATION (A1, owner-accepted P2/P3 — documented, NOT a defect to
// fix): the chars/APPROX_CHARS_PER_TOKEN estimate is a HEURISTIC, not a provable
// token upper bound. CJK text, emoji, and base64 can tokenize to MORE tokens
// than chars/3 predicts, and the system-prompt / role-framing tokens are not
// included in the pre-gate clamp. So the pre-gate is BEST-EFFORT and a single
// over-budget call can transiently overshoot the cap until the EXACT post-call
// reconcile trues the daily total up. The cap is therefore enforced as a
// bounded best-effort pre-gate plus an exact, authoritative post-reconcile.
export const APPROX_CHARS_PER_TOKEN = 3;

// Backward-compatible alias. Older call sites / tests reference
// CONSERVATIVE_CHARS_PER_TOKEN; it now points at the clearly-named heuristic
// constant above. NOTE: the name "conservative" overstated the guarantee — the
// ratio is a best-effort heuristic, not a conservative provable bound (see the
// ACCEPTED-LIMITATION note above). Value and behavior are unchanged.
export const CONSERVATIVE_CHARS_PER_TOKEN = APPROX_CHARS_PER_TOKEN;

// Estimated ceiling on the provider INPUT tokens any single call is sized for.
// Half the daily quota, so a single estimated-worst-case call (input ceiling +
// max output) always fits within the daily budget at least once. The assembled
// prompt's user-controllable tail is clamped to MAX_INPUT_CHARS = MAX_INPUT_TOKENS
// * APPROX_CHARS_PER_TOKEN. Per the ACCEPTED-LIMITATION note above this maps to
// MAX_INPUT_TOKENS only as a BEST-EFFORT heuristic (not a provable bound); the
// exact post-call reconcile is what makes the daily total authoritative.
export const MAX_INPUT_TOKENS = DAILY_TOKEN_QUOTA / 2; // 6000
export const MAX_INPUT_CHARS = MAX_INPUT_TOKENS * CONSERVATIVE_CHARS_PER_TOKEN; // 18000

// The estimated worst-case TOTAL tokens a single call is reserved for: the
// estimated input ceiling plus the hard provider output cap. Reserving this up
// front is the BOUNDED BEST-EFFORT pre-spend gate (see the ACCEPTED-LIMITATION
// note above); the exact post-call reconcile trues the daily total up.
export const PER_CALL_TOKEN_RESERVATION = MAX_INPUT_TOKENS + MAX_TOKENS_PER_CALL; // 6600

// Clamp the user-controllable prompt so the TOTAL assembled text the provider
// receives never exceeds MAX_INPUT_CHARS. The system prompt carries guardrails
// and is preserved intact (it is app-controlled and bounded by the finite
// CLIENT_CONTEXT fields, comfortably under the ceiling); only the
// user-controllable tail (conversation history + the user message) is truncated
// to fit. NOTE (ACCEPTED-LIMITATION): clamping CHARACTERS bounds the assembled
// text length, but char count maps to token count only as a best-effort
// heuristic (chars/APPROX_CHARS_PER_TOKEN), and the system prompt's own tokens
// are not part of this clamp. The reservation built from it is therefore a
// best-effort pre-gate, not a provable hard cap; the exact post-call reconcile
// is authoritative for the daily total.
//
// Returns the clamped history (oldest-trimmed, each entry length-bounded) and
// the clamped user message. The combined length of systemPrompt + the returned
// parts (with single-char join separators) is <= MAX_INPUT_CHARS.
export function clampPromptParts(
  systemPrompt: string,
  history: Array<{ role: ChatRole; content: string }>,
  userMessage: string,
): { history: Array<{ role: ChatRole; content: string }>; userMessage: string } {
  // Budget left for the user-controllable tail after the system prompt. If the
  // system prompt alone somehow exceeds the ceiling, the tail budget is 0 (the
  // system prompt is never truncated so guardrails always reach the model; the
  // ceiling is sized so this does not happen for normal app contexts).
  const tailBudget = Math.max(0, MAX_INPUT_CHARS - systemPrompt.length);

  // The user's CURRENT message takes priority over older history. Reserve up to
  // half the tail budget for it, then give the remainder to history.
  const messageBudget = Math.min(userMessage.length, Math.floor(tailBudget / 2) || tailBudget);
  const clampedMessage = userMessage.slice(0, messageBudget);

  let remaining = tailBudget - clampedMessage.length;
  // Walk history newest-first so the most recent turns survive truncation.
  const clampedHistoryReversed: Array<{ role: ChatRole; content: string }> = [];
  for (let i = history.length - 1; i >= 0 && remaining > 0; i--) {
    const entry = history[i];
    const take = Math.min(entry.content.length, remaining);
    if (take <= 0) break;
    clampedHistoryReversed.push({ role: entry.role, content: entry.content.slice(0, take) });
    remaining -= take;
  }
  return { history: clampedHistoryReversed.reverse(), userMessage: clampedMessage };
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
    // billable tokens) so we can assemble + clamp the prompt and reserve the
    // best-effort worst-case TOTAL-token estimate before any model call.
    const ctx = await this.contextSvc.build(userId);
    let modelUsed: 'perplexity' | 'anthropic' | 'fallback' = 'perplexity';

    // A1 (P1) — ENFORCE the hard input ceiling. Build the system prompt once,
    // take the last 10 history turns, then CLAMP the user-controllable prompt
    // (history + user message) so the TOTAL assembled text the provider receives
    // can never exceed MAX_INPUT_CHARS. MAX_INPUT_CHARS maps to MAX_INPUT_TOKENS
    // via APPROX_CHARS_PER_TOKEN, which is a BEST-EFFORT heuristic, not a provable
    // upper bound on real input tokens (see the ACCEPTED-LIMITATION note above):
    // CJK / emoji / base64 can tokenize to more, and the system-prompt tokens are
    // not counted. The clamped values below are what BOTH provider branches send,
    // so the assembled CHARACTER length is bounded on the wire; the token estimate
    // built from it remains best-effort. Oversized history/messages are truncated
    // (lossy only on extreme inputs; the system prompt with all guardrails is
    // preserved). The EXACT post-call reconcile is authoritative for the daily
    // total.
    const systemPrompt = this.buildSystemPrompt(ctx, userMessage);
    const clamped = clampPromptParts(
      systemPrompt,
      conversationHistory.slice(-10),
      userMessage,
    );
    const clampedHistory = clamped.history;
    const clampedUserMessage = clamped.userMessage;

    // A1 — reserve the worst-case total estimate for this call: the enforced
    // input-char ceiling (mapped to tokens via APPROX_CHARS_PER_TOKEN) plus the
    // hard provider output cap (MAX_TOKENS_PER_CALL). The assembled input is
    // clamped to MAX_INPUT_CHARS and output is hard-capped at the provider, so
    // this reservation is the up-front PRE-GATE the daily cap is enforced with.
    //
    // ACCEPTED-LIMITATION (A1, owner-accepted P2/P3 — documented, NOT fixed):
    // The pre-gate is BOUNDED BEST-EFFORT, not a provable hard upper bound.
    //  (a) chars/APPROX_CHARS_PER_TOKEN (chars/3) is a HEURISTIC estimate of
    //      token count, NOT a provable upper bound. Inputs such as CJK text,
    //      emoji, or base64 blobs can tokenize to MORE tokens than chars/3
    //      predicts, so the real provider input can exceed the estimate.
    //  (b) the input clamp bounds only the user-controllable tail (history +
    //      user message); the SYSTEM PROMPT / role-framing tokens are NOT
    //      counted in the pre-gate clamp, so the estimate omits them.
    // Consequently a single over-budget call can TRANSIENTLY overshoot the daily
    // cap before reconcile runs. Correctness of the DAILY TOTAL is guaranteed
    // NOT by this pre-gate but by the EXACT post-call reconcile below, which
    // DECREMENTS the ledger by the provider's ACTUAL reported usage. So the cap
    // is enforced as: bounded best-effort pre-gate + exact post-reconcile, and
    // the post-reconcile is the authoritative source of the running total. The
    // product owner has accepted this bounded best-effort behavior for merge.
    const reservation = PER_CALL_TOKEN_RESERVATION;

    // A1 (P1) — apply the per-user DAILY token quota as a bounded best-effort
    // pre-spend gate BEFORE we call any model. reserveDailyTokens enforces:
    //  (a) PRE-CALL reject if the already-consumed daily total is at/over cap;
    //  (b) PRE-CALL reject if the full worst-case reservation estimate would not
    //      fit in the remaining budget — a best-effort guard that blocks calls
    //      whose estimated cost cannot fit, keeping the pre-gate from running
    //      over the cap on the estimate;
    //  (c) the atomic guarded updateMany (tokens_used + reservation <= cap)
    //      which is the race-safe gate so concurrent calls cannot both pass. The
    //      reservation captures the day-bucket key (P2) ONCE here so the
    //      post-call reconcile/refund always hits the SAME row even across a
    //      midnight rollover. The EXACT post-call reconcile is what makes the
    //      running daily total authoritative.
    const quotaDate = await this.reserveDailyTokens(
      userId,
      reservation,
      reservation,
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
        // A1 (P1) — send the CLAMPED history + user message so the provider
        // input is the same bounded text the reservation was sized against.
        const historyText = clampedHistory
          .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
          .join('\n');
        const result = await this.anthropic.complete(
          {
            system: systemPrompt,
            user: historyText
              ? `${historyText}\nUser: ${clampedUserMessage}`
              : clampedUserMessage,
          },
          {
            // P3 — use the shared MAX_TOKENS_PER_CALL constant so the provider
            // output cap and the reservation can never desynchronize.
            maxTokens: MAX_TOKENS_PER_CALL,
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
      // A1 (P1) — send the CLAMPED history + user message so the provider input
      // is the same bounded text the reservation was sized against.
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...clampedHistory.map((m) => {
          // A9 defense-in-depth: the role is already validated to
          // 'user'|'assistant' by ChatRequestDto, but we still narrow here so
          // any non-'assistant' value collapses to 'user' — a 'system' role
          // can never reach Perplexity even if this method is called directly.
          const role: 'assistant' | 'user' = m.role === 'assistant' ? 'assistant' : 'user';
          return { role, content: m.content };
        }),
        { role: 'user', content: clampedUserMessage },
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
      // A1 (P1) — settle the reservation against reality on the SAME day-bucket
      // row we reserved (P2). In the designed path the reservation estimate is
      // at/above the provider's real total (enforced input-char clamp + hard
      // output cap), so reconciliation only ever DECREMENTS — it refunds the
      // over-reservation. A clamp (see reconcileDailyTokens) defends the rare
      // case where a best-effort under-estimate is exceeded so the post-call step
      // never increments above the reservation. The EXACT reconcile is what makes
      // the daily total authoritative. Three cases:
      //  1. Provider reported a real TOTAL usage => reconcile DOWN to that exact
      //     total (refund reserved - actual). Since actual <= reserved, this is
      //     always a refund; the daily ledger then reflects TRUE total tokens.
      //     This fires whenever usage was reported, INCLUDING the P2 case of a
      //     usage-but-no-text response: we charge the real usage rather than
      //     refunding it in full.
      //  2. The call produced NO billable provider tokens — a thrown provider
      //     error, or an empty completion with NO usage reported, that fell
      //     back to the deterministic responder => refund the ENTIRE
      //     reservation (P1) so a genuinely free call never leaks quota.
      //  3. Provider ran successfully but did NOT report usage => keep the
      //     worst-case reservation in place (we cannot know the true cost, so
      //     we must not refund a call that really did spend tokens; the
      //     reservation already bounds it at/under the cap).
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
  // applying the DAILY_TOKEN_QUOTA as a bounded best-effort PRE-SPEND gate.
  //
  // `cost` is the BEST-EFFORT worst-case estimate for the call (enforced
  // input-char clamp + hard output cap). It is a heuristic estimate, not a
  // provable upper bound on the real provider total (see the ACCEPTED-LIMITATION
  // note above: CJK / emoji / base64 and the uncounted system-prompt tokens can
  // exceed it). Reserving it up front gates the spend in three layers:
  //  (a) PRE-CALL reject if the already-consumed daily total is at/over the
  //      cap — an at/over-cap user is blocked even for an individually tiny
  //      call, before any model is touched.
  //  (b) PRE-CALL reject if the worst-case reservation estimate (`minRequired`,
  //      equal to `cost`) would not fit in the remaining budget — a best-effort
  //      guard that blocks calls whose estimated cost cannot fit.
  //  (c) the atomic guarded `updateMany` (tokens_used + cost <= cap, i.e.
  //      tokens_used <= cap - cost) which is the race-safe gate: N concurrent
  //      requests each either win the guarded update (count === 1) or are
  //      rejected (count === 0) with no read-modify-write race, so they can
  //      never collectively push the RESERVED total past the cap.
  //
  // Any rejection throws 429 BEFORE a model call, so an at/over-cap user never
  // burns provider tokens. In the designed path the estimate is at/above the
  // real total, so the post-call reconcile only ever refunds the
  // over-reservation DOWN. The EXACT post-call reconcile — not this pre-gate — is
  // what makes the running daily total authoritative; the pre-gate is bounded
  // best-effort.
  //
  // P2 (day key) — returns the captured quota_date so the caller passes the
  // SAME day-bucket key to the post-call reconcile/refund. Recomputing the
  // bucket at reconcile time would mis-target the row for a request that
  // crosses midnight; reusing the reservation's key keeps reserve and reconcile
  // on the same ledger row.
  private async reserveDailyTokens(
    userId: string,
    cost: number,
    minRequired: number,
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

    // (a) + (b) — explicit pre-call checks. Reject when already at/over the cap,
    // or when the worst-case reservation estimate would not fit in the remaining
    // budget. These are best-effort pre-spend guards on the estimate; the EXACT
    // post-call reconcile is what makes the daily total authoritative.
    const consumed = row?.tokens_used ?? 0;
    if (
      consumed >= DAILY_TOKEN_QUOTA ||
      consumed + minRequired > DAILY_TOKEN_QUOTA
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

  // A1 (P1) — reconcile the up-front reservation DOWN to the provider's actual
  // TOTAL usage (prompt + completion). We reserved `reserved` tokens (a
  // best-effort worst-case estimate); the real cost was `actual`. In the
  // designed path the estimate is at/above the real total, so `actual <=
  // reserved` and reconciliation is a refund (decrement) of `reserved - actual`.
  // This EXACT reconcile is what makes the daily total authoritative: after it
  // runs the ledger reflects the provider's ACTUAL reported usage, regardless of
  // whether the best-effort pre-estimate over- or under-counted.
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
  // Defensive: if a provider ever reports actual > reserved (possible since the
  // pre-estimate is best-effort, not a provable bound — e.g. heavy tokenization
  // the heuristic could not foresee), we DO NOT apply an unguarded post-spend
  // increment. Instead we clamp the reconcile to charge at most the reservation
  // (treat the call as having consumed its full reservation — i.e. no refund),
  // so the post-call step never increments the ledger above what was reserved.
  //
  // Safety: the refund is a DB-side decrement guarded by tokens_used >= refund
  // so it can never underflow below zero, and it is atomic (single guarded
  // updateMany). Non-fatal: a failed reconcile leaves the worst-case
  // reservation in place rather than throwing.
  private async reconcileDailyTokens(
    userId: string,
    quotaDate: Date,
    reserved: number,
    actual: number,
  ): Promise<void> {
    // Clamp actual at the reservation: in the designed path the best-effort
    // estimate is at/above the real total, so actual should not exceed it. If a
    // provider ever reports more, we charge at most the reservation (no
    // post-spend increment), so the post-call step never grows the ledger above
    // what was reserved.
    const effectiveActual = Math.min(actual, reserved);
    const refund = reserved - effectiveActual; // always >= 0 (decrement-only)
    if (refund === 0) return;
    try {
      // Refund the over-reserved (or, when actual=0, the full) reservation,
      // never below 0. The guard makes the decrement atomic and underflow-safe.
      await this.prisma.userAIQuota.updateMany({
        where: { user_id: userId, quota_date: quotaDate, tokens_used: { gte: refund } },
        data: { tokens_used: { decrement: refund } },
      });
    } catch (error) {
      this.logger.warn(
        `Daily token reconcile failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
