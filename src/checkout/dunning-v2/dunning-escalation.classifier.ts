import { Injectable } from '@nestjs/common';

/**
 * B3 Smart Dunning v2 — DunningEscalationClassifier (spec §4).
 *
 * The v1 model ("suppress coach notify on auto-recoverable failure reasons,
 * notify later") is REPLACED by a deterministic channel-escalation resolver
 * keyed on `step_index`. Failure-reason taxonomy is retained elsewhere only
 * for logging/analytics — it NEVER gates a channel here.
 *
 * Per-step channel ladder (spec §4.1):
 *   Step 0 (Day 0): push only, on failure. No email/blocker/coach.
 *   Step 1 (Day 1): push + email. No blocker/coach.
 *   Step 2 (Day 3): push + email + in-app blocker. No coach.
 *   Step 3 (Day 7): push + email + in-app blocker + coach (all 3 channels).
 *   Day-10 sweep: no client notify, no coach notify.
 *
 * For a late-reversal cycle (reversal_count > 0) the resolver returns the
 * compressed `lr_*` copy keys; the cycle enters at Step 2, so Steps 0/1 are
 * skipped (spec §4.2, §6.2).
 *
 * Pure / stateless: no feature-flag check here. The caller (the v2 cadence
 * service) is already gated behind FEATURE_DUNNING_V2.
 */

export interface ChannelDecision {
  push: boolean;
  email: boolean;
  /** Render the Day-3 / Day-7 in-app blocker pop-up (spec §8.2). */
  inAppBlocker: boolean;
  /** Fan out via CoachNotifierService.notifyDunningStep7 (spec §9). */
  coachAllChannels: boolean;
  blockerVariant: 'none' | 'day3' | 'day7';
  /** Selects the copy block in §C (regular vs late-reversal — §6). */
  copyKey: string;
}

export interface ClassifierInput {
  /** 0..3 cadence step that just resolved as failed. */
  stepIndex: number;
  /** DunningState.reversal_count > 0 — a late-reversal compressed cycle. */
  isLateReversalCycle: boolean;
}

@Injectable()
export class DunningEscalationClassifier {
  resolve(input: ClassifierInput): ChannelDecision {
    const lr = input.isLateReversalCycle;
    switch (input.stepIndex) {
      case 0:
        return {
          push: true,
          email: false,
          inAppBlocker: false,
          coachAllChannels: false,
          blockerVariant: 'none',
          copyKey: lr ? 'lr_step0_noop' : 'day0',
        };
      case 1:
        return {
          push: true,
          email: true,
          inAppBlocker: false,
          coachAllChannels: false,
          blockerVariant: 'none',
          copyKey: lr ? 'lr_step1_noop' : 'day1',
        };
      case 2:
        return {
          push: true,
          email: true,
          inAppBlocker: true,
          coachAllChannels: false,
          blockerVariant: 'day3',
          copyKey: lr ? 'lr_day3' : 'day3',
        };
      case 3:
        return {
          push: true,
          email: true,
          inAppBlocker: true,
          coachAllChannels: true,
          blockerVariant: 'day7',
          copyKey: lr ? 'lr_day7' : 'day7',
        };
      default:
        return {
          push: false,
          email: false,
          inAppBlocker: false,
          coachAllChannels: false,
          blockerVariant: 'none',
          copyKey: 'noop',
        };
    }
  }
}
