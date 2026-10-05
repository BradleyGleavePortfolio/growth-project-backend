import { ConflictException } from '@nestjs/common';
import type { CoachingSession, Prisma } from '@prisma/client';
import { AuditAction, type AuditService } from '../audit/audit.service';
import {
  REQUEST_EXPIRED_END_REASON,
  SchedulingErrorCode,
  isLapsedRequest,
  schedulingError,
} from './scheduling.types';

// S-SCHED-5 auto-expiry (OR-112-5): the one write that closes a pending
// request at its clear time, shared by the sweep (BookingRequestExpiryJob)
// and the booking transaction (which closes a coach's lapsed requests under
// the per-coach lock before it validates, so a slot is bookable at exactly
// its clear time even if the sweep is late).
//
// The write is compare-and-set: status still 'requested', the deadline still
// passed, and (per row) the same interval the caller read. A request that was
// approved, declined, cancelled or moved meanwhile is left alone. Notices are
// not sent here; the sweep sends them from the committed row (both sides,
// receipts in NotificationDeliveryLog), so a crash never loses or doubles one.

type Db = Pick<Prisma.TransactionClient, 'coachingSession'>;

export type LapsedRow = Pick<
  CoachingSession,
  'id' | 'coach_id' | 'client_id' | 'start_at' | 'end_at' | 'request_expires_at'
>;

const LAPSED_SELECT = {
  id: true,
  coach_id: true,
  client_id: true,
  start_at: true,
  end_at: true,
  request_expires_at: true,
} as const;

/** Close one lapsed request. True when this call closed it. */
export async function expireRequest(db: Db, row: LapsedRow, now: Date): Promise<boolean> {
  const res = await db.coachingSession.updateMany({
    where: {
      id: row.id,
      status: 'requested',
      start_at: row.start_at,
      end_at: row.end_at,
      request_expires_at: { lte: now },
    },
    data: { status: 'expired', ended_at: now, end_reason: REQUEST_EXPIRED_END_REASON },
  });
  return res.count === 1;
}

/** Close every lapsed request of one coach (inside the booking transaction). */
export async function expireLapsedForCoach(
  db: Db,
  coachId: string,
  now: Date,
): Promise<LapsedRow[]> {
  const lapsed = await db.coachingSession.findMany({
    where: { coach_id: coachId, status: 'requested', request_expires_at: { lte: now } },
    select: LAPSED_SELECT,
  });
  const closed: LapsedRow[] = [];
  for (const row of lapsed) {
    if (await expireRequest(db, row, now)) closed.push(row);
  }
  return closed;
}

/** One audit row per closed request; the system closed it, nobody acted. */
export async function auditExpired(
  audit: AuditService,
  rows: LapsedRow[],
  source: 'sweep' | 'booking',
): Promise<void> {
  for (const row of rows) {
    await audit.write({
      action: AuditAction.SESSION_EXPIRED,
      actorId: null,
      actorRole: 'system',
      tenantCoachId: row.coach_id,
      targetUserId: row.client_id ?? null,
      targetType: 'coaching_session',
      targetId: row.id,
      metadata: {
        from: 'requested',
        to: 'expired',
        source,
        request_expires_at: row.request_expires_at?.toISOString() ?? null,
      },
    });
  }
}

/** True when a row is closed by expiry, or has reached its clear time. */
export function isExpiredOrLapsed(
  row: { status: string; request_expires_at?: Date | null },
  now: Date = new Date(),
): boolean {
  return row.status === 'expired' || isLapsedRequest(row, now);
}

/**
 * 409 REQUEST_EXPIRED with copy for the person acting. The body carries the
 * clear time so the app can show it in the viewer's own time zone.
 */
export function requestExpiredError(
  row: { request_expires_at?: Date | null },
  viewer: 'client' | 'coach',
): ConflictException {
  const message =
    viewer === 'coach'
      ? 'This request closed at its answer-by time without a reply, so the time is open again. Message the client if you would like to find another time.'
      : 'This request closed because your coach did not confirm it in time, and the time is open again. Pick a new time in Calendar.';
  return new ConflictException({
    ...schedulingError(SchedulingErrorCode.REQUEST_EXPIRED, message),
    request_expires_at: row.request_expires_at ? row.request_expires_at.toISOString() : null,
  });
}
