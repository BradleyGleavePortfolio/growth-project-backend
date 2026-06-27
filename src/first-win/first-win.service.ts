import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../prisma.service';
import { createBreaker } from '../circuit-breakers/circuit-breaker.factory';

export type WinType = 'logged_first_weight' | 'set_first_goal' | 'first_checkin' | 'first_meal';

const VALID_WIN_TYPES = new Set<WinType>([
  'logged_first_weight',
  'set_first_goal',
  'first_checkin',
  'first_meal',
]);

export function isValidWinType(value: unknown): value is WinType {
  return typeof value === 'string' && VALID_WIN_TYPES.has(value as WinType);
}

// Deterministic fallback messages per win-type — used when PERPLEXITY_API_KEY
// is unset or the upstream call fails. These follow the voice doctrine: no
// emoji, no hype, numbers over adjectives.
const FALLBACK_MESSAGES: Record<WinType, string> = {
  logged_first_weight:
    'Your first weight log sets the baseline every future measurement is compared against. Tracking consistently, even on days the number is not where you want it, is the discipline that produces results over 90 days.',
  set_first_goal:
    'Setting a clear goal turns a direction into a destination. Every decision from here — what you eat, when you train — can now be tested against that target.',
  first_checkin:
    'Your first check-in opens the feedback loop. The data you submit each day lets your coach adjust your plan before small drifts become large ones.',
  first_meal:
    'Logging your first meal starts your nutrition baseline. Three days of honest data tells your coach more about your habits than any intake form.',
};

@Injectable()
export class FirstWinService {
  private readonly logger = new Logger(FirstWinService.name);

  // H6 (D-H6-2): per-client Opossum breaker around the outbound
  // OpenAI-compatible (Perplexity) chat-completions boundary. 'default'
  // profile (8s/50%/30s). The caller already null-checks the client and
  // falls back to a deterministic message; the breaker only fails fast on a
  // sustained upstream outage. Touches only the SDK call boundary.
  private guardedChat = createBreaker(
    'openai',
    (client: OpenAI, params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) =>
      client.chat.completions.create(params),
    { key: 'openai:first-win' },
  );

  // Lazy-init: OpenAI SDK v5+ throws synchronously when apiKey is empty,
  // so we defer construction until first use and read the env var at call
  // time. Returns null when the key is unset so callers can fall back to
  // the deterministic message without an exception path.
  private _perplexity: OpenAI | null = null;
  private _perplexityInitialized = false;
  private getPerplexityClient(): OpenAI | null {
    if (!this._perplexityInitialized) {
      const key = process.env.PERPLEXITY_API_KEY?.trim();
      this._perplexity = key
        ? new OpenAI({ apiKey: key, baseURL: 'https://api.perplexity.ai' })
        : null;
      this._perplexityInitialized = true;
    }
    return this._perplexity;
  }

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Marks the Day 1 Win as completed for the given user and generates a
   * 2-sentence AI message explaining what that first data point means.
   *
   * Idempotent: if `first_win_completed_at` is already set the existing
   * timestamp is returned unchanged — no second write is made. The AI
   * message is still generated on re-calls so the mobile can re-display it.
   *
   * @param userId  The internal User.id (UUID)
   * @param winType The specific win action the client completed
   * @returns { completedAt, aiMessage }
   */
  async complete(
    userId: string,
    winType: WinType,
  ): Promise<{ completedAt: Date; aiMessage: string }> {
    // Read current state first to avoid a write on every call (idempotency).
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { first_win_completed_at: true },
    });

    let completedAt: Date;

    if (user.first_win_completed_at !== null) {
      // Already completed — return the original timestamp. No DB write.
      completedAt = user.first_win_completed_at;
    } else {
      completedAt = new Date();
      await this.prisma.user.update({
        where: { id: userId },
        data: { first_win_completed_at: completedAt },
      });
    }

    // Generate the AI message fire-and-forget-style as an async operation that
    // we still await here — the delay is acceptable (< 3s in practice) because
    // this is a one-time first-open event. See README for the async-polling
    // alternative if latency becomes a concern.
    const aiMessage = await this.generateFirstDataPointMessage(winType);

    return { completedAt, aiMessage };
  }

  /**
   * Returns whether the Day 1 Win has been completed and when.
   *
   * @param userId The internal User.id (UUID)
   */
  async getStatus(userId: string): Promise<{ completed: boolean; completedAt: string | null }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { first_win_completed_at: true },
    });

    const completedAt = user.first_win_completed_at;
    return {
      completed: completedAt !== null,
      completedAt: completedAt ? completedAt.toISOString() : null,
    };
  }

  /**
   * Generates a 2-sentence coaching message explaining what the client's
   * first data point means. Falls back to a deterministic message if
   * Perplexity is unavailable or slow.
   *
   * Voice doctrine enforced in system prompt: no emoji, no hype, numbers
   * over adjectives, 2 sentences only.
   */
  private async generateFirstDataPointMessage(winType: WinType): Promise<string> {
    const perplexity = this.getPerplexityClient();
    if (!perplexity) {
      return FALLBACK_MESSAGES[winType];
    }

    const winLabel: Record<WinType, string> = {
      logged_first_weight: 'logged their first body weight measurement',
      set_first_goal: 'set their first 90-day goal',
      first_checkin: 'submitted their first daily check-in',
      first_meal: 'logged their first meal',
    };

    const systemPrompt =
      'You are a factual coaching assistant for a results-driven fitness and lifestyle programme. ' +
      'Write exactly 2 sentences. No emoji. No exclamation marks. No hype words. ' +
      'Numbers over adjectives. Address the client directly using "you" and "your". ' +
      'Explain what this specific first data point means for their progress, ' +
      'and why consistency with this action over the next 90 days matters.';

    const userMessage = `The client has just ${winLabel[winType]}. Write the 2-sentence message.`;

    try {
      const response = await this.guardedChat(perplexity, {
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.4,
        max_tokens: 120,
      });

      const text = response.choices[0]?.message?.content?.trim() ?? '';
      if (text.length > 10) return text;

      this.logger.warn('first-win: Perplexity returned empty content, using fallback');
      return FALLBACK_MESSAGES[winType];
    } catch (err) {
      // Fire-and-forget principle: AI failure must never break the primary
      // win-completion operation. Log and return the deterministic fallback.
      this.logger.error('first-win: Perplexity call failed, using fallback', err);
      return FALLBACK_MESSAGES[winType];
    }
  }
}
