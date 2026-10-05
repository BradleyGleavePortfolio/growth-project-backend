import { Injectable } from '@nestjs/common';
import type { CoachlessPromptState } from '@prisma/client';
import { isUniqueViolation } from './coach-code-lookup.service';
import { PrismaService } from '../prisma.service';
import type { ResolvedFeaturedCoach, RomanCaps } from './featured-coach.service';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** Two "Not now" taps inside this window count once (double tap, retry). */
export const NOT_NOW_DEBOUNCE_MS = 60_000;

export type RomanCardHiddenReason =
  'offer_off' | 'not_accepting' | 'not_now_final' | 'snoozed' | 'weekly_cap';

export type RomanCardDecision = { show: true } | { show: false; reason: RomanCardHiddenReason };

/**
 * Frequency rules for the scripted coachless Roman card (no AI call, no
 * consent dependency — the copy is the owner's config text).
 *
 * An "impression" is a window of `min_hours_between` hours that starts the
 * first time the card is seen; the card stays visible for the rest of that
 * window (no flicker between Home visits), and at most `max_per_week`
 * impressions start in any rolling 7-day window. "Not now" hides the card
 * for `snooze_days`; after `max_not_now` taps it never returns.
 */
export function decideRomanCard(
  offer: Pick<
    ResolvedFeaturedCoach,
    'roman_enabled' | 'roman_pitch_text' | 'code' | 'accepting_clients'
  > & {
    roman_caps: RomanCaps;
  },
  state: Pick<
    CoachlessPromptState,
    | 'roman_seen_count'
    | 'roman_window_started_at'
    | 'roman_last_seen_at'
    | 'roman_not_now_count'
    | 'roman_not_now_at'
  > | null,
  now: Date,
): RomanCardDecision {
  if (!offer.roman_enabled || !offer.roman_pitch_text || !offer.code)
    return { show: false, reason: 'offer_off' };
  if (!offer.accepting_clients) return { show: false, reason: 'not_accepting' };
  const caps = offer.roman_caps;
  const t = now.getTime();
  if (state) {
    if (state.roman_not_now_count >= caps.max_not_now)
      return { show: false, reason: 'not_now_final' };
    if (
      state.roman_not_now_at &&
      t - state.roman_not_now_at.getTime() < caps.snooze_days * DAY_MS
    ) {
      return { show: false, reason: 'snoozed' };
    }
    const inImpression =
      !!state.roman_last_seen_at &&
      t - state.roman_last_seen_at.getTime() < caps.min_hours_between * HOUR_MS;
    if (inImpression) return { show: true };
    const windowOpen =
      !!state.roman_window_started_at && t - state.roman_window_started_at.getTime() < WEEK_MS;
    if (windowOpen && state.roman_seen_count >= caps.max_per_week)
      return { show: false, reason: 'weekly_cap' };
  }
  return { show: true };
}

@Injectable()
export class CoachlessPromptService {
  constructor(private readonly prisma: PrismaService) {}

  async getState(userId: string): Promise<CoachlessPromptState | null> {
    return this.prisma.coachlessPromptState.findUnique({ where: { user_id: userId } });
  }

  /**
   * Record that the card was rendered. Starts a new impression only when the
   * previous one has ended (conditional update, so concurrent calls from two
   * screens count once) and resets the weekly window when it has expired.
   */
  async recordSeen(
    userId: string,
    caps: RomanCaps,
    now = new Date(),
  ): Promise<CoachlessPromptState> {
    await this.ensureRow(userId);
    const impressionCutoff = new Date(now.getTime() - caps.min_hours_between * HOUR_MS);
    const windowCutoff = new Date(now.getTime() - WEEK_MS);
    // New weekly window: the old one expired (or never started).
    const reset = await this.prisma.coachlessPromptState.updateMany({
      where: {
        user_id: userId,
        OR: [{ roman_window_started_at: null }, { roman_window_started_at: { lte: windowCutoff } }],
      },
      data: { roman_window_started_at: now, roman_seen_count: 1, roman_last_seen_at: now },
    });
    if (reset.count === 0) {
      await this.prisma.coachlessPromptState.updateMany({
        where: {
          user_id: userId,
          OR: [{ roman_last_seen_at: null }, { roman_last_seen_at: { lte: impressionCutoff } }],
        },
        data: { roman_seen_count: { increment: 1 }, roman_last_seen_at: now },
      });
    }
    return this.read(userId);
  }

  /** Persist "Not now". A second tap within NOT_NOW_DEBOUNCE_MS is the same decision. */
  async recordNotNow(userId: string, now = new Date()): Promise<CoachlessPromptState> {
    await this.ensureRow(userId);
    await this.prisma.coachlessPromptState.updateMany({
      where: {
        user_id: userId,
        OR: [
          { roman_not_now_at: null },
          { roman_not_now_at: { lte: new Date(now.getTime() - NOT_NOW_DEBOUNCE_MS) } },
        ],
      },
      data: { roman_not_now_count: { increment: 1 }, roman_not_now_at: now },
    });
    return this.read(userId);
  }

  private async read(userId: string): Promise<CoachlessPromptState> {
    const row = await this.prisma.coachlessPromptState.findUnique({ where: { user_id: userId } });
    if (!row) throw new Error('CoachlessPromptState row missing right after upsert');
    return row;
  }

  private async ensureRow(userId: string): Promise<void> {
    try {
      await this.prisma.coachlessPromptState.upsert({
        where: { user_id: userId },
        create: { user_id: userId },
        update: {},
      });
    } catch (err) {
      // Two first-ever calls racing the insert: the row now exists.
      if (!isUniqueViolation(err)) throw err;
    }
  }
}
