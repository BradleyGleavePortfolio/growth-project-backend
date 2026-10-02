import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { checkCommunityText } from './community-content-filter';
import { memberFirstName } from '../member-display-name';
import { SUPPORT_EMAIL } from '../../public-pages/trust-pages.html';

export const CONTENT_REJECTED = {
  error: 'content_rejected',
  code: 'community.content.rejected',
  message:
    'This message was not posted because it appears to contain abusive or explicit language. Please rephrase it.',
} as const;

/**
 * DM refusal for the person who placed the block: they know, so they get the
 * way back (owner rule 13:34: what happened + what to do next).
 */
export const DM_BLOCKED_BY_YOU = {
  error: 'forbidden',
  code: 'community.dm.blocked_by_you',
  message: 'You blocked this member. To message them again, unblock them in Community safety.',
} as const;

/**
 * DM refusal for the person who WAS blocked: the same 404 body as a DM with a
 * member who is not there, so the block is never disclosed ("they are not
 * told"). Kept identical to CommunityDmsService's not-found body.
 */
export const DM_UNAVAILABLE = {
  error: 'not_found',
  code: 'community.dm.not_found',
  message:
    'This conversation is not available. The member may have left the community. Refresh and try again.',
} as const;

/**
 * Block route refusals: stable machine `code` plus a human `message` the app
 * can show as-is (owner rule 13:34: every failure says what happened and what
 * to do next).
 */
export const BLOCK_SELF = {
  error: 'bad_request',
  code: 'community.block.self',
  message: 'You cannot block yourself.',
} as const;

export const BLOCK_NOT_FOUND = {
  error: 'not_found',
  code: 'community.block.not_found',
  message:
    'This member could not be found in your community. They may have left. Refresh and try again.',
} as const;

export const BLOCK_WORKSPACE_COACH = {
  error: 'forbidden',
  code: 'community.block.workspace_coach',
  message:
    'You cannot block your coach. You can report a message or post, or email the safety contact in Community safety.',
} as const;

/** Report reasons offered by the app (stored verbatim in the moderation row). */
export const COMMUNITY_REPORT_REASONS = [
  { code: 'harassment', label: 'Harassment or bullying' },
  { code: 'hate', label: 'Hate speech or discrimination' },
  { code: 'sexual', label: 'Sexual or explicit content' },
  { code: 'violence', label: 'Threats or violence' },
  { code: 'self_harm', label: 'Self-harm or suicide' },
  { code: 'spam', label: 'Spam or scams' },
  { code: 'misinformation', label: 'Harmful health misinformation' },
  { code: 'other', label: 'Something else' },
] as const;

/**
 * The community safety contact shown to members is the one support address
 * (OR-109-1): SUPPORT_EMAIL from src/public-pages/trust-pages.html.ts, the
 * repo's single support constant. No separate env override, so the app,
 * the public pages and the safety screen can never disagree.
 */
export const COMMUNITY_SAFETY_EMAIL: string = SUPPORT_EMAIL;

/**
 * Community guidelines shown in Community > Community safety. Owner-approved
 * copy (2026-10-01 09:07 PDT, launch copy section 2); change only with a new
 * owner approval. Pinned by test/community/safety/community-safety-copy.spec.ts.
 */
export const COMMUNITY_GUIDELINES: readonly string[] = [
  'Be respectful. No harassment, bullying, hate speech or threats.',
  'No sexual or explicit content.',
  'No spam, advertising or scams.',
  'Share training experience, not medical advice. This is a personal-training community.',
  "Keep private things private. Do not share anyone else's personal or health information.",
  'Report anything that breaks these rules. Reports go to your coach and to the team.',
  'This space is not for emergencies. If you are in danger, call 911. If you are struggling emotionally, call or text 988.',
];

/**
 * Public 24-hour moderation commitment (owner-approved 2026-10-01 09:07 PDT,
 * launch copy section 4). Pinned by community-safety-copy.spec.ts.
 */
export const COMMUNITY_RESPONSE_COMMITMENT =
  'Reports are reviewed within 24 hours, every day, by your coach and The Growth Project team. Content that breaks these guidelines is removed, and people who break them repeatedly lose access. If you block someone, they can no longer see your posts or message you, and they are not told.';

