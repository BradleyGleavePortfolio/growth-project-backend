import type { CoachingSession, Prisma, SessionStatus } from '@prisma/client';
import {
  MEETING_LINK_PATTERN,
  OCCUPYING_SESSION_STATUSES,
  isLapsedRequest,
} from './scheduling.types';
import type { ActorContext } from './scheduling.types';

// S-SCHED-2: the one place a CoachingSession row becomes an API response.
//
// Every session-returning endpoint (list, get, request, approve, decline,
// reschedule, cancel, complete, no-show, call link) goes through
// toSessionView, so:
//   - clients never receive coach-only fields (coach_notes_md, provider
//     idempotency/meeting/calendar ids); they read as null,
//   - both apps get the same derived state instead of re-deriving it:
//       cancellable / reschedulable: the server's own rules for this viewer,
//       meeting_link_status: 'ready' (usable https/tel link),
//         'pending' (confirmed, no link yet: client shows a calm waiting
//         state, coach shows an "add the call link" action),
//         'awaiting_approval' (request not confirmed yet), 'none' (closed),
//   - the appointment type and the other party's name ride along.
// All original columns stay present (additive), so older app builds keep
// working.

export const SESSION_VIEW_INCLUDE = {
  session_type: {
    select: {
      id: true,
      name: true,
      duration_minutes: true,
      auto_approve: true,
      is_welcome: true,
      archived_at: true,
    },
  },
  coach: { select: { id: true, name: true } },
  client: { select: { id: true, name: true } },
} satisfies Prisma.CoachingSessionInclude;

export type SessionWithRelations = CoachingSession & {
  session_type?: {
    id: string;
    name: string;
    duration_minutes: number;
    auto_approve: boolean;
    is_welcome: boolean;
    archived_at: Date | null;
  } | null;
  coach?: { id: string; name: string } | null;
  client?: { id: string; name: string } | null;
};

export type MeetingLinkStatus = 'ready' | 'pending' | 'awaiting_approval' | 'none';

export interface SessionView extends Omit<
  CoachingSession,
  'coach_notes_md' | 'provider_idempotency_key'
> {
  coach_notes_md: string | null;
  provider_idempotency_key: string | null;
  session_type: {
    id: string;
    name: string;
    duration_minutes: number;
    auto_approve: boolean;
    is_welcome: boolean;
    archived: boolean;
  } | null;
  coach_name: string | null;
  client_name: string | null;
  meeting_link_status: MeetingLinkStatus;
  cancellable: boolean;
  reschedulable: boolean;
}

export function meetingLinkStatus(
  row: Pick<CoachingSession, 'status' | 'video_url'>,
): MeetingLinkStatus {
  if (row.status === 'requested') return 'awaiting_approval';
  if (row.status === 'scheduled' || row.status === 'pending_provider') {
    return typeof row.video_url === 'string' && MEETING_LINK_PATTERN.test(row.video_url.trim())
      ? 'ready'
      : 'pending';
  }
  return 'none';
}

export function toSessionView(
  row: SessionWithRelations,
  actor: ActorContext,
  now: Date = new Date(),
): SessionView {
  const { session_type, coach, client, ...base } = row;
  const isClientViewer = actor.role === 'student';
  // S-SCHED-5: a request past its clear time reads as expired at once, even
  // before the sweep writes it, so both apps show the exact clear time.
  const status: SessionStatus = isLapsedRequest(row, now) ? 'expired' : row.status;
  const occupying = (OCCUPYING_SESSION_STATUSES as readonly string[]).includes(status);
  const notStarted = row.start_at.getTime() > now.getTime();
  return {
    ...base,
    status,
    coach_notes_md: isClientViewer ? null : row.coach_notes_md,
    provider_idempotency_key: isClientViewer ? null : row.provider_idempotency_key,
    video_meeting_id: isClientViewer ? null : row.video_meeting_id,
    calendar_event_id: isClientViewer ? null : row.calendar_event_id,
    // A link only matters once confirmed; clients never see a link on an
    // unapproved request (the coach may still decline it).
    video_url:
      isClientViewer && (status === 'requested' || status === 'expired') ? null : row.video_url,
    session_type: session_type
      ? {
          id: session_type.id,
          name: session_type.name,
          duration_minutes: session_type.duration_minutes,
          auto_approve: session_type.auto_approve,
          is_welcome: session_type.is_welcome,
          archived: session_type.archived_at !== null,
        }
      : null,
    coach_name: coach?.name ?? null,
    client_name: client?.name ?? null,
    meeting_link_status: meetingLinkStatus({ status, video_url: row.video_url }),
    cancellable: occupying && (isClientViewer ? notStarted : true),
    reschedulable: (status === 'requested' || status === 'scheduled') && notStarted,
  };
}
