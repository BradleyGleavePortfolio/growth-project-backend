/**
 * LEAVE-MUTE-BE (agent 176; owner D2, #170-1 BAN-SCOPE): a member's own quiet tools. Leave a space (it drops
 * out of their space list and unread counts; they join again on their own while the coach's access stands),
 * and mute or leave a thread (its replies count nowhere for them). A ban stays the coach's tool for a person.
 *
 * Space mute and timed mutes are b#1137's notification mode and silence (community-space-reads.service.ts),
 * reused. Every route answers 404 community.cohort.not_found for a space the caller cannot read now (the
 * b#1137 rule), so these routes never confirm that a space exists.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CommunityCohort, User } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { CommunityAccessService } from '../community-access.service';
import { fullNamesFor, placeOf } from '../community-space-access';
import { memberName } from '../member-display-name';
import { CommunitySafetyService } from '../safety/community-safety.service';
import type { LeftMembers, SpaceLeave, ThreadState, ThreadStates } from './community-leave-mute.dto';

const COHORT_NOT_FOUND = { error: 'not_found', code: 'community.cohort.not_found' } as const;
const MESSAGE_NOT_FOUND = { error: 'not_found', code: 'community.message.not_found' } as const;
const CANNOT_LEAVE = { error: 'conflict', code: 'community.space.cannot_leave' } as const;

export const THREAD_STATES = ['muted', 'left'] as const;
export type ThreadStateName = (typeof THREAD_STATES)[number];

/** When the person left each of these spaces (only the spaces they left). One round trip. */
export async function leftSpaces(prisma: PrismaService, userId: string, cohortIds: string[]): Promise<Map<string, Date>> {
  if (cohortIds.length === 0) return new Map();
  const rows = await prisma.communitySpaceRead.findMany({
    where: { user_id: userId, cohort_id: { in: cohortIds }, left_at: { not: null } },
    select: { cohort_id: true, left_at: true },
  });
  return new Map(rows.map((r) => [r.cohort_id, r.left_at as Date]));
}

