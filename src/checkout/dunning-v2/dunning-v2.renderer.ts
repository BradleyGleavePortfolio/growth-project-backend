import { Injectable } from '@nestjs/common';
import {
  BlockerCopy,
  BlockerVariant,
  COACH_EMAIL,
  COACH_INAPP,
  COACH_PUSH,
  DAY0_PUSH,
  DAY1_EMAIL,
  DAY1_PUSH,
  DAY3_BLOCKER,
  DAY3_EMAIL,
  DAY3_PUSH,
  DAY7_BLOCKER,
  DAY7_EMAIL,
  DAY7_PUSH,
  EXPIRED_LINK,
  LOCKOUT_SCREEN,
  LOCKOUT_SCREEN_ERROR,
  LR_DAY3_BLOCKER,
  LR_DAY3_PUSH,
  LR_DAY7_ESCALATION,
  ROMAN_FLAGS,
  RomanVariantPair,
} from './dunning-v2.copy';

/**
 * B3 Smart Dunning v2 — Roman copy renderer.
 *
 * Resolves a copy key + tokens into the final string, applying the locked
 * Roman quip rotation (ROMAN_VOICE_POLICY §3.2, §5):
 *   - client surfaces quip at `roman_quip_rate_client` (0.125, ~1-in-8);
 *   - coach surfaces quip at `roman_quip_rate_coach` (0.083, ~1-in-12);
 *   - NEVER two quips in a row (enforced locally per `QuipRotation`);
 *   - money/lockout surfaces may opt out of a quip on any render.
 *
 * The quip decision selects the `dryRoman` variant; otherwise `straight`. The
 * straight variant is always available, so a no-quip render is always valid.
 */

export type RecipientRole = 'client' | 'coach';

export interface CopyTokens {
  firstName?: string;
  coachName?: string;
  clientName?: string;
  amount?: string;
  cardLast4?: string;
  lockoutDate?: string;
  reason?: string;
  dunningDetailDeeplink?: string;
}

/**
 * Local "never two quips in a row" gate. Callers thread one instance per
 * session/recipient so the constraint holds across a render sequence.
 */
export class QuipRotation {
  private lastWasQuip = false;

  constructor(
    private readonly rng: () => number = Math.random,
  ) {}

  /**
   * Decide whether THIS render should quip. Returns false if the previous
   * render quipped (never two in a row) or the surface opted out.
   */
  shouldQuip(role: RecipientRole, optOut = false): boolean {
    if (optOut || this.lastWasQuip) {
      this.lastWasQuip = false;
      return false;
    }
    const rate =
      role === 'coach'
        ? ROMAN_FLAGS.roman_quip_rate_coach
        : ROMAN_FLAGS.roman_quip_rate_client;
    const quip = this.rng() < rate;
    this.lastWasQuip = quip;
    return quip;
  }
}

/** Substitute {token} placeholders. Absent tokens are left as-is for clarity. */
export function applyTokens(template: string, tokens: CopyTokens): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = (tokens as Record<string, unknown>)[key];
    return v === undefined || v === null ? match : String(v);
  });
}

@Injectable()
export class DunningV2Renderer {
  /** Pick straight vs dry-Roman from a variant pair, then substitute tokens. */
  renderPair(
    pair: RomanVariantPair,
    tokens: CopyTokens,
    quip: boolean,
  ): string {
    return applyTokens(quip ? pair.dryRoman : pair.straight, tokens);
  }

  /** Render a blocker (headline + body + CTAs) with token substitution. */
  renderBlocker(
    copy: BlockerCopy,
    tokens: CopyTokens,
    quip: boolean,
  ): BlockerVariant {
    const v = quip ? copy.dryRoman : copy.straight;
    return {
      headline: applyTokens(v.headline, tokens),
      body: applyTokens(v.body, tokens),
      primaryCta: v.primaryCta,
      secondaryCta: v.secondaryCta,
    };
  }

  // ── Convenience resolvers keyed by classifier copyKey ────────────────────

  /** Client push string for the given copyKey. Money surface: quip allowed. */
  clientPush(copyKey: string, tokens: CopyTokens, quip: boolean): string {
    const pair = this.pushPair(copyKey);
    return this.renderPair(pair, tokens, quip);
  }

  /** Client email body for the given copyKey. */
  clientEmail(copyKey: string, tokens: CopyTokens, quip: boolean): string {
    const pair = this.emailPair(copyKey);
    return this.renderPair(pair, tokens, quip);
  }

  /** Day-3 / Day-7 / late-reversal blocker for the given variant. */
  blocker(
    variant: 'day3' | 'day7' | 'lr_day3',
    tokens: CopyTokens,
    quip: boolean,
  ): BlockerVariant {
    const copy =
      variant === 'day7'
        ? DAY7_BLOCKER
        : variant === 'lr_day3'
          ? LR_DAY3_BLOCKER
          : DAY3_BLOCKER;
    return this.renderBlocker(copy, tokens, quip);
  }

  /** Lockout screen (Day 10 / late-reversal Day-10 are identical). */
  lockoutScreen(tokens: CopyTokens, quip: boolean): string {
    return this.renderPair(LOCKOUT_SCREEN, tokens, quip);
  }

  lockoutScreenError(tokens: CopyTokens, quip: boolean): string {
    return this.renderPair(LOCKOUT_SCREEN_ERROR, tokens, quip);
  }

  expiredLink(tokens: CopyTokens, quip: boolean): string {
    return this.renderPair(EXPIRED_LINK, tokens, quip);
  }

  // ── Coach (all three channels) ───────────────────────────────────────────
  coachInApp(tokens: CopyTokens, quip: boolean): string {
    return this.renderPair(COACH_INAPP, tokens, quip);
  }

  coachPush(tokens: CopyTokens, quip: boolean): string {
    return this.renderPair(COACH_PUSH, tokens, quip);
  }

  coachEmail(tokens: CopyTokens, quip: boolean): string {
    return this.renderPair(COACH_EMAIL, tokens, quip);
  }

  private pushPair(copyKey: string): RomanVariantPair {
    switch (copyKey) {
      case 'day0':
        return DAY0_PUSH;
      case 'day1':
        return DAY1_PUSH;
      case 'day3':
        return DAY3_PUSH;
      case 'day7':
        return DAY7_PUSH;
      case 'lr_day3':
        return LR_DAY3_PUSH;
      default:
        return DAY1_PUSH;
    }
  }

  private emailPair(copyKey: string): RomanVariantPair {
    switch (copyKey) {
      case 'day1':
        return DAY1_EMAIL;
      case 'day3':
        return DAY3_EMAIL;
      case 'day7':
        return DAY7_EMAIL;
      case 'lr_day7':
        return LR_DAY7_ESCALATION;
      default:
        return DAY1_EMAIL;
    }
  }
}
