import type { CommunityClassroomPostStatus } from '@prisma/client';

/**
 * v3-2 release-lock logic — the single source of truth for "is this lesson
 * visible to a student right now?" and "what status should a publish produce?".
 *
 * Kept as a PURE, side-effect-free module (no Prisma, no clock of its own) so
 * both the service and the unit tests evaluate the exact same predicate against
 * an injected `now`. The DB RLS policy mirrors this predicate
 * (status='published' AND (release_at IS NULL OR release_at <= now()) AND
 * soft_deleted_at IS NULL); keeping the application copy in one tested function
 * prevents the two from drifting (Failure #15 duplicated business rule).
 *
 * DOCTRINE: a lesson is STUDENT-VISIBLE only when it is published, released, and
 * not soft-deleted. `scheduled` is a published-but-future state used purely to
 * keep the coach's intent legible; the visibility predicate treats a future
 * `release_at` identically whether the row is stored as `scheduled` or
 * `published`, so a clock skew between the status column and release_at can
 * never leak a locked lesson.
 */

/** The status a publish call should persist given the (possibly future) release time. */
export function statusForPublish(
  releaseAt: Date | null,
  now: Date,
): Extract<CommunityClassroomPostStatus, 'published' | 'scheduled'> {
  if (releaseAt !== null && releaseAt.getTime() > now.getTime()) {
    return 'scheduled';
  }
  return 'published';
}

/**
 * True when a lesson is published-but-not-yet-released: the coach has published
 * it, but `release_at` is still in the future. The client renders a release
 * badge and suppresses media for such a lesson. A draft/archived lesson is not
 * "release locked" — it is simply not visible at all — so this returns false
 * for any non-published status.
 */
export function isReleaseLocked(
  status: CommunityClassroomPostStatus,
  releaseAt: Date | null,
  now: Date,
): boolean {
  if (status !== 'published' && status !== 'scheduled') return false;
  return releaseAt !== null && releaseAt.getTime() > now.getTime();
}

/**
 * The authoritative student-visibility predicate. A lesson is visible to a
 * student ONLY when it is published, released (release_at null or in the past),
 * and not soft-deleted. Used by the service to decide whether a single
 * by-id read resolves for a student, and mirrored verbatim by the repository
 * feed filter + the RLS member-select policy.
 */
export function isStudentVisible(
  input: {
    status: CommunityClassroomPostStatus;
    releaseAt: Date | null;
    softDeletedAt: Date | null;
  },
  now: Date,
): boolean {
  if (input.softDeletedAt !== null) return false;
  if (input.status !== 'published') return false;
  if (input.releaseAt !== null && input.releaseAt.getTime() > now.getTime()) {
    return false;
  }
  return true;
}
