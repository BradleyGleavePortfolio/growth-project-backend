import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { AuditAction, AuditService } from '../audit/audit.service';
import { CoachOnboardingService } from '../coach/coach-onboarding.service';

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_PREFIX = 'GP-';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private analytics: AnalyticsService,
    private audit: AuditService,
    // Optional in the constructor signature so legacy unit tests that
    // construct AdminService directly (e.g. test/admin-audit.spec.ts,
    // test/e2e-saas-smoke.spec.ts) keep compiling. In NestJS DI this is
    // always populated because CoachModule exports CoachOnboardingService.
    private coachOnboarding?: CoachOnboardingService,
  ) {}

  private generateInviteCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let out = CODE_PREFIX;
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  }

  // Phase 1A: ensure a CoachProfile exists for the given user. Idempotent
  // — returns the existing profile if there is one, otherwise creates one
  // with a unique invite_code. Used both at promote-time and lazily by
  // the /coaches/me/invite-link endpoint.
  async ensureCoachProfile(userId: string, ownerId?: string, hints?: {
    business_name?: string;
    bio?: string;
    timezone?: string;
  }) {
    const existing = await this.prisma.coachProfile.findUnique({
      where: { user_id: userId },
    });
    if (existing) return existing;

    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const created = await this.prisma.coachProfile.create({
          data: {
            user_id: userId,
            invite_code: this.generateInviteCode(),
            business_name: hints?.business_name ?? null,
            bio: hints?.bio ?? null,
            timezone: hints?.timezone ?? null,
            created_by_owner_id: ownerId ?? null,
          },
        });
        this.analytics.capture(userId, Events.COACH_PROVISIONED, {
          provisioned_by_owner: !!ownerId,
        });
        return created;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw new Error('Failed to allocate unique invite_code after retries');
  }

  async promoteUser(
    actingOwnerId: string,
    targetUserId: string,
    role: 'student' | 'coach' | 'owner',
    hints?: { business_name?: string; bio?: string; timezone?: string },
    audit?: { ip?: string | null; userAgent?: string | null },
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) throw new NotFoundException('User not found');

    if (target.id === actingOwnerId && role !== 'owner') {
      // Refuse to demote yourself — keeps at least one owner online.
      throw new BadRequestException('Cannot demote yourself');
    }

    const previousRole = target.role;

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { role },
    });

    // Promotion to coach: ensure a CoachProfile exists with a default
    // invite_code so the coach can immediately start onboarding clients.
    if (role === 'coach') {
      await this.ensureCoachProfile(updated.id, actingOwnerId, hints);
      this.analytics.capture(updated.id, Events.COACH_PROMOTED, {
        via: 'admin_promote',
        promoted_by_owner_id: actingOwnerId,
      });
      // Phase 6D — auto-start the onboarding wizard. Idempotent on the
      // service side (re-promoting the same user reuses the existing row).
      // This MUST NEVER block promotion: a wizard-creation failure is logged
      // and swallowed; the operator sees a failed promote_user otherwise,
      // which would be a worse outcome than a coach with no wizard row.
      if (this.coachOnboarding && CoachOnboardingService.autoStartEnabled()) {
        try {
          await this.coachOnboarding.startWizard(updated.id);
        } catch (err) {
          this.logger.warn(
            `coachOnboarding.startWizard failed for ${updated.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    // Immutable audit trail of the role change. Only write if the role
    // actually changed — re-asserting the same role is a no-op and
    // shouldn't pollute the audit log.
    if (previousRole !== role) {
      const actor = await this.prisma.user.findUnique({
        where: { id: actingOwnerId },
        select: { email: true, role: true },
      });
      await this.audit.write({
        action: AuditAction.USER_ROLE_CHANGED,
        actorId: actingOwnerId,
        actorRole: actor?.role ?? null,
        actorEmail: actor?.email ?? null,
        targetUserId: updated.id,
        targetType: 'user',
        targetId: updated.id,
        tenantCoachId: role === 'coach' ? updated.id : null,
        ip: audit?.ip ?? null,
        userAgent: audit?.userAgent ?? null,
        metadata: { from: previousRole, to: role },
      });
    }

    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      coach_id: updated.coach_id,
    };
  }

  // OWNER-only view over the Stripe webhook idempotency table. Lets
  // operators verify that recent deliveries landed (by id + type) without
  // jumping to the Stripe dashboard, and supports a `type` filter for
  // narrowing during incident response (e.g. payment_failed-only).
  // Pagination uses the indexed `processed_at` column for keyset cursor.
  async listStripeProcessedEvents(params: {
    type?: string;
    before?: Date;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const where: Prisma.StripeProcessedEventWhereInput = {};
    if (params.type) where.type = params.type;
    if (params.before) where.processed_at = { lt: params.before };
    const rows = await this.prisma.stripeProcessedEvent.findMany({
      where,
      orderBy: { processed_at: 'desc' },
      take: limit,
    });
    return {
      events: rows.map((r) => ({
        stripe_event_id: r.stripe_event_id,
        type: r.type,
        processed_at: r.processed_at,
      })),
      next_before:
        rows.length === limit ? rows[rows.length - 1].processed_at : null,
    };
  }

  // OWNER-only coach list. Cursor-paginated (#2): the page bound is pushed
  // into the DB query via `take` + a keyset `created_at` cursor so a large
  // coach roster never loads unbounded into memory. Coaches are ordered
  // created_at ASC, so the cursor is the created_at of the previous page's
  // last row and the next page returns rows with created_at > cursor.
  async listCoaches(params?: { limit?: number; cursor?: Date }) {
    const limit = Math.min(Math.max(params?.limit ?? 50, 1), 100);
    const where: Prisma.UserWhereInput = { role: 'coach' };
    if (params?.cursor) where.created_at = { gt: params.cursor };
    const coaches = await this.prisma.user.findMany({
      where,
      orderBy: { created_at: 'asc' },
      take: limit,
      include: {
        coach_profile: true,
        students: { select: { id: true, archived_at: true } },
      },
    });

    const items = coaches.map((c) => ({
      id: c.id,
      email: c.email,
      name: c.name,
      created_at: c.created_at,
      profile: c.coach_profile
        ? {
            business_name: c.coach_profile.business_name,
            invite_code: c.coach_profile.invite_code,
            subscription_status: c.coach_profile.subscription_status,
            plan_tier: c.coach_profile.plan_tier,
            current_period_end: c.coach_profile.current_period_end,
            trial_end: c.coach_profile.trial_end,
            timezone: c.coach_profile.timezone,
            branding: {
              accent_color: c.coach_profile.branding_accent_color,
              logo_url: c.coach_profile.branding_logo_url,
            },
          }
        : null,
      client_count: c.students.length,
      active_client_count: c.students.filter((s) => !s.archived_at).length,
    }));

    return {
      coaches: items,
      next_cursor:
        coaches.length === limit
          ? coaches[coaches.length - 1].created_at.toISOString()
          : null,
    };
  }

  async getCoachDetail(coachId: string) {
    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      include: {
        coach_profile: true,
        students: {
          select: {
            id: true,
            email: true,
            name: true,
            created_at: true,
            archived_at: true,
          },
          orderBy: { created_at: 'desc' },
        },
      },
    });
    if (!coach || coach.role !== 'coach') {
      throw new NotFoundException('Coach not found');
    }

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const clientIds = coach.students.map((s) => s.id);
    const [recentLogs, recentWorkouts, recentMessages] =
      clientIds.length === 0
        ? [0, 0, 0]
        : await Promise.all([
            this.prisma.loggedFoodEntry.count({
              where: { user_id: { in: clientIds }, logged_at: { gte: sevenDaysAgo } },
            }),
            this.prisma.workoutSession.count({
              where: { user_id: { in: clientIds }, date: { gte: sevenDaysAgo } },
            }),
            this.prisma.coachMessage.count({
              where: { coach_id: coachId, created_at: { gte: sevenDaysAgo } },
            }),
          ]);

    return {
      id: coach.id,
      email: coach.email,
      name: coach.name,
      created_at: coach.created_at,
      profile: coach.coach_profile,
      students: coach.students,
      stats_last_7d: {
        logs: recentLogs,
        workouts: recentWorkouts,
        messages: recentMessages,
      },
    };
  }

  async listAuditLog(params: {
    action?: string;
    targetUserId?: string;
    tenantCoachId?: string;
    before?: string;
    limit?: number;
  }) {
    return this.audit.list({
      action: params.action,
      targetUserId: params.targetUserId,
      tenantCoachId: params.tenantCoachId,
      before: params.before ? new Date(params.before) : undefined,
      limit: params.limit,
    });
  }

  // OWNER-only user list with role/search filters. Cursor-paginated (#2):
  // users are ordered created_at DESC, so the cursor is the created_at of
  // the previous page's last row and the next page returns rows with
  // created_at < cursor. The bound is enforced in the DB query (`take`),
  // not by slicing in memory.
  async listUsers(params: {
    role?: 'owner' | 'coach' | 'student';
    q?: string;
    limit?: number;
    cursor?: Date;
  }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    const where: Prisma.UserWhereInput = {};
    if (params.role) where.role = params.role;
    if (params.cursor) where.created_at = { lt: params.cursor };
    if (params.q) {
      where.OR = [
        { email: { contains: params.q, mode: 'insensitive' } },
        { name: { contains: params.q, mode: 'insensitive' } },
      ];
    }
    const users = await this.prisma.user.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        coach_id: true,
        created_at: true,
        archived_at: true,
      },
    });
    return {
      users,
      next_cursor:
        users.length === limit
          ? users[users.length - 1].created_at.toISOString()
          : null,
    };
  }
}
