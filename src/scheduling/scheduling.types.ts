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

// ---------------------------------------------------------------------------
// S-SCHED-5 auto-expiry (OR-112-5): a pending request has one clear time by
// which the coach must answer. At or after it the request is closed as
// `expired` (both sides get a calm notice and the slot is free again).
// ---------------------------------------------------------------------------

/** A coach has at most this long after a request to answer it. */
export const REQUEST_RESPONSE_WINDOW_HOURS = 48;
/** ...and must answer at least this long before the session starts. */
export const REQUEST_ANSWER_BY_BEFORE_START_MINUTES = 60;
/**
 * Short-notice requests: when the two rules above would leave the coach less
 * than this to answer, the request stays open until the session starts
 * (approval already stops at the start).
 */
export const REQUEST_MIN_ANSWER_WINDOW_MINUTES = 30;

/** The clear time a request made (or re-asked) at `requestedAt` closes. */
export function requestExpiresAt(requestedAt: Date, startAt: Date): Date {
  const byWindow = requestedAt.getTime() + REQUEST_RESPONSE_WINDOW_HOURS * 3_600_000;
  const byStart = startAt.getTime() - REQUEST_ANSWER_BY_BEFORE_START_MINUTES * 60_000;
  const deadline = Math.min(byWindow, byStart);
  if (deadline < requestedAt.getTime() + REQUEST_MIN_ANSWER_WINDOW_MINUTES * 60_000) {
    return new Date(startAt.getTime());
  }
  return new Date(deadline);
}

/**
 * True when a still-`requested` row has reached its clear time. Such a row is
 * treated as expired everywhere (reads, approve/decline/cancel/move, open
 * slots) even before the sweep writes `expired`, so the clear time is exact.
 */
export function isLapsedRequest(
  row: { status: string; request_expires_at?: Date | null },
  now: Date = new Date(),
): boolean {
  return (
    row.status === 'requested' &&
    row.request_expires_at instanceof Date &&
    row.request_expires_at.getTime() <= now.getTime()
  );
}

/** end_reason written when a request expires. */
export const REQUEST_EXPIRED_END_REASON = 'request_expired';

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
  // S-SCHED-5: the request reached its clear time without an answer and is
  // closed (or is about to be closed by the sweep); the slot is free again.
  REQUEST_EXPIRED: 'REQUEST_EXPIRED',
} as const;
export type SchedulingErrorCodeValue =
  (typeof SchedulingErrorCode)[keyof typeof SchedulingErrorCode];

// B-634-9: the one 404 message for a session the caller cannot see. A
// missing session and another person's session read the same (existence
// hiding), so every SESSION_NOT_FOUND throw uses this constant. Client-facing
// scheduling copy speaks to the reader directly: no "we"/"us", and every
// message names a working next step.
export const SESSION_NOT_FOUND_MESSAGE =
  'That session is no longer available. Open Calendar to see your sessions.';

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
