/**
 * SC-BE2 (agent 168; fix round 2 FX-1137, agent 169): the space chat's read line and unread count (SPACE-CHAT
 * plan section 3).
 *
 * One row per (person, space) in community_space_reads (20270502009100; RLS forced: own rows, written only
 * for a space the person can read now). Clients read an open "clients" space without a membership row, so
 * the read line lives here, not on community_memberships.
 * The same row holds the person's notification setting for the space (#167-8, OWNER DECISION 6348239806):
 * a mode (null = the space default: "all" for an Announcements space, "mute_low" for every other space) and
 * an optional silence end (Mute all until then, then back to the chosen mode). SC-PUSH reads both through
 * notifySettingOf().
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { CommunityCohort, User } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { CommunityAccessService } from '../community-access.service';
import { placeOf } from '../community-space-access';
import { CommunitySafetyService } from '../safety/community-safety.service';

/** The unread badge stops counting here; the phone shows "99+". */
export const UNREAD_CAP = 99;

const COHORT_NOT_FOUND = { error: 'not_found', code: 'community.cohort.not_found' } as const;
const MESSAGE_NOT_FOUND = { error: 'not_found', code: 'community.message.not_found' } as const;

export const NOTIFY_MODES = ['all', 'mute_low', 'mute_all'] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];
export const SILENCE_HOURS = [1, 8, 24] as const;

export interface SpaceRead {
  last_read_at: string | null;
  last_read_message_id: string | null;
}

export interface SpaceNotifySetting {
  mode: NotifyMode; // the chosen mode, or the default when none is chosen
  default_mode: NotifyMode;
  effective_mode: NotifyMode; // mute_all while a silence runs
  silenced_until: string | null; // null when no silence is running
}

/** #167-8: an Announcements space defaults to All messages; every other space to Mute low priority. */
export const defaultNotifyMode = (cohort: Pick<CommunityCohort, 'kind'>): NotifyMode =>
  cohort.kind === 'announcement' ? 'all' : 'mute_low';

/** The setting a person has for a space at `now`, from their row (or none). */
export function notifySettingOf(
  cohort: Pick<CommunityCohort, 'kind'>,
  row: { notify_mode: string | null; silenced_until: Date | null } | null,
  now = new Date(),
): SpaceNotifySetting {
  const default_mode = defaultNotifyMode(cohort);
  const mode = (NOTIFY_MODES as readonly string[]).includes(row?.notify_mode ?? '') ? (row?.notify_mode as NotifyMode) : default_mode;
  const silenced = row?.silenced_until && row.silenced_until > now ? row.silenced_until : null;
  return { mode, default_mode, effective_mode: silenced ? 'mute_all' : mode, silenced_until: silenced?.toISOString() ?? null };
}

interface SpaceRow {
  c: string;
  n: number;
  since: Date;
  last_read_message_id: string | null;
  notify_mode: string | null;
  silenced_until: Date | null;
}

/**
 * Per space for one person, in one round trip (the caller passes only spaces the person can read):
 * - since: where their unread count starts (#168-15 UNREAD-START, OWNER DECISION 6353734516): their read line;
 *   before they first open the space, the time they joined it: their membership row, else, for a space open to
 *   the coach's clients, joining the coach (and a package space: their first purchase that opens it); else (the
 *   coach, or an account older than coach_joined_at) the space's own start.
 * - n: plain chat messages after it, capped at UNREAD_CAP, leaving out their own, deleted ones, those of anyone
 *   they block or who blocks them, and of an author who left the coach's community or is banned from it: the
 *   chat list's own rule (C6-WINS-MOVE app.community_author_stays, #168-4 app.community_author_unbanned).
 * - their notification row.
 */
async function spaceRows(prisma: PrismaService, userId: string, cohortIds: string[]): Promise<SpaceRow[]> {
  if (cohortIds.length === 0) return [];
  return prisma.$queryRaw<SpaceRow[]>`
    SELECT c."id"::text AS "c", j."since", r."last_read_message_id"::text AS "last_read_message_id",
      r."notify_mode", r."silenced_until", (
      SELECT count(*)::int FROM (
        SELECT 1 FROM "community_messages" m
        WHERE m."cohort_id" = c."id" AND m."scope" = 'cohort' AND m."plan_context_type" IS NULL
          AND m."deleted_at" IS NULL AND m."sender_id" <> ${userId} AND m."created_at" > j."since"
          AND NOT EXISTS (SELECT 1 FROM "UserBlock" b
            WHERE (b."blocker_id" = ${userId} AND b."blocked_id" = m."sender_id")
               OR (b."blocker_id" = m."sender_id" AND b."blocked_id" = ${userId}))
          AND app.community_author_stays(m."workspace_id", m."cohort_id", m."sender_id")
          AND app.community_author_unbanned(m."workspace_id", m."sender_id")
        LIMIT ${UNREAD_CAP}) t) AS "n"
    FROM "community_cohorts" c
    LEFT JOIN "community_space_reads" r ON r."cohort_id" = c."id" AND r."user_id" = ${userId}
    LEFT JOIN "community_memberships" mb ON mb."cohort_id" = c."id" AND mb."user_id" = ${userId}
    LEFT JOIN "User" u ON u."id" = ${userId}
    CROSS JOIN LATERAL (SELECT COALESCE(r."last_read_at", LEAST(COALESCE(mb."joined_at", mb."created_at"),
      CASE WHEN c."visibility" IN ('clients', 'package') THEN GREATEST(u."coach_joined_at" AT TIME ZONE 'UTC',
        CASE WHEN c."visibility" = 'package' THEN (SELECT min(p."created_at") AT TIME ZONE 'UTC'
          FROM "community_cohort_packages" l JOIN "ClientPurchase" p ON p."package_id" = l."package_id"
          WHERE l."cohort_id" = c."id" AND p."client_user_id" = ${userId} AND p."entitlement_active") END) END),
      c."created_at") AS "since") j
    WHERE c."id" = ANY(${cohortIds}::uuid[])`;
}

