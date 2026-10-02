// Shared types and module-private helpers for the scheduling surface.
// Extracted from scheduling.service.ts during the M9 refactor so the
// lifecycle / open-slots / availability / facade services share one set
// of definitions without importing each other.

export interface ActorContext {
  id: string;
  role: 'student' | 'coach' | 'owner';
  email: string | null;
  coach_id: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface OpenSlotsPayload {
  coach_id: string;
  timezone: string;
  generated_at: string;
  // S-SCHED-2: echo of the type the slots were computed for (null for a
  // legacy duration-only query) and the slot length actually used.
  session_type_id: string | null;
  duration_minutes: number;
  slots: { start_at: string; end_at: string }[];
}

export function dateOnly(d: Date, dayDelta: number): Date {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  r.setUTCDate(r.getUTCDate() + dayDelta);
  return r;
}

export function minutesToHHMM(min: number | null): string | null {
  if (min === null) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// S-SCHED-2 booking integrity constants. One definition shared by open-slot
// computation, the booking/reschedule validation and the reminder sweep, so
// "shown as open" and "bookable" can never disagree.
// ---------------------------------------------------------------------------

// Statuses that occupy a coach's time. A pending request holds its slot
// (it is excluded from open slots and blocks overlapping bookings) until the
// coach declines it or someone cancels it. Mirrors the WHERE clause of the
// CoachingSession_no_overlapping_active_booking exclusion constraint.
export const OCCUPYING_SESSION_STATUSES = ['requested', 'scheduled', 'pending_provider'] as const;

// Minimum lead time between now and a bookable start.
export const MIN_BOOKING_LEAD_MINUTES = 5;

// How far ahead a client may book or move a session.
export const MAX_BOOKING_HORIZON_DAYS = 120;

// At most this many coach-approval requests may wait on one coach per client.
// Bounds slot holding by unapproved requests.
export const MAX_PENDING_REQUESTS_PER_COACH = 3;

// Stable machine codes for scheduling failures. Every BadRequest/Conflict the
// booking surface throws carries one of these as `code` (and, for older
// clients, as `error`) plus a human message.
export const SchedulingErrorCode = {
  SESSION_TYPE_REQUIRED: 'SESSION_TYPE_REQUIRED',
  SESSION_TYPE_UNAVAILABLE: 'SESSION_TYPE_UNAVAILABLE',
  DURATION_MISMATCH: 'DURATION_MISMATCH',
  SESSION_IN_PAST: 'SESSION_IN_PAST',
  BEYOND_BOOKING_HORIZON: 'BEYOND_BOOKING_HORIZON',
  INVALID_TIME: 'INVALID_TIME',
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  SLOT_TAKEN: 'SLOT_TAKEN',
  CALENDAR_BUSY: 'CALENDAR_BUSY',
  PENDING_REQUEST_LIMIT: 'PENDING_REQUEST_LIMIT',
  WELCOME_ALREADY_BOOKED: 'WELCOME_ALREADY_BOOKED',
  SESSION_STATE_CHANGED: 'SESSION_STATE_CHANGED',
  SESSION_NOT_ACTIVE: 'SESSION_NOT_ACTIVE',
  SESSION_STARTED: 'SESSION_STARTED',
  COACH_NOT_BOOKABLE: 'COACH_NOT_BOOKABLE',
  COACH_NOT_FOUND: 'COACH_NOT_FOUND',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  NOT_SESSION_PARTICIPANT: 'NOT_SESSION_PARTICIPANT',
  INVALID_MEETING_LINK: 'INVALID_MEETING_LINK',
  // S-SCHED-3 (B-634-1): the session moved to a new time after the caller
  // read it, so the answer they gave was about a different time.
  SESSION_MOVED: 'SESSION_MOVED',
  // S-SCHED-3 (B-634-4 / C-634-3): a list cursor or status filter that the
  // server cannot read.
  INVALID_LIST_QUERY: 'INVALID_LIST_QUERY',
} as const;
export type SchedulingErrorCodeValue =
  (typeof SchedulingErrorCode)[keyof typeof SchedulingErrorCode];

export function schedulingError(
  code: SchedulingErrorCodeValue,
  message: string,
): { code: SchedulingErrorCodeValue; error: SchedulingErrorCodeValue; message: string } {
  return { code, error: code, message };
}

// Meeting links a coach may attach or set as a type default: https only, or
// a tel: number for phone calls. Bounded. Anything else (javascript:, http:,
// custom schemes) is refused so the client app only ever opens a safe link.
export const MEETING_LINK_PATTERN = /^(https:\/\/[^\s<>"']{3,490}|tel:\+?[0-9 ().-]{3,30})$/i;
export const HTTPS_LINK_PATTERN = /^https:\/\/[^\s<>"']{3,490}$/i;

export function hasUsableLink(url: string | null | undefined): boolean {
  return typeof url === 'string' && MEETING_LINK_PATTERN.test(url.trim());
}
