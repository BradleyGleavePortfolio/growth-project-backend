/**
 * roman-coach-scope.ts — which coach-owned rows Roman may read for a client.
 *
 * Extracted from RomanClientContextService.build (behaviour identical) so the
 * per-turn context and the Roman v1.1 timeline reader share one rule:
 * - The coach's own conversation comes only from the client's CURRENT coach
 *   (User.coach_id), and only while that coach is a live coach account (role
 *   coach, not soft-deleted).
 * - Both the DB role and the caller role must say "student"; anything else
 *   gets no coach-owned facts and no plan history.
 * - B-665-3: a delegated sub-coach writes in the head-coach thread as itself
 *   (MessagingService pins the thread to the head coach). Only an open
 *   delegation from the current head coach counts.
 * - HIST3 (owner 139-13, history follows the client): what the client was
 *   given (targets, workout assignments, the daily meal plan, sessions,
 *   applied workout adjustments) is the client's own history, whoever set it:
 *   the current coach, an earlier coach or sub-coach, or the client's own
 *   coachless house plan (B31). `ownHistory` says those rows are read by the
 *   client id alone. The coach's conversation and private work (thread,
 *   guideline, coaching style, message activity) still need `coachId`, so an
 *   earlier coach's chat and notes never reach Roman (owner 4b).
 *
 * Pure: no I/O. The caller reads the user (with `coach`) and the open
 * SubCoachAssignment overlay and passes them in.
 */

export interface RomanCoachRow {
  id: string;
  role: string;
  deleted_at: Date | null;
}

export interface RomanSubCoachOverlay {
  head_coach_id: string;
  sub_coach_id: string;
}

export interface RomanCoachScopeInput<C extends RomanCoachRow> {
  /** User.role from the database. */
  userRole: string;
  /** The role the caller acts as (JWT role on a turn; the DB role for internal readers). */
  callerRole: string;
  /** User.coach (the current coach relation), or null. */
  coach: C | null | undefined;
  /** The client's open SubCoachAssignment (unassigned_at null), newest first, or null. */
  overlay: RomanSubCoachOverlay | null | undefined;
}

export interface RomanCoachScope<C extends RomanCoachRow> {
  /** The live current coach row, or null (used for display, e.g. first name). */
  coach: C | null;
  /** The head coach whose rows may be read, or null (no coach-owned facts). */
  coachId: string | null;
  /** The open delegated sub-coach of that head coach, or null. */
  subCoachId: string | null;
  /** Coach-side ids allowed as assigner / sender: [coachId] or [coachId, subCoachId]; [] without a coach. */
  coachSide: string[];
  /** HIST3: both roles say student, so the client's own history is read by client id (any coach). */
  ownHistory: boolean;
}

export function resolveRomanCoachScope<C extends RomanCoachRow>(
  input: RomanCoachScopeInput<C>,
): RomanCoachScope<C> {
  // Coach-owned facts only for a student whose current coach is live.
  const coach =
    input.coach && input.coach.role === 'coach' && !input.coach.deleted_at ? input.coach : null;
  // Both the DB role and the caller role must say "student" (defence in depth:
  // the service already gates on the caller role; a mismatch gets nothing).
  const ownHistory = input.userRole === 'student' && input.callerRole === 'student';
  const coachId = ownHistory && coach ? coach.id : null;
  const overlay = input.overlay;
  const subCoachId = coachId && overlay?.head_coach_id === coachId ? overlay.sub_coach_id : null;
  const coachSide: string[] = coachId ? (subCoachId ? [coachId, subCoachId] : [coachId]) : [];
  return { coach, coachId, subCoachId, coachSide, ownHistory };
}