/** Unread messages per space for one person (see spaceRows). */
export async function spaceUnreadCounts(
  prisma: PrismaService,
  userId: string,
  cohortIds: string[],
): Promise<Map<string, number>> {
  return new Map((await spaceRows(prisma, userId, cohortIds)).map((r) => [r.c, r.n]));
}

/** The Community tab badge on GET /community/me: the sum of the badges on the space list (pass the same
 *  spaces), leaving out a space on Mute all, which keeps its own count on its row (#168-16 MUTE-BADGE,
 *  OWNER DECISION 6353734516; a running silence is Mute all until it ends). */
export async function communityTabUnread(
  prisma: PrismaService,
  userId: string,
  cohorts: Pick<CommunityCohort, 'id' | 'kind'>[],
): Promise<number> {
  const rows = new Map((await spaceRows(prisma, userId, cohorts.map((c) => c.id))).map((r) => [r.c, r]));
  return cohorts.reduce((sum, c) => {
    const row = rows.get(c.id);
    return !row || notifySettingOf(c, row).effective_mode === 'mute_all' ? sum : sum + row.n;
  }, 0);
}

@Injectable()
export class CommunitySpaceReadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CommunityAccessService,
    private readonly safety: CommunitySafetyService,
  ) {}

  /** The space when the person may read it now (the messages routes' check, so a ban or a move closes it).
   *  404 both for an unknown space and for one they cannot read, the flag-off answer, so these routes never
   *  confirm that a space exists (operator ruling with OWNER DECISION 6353734516). */
  async readable(user: User, cohortId: string): Promise<CommunityCohort> {
    const cohort = await this.access.findCohort(cohortId);
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) throw new NotFoundException(COHORT_NOT_FOUND);
    return cohort;
  }

  /** GET /community/cohorts/:cohortId/read */
  async getRead(user: User, cohortId: string): Promise<SpaceRead> {
    await this.readable(user, cohortId);
    return this.readOf(user.id, cohortId);
  }

  /** POST /community/cohorts/:cohortId/read: moves the read line to a chat message of this space the person
   *  can see (404 otherwise, the chat's own answer: not a deleted message, nor one of a person blocked either
   *  way, banned from the workspace or gone from the community), never backwards. Returns the line as it stands. */
  async markRead(user: User, cohortId: string, messageId: string): Promise<SpaceRead> {
    await this.readable(user, cohortId);
    const m = await this.prisma.communityMessage.findFirst({
      where: { id: messageId, cohort_id: cohortId, scope: 'cohort', plan_context_type: null, deleted_at: null },
      select: { id: true, workspace_id: true, cohort_id: true, sender_id: true },
    });
    if (!m) throw new NotFoundException(MESSAGE_NOT_FOUND);
    // With the place, the block either way, an author gone from the community and (#168-4) a banned author.
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

  /** GET /community/cohorts/:cohortId/notifications */
  async getNotify(user: User, cohortId: string): Promise<SpaceNotifySetting> {
    const cohort = await this.readable(user, cohortId);
    return notifySettingOf(cohort, await this.rowOf(user.id, cohortId));
  }

  /** PUT .../notifications { mode }, POST .../notifications/silence { hours }, DELETE .../notifications/silence */
  async setNotify(
    user: User,
    cohortId: string,
    change: { notify_mode: NotifyMode } | { silenced_until: Date | null },
  ): Promise<SpaceNotifySetting> {
    const cohort = await this.readable(user, cohortId);
    const row = await this.prisma.communitySpaceRead.upsert({
      where: { user_id_cohort_id: { user_id: user.id, cohort_id: cohortId } },
      create: { user_id: user.id, cohort_id: cohortId, ...change },
      update: change,
      select: { notify_mode: true, silenced_until: true },
    });
    return notifySettingOf(cohort, row);
  }

  private rowOf(userId: string, cohortId: string) {
    return this.prisma.communitySpaceRead.findUnique({
      where: { user_id_cohort_id: { user_id: userId, cohort_id: cohortId } },
      select: { notify_mode: true, silenced_until: true },
    });
  }

  /** The read line as it stands; before the first read, their join time (#168-15) and no message. */
  private async readOf(userId: string, cohortId: string): Promise<SpaceRead> {
    const [row] = await spaceRows(this.prisma, userId, [cohortId]);
    return { last_read_at: row?.since.toISOString() ?? null, last_read_message_id: row?.last_read_message_id ?? null };
  }
}
