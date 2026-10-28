import { Injectable } from '@nestjs/common';
import type {
  CommunityMessage,
  CommunityPost,
  Prisma,
  User,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { authorsWhoLeft } from '../community-space-access';
import { clientOf, PUBLIC_SPACE, unbannedSpaces } from '../community-public-row';

/**
 * Data access for the coach inbox aggregator.
 *
 * Tenant scoping follows the v1-2 doctrine: the app connects as service_role
 * (BYPASSRLS), so the SERVICE bounds every read to cohorts the caller actually
 * coaches (resolved here from workspace ownership + coach/assistant
 * memberships). Postgres RLS remains as defence-in-depth. No method here trusts
 * a request-supplied id for authorization.
 *
 * C6-MOVED-PRIVILEGED-READS (owner: history follows the client): a client who
 * moved to another coach left these cohorts, so their rows are left out IN the
 * query (authorsWhoLeft asks app.community_author_stays, the rule the row
 * policies use). Each stream is limit-bounded, so a later filter would drop rows.
 *
 * SPACE-OWNER-ALERTS (owner rule D, 10-26: "ALL alerts and information go to the space owner and their team, plus
 * your resident coach (or just the space owner if coachless)"): in a public space every row of every kind reaches
 * the space owner and their team (the cohorts above), whoever the poster's coach is; it also reaches the poster's
 * own current coach (clientsPublicSpaceIds), for that coach's clients' rows only. A coachless poster reaches the
 * space owner's side only. Row policy: 20270502009800.
 */
export type MessageWithSender = CommunityMessage & {
  sender: Pick<User, 'id' | 'name' | 'role'>;
};

export type PostWithAuthor = CommunityPost & {
  author: Pick<User, 'id' | 'name' | 'role'>;
};

@Injectable()
export class CommunityCoachInboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cohort ids the caller coaches: every cohort in a workspace they OWN, plus
   * every cohort where they hold an active coach/assistant membership. De-duped.
   */
  async coachedCohortIds(userId: string): Promise<string[]> {
    const [ownedCohorts, coachMemberships] = await Promise.all([
      this.prisma.communityCohort.findMany({
        where: { workspace: { coach_id: userId } },
        select: { id: true },
      }),
      this.prisma.communityMembership.findMany({
        where: {
          user_id: userId,
          status: 'active',
          role: { in: ['coach', 'assistant'] },
        },
        select: { cohort_id: true },
      }),
    ]);
    const ids = new Set<string>();
    for (const c of ownedCohorts) ids.add(c.id);
    for (const m of coachMemberships) ids.add(m.cohort_id);
    return [...ids];
  }

  /**
   * Unanswered client messages across the given cohorts, oldest-first.
   *
   * "Unanswered" = a cohort-scope, non-deleted, non-comment message whose sender
   * is NOT a coach/assistant (a client) and which carries no coach reply
   * (coach_replied_at IS NULL). Ordered (created_at ASC, id ASC) — a stable FIFO
   * triage order with a deterministic tiebreak. Fetches `limit` rows; the caller
   * derives next_cursor.
   *
   * VOICE-INBOX (owner "#167-4 VOICE-INBOX - op 1"): with `withVoice` a client's space voice note is a row too,
   * through its chat message (kind voice, same id and time as the note), so every rule here applies to it as it
   * does to typed words: the authors authorsWhoLeft names (moved away, banned, in a block either way with the
   * viewer) stay out, and rule D reaches the same people for every kind. Without it (the AI triage) voice notes
   * stay out: they carry no words.
   */
  async unansweredMessages(params: {
    cohortIds: string[];
    limit: number;
    after: { createdAt: Date; id: string } | null;
    /** #168-4: the coach reading; authors in a block with them stay out. */
    viewerId?: string;
    withVoice?: boolean;
  }): Promise<MessageWithSender[]> {
    const { cohortIds, limit, after } = params;
    const theirs = await this.clientsPublicSpaceIds(params.viewerId, cohortIds);
    if (cohortIds.length === 0 && theirs.length === 0) return [];
    const left = await authorsWhoLeft(this.prisma, [...cohortIds, ...theirs], params.viewerId);
    const notIn: Prisma.CommunityMessageWhereInput[] = left.map(([s, a]) => ({ cohort_id: s, sender_id: a }));
    const arms: Prisma.CommunityMessageWhereInput[] = [{ cohort_id: { in: cohortIds } }];
    if (theirs.length > 0 && params.viewerId) {
      arms.push({ cohort_id: { in: theirs }, sender: clientOf(params.viewerId) });
    }
    return this.prisma.communityMessage.findMany({
      where: {
        ...(notIn.length > 0 ? { NOT: notIn } : {}),
        AND: [{ OR: arms }, afterKey(after)],
        scope: 'cohort',
        deleted_at: null,
        plan_context_type: null,
        ...(params.withVoice ? {} : { kind: { not: 'voice' as const } }),
        coach_replied_at: null,
        // Rule D (d): one coach's Acknowledge clears the row for every coach and the AI triage (Seen does not).
        coach_acked_at: null,
        sender: { role: { notIn: ['coach', 'owner'] } },
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: limit,
      include: { sender: { select: { id: true, name: true, role: true } } },
    });
  }

  /**
   * Unanswered client posts across the given cohorts, oldest-first.
   *
   * "Unanswered" = a cohort-scope, non-deleted post authored by a client (not a
   * coach/owner) that has NO coach-authored comment. Comments are stored as
   * CommunityMessage rows tagged plan_context_id = post.id (see
   * CommunityMessagesRepository.COMMENT_CONTEXT_TYPE). We fetch candidate posts
   * then filter those with a coach comment in a second bounded query, batch by
   * batch until `limit` unanswered posts or the end: an answered post must not
   * use up a place, or the page ends early and the next one starts past the
   * unanswered posts behind it.
   */
  async unansweredPosts(params: {
    cohortIds: string[];
    limit: number;
    after: { createdAt: Date; id: string } | null;
    viewerId?: string;
  }): Promise<PostWithAuthor[]> {
    const { cohortIds, limit } = params;
    const theirs = await this.clientsPublicSpaceIds(params.viewerId, cohortIds);
    if (cohortIds.length === 0 && theirs.length === 0) return [];
    const left = await authorsWhoLeft(this.prisma, [...cohortIds, ...theirs], params.viewerId);
    const arms: Prisma.CommunityPostWhereInput[] = [{ cohort_id: { in: cohortIds } }];
    if (theirs.length > 0 && params.viewerId) {
      arms.push({ cohort_id: { in: theirs }, author: clientOf(params.viewerId) });
    }
    const out: PostWithAuthor[] = [];
    for (let after = params.after; out.length < limit; ) {
      const candidates = await this.prisma.communityPost.findMany({
        where: {
          ...(left.length > 0 ? { NOT: left.map(([s, a]) => ({ cohort_id: s, author_id: a })) } : {}),
          AND: [{ OR: arms }, afterKey(after)],
          scope: 'cohort',
          deleted_at: null,
          author: { role: { notIn: ['coach', 'owner'] } },
        },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: limit,
        include: { author: { select: { id: true, name: true, role: true } } },
      });
      if (candidates.length === 0) break;

      // Which of these posts already has a coach-authored comment? A single
      // bounded query over the comment rows, joined to sender role.
      const answered = await this.prisma.communityMessage.findMany({
        where: {
          plan_context_id: { in: candidates.map((p) => p.id) },
          deleted_at: null,
          sender: { role: { in: ['coach', 'owner'] } },
        },
        select: { plan_context_id: true },
      });
      const answeredPostIds = new Set(
        answered.map((m) => m.plan_context_id).filter((v): v is string => !!v),
      );
      out.push(...candidates.filter((p) => !answeredPostIds.has(p.id)));
      if (candidates.length < limit) break;
      const last = candidates[candidates.length - 1];
      after = { createdAt: last.created_at, id: last.id };
    }
    return out.slice(0, limit);
  }

  /**
   * Rule D, the poster's own coach: the public spaces outside `cohortIds` where a current client of the viewer is
   * or was a member (a public space needs a membership to write in; a member who left keeps what they wrote
   * there). Only that coach's clients' rows are asked for there (the callers' second arm), so a coachless poster,
   * or another coach's client, reaches no one here. No viewer, no spaces. A coach banned from the space's community
   * gets none of it (the row rule asks the same, app.community_public_row_of_my_client).
   */
  async clientsPublicSpaceIds(viewerId: string | undefined, cohortIds: string[]): Promise<string[]> {
    if (!viewerId) return [];
    const spaces = await this.prisma.communityCohort.findMany({
      where: {
        id: { notIn: cohortIds },
        ...PUBLIC_SPACE,
        memberships: { some: { user: clientOf(viewerId) } },
      },
      select: { id: true, workspace_id: true },
    });
    return unbannedSpaces(this.prisma, viewerId, spaces);
  }
}

/**
 * The keyset after `after`, at the cursor's own precision. created_at keeps microseconds; the cursor (a JS Date)
 * keeps milliseconds, so "created_at > cursor" hands back the cursor's own row (and any row of that millisecond
 * the page already passed), each using up a place on the next page. This asks for the rows after (millisecond,
 * id), the order the service cuts the page in.
 */
function afterKey(after: { createdAt: Date; id: string } | null): {
  OR?: Array<{ created_at: { gte: Date; lt?: Date }; id?: { gt: string } }>;
} {
  if (!after) return {};
  const next = new Date(after.createdAt.getTime() + 1);
  return {
    OR: [{ created_at: { gte: next } }, { created_at: { gte: after.createdAt, lt: next }, id: { gt: after.id } }],
  };
}
