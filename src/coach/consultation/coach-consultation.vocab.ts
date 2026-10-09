// COACH-CONSULT-BE-134 — the one list of values the coach consultation
// (prototype K0-K8, screens 77-85) accepts. The mobile app shows the labels;
// the server stores the keys and rejects anything else.

// K2 Specialties: optional, up to five.
export const COACH_SPECIALTIES = [
  'fat_loss', // Fat loss
  'strength', // Strength
  'muscle', // Muscle gain
  'beginners', // Beginners
  'older', // Older adults
  'sports', // Sports performance
  'mobility', // Mobility
  'nutrition', // Nutrition habits
  'busy', // Busy professionals
  'other', // Something else
] as const;
export const MAX_SPECIALTIES = 5;

// K3 Clients today: required, single choice (gates K7 when not 'none').
export const CLIENTS_TODAY = ['none', '1_10', '11_25', '26_50', '50_plus'] as const;

// K4 Coaching touch: optional (feeds Roman coach context and check-in cadence).
export const COACHING_TOUCH = ['close', 'balanced', 'light'] as const;

// K5 Programming style: optional (branches the coach tutorial).
export const PROGRAMMING_STYLE = ['own', 'templates', 'help'] as const;

// Resume points. K7 (import offer) is only shown when the importer flag is on.
export const CONSULTATION_STEPS = ['K0', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8'] as const;

// K1 Your card limits.
export const DISPLAY_NAME_MAX = 80;
export const BUSINESS_NAME_MAX = 80;
export const HEADLINE_MAX = 120;
export const BIO_MAX = 280;
export const YEARS_COACHING_MAX = 60;

export type CoachSpecialty = (typeof COACH_SPECIALTIES)[number];
export type ClientsToday = (typeof CLIENTS_TODAY)[number];
export type CoachingTouch = (typeof COACHING_TOUCH)[number];
export type ProgrammingStyle = (typeof PROGRAMMING_STYLE)[number];
export type ConsultationStep = (typeof CONSULTATION_STEPS)[number];
