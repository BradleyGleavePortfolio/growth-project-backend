/**
 * Nudge v1 — in-app + push copy.
 *
 * Tone doctrine (per R1+ "calm, premium, mindful, lifestyle" rule and the
 * Phantom/Duolingo references in Mobile-App-Design-Intelligence Part II):
 *
 *   - No exclamation marks.
 *   - No streak numbers ("you broke your 14-day streak" is forbidden).
 *   - No guilt vocabulary: "missed", "forgot", "you've been gone".
 *   - First-person "your", not commanding "do this".
 *   - Frame absence as quiet, not failure. "Your practice has been quiet"
 *     not "You haven't checked in".
 *
 * Email subject lines live in src/email/email.service.ts so the existing
 * subject-template machinery picks them up; the bodies are the .hbs
 * templates under src/email/templates/nudge-*.hbs.
 */
import { NudgeTriggerType } from './nudge.types';

export interface NudgeCopy {
  /** Notification body (in-app + push body). Max 160 chars enforced downstream. */
  body: string;
  /** Push notification title. Short, warm, no urgency. */
  pushTitle: string;
  /** tgp:// deep-link the notification opens. */
  deepLink: string;
}

export function nudgeCopyFor(
  trigger: NudgeTriggerType,
  ctx: { first_name?: string } = {},
): NudgeCopy {
  // Optional first-name softener. Falls back to a tone-safe phrase
  // when the name is missing so we never render "Hi ,".
  const hi = ctx.first_name ? `${ctx.first_name}, ` : '';

  switch (trigger) {
    case 'missed_checkin':
      return {
        pushTitle: 'A gentle check-in',
        body: `${hi}your space is here when you're ready. One minute, one check-in — that's the whole practice.`,
        deepLink: 'tgp://checkin/today',
      };
    case 'streak_broken':
      return {
        pushTitle: 'Your practice is here',
        body: `${hi}your rhythm has been quiet. Today is a complete starting point on its own — no catching up needed.`,
        deepLink: 'tgp://checkin/today',
      };
    case 'onboarding_abandoned':
      return {
        pushTitle: 'Pick up where you left off',
        body: `${hi}a few quiet steps left to finish setting up your space. Under three minutes, whenever it fits.`,
        deepLink: 'tgp://onboarding',
      };
    case 'inactive':
      return {
        pushTitle: 'Quietly waiting for you',
        body: `${hi}your space is exactly how you left it. Come back when the moment fits — the work isn't going anywhere.`,
        deepLink: 'tgp://home',
      };
  }
}
