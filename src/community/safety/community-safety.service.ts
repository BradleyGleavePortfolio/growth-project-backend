import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { checkCommunityText } from './community-content-filter';

export const CONTENT_REJECTED = {
  error: 'content_rejected',
  code: 'community.content.rejected',
  message:
    'This message was not posted because it appears to contain abusive or explicit language. Please rephrase it.',
} as const;

export const DM_BLOCKED = {
  error: 'forbidden',
  code: 'community.dm.blocked',
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

export const DEFAULT_COMMUNITY_SAFETY_EMAIL = 'Bradley@Bradleytgpcoaching.com';

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
 * Community safety primitives (Apple 1.2): user blocking across every
 * community surface, the pre-publication content filter, and the published
 * contact path.
 *
 * Blocks reuse the existing `UserBlock` table (one block list per user, the
 * same list coach-client messaging already honours), so blocking someone in
 * the community also stops them messaging you there. A block hides the
 * blocked user's posts, comments, cohort messages, challenge comments, voice
 * notes and search results from the blocker, and stops DMs in both
 * directions. The blocked user is never told.
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

  /** Ids of users the viewer has blocked. */
  async blockedByViewer(viewerId: string): Promise<Set<string>> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blocker_id: viewerId },
      select: { blocked_id: true },
    });
    return new Set(rows.map((r) => r.blocked_id));
  }

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

  /** Drop rows authored by users the viewer blocked. */
  async filterBlocked<T>(
    viewerId: string,
    rows: T[],
    authorOf: (row: T) => string | null | undefined,
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const blocked = await this.blockedByViewer(viewerId);
    if (blocked.size === 0) return rows;
    return rows.filter((r) => {
      const author = authorOf(r);
      return !author || !blocked.has(author);
    });
  }

  async assertDmAllowed(senderId: string, recipientId: string): Promise<void> {
    if (await this.isBlockedEitherWay(senderId, recipientId)) {
      throw new ForbiddenException(DM_BLOCKED);
    }
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
      throw new BadRequestException({ error: 'bad_request', code: 'community.block.self' });
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, deleted_at: true },
    });
    if (!target || target.deleted_at) {
      throw new NotFoundException({ error: 'not_found', code: 'community.block.not_found' });
    }
    if (!(await this.sharesWorkspace(viewer.id, targetUserId))) {
      throw new NotFoundException({ error: 'not_found', code: 'community.block.not_found' });
    }
    const coachesViewer = await this.prisma.communityWorkspace.findFirst({
      where: {
        coach_id: targetUserId,
        memberships: { some: { user_id: viewer.id } },
      },
      select: { id: true },
    });
    if (coachesViewer) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.block.workspace_coach',
      });
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
        name: r.blocked?.name ?? 'Member',
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
    const email =
      (process.env.COMMUNITY_SAFETY_CONTACT_EMAIL ?? '').trim() || DEFAULT_COMMUNITY_SAFETY_EMAIL;
    return {
      contact_email: email,
      report_reasons: COMMUNITY_REPORT_REASONS,
      guidelines: [...COMMUNITY_GUIDELINES],
      response_commitment: COMMUNITY_RESPONSE_COMMITMENT,
    };
  }
}
