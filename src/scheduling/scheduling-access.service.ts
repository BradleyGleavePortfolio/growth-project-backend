import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CoachingSession, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SchedulingErrorCode, schedulingError } from './scheduling.types';
import type { ActorContext } from './scheduling.types';

// S-SCHED-2 (T4): the single answer to "which coaches may this person see and
// book with?" for the scheduling surface.
//
// A client (role=student) may browse and book:
//   - their head coach: User.coach_id (the assignment every other surface uses), and
//   - the sub-coach they are currently delegated to inside that head coach's
//     team: an open SubCoachAssignment row (unassigned_at IS NULL) for
//     (client, head coach), whose TeamSubCoachAssignment is not archived and
//     whose user is still a coach.
// Nobody else. A coach browses only their own calendar; an owner browses any.
//
// Reads of an existing session are separate (assertCanViewSession): the
// lead client may always read their own session (history must survive a
// coach change), but acting on it (move/cancel) requires the coach to still
// be bookable.
export interface BookableCoach {
  coach_id: string;
  name: string;
  avatar_url: string | null;
  timezone: string;
  relationship: 'head_coach' | 'sub_coach';
}

type Db = PrismaService | Prisma.TransactionClient;

export const DEFAULT_COACH_TIMEZONE = 'America/Los_Angeles';

@Injectable()
export class SchedulingAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Coach ids this client may browse/book, head coach first. */
  async bookableCoachIds(actor: ActorContext, db: Db = this.prisma): Promise<string[]> {
    if (actor.role !== 'student' || !actor.coach_id) return [];
    const ids = [actor.coach_id];
    const sub = await db.subCoachAssignment.findFirst({
      where: {
        client_id: actor.id,
        head_coach_id: actor.coach_id,
        unassigned_at: null,
      },
      orderBy: { assigned_at: 'desc' },
      select: { sub_coach_id: true },
    });
    if (sub && sub.sub_coach_id !== actor.coach_id) {
      const team = await db.teamSubCoachAssignment.findFirst({
        where: {
          head_coach_id: actor.coach_id,
          sub_coach_id: sub.sub_coach_id,
          archived_at: null,
        },
        select: { id: true },
      });
      if (team) ids.push(sub.sub_coach_id);
    }
    return ids;
  }

  /**
   * Throws 403 COACH_NOT_BOOKABLE unless the actor may browse/book this
   * coach's calendar (types, weekly hours, open slots, new requests).
   */
  async assertCanBrowseCoach(
    actor: ActorContext,
    coachId: string,
    db: Db = this.prisma,
  ): Promise<void> {
    if (actor.role === 'owner') return;
    if (actor.role === 'coach') {
      if (actor.id === coachId) return;
      throw new ForbiddenException(
        schedulingError(
          SchedulingErrorCode.COACH_NOT_BOOKABLE,
          'You can only manage your own calendar.',
        ),
      );
    }
    const ids = await this.bookableCoachIds(actor, db);
    if (ids.includes(coachId)) return;
    throw new ForbiddenException(
      schedulingError(
        SchedulingErrorCode.COACH_NOT_BOOKABLE,
        'You can only book with your own coach. Open Calendar to see who you can book with.',
      ),
    );
  }

  /** The client's bookable coaches with display identity. */
  async listBookableCoaches(actor: ActorContext): Promise<BookableCoach[]> {
    const ids = await this.bookableCoachIds(actor);
    if (ids.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, role: 'coach' },
      select: {
        id: true,
        name: true,
        profile: { select: { avatar_url: true } },
        coach_profile: { select: { timezone: true } },
      },
    });
    const out: BookableCoach[] = [];
    for (const id of ids) {
      const u = users.find((x) => x.id === id);
      if (!u) continue;
      out.push({
        coach_id: u.id,
        name: u.name,
        avatar_url: u.profile?.avatar_url ?? null,
        timezone: u.coach_profile?.timezone ?? DEFAULT_COACH_TIMEZONE,
        relationship: id === actor.coach_id ? 'head_coach' : 'sub_coach',
      });
    }
    return out;
  }

  /**
   * Read access to one session. The session's coach, an owner, or the lead
   * client. A 404 (not 403) for everyone else so session ids cannot be probed.
   */
  assertCanViewSession(
    actor: ActorContext,
    session: Pick<CoachingSession, 'coach_id' | 'client_id'>,
  ): void {
    if (actor.role === 'owner') return;
    if (actor.role === 'coach' && session.coach_id === actor.id) return;
    if (actor.role === 'student' && session.client_id === actor.id) return;
    throw new NotFoundException(
      schedulingError(
        SchedulingErrorCode.SESSION_NOT_FOUND,
        'We could not find that session. It may have been removed. Open Calendar to see your sessions.',
      ),
    );
  }

  /**
   * Move/cancel access. Coach of the session or owner; or the lead client
   * while the coach is still one of their bookable coaches.
   */
  async assertCanActAsParticipant(
    actor: ActorContext,
    session: Pick<CoachingSession, 'coach_id' | 'client_id'>,
    db: Db = this.prisma,
  ): Promise<void> {
    this.assertCanViewSession(actor, session);
    if (actor.role !== 'student') return;
    const ids = await this.bookableCoachIds(actor, db);
    if (ids.includes(session.coach_id)) return;
    throw new ForbiddenException(
      schedulingError(
        SchedulingErrorCode.NOT_SESSION_PARTICIPANT,
        'This session is with a coach you are no longer assigned to. Message your coach or contact support to change it.',
      ),
    );
  }

  /** Coach-only actions (approve, decline, complete, no-show, call link). */
  assertIsSessionCoach(
    actor: ActorContext,
    session: Pick<CoachingSession, 'coach_id' | 'client_id'>,
  ): void {
    if (actor.role === 'owner') return;
    if (actor.role === 'coach' && session.coach_id === actor.id) return;
    if (actor.role === 'student' && session.client_id === actor.id) {
      throw new ForbiddenException(
        schedulingError(
          SchedulingErrorCode.NOT_SESSION_PARTICIPANT,
          'Only your coach can do this. Message your coach if something needs to change.',
        ),
      );
    }
    this.assertCanViewSession(actor, session);
    throw new ForbiddenException(
      schedulingError(
        SchedulingErrorCode.NOT_SESSION_PARTICIPANT,
        'Only the coach for this session can do this.',
      ),
    );
  }
}
