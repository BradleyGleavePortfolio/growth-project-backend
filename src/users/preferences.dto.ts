/**
 * DTOs for GET/PATCH /users/me/preferences
 * UX Psychology Report #4 — Preference-Controlled Personalization
 */

export const HOME_MODULE_VALUES = ['hero', 'milestone', 'trustcues', 'secondary', 'community'] as const;
export type HomeModule = (typeof HOME_MODULE_VALUES)[number];

export const NOTIFICATION_CADENCE_VALUES = ['daily', 'weekly', 'off'] as const;
export type NotificationCadence = (typeof NOTIFICATION_CADENCE_VALUES)[number];

export const MOTIVATIONAL_TONE_VALUES = ['gentle', 'direct', 'drill'] as const;
export type MotivationalTone = (typeof MOTIVATIONAL_TONE_VALUES)[number];

export const UNITS_VALUES = ['metric', 'imperial'] as const;
export type Units = (typeof UNITS_VALUES)[number];

export const FIRST_DAY_VALUES = [0, 1, 6] as const;
export type FirstDayOfWeek = (typeof FIRST_DAY_VALUES)[number];

/** Shape returned by GET and written by PATCH (full merged object) */
export interface UserPreferencesDto {
  homeModules: HomeModule[];
  notificationCadence: NotificationCadence;
  motivationalTone: MotivationalTone;
  units: Units;
  firstDayOfWeek: FirstDayOfWeek;
}

/** Defaults — used when no row exists yet */
export const DEFAULT_PREFERENCES: UserPreferencesDto = {
  homeModules: ['hero', 'milestone', 'trustcues', 'secondary'],
  notificationCadence: 'daily',
  motivationalTone: 'direct',
  units: 'imperial',
  firstDayOfWeek: 1,
};