@Injectable()
export class CommunityLeaveMuteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CommunityAccessService,
    private readonly safety: CommunitySafetyService,
  ) {}

  /** The space when the person may read it now (the b#1137 rule; 404 otherwise). */
  private async readable(user: User, cohortId: string): Promise<CommunityCohort> {
    const cohort = await this.access.findCohort(cohortId);
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) throw new NotFoundException(COHORT_NOT_FOUND);
    return cohort;
  }

  /** POST .../leave (D2c, D2f): every space but Announcements; never a section heading, never the coach of the
   *  community from their own space (409). Leaving twice keeps the first time. */
  async leave(user: User, cohortId: string): Promise<SpaceLeave> {
    const cohort = await this.readable(user, cohortId);
    if (cohort.kind !== 'chat' || (await this.access.isWorkspaceCoach(cohort.workspace_id, user.id))) {
      throw new ConflictException(CANNOT_LEAVE);
    }
    const key = { user_id_cohort_id: { user_id: user.id, cohort_id: cohortId } };
    const prior = await this.prisma.communitySpaceRead.findUnique({ where: key, select: { left_at: true } });
    const row = prior?.left_at
      ? prior
      : await this.prisma.communitySpaceRead.upsert({
          where: key,
          create: { user_id: user.id, cohort_id: cohortId, left_at: new Date() },
          update: { left_at: new Date() },
          select: { left_at: true },
        });
    return { cohort_id: cohortId, left_at: (row.left_at as Date).toISOString() };
  }

  /** POST .../join (D2e): back in, on their own, while they can read the space now (404 otherwise). The read
   *  line moves to now, so the unread count starts at the moment they join again (#168-15). */
  async join(user: User, cohortId: string): Promise<SpaceLeave> {
    await this.readable(user, cohortId);
    const newest = await this.prisma.communityMessage.findFirst({
      where: { cohort_id: cohortId, scope: 'cohort', plan_context_type: null, deleted_at: null },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { id: true, created_at: true },
    });
    const now = new Date();
    const at = newest && newest.created_at > now ? newest.created_at : now;
    const line = { left_at: null, last_read_at: at, ...(newest ? { last_read_message_id: newest.id } : {}) };
    await this.prisma.communitySpaceRead.upsert({
      where: { user_id_cohort_id: { user_id: user.id, cohort_id: cohortId } },
      create: { user_id: user.id, cohort_id: cohortId, ...line },
      update: line,
    });
    return { cohort_id: cohortId, left_at: null };
  }

  /** GET .../left (D2d): the people who left this space, for the "{name} left" line in its chat. The chat's own
   *  rule: nobody blocked either way, banned from the community or gone from it. Names follow the chat
   *  (full names in a space open to all of a coach's clients, first names elsewhere). Ids, names and times only. */
  async leftMembers(user: User, cohortId: string): Promise<LeftMembers> {
    const cohort = await this.readable(user, cohortId);
    const rows = await this.prisma.communitySpaceRead.findMany({
      where: { cohort_id: cohortId, left_at: { not: null } },
      orderBy: [{ left_at: 'asc' }, { user_id: 'asc' }],
      select: { user_id: true, left_at: true, user: { select: { name: true } } },
      take: 200,
    });
    const place = placeOf({ workspace_id: cohort.workspace_id, cohort_id: cohort.id });
    const shown = await this.safety.filterBlocked(user.id, rows, (r) => r.user_id, () => place);
    const full = await fullNamesFor(this.prisma, user.id, cohort.workspace_id, shown.map((r) => [cohort.id, r.user_id] as const));
    return {
      cohort_id: cohortId,
      left: shown.map((r) => ({
        user_id: r.user_id,
        name: memberName(r.user.name, full(cohort.id, r.user_id)),
        left_at: (r.left_at as Date).toISOString(),
      })),
    };
  }

  /** GET .../threads (D2b): the caller's muted and left threads in this space, with since when (for the phone's
   *  "{n} replies since you left"). */
  async threadStates(user: User, cohortId: string): Promise<ThreadStates> {
    await this.readable(user, cohortId);
    const rows = await this.prisma.communityThreadPref.findMany({
      where: { user_id: user.id, cohort_id: cohortId },
      orderBy: [{ since: 'asc' }, { thread_message_id: 'asc' }],
      select: { thread_message_id: true, state: true, since: true },
    });
    return {
      cohort_id: cohortId,
      threads: rows.map((r) => ({ thread_message_id: r.thread_message_id, state: r.state as ThreadStateName, since: r.since.toISOString() })),
    };
  }

  /** PUT .../threads/:messageId/mute | leave (D2b): the thread of a chat message of this space the caller can
   *  see (a reply id resolves to its first message); one state per thread, the newest wins. */
  async setThread(user: User, cohortId: string, messageId: string, state: ThreadStateName): Promise<ThreadState> {
    await this.readable(user, cohortId);
    const root = await this.threadRoot(user, cohortId, messageId);
    const row = await this.prisma.communityThreadPref.upsert({
      where: { user_id_thread_message_id: { user_id: user.id, thread_message_id: root } },
      create: { user_id: user.id, cohort_id: cohortId, thread_message_id: root, state },
      update: state === 'left' ? { state, since: new Date() } : { state },
      select: { thread_message_id: true, state: true, since: true },
    });
    return { thread_message_id: row.thread_message_id, state: row.state as ThreadStateName, since: row.since.toISOString() };
  }

  /** DELETE .../threads/:messageId/mute | leave: unmute, or follow again; only that state is undone (204). */
  async clearThread(user: User, cohortId: string, messageId: string, state: ThreadStateName): Promise<void> {
    await this.readable(user, cohortId);
    const root = await this.threadRoot(user, cohortId, messageId);
    await this.prisma.communityThreadPref.deleteMany({ where: { user_id: user.id, thread_message_id: root, state } });
  }

  /** The first message of the thread of `messageId`: a chat message of this space (not deleted, not a comment
   *  or challenge row) the caller may see (no block either way, author not banned or gone); 404 otherwise. */
  private async threadRoot(user: User, cohortId: string, messageId: string): Promise<string> {
    const chat = { cohort_id: cohortId, scope: 'cohort', plan_context_type: null } as const;
    const m = await this.prisma.communityMessage.findFirst({
      where: { id: messageId, ...chat, deleted_at: null },
      select: { id: true, workspace_id: true, cohort_id: true, sender_id: true, parent_message_id: true },
    });
    if (!m) throw new NotFoundException(MESSAGE_NOT_FOUND);
    await this.safety.assertVisibleTo(user.id, m.sender_id, MESSAGE_NOT_FOUND, placeOf(m));
    if (!m.parent_message_id) return m.id;
    // SC-BE1: a reply answers its thread's first message (one level), which may since have been deleted.
    const root = await this.prisma.communityMessage.findFirst({
      where: { id: m.parent_message_id, ...chat, parent_message_id: null },
      select: { id: true },
    });
    if (!root) throw new NotFoundException(MESSAGE_NOT_FOUND);
    return root.id;
  }
}
