/**
 * Roman approve-to-adjust: kill switch, error codes and coach-facing copy.
 *
 * Copy rules: plain warm words, no exclamation marks, no emojis, no "we/us".
 * Every refusal says what happened and what the coach can do next.
 */
import { SUPPORT_EMAIL } from '../public-pages/trust-pages.html';

/** Kill switch. ON only for the exact value 'true'; unset or anything else is OFF. */
export const FEATURE_ROMAN_ADJUST_ENABLED_ENV = 'FEATURE_ROMAN_ADJUST_ENABLED';

export function isRomanAdjustEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FEATURE_ROMAN_ADJUST_ENABLED ?? '').toLowerCase() === 'true';
}

/** How long an applied change can be undone from the card. */
export const ADJUST_UNDO_WINDOW_MS = 10 * 60 * 1000;
/** Only workouts in the next few days are worth adjusting from today's data. */
export const ADJUST_LOOKAHEAD_DAYS = 3;
/** A coach list call re-scans at most this often (per coach, per instance). */
export const ADJUST_SCAN_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** Upper bound of clients scanned per coach per refresh. */
export const ADJUST_SCAN_MAX_CLIENTS = 200;

export const ADJUST_ERRORS = {
  NOT_FOUND: {
    status: 404,
    code: 'ADJUSTMENT_NOT_FOUND',
    message: 'This suggestion is no longer available. Pull to refresh to see the current ones.',
  },
  ALREADY_DECIDED: {
    status: 409,
    code: 'ADJUSTMENT_ALREADY_DECIDED',
    message: 'This suggestion has already been handled, possibly from another device. Pull to refresh to see where it stands.',
  },
  WORKOUT_STARTED: {
    status: 409,
    code: 'ADJUSTMENT_WORKOUT_STARTED',
    message: 'Your client has already started or finished this workout, so it was left as it is. Any change now belongs in your next programming.',
  },
  WORKOUT_CHANGED: {
    status: 409,
    code: 'ADJUSTMENT_WORKOUT_CHANGED',
    message: 'This workout was edited after Roman made the suggestion, so it was not applied. Open the workout to review it, then refresh for a new suggestion.',
  },
  CONSENT_WITHDRAWN: {
    status: 409,
    code: 'ADJUSTMENT_CONSENT_WITHDRAWN',
    message: 'Your client has turned off AI features for their data, so Roman can no longer make or apply this suggestion. You can still edit the workout yourself.',
  },
  UNDO_EXPIRED: {
    status: 409,
    code: 'ADJUSTMENT_UNDO_EXPIRED',
    message: 'The undo window has closed. You can still change the sets in the workout builder.',
  },
  UNDO_BLOCKED: {
    status: 409,
    code: 'ADJUSTMENT_UNDO_BLOCKED',
    message: 'The workout has changed since this suggestion was applied, so undo would overwrite newer edits. Open the workout to adjust it directly.',
  },
  EDIT_INVALID: {
    status: 400,
    code: 'ADJUSTMENT_EDIT_INVALID',
    message: 'Each exercise needs between 1 and 20 sets, and the change has to match the exercises in this workout. Check the numbers and try again.',
  },
  UNAVAILABLE: {
    status: 503,
    code: 'ADJUSTMENTS_UNAVAILABLE',
    message: `Roman's suggestions could not be loaded just now. Your workouts are unchanged. Try again in a minute; if it keeps happening, contact ${SUPPORT_EMAIL}.`,
  },
} as const;

export type AdjustErrorKey = keyof typeof ADJUST_ERRORS;

export const ADJUST_DISMISS_REASONS = ['not_now', 'disagree', 'client_feels_fine', 'other'] as const;
export type AdjustDismissReason = (typeof ADJUST_DISMISS_REASONS)[number];
