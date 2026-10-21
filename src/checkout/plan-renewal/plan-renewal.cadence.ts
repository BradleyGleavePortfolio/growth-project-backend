/**
 * RENEWAL-BE: the plan-renewal sequence a client gets after a plan with their
 * coach ends normally (a fixed-term package ran out, or a subscription ended
 * or was cancelled). Failed payments never enter it: Smart Dunning v2 owns
 * them. Mirrors the dunning v2 calendar ([0, 1, 3, 7]) and its sweep.
 *
 * FEATURE_PLAN_RENEWAL (default OFF; only "true" turns it on): off means no
 * cycle opens, no step is claimed, nothing is sent, and the entitlement answer
 * carries no `renewal` block.
 */
export const FEATURE_PLAN_RENEWAL_ENV = 'FEATURE_PLAN_RENEWAL';

export function isPlanRenewalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[FEATURE_PLAN_RENEWAL_ENV] ?? '').toLowerCase() === 'true';
}

export const PLAN_RENEWAL_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One row per step, in order. `popup`: the phone shows the renewal pop-up
 * once; `push`: one app notification; `message`: one chat message sent as the
 * coach (the coach can turn these off). Operator default, owner-tunable.
 */
export const PLAN_RENEWAL_STEPS = [
  { day: 0, popup: true, push: true, message: true },
  { day: 1, popup: false, push: true, message: false },
  { day: 3, popup: true, push: true, message: false },
  { day: 7, popup: true, push: true, message: true },
] as const;

export const PLAN_RENEWAL_LAST_STEP = PLAN_RENEWAL_STEPS.length - 1;

/** A plan that ended longer ago than this never opens a cycle (Day 7 + one day to claim it). */
export const PLAN_RENEWAL_OPEN_WINDOW_MS = 8 * PLAN_RENEWAL_DAY_MS;

/** At most one step (so at most one renewal push) per client in any 24 hours. */
export const PLAN_RENEWAL_MIN_STEP_GAP_MS = PLAN_RENEWAL_DAY_MS;

/** Coach-message retries: 1 min, 5 min, 30 min, 2 h, then the row is given up. */
export const PLAN_RENEWAL_MESSAGE_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000] as const;

/** Hourly at minute 17 UTC (dunning v2 runs at minute 7). */
export const PLAN_RENEWAL_SWEEP_CRON = '17 * * * *';

/** The latest step due `elapsedMs` after the plan ended, or -1 before Day 0. */
export function planRenewalStepFor(elapsedMs: number): number {
  let step = -1;
  PLAN_RENEWAL_STEPS.forEach((s, i) => {
    if (elapsedMs >= s.day * PLAN_RENEWAL_DAY_MS) step = i;
  });
  return step;
}

/** The latest step at or below `step` that shows a pop-up, or -1. */
export function planRenewalPopupStepAt(step: number): number {
  for (let i = Math.min(step, PLAN_RENEWAL_LAST_STEP); i >= 0; i--) {
    if (PLAN_RENEWAL_STEPS[i].popup) return i;
  }
  return -1;
}

/**
 * The coach-voice chat messages (needs owner, 137-2). {first_name} is the
 * client's first name; renderWelcomeMessage fills it.
 */
export const PLAN_RENEWAL_MESSAGES: Readonly<Record<number, string>> = {
  0: 'Hi {first_name}, your plan with me has ended. If you want to keep going, you can pick a new plan in the app. Message me here with any questions.',
  3: 'Hi {first_name}, one last note about your plan. If you want to keep working together, you can pick a plan in the app any time.',
};
