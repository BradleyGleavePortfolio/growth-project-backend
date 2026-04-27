import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_PREFIX = 'GP-';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private analytics: AnalyticsService,
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
      } catch (err: any) {
        if (err?.code === 'P2002') continue;
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
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) throw new NotFoundException('User not found');

    if (target.id === actingOwnerId && role !== 'owner') {
      // Refuse to demote yourself — keeps at least one owner online.
      throw new BadRequestException('Cannot demote yourself');
    }

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
    }

    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      coach_id: updated.coach_id,
    };
  }

  async listCoaches() {
    const coaches = await this.prisma.user.findMany({
      where: { role: 'coach' },
      orderBy: { created_at: 'asc' },
      include: {
        coach_profile: true,
        students: { select: { id: true, archived_at: true } },
      },
    });

    return coaches.map((c) => ({
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

  async listUsers(params: { role?: 'owner' | 'coach' | 'student'; q?: string; limit?: number }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const where: any = {};
    if (params.role) where.role = params.role;
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
    return users;
  }
}
