import { ForbiddenException } from '@nestjs/common';
import type { User } from '@prisma/client';

// Centralised permission rules for the scheduling module. The doctrine:
//
//   - A *client* (role=student) may request, view, reschedule, or cancel
//     sessions where they are the lead client and the coach matches
//     their `User.coach_id`. They cannot list other clients' sessions.
//   - A *coach* (role=coach) may approve/deny/reschedule/cancel/complete/
//     no-show any session where they are the coach. Sub-coach boundaries
//     are enforced by checking that the lead client's `User.coach_id`
//     points at this coach (or, for sub-coaches, that the lead coach
//     manages the sub-coach — but full hierarchy lands later; for now a
//     sub-coach is simply a User with role=coach whose `coach_id`
//     points at the lead coach).
//   - An *owner* (role=owner) may do everything any coach may do across
//     the whole org.
//
// Errors are deliberately ForbiddenException (403), not NotFoundException —
// the caller-side surface is allowed to know the row exists; we just won't
// let them act on it. (This differs from coach.controller.ts which
// 404s on archive/unarchive of someone else's client; that decision is
// about not leaking the existence of foreign rows. Here, sessions
// surface to clients directly so 403 is honest.)

type Role = User['role'];

export interface SessionAccessTarget {
  coach_id: string;
  client_id: string | null;
}

export function assertCanViewSession(
  user: { id: string; role: Role; coach_id: string | null },
  target: SessionAccessTarget,
): void {
  if (user.role === 'owner') return;
  if (user.role === 'coach' && target.coach_id === user.id) return;
  if (
    user.role === 'student' &&
    target.client_id === user.id &&
    user.coach_id === target.coach_id
  ) {
    return;
  }
  throw new ForbiddenException('Not allowed to view this session');
}

export function assertCanRequestSession(
  user: { id: string; role: Role; coach_id: string | null },
  coachId: string,
): void {
  if (user.role === 'owner') return;
  // A coach cannot "request" a session against themselves — they create
  // sessions directly via the coach-side path. Block here so the
  // request-flow does not pollute the audit log with self-bookings.
  if (user.role === 'coach') {
    throw new ForbiddenException(
      'Coaches book sessions directly; the request flow is client-only',
    );
  }
  if (user.role === 'student' && user.coach_id === coachId) return;
  throw new ForbiddenException(
    'You can only request sessions with your assigned coach',
  );
}

export function assertCanApproveOrDecline(
  user: { id: string; role: Role },
  target: SessionAccessTarget,
): void {
  if (user.role === 'owner') return;
  if (user.role === 'coach' && target.coach_id === user.id) return;
  throw new ForbiddenException('Only the coach can approve or decline');
}

export function assertCanCancel(
  user: { id: string; role: Role; coach_id: string | null },
  target: SessionAccessTarget,
): void {
  if (user.role === 'owner') return;
  if (user.role === 'coach' && target.coach_id === user.id) return;
  if (
    user.role === 'student' &&
    target.client_id === user.id &&
    user.coach_id === target.coach_id
  ) {
    return;
  }
  throw new ForbiddenException('Not allowed to cancel this session');
}

export function assertCanReschedule(
  user: { id: string; role: Role; coach_id: string | null },
  target: SessionAccessTarget,
): void {
  // Same rule as cancel — both parties may propose a reschedule. The
  // service layer collapses an in-flight reschedule into a SESSION_RESCHEDULED
  // audit entry plus an updated start_at/end_at; it does not require
  // re-approval, since the rescheduling party is also the one currently
  // expected to attend.
  return assertCanCancel(user, target);
}

export function assertCanCompleteOrNoShow(
  user: { id: string; role: Role },
  target: SessionAccessTarget,
): void {
  if (user.role === 'owner') return;
  if (user.role === 'coach' && target.coach_id === user.id) return;
  throw new ForbiddenException(
    'Only the coach can mark a session complete or no-show',
  );
}

export function assertCanManageAvailability(
  user: { id: string; role: Role },
  coachId: string,
): void {
  if (user.role === 'owner') return;
  if (user.role === 'coach' && user.id === coachId) return;
  throw new ForbiddenException('Only the coach can manage their availability');
}
