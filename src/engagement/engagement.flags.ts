/**
 * Kill switches for the two clinic engagement jobs (C05 items 6-7).
 *
 * Both jobs ship ON (unset = on), parsed exactly like
 * SIGNUP_ROLE_CHOICE_ENABLED (src/auth/auth.service.ts): the welcome job
 * sends nothing until the owner enables a coach's welcome setting at C04
 * (CoachWelcomeMessageSetting.enabled, default false), and workout reminders
 * are launch scope from the client's first-session day. An operator turns a
 * job off with 'false', '0' or 'off' (trimmed, case-insensitive); any other
 * value, including an empty string, leaves it on. Because unset = on, the
 * emergency kill is SETTING 'false', never unsetting.
 *
 * The switches stop sends only. The erasure sweep (purgeErased) in each
 * service keeps running while its switch is off, so deleted accounts are
 * still cleaned up.
 *
 * Both names are registered in src/common/env-validation.ts ENV_RULES with
 * this default; test/engagement/engagement-flags.spec.ts proves the two agree.
 */

/** The values that turn a job off. */
export const ENGAGEMENT_SWITCH_OFF_VALUES: readonly string[] = ['false', '0', 'off'];

function switchOn(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !ENGAGEMENT_SWITCH_OFF_VALUES.includes(raw.trim().toLowerCase());
}

/** COACH_WELCOME_SCHEDULER_ENABLED: unset = on; 'false' | '0' | 'off' = off. */
export function isCoachWelcomeSchedulerEnabled(): boolean {
  return switchOn(process.env.COACH_WELCOME_SCHEDULER_ENABLED);
}

/** WORKOUT_REMINDERS_ENABLED: unset = on; 'false' | '0' | 'off' = off. */
export function isWorkoutRemindersEnabled(): boolean {
  return switchOn(process.env.WORKOUT_REMINDERS_ENABLED);
}