/**
 * A DM row (dm_key set) is only addressable by its two participants. Used by
 * every path that resolves a CommunityMessage by id outside the DM routes
 * (reactions, reports), so a third member cannot react to or pull someone
 * else's DM into the moderation queue by id. Same 404 body as "not found".
 */
export function assertDmParticipantIfDm(
  message: { dm_key: string | null; sender_id: string; recipient_user_id: string | null },
  viewerId: string,
  notFoundBody: object,
): void {
  if (message.dm_key === null) return;
  if (viewerId === message.sender_id || viewerId === message.recipient_user_id) return;
  throw new NotFoundException(notFoundBody);
}

/**
 * Community safety primitives (Apple 1.2): user blocking across every
 * community surface, the pre-publication content filter, and the published
 * contact path.
 *
 * Blocks reuse the existing `UserBlock` table (one block list per user, the
 * same list coach-client messaging already honours), so blocking someone in
 * the community also stops them messaging you there. A block is TWO-WAY on
 * every member-facing community read surface: the blocker no longer sees
 * anything the blocked user authored (posts, comments and replies, cohort
 * messages, DMs, challenge comments, voice notes, roster and leaderboard rows,
 * wins, search results, reaction counts, and coach-authored lessons, events
 * and challenges), AND the blocked user no longer sees the blocker's. Single
 * reads by id answer 404 (same body as "does not exist"), and every
 * interaction that targets the other side (reply, react, RSVP, join, DM) is
 * refused the same way, so no push can cross a block. Unblocking restores
 * both directions at once (one row). The blocked user is never told.
 * Coach/owner moderation surfaces (queue, flagged list, coach inbox, AI
 * triage, the coach roster view) stay complete so reports can be actioned.
 * This makes the owner-approved copy true: "If you block someone, they can no
 * longer see your posts or message you, and they are not told."
 */
