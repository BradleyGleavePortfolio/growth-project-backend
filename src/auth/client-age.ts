import { SetMetadata } from '@nestjs/common';
import { ageInYears } from '../macros/macro-calculator';

/**
 * AGEGATE16 (owner ruling #C8-UNDER18-B, 2026-10-14: "16+ gets treated like
 * any other client - if they dont agree theyre over 16 they dont get in the
 * app"). A client (role student) confirms 16 or older with the date of birth
 * on their profile: the consultation's B2 answer, or the app's same question
 * for a client who reached the app without it. Nothing else is stored.
 *
 * JwtAuthGuard refuses every other client route with 403
 * AGE_CONFIRMATION_REQUIRED until that date shows MIN_CLIENT_AGE or older.
 * Routes a client needs before then (sign-in and joining, the consultation,
 * consent, the profile the answer is saved to, account deletion and data
 * export) opt out with @AllowBeforeAgeConfirmed(). Coaches, sub-coaches and
 * owners are never asked.
 */
export const MIN_CLIENT_AGE = 16;

export const AGE_CONFIRMATION_REQUIRED = 'AGE_CONFIRMATION_REQUIRED';

export const ALLOW_BEFORE_AGE_CONFIRMED_KEY = 'allowBeforeAgeConfirmed';
export const AllowBeforeAgeConfirmed = () => SetMetadata(ALLOW_BEFORE_AGE_CONFIRMED_KEY, true);

/** True when a stored date of birth shows MIN_CLIENT_AGE or older on `now`. */
export function confirmsMinClientAge(dob: Date | null | undefined, now: Date): boolean {
  return dob instanceof Date && !Number.isNaN(dob.getTime()) && ageInYears(dob, now) >= MIN_CLIENT_AGE;
}
