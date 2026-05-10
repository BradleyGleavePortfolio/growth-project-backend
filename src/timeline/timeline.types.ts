/**
 * timeline.types.ts — Phase 7B: Transformation Timeline
 *
 * Discriminated-union type for a single timeline event.
 *
 * PRIVACY RULES:
 *   - PTM risk_score MUST NOT appear anywhere in this type or its
 *     serialised form. Use `ptmBucket` (low | medium | high) if risk
 *     context is ever needed — raw scores are forbidden.
 *   - The `metadata` bag must carry no PII beyond what is already
 *     visible in `title` and `body`.
 */

// ─── Lane identifiers ──────────────────────────────────────────────────────────

export type TimelineLane = 'body' | 'win' | 'coach' | 'friction';

// ─── Shared base ──────────────────────────────────────────────────────────────

interface TimelineEventBase {
  /** Client-opaque cursor token — ISO timestamp + CUID, URL-safe. */
  id: string;
  /** The lane this event belongs to. */
  lane: TimelineLane;
  /** ISO 8601 timestamp — the moment the event occurred. */
  at: string;
  /** Short headline (≤ 80 chars). No emoji. */
  title: string;
  /** Optional supporting copy (≤ 280 chars). */
  body?: string;
}

// ─── Body lane ────────────────────────────────────────────────────────────────

export interface BodyWeightEvent extends TimelineEventBase {
  lane: 'body';
  eventType: 'weight_logged';
  metadata: {
    weightLbs: number;
    deltaLbs: number | null;
    /** Number of consecutive days weight was logged up to this point. */
    streakDays: number;
  };
}

export interface BodyCompositionEvent extends TimelineEventBase {
  lane: 'body';
  eventType: 'body_composition';
  metadata: {
    bodyFatPct: number | null;
    muscleMassLbs: number | null;
  };
}

export interface BodyPhotoEvent extends TimelineEventBase {
  lane: 'body';
  eventType: 'progress_photo';
  metadata: {
    /** Signed URL is intentionally omitted — the client fetches it separately. */
    photoId: string;
  };
}

// ─── Win lane ─────────────────────────────────────────────────────────────────

export interface WinStreakEvent extends TimelineEventBase {
  lane: 'win';
  eventType: 'checkin_streak_milestone';
  metadata: {
    streakDays: number;
    /** Days threshold that was crossed: 7 | 14 | 30 | 60 | 90 */
    threshold: 7 | 14 | 30 | 60 | 90;
  };
}

export interface WinFinanceMilestoneEvent extends TimelineEventBase {
  lane: 'win';
  eventType: 'finance_milestone';
  metadata: {
    /** Opaque — finance app defines the content. */
    milestoneRef: string;
  };
}

export interface WinBuildWeekDay7Event extends TimelineEventBase {
  lane: 'win';
  eventType: 'build_week_complete';
  metadata: {
    enrollmentId: string;
    dayCompleted: 7;
  };
}

// ─── Coach lane ───────────────────────────────────────────────────────────────

export interface CoachTextNoteEvent extends TimelineEventBase {
  lane: 'coach';
  eventType: 'coach_text_note';
  metadata: {
    messageId: string;
    /** Coach display name — not email. */
    coachName: string;
  };
}

export interface CoachVoiceNoteEvent extends TimelineEventBase {
  lane: 'coach';
  eventType: 'coach_voice_note';
  metadata: {
    messageId: string;
    coachName: string;
    durationSec: number;
  };
}

// ─── Friction lane ────────────────────────────────────────────────────────────

export interface FrictionMissedDayEvent extends TimelineEventBase {
  lane: 'friction';
  eventType: 'missed_checkin';
  metadata: {
    /** Consecutive missed check-ins that triggered this entry. */
    consecutiveMisses: number;
  };
}

export interface FrictionRecoveredStreakEvent extends TimelineEventBase {
  lane: 'friction';
  eventType: 'streak_recovered';
  metadata: {
    /** Days of the streak before the gap. */
    priorStreakDays: number;
    /** Days of gap that interrupted the streak. */
    gapDays: number;
  };
}

// ─── Union ────────────────────────────────────────────────────────────────────

export type TimelineEvent =
  | BodyWeightEvent
  | BodyCompositionEvent
  | BodyPhotoEvent
  | WinStreakEvent
  | WinFinanceMilestoneEvent
  | WinBuildWeekDay7Event
  | CoachTextNoteEvent
  | CoachVoiceNoteEvent
  | FrictionMissedDayEvent
  | FrictionRecoveredStreakEvent;

// ─── API response shapes ──────────────────────────────────────────────────────

export interface TimelineResponse {
  events: TimelineEvent[];
  /** Opaque cursor for the next page. Null when the feed is exhausted. */
  nextCursor: string | null;
  /** Total events available in the requested window and lanes. */
  total: number;
}

// ─── Query shape (mirrors controller @Query()) ────────────────────────────────

export interface TimelineQuery {
  sinceDays: number;
  lanes: TimelineLane[];
  cursor?: string;
  limit: number;
}

// ─── Cursor codec ─────────────────────────────────────────────────────────────

/**
 * Cursors are `<ISO timestamp>_<eventId>` encoded as URL-safe base64.
 * The service decodes these; the controller passes them through opaquely.
 */
export interface DecodedCursor {
  at: string;
  id: string;
}