@Injectable()
export class CommunitySafetyService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Content filter ───────────────────────────────────────────────────────

  /** Throw 422 when any field contains objectionable content. */
  assertAllowed(...fields: Array<string | null | undefined>): void {
    if (!checkCommunityText(...fields).allowed) {
      throw new UnprocessableEntityException(CONTENT_REJECTED);
    }
  }

  // ── Blocks ───────────────────────────────────────────────────────────────

  /** True when either user has blocked the other. */
  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const row = await this.prisma.userBlock.findFirst({
      where: {
        OR: [
          { blocker_id: a, blocked_id: b },
          { blocker_id: b, blocked_id: a },
        ],
      },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Ids hidden from the viewer in BOTH directions: users the viewer blocked
   * and users who blocked the viewer. One query over both columns.
   */
  async hiddenFromViewer(viewerId: string): Promise<Set<string>> {
    const rows = await this.prisma.userBlock.findMany({
      where: { OR: [{ blocker_id: viewerId }, { blocked_id: viewerId }] },
      select: { blocker_id: true, blocked_id: true },
    });
    const hidden = new Set<string>();
    for (const r of rows) {
      if (r.blocker_id === viewerId) hidden.add(r.blocked_id);
      else if (r.blocked_id === viewerId) hidden.add(r.blocker_id);
    }
    hidden.delete(viewerId);
    return hidden;
  }

  /**
   * Drop rows authored by anyone in a block relation with the viewer, in
   * either direction (the viewer blocked them, or they blocked the viewer).
   */
  async filterBlocked<T>(
    viewerId: string,
    rows: T[],
    authorOf: (row: T) => string | null | undefined,
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const hidden = await this.hiddenFromViewer(viewerId);
    if (hidden.size === 0) return rows;
    return rows.filter((r) => {
      const author = authorOf(r);
      return !author || !hidden.has(author);
    });
  }

  /**
   * Single-item reads: 404 (same body as "does not exist") when the viewer
   * and the author are in a block relation either way, so a direct link or
   * id cannot be used to read around the list filter.
   */
  async assertVisibleTo(
    viewerId: string,
    authorId: string | null | undefined,
    notFoundBody: object,
  ): Promise<void> {
    if (!authorId || authorId === viewerId) return;
    if (await this.isBlockedEitherWay(viewerId, authorId)) {
      throw new NotFoundException(notFoundBody);
    }
  }

  /**
   * A block in either direction closes the DM (open, read, send). The blocker
   * gets 403 community.dm.blocked_by_you with the unblock step; the blocked
   * person gets the plain not-found body, so the block is not disclosed.
   */
  async assertDmAllowed(senderId: string, recipientId: string): Promise<void> {
    const rows = await this.prisma.userBlock.findMany({
      where: {
        OR: [
          { blocker_id: senderId, blocked_id: recipientId },
          { blocker_id: recipientId, blocked_id: senderId },
        ],
      },
      select: { blocker_id: true, blocked_id: true },
    });
    if (rows.length === 0) return;
    if (rows.some((r) => r.blocker_id === senderId && r.blocked_id === recipientId)) {
      throw new ForbiddenException(DM_BLOCKED_BY_YOU);
    }
    throw new NotFoundException(DM_UNAVAILABLE);
  }

  /**
   * Block a user the caller shares a community workspace with. The caller's
   * own workspace coach cannot be blocked (they run the space and its
   * moderation; members report them to the platform contact instead).
   */
  async block(
    viewer: { id: string },
    targetUserId: string,
  ): Promise<{ blocked_user_id: string; blocked: true }> {
    if (viewer.id === targetUserId) {
      throw new BadRequestException(BLOCK_SELF);
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, deleted_at: true },
    });
    if (!target || target.deleted_at) {
      throw new NotFoundException(BLOCK_NOT_FOUND);
    }
    if (!(await this.sharesWorkspace(viewer.id, targetUserId))) {
      throw new NotFoundException(BLOCK_NOT_FOUND);
    }
    const coachesViewer = await this.prisma.communityWorkspace.findFirst({
      where: {
        coach_id: targetUserId,
        memberships: { some: { user_id: viewer.id } },
      },
      select: { id: true },
    });
    if (coachesViewer) {
      throw new ForbiddenException(BLOCK_WORKSPACE_COACH);
    }
    await this.prisma.userBlock.upsert({
      where: {
        UserBlock_pair_key: { blocker_id: viewer.id, blocked_id: targetUserId },
      },
      update: {},
      create: { blocker_id: viewer.id, blocked_id: targetUserId },
    });
    return { blocked_user_id: targetUserId, blocked: true };
  }

  async unblock(
    viewer: { id: string },
    targetUserId: string,
  ): Promise<{ blocked_user_id: string; blocked: false }> {
    await this.prisma.userBlock.deleteMany({
      where: { blocker_id: viewer.id, blocked_id: targetUserId },
    });
    return { blocked_user_id: targetUserId, blocked: false };
  }

  async listBlocks(viewer: { id: string }): Promise<{
    blocks: Array<{ user_id: string; name: string; blocked_at: string }>;
  }> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blocker_id: viewer.id },
      orderBy: { created_at: 'desc' },
      select: {
        blocked_id: true,
        created_at: true,
        blocked: { select: { name: true } },
      },
    });
    return {
      blocks: rows.map((r) => ({
        user_id: r.blocked_id,
        // Client privacy: other members see first names only.
        name: memberFirstName(r.blocked?.name),
        blocked_at: r.created_at.toISOString(),
      })),
    };
  }

  /** True when both users hold (or own) a membership in a common workspace. */
  private async sharesWorkspace(a: string, b: string): Promise<boolean> {
    const workspacesOf = async (userId: string): Promise<Set<string>> => {
      const [memberships, owned] = await Promise.all([
        this.prisma.communityMembership.findMany({
          where: { user_id: userId },
          select: { workspace_id: true },
        }),
        this.prisma.communityWorkspace.findMany({
          where: { coach_id: userId },
          select: { id: true },
        }),
      ]);
      return new Set([...memberships.map((m) => m.workspace_id), ...owned.map((w) => w.id)]);
    };
    const [wa, wb] = await Promise.all([workspacesOf(a), workspacesOf(b)]);
    for (const w of wa) if (wb.has(w)) return true;
    return false;
  }

  // ── Published contact path ───────────────────────────────────────────────

  safetyInfo(): {
    contact_email: string;
    report_reasons: typeof COMMUNITY_REPORT_REASONS;
    guidelines: string[];
    response_commitment: string;
  } {
    return {
      contact_email: COMMUNITY_SAFETY_EMAIL,
      report_reasons: COMMUNITY_REPORT_REASONS,
      guidelines: [...COMMUNITY_GUIDELINES],
      response_commitment: COMMUNITY_RESPONSE_COMMITMENT,
    };
  }
}
