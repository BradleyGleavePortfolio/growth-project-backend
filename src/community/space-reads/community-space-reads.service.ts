/**
 * SC-BE2 (agent 168): the space chat's read line and unread count (SPACE-CHAT plan section 3).
 *
 * One row per (person, space) in community_space_reads (20270502008400; RLS forced: own rows, written only
 * for a space the person can read now). Clients read an open "clients" space without a membership row, so
 * the read line lives here, not on community_memberships.
 *
 * Behind FEATURE_COMMUNITY_SPACE_CHAT (default off; the same switch for SC-BE1..3): off, the read routes
 * answer 404 and GET /community/cohorts rows carry no unread_count.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CommunityCohort, User } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { CommunityAccessService } from '../community-access.service';
import { placeOf } from '../community-space-access';
import { CommunitySafetyService } from '../safety/community-safety.service';

/** The space chat's server switch: on only for "true". */
export const spaceChatOn = (): boolean => process.env.FEATURE_COMMUNITY_SPACE_CHAT === 'true';

/** The unread badge stops counting here; the phone shows "99+". */
export const UNREAD_CAP = 99;

const COHORT_NOT_FOUND = { error: 'not_found', code: 'community.cohort.not_found' } as const;
const COHORT_NO_ACCESS = { error: 'forbidden', code: 'community.cohort.no_access' } as const;
const MESSAGE_NOT_FOUND = { error: 'not_found', code: 'community.message.not_found' } as const;

export interface SpaceRead {
  last_read_at: string | null;
  last_read_message_id: string | null;
}

/**
 * Unread messages per space for one person, each capped at UNREAD_CAP: plain chat messages after their read
 * line (all of them when they never opened the space), leaving out their own, deleted ones, those of anyone
 * they block or who blocks them, of an author banned from the workspace, and of an author who left the
 * coach's community (C6-WINS-MOVE, app.community_author_stays). One round trip; the caller passes only spaces
 * the person can read.
 */
export async function spaceUnreadCounts(
  prisma: PrismaService,
  userId: string,
  cohortIds: string[],
): Promise<Map<string, number>> {
  if (cohortIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ c: string; n: number }[]>`
    SELECT s."id"::text AS "c", (
      SELECT count(*)::int FROM (
        SELECT 1 FROM "community_messages" m
        WHERE m."cohort_id" = s."id" AND m."scope" = 'cohort' AND m."plan_context_type" IS NULL
          AND m."deleted_at" IS NULL AND m."sender_id" <> ${userId}
          AND m."created_at" > COALESCE(r."last_read_at", '-infinity'::timestamptz)
          AND NOT EXISTS (SELECT 1 FROM "UserBlock" b
            WHERE (b."blocker_id" = ${userId} AND b."blocked_id" = m."sender_id")
               OR (b."blocker_id" = m."sender_id" AND b."blocked_id" = ${userId}))
          AND NOT EXISTS (SELECT 1 FROM "community_workspace_bans" x
            WHERE x."workspace_id" = m."workspace_id" AND x."user_id" = m."sender_id" AND x."lifted_at" IS NULL)
          AND app.community_author_stays(m."workspace_id", m."cohort_id", m."sender_id")
        LIMIT ${UNREAD_CAP}) t) AS "n"
    FROM unnest(${cohortIds}::uuid[]) AS s("id")
    LEFT JOIN "community_space_reads" r ON r."cohort_id" = s."id" AND r."user_id" = ${userId}`;
  return new Map(rows.map((r) => [r.c, r.n]));
}

@Injectable()
export class CommunitySpaceReadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CommunityAccessService,
    private readonly safety: CommunitySafetyService,
  ) {}

  /** The space when the switch is on and the person may read it now (the messages routes' check):
   *  404 for an unknown space, 403 for one they cannot read (as GET /community/cohorts/:id). */
  async readable(user: User, cohortId: string): Promise<CommunityCohort> {
    if (!spaceChatOn()) throw new NotFoundException(COHORT_NOT_FOUND);
    const cohort = await this.access.findCohort(cohortId);
    if (!cohort) throw new NotFoundException(COHORT_NOT_FOUND);
    if (!(await this.access.canAccessCohort(cohort, user))) throw new ForbiddenException(COHORT_NO_ACCESS);
    return cohort;
  }

  /** GET /community/cohorts/:cohortId/read */
  async getRead(user: User, cohortId: string): Promise<SpaceRead> {
    await this.readable(user, cohortId);
    return this.readOf(user.id, cohortId);
  }

  /** POST /community/cohorts/:cohortId/read: moves the read line to a chat message of this space the person
   *  can see (404 otherwise, the chat's own answer), never backwards. Returns the line as it stands. */
  async markRead(user: User, cohortId: string, messageId: string): Promise<SpaceRead> {
    await this.readable(user, cohortId);
    const m = await this.prisma.communityMessage.findFirst({
      where: { id: messageId, cohort_id: cohortId, scope: 'cohort', plan_context_type: null, deleted_at: null },
      select: { id: true, workspace_id: true, cohort_id: true, sender_id: true },
    });
    if (!m) throw new NotFoundException(MESSAGE_NOT_FOUND);
    await this.safety.assertVisibleTo(user.id, m.sender_id, MESSAGE_NOT_FOUND, placeOf(m));
    // The message's own stored time (microseconds), so the unread count compares like with like.
    await this.prisma.$executeRaw`
      INSERT INTO "community_space_reads" ("user_id", "cohort_id", "last_read_at", "last_read_message_id", "updated_at")
      SELECT ${user.id}, m."cohort_id", m."created_at", m."id", now() FROM "community_messages" m
      WHERE m."id" = ${m.id}::uuid AND m."cohort_id" = ${cohortId}::uuid
      ON CONFLICT ("user_id", "cohort_id") DO UPDATE
        SET "last_read_at" = EXCLUDED."last_read_at", "last_read_message_id" = EXCLUDED."last_read_message_id",
            "updated_at" = now()
        WHERE "community_space_reads"."last_read_at" IS NULL
           OR "community_space_reads"."last_read_at" < EXCLUDED."last_read_at"`;
    return this.readOf(user.id, cohortId);
  }

  private async readOf(userId: string, cohortId: string): Promise<SpaceRead> {
    const row = await this.prisma.communitySpaceRead.findUnique({
      where: { user_id_cohort_id: { user_id: userId, cohort_id: cohortId } },
      select: { last_read_at: true, last_read_message_id: true },
    });
    return {
      last_read_at: row?.last_read_at?.toISOString() ?? null,
      last_read_message_id: row?.last_read_message_id ?? null,
    };
  }
}
