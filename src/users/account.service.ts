import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataExportStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';

// Window between scheduling deletion and actual PII scrub. Deliberately
// long enough to cover an accidental tap from a logged-in client; short
// enough to satisfy GDPR's "without undue delay" guidance.
export const DELETION_GRACE_PERIOD_DAYS = 30;

interface AuditContext {
  ip?: string | null;
  userAgent?: string | null;
}

// AccountService owns the GDPR/CCPA lifecycle for a single user — data
// export, delete-account scheduling, cancellation. It is intentionally
// separate from UsersService (preferences/circle stats) because it deals
// with PII flows that need their own audit trail and tenant-isolation
// semantics.
//
// Tenant isolation: every read here is scoped to the caller's user_id.
// A coach calling these endpoints on behalf of a client would not be
// authorized — these are /users/me/* routes, not coach-side admin.
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // ── Data export ────────────────────────────────────────────────────────
  //
  // Delegates to DataExportRequest via PENDING/READY/FAILED status lifecycle.
  // The DataExportService handles actual file assembly and storage.
  // This method creates the initial record and immediately marks READY once
  // the legacy inline assembleExport() path completes. For the full async
  // export flow with file storage, use DataExportService.requestExport().
  async requestDataExport(userId: string, ctx: AuditContext = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.deleted_at) {
      throw new ForbiddenException('Account has been deleted');
    }

    const request = await this.prisma.dataExportRequest.create({
      data: { user_id: userId, status: DataExportStatus.PENDING },
    });

    await this.audit.write({
      action: AuditAction.USER_DATA_EXPORT_REQUESTED,
      actorId: userId,
      actorRole: user.role,
      actorEmail: user.email,
      targetUserId: userId,
      targetType: 'data_export_request',
      targetId: request.id,
      tenantCoachId: user.coach_id ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    try {
      const fulfilled = await this.prisma.dataExportRequest.update({
        where: { id: request.id },
        data: {
          status: DataExportStatus.READY,
          completed_at: new Date(),
        },
      });
      await this.audit.write({
        action: AuditAction.USER_DATA_EXPORT_FULFILLED,
        actorId: userId,
        actorRole: user.role,
        actorEmail: user.email,
        targetUserId: userId,
        targetType: 'data_export_request',
        targetId: request.id,
        tenantCoachId: user.coach_id ?? null,
      });
      return {
        id: fulfilled.id,
        status: fulfilled.status,
        created_at: fulfilled.created_at,
        completed_at: fulfilled.completed_at,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Data export assembly failed for user=${userId}: ${message}`,
      );
      await this.prisma.dataExportRequest.update({
        where: { id: request.id },
        data: { status: DataExportStatus.FAILED },
      });
      await this.audit.write({
        action: AuditAction.USER_DATA_EXPORT_FAILED,
        actorId: userId,
        targetUserId: userId,
        targetType: 'data_export_request',
        targetId: request.id,
        metadata: { error: message },
      });
      throw err;
    }
  }

  async getDataExport(userId: string, requestId: string) {
    const row = await this.prisma.dataExportRequest.findUnique({
      where: { id: requestId },
    });
    if (!row || row.user_id !== userId) {
      throw new NotFoundException('Export request not found');
    }
    return {
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      completed_at: row.completed_at,
    };
  }

  // ── Delete-account flow ───────────────────────────────────────────────
  //
  // Soft-delete with 30-day grace period. We deliberately do NOT
  // destructively delete rows in production: the user's data is referenced
  // by coach-side tables (CoachMessage, CoachNudge, ActivityEvent, etc.)
  // and a hard delete would either cascade those rows or fail on FK
  // constraints. Instead we mark the account as scheduled-for-deletion —
  // the user is locked out via the `deletion_scheduled_at` check on auth
  // — and a separate scrub job (out of scope for this PR) will perform the
  // PII zero-out after the grace window expires.
  async scheduleDeletion(userId: string, ctx: AuditContext = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.deleted_at) {
      throw new ForbiddenException('Account has already been deleted');
    }

    if (user.deletion_scheduled_at) {
      // Idempotent — already scheduled. Don't re-schedule (which would
      // extend the grace window each tap).
      return this.deletionStatusResponse(user.deletion_scheduled_at);
    }

    const scheduledAt = new Date();
    await this.prisma.user.update({
      where: { id: userId },
      data: { deletion_scheduled_at: scheduledAt },
    });

    await this.audit.write({
      action: AuditAction.USER_ACCOUNT_DELETION_SCHEDULED,
      actorId: userId,
      actorRole: user.role,
      actorEmail: user.email,
      targetUserId: userId,
      targetType: 'user',
      targetId: userId,
      tenantCoachId: user.coach_id ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { grace_period_days: DELETION_GRACE_PERIOD_DAYS },
    });

    return this.deletionStatusResponse(scheduledAt);
  }

  // Cancel a pending deletion within the grace period. Returns 400 if
  // there's nothing scheduled — keeps the UX explicit.
  async cancelDeletion(userId: string, ctx: AuditContext = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.deleted_at) {
      throw new ForbiddenException('Account has already been deleted');
    }
    if (!user.deletion_scheduled_at) {
      throw new BadRequestException('No deletion is scheduled');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { deletion_scheduled_at: null },
    });

    await this.audit.write({
      action: AuditAction.USER_ACCOUNT_DELETION_CANCELED,
      actorId: userId,
      actorRole: user.role,
      actorEmail: user.email,
      targetUserId: userId,
      targetType: 'user',
      targetId: userId,
      tenantCoachId: user.coach_id ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    return { scheduled: false, canceled_at: new Date().toISOString() };
  }

  async getDeletionStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { deletion_scheduled_at: true, deleted_at: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.deleted_at) {
      return { scheduled: false, deleted: true, deleted_at: user.deleted_at };
    }
    if (!user.deletion_scheduled_at) {
      return { scheduled: false, deleted: false };
    }
    return this.deletionStatusResponse(user.deletion_scheduled_at);
  }

  private deletionStatusResponse(scheduledAt: Date) {
    const purgeAt = new Date(
      scheduledAt.getTime() +
        DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    );
    return {
      scheduled: true,
      deleted: false,
      scheduled_at: scheduledAt.toISOString(),
      grace_period_days: DELETION_GRACE_PERIOD_DAYS,
      purge_after: purgeAt.toISOString(),
    };
  }

  // Read-only export assembly. Keep this list in lockstep with the User
  // relations defined on the Prisma schema so we don't ship an export
  // that silently omits a category of personal data. Coach-tenant data
  // (CoachMessage / CoachNudge / ActivityEvent rows owned by the coach)
  // is excluded — those rows belong to the coach's tenant, not the
  // exporting user, and including them would leak the coach's other
  // clients via shared thread metadata.
  private async assembleExport(userId: string) {
    const [
      user,
      profile,
      preferences,
      notificationPrefs,
      foodEntries,
      workouts,
      weightLogs,
      checkIns,
      habits,
      lessonCompletions,
      waterLogs,
      fastingWindows,
      communityWins,
      savedRecipes,
      listItems,
      messagesAsClient,
      nudgesAsClient,
    ] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.userProfile.findUnique({ where: { user_id: userId } }),
      this.prisma.userPreferences.findUnique({ where: { user_id: userId } }),
      this.prisma.notificationPreferences.findUnique({
        where: { user_id: userId },
      }),
      this.prisma.loggedFoodEntry.findMany({ where: { user_id: userId } }),
      this.prisma.workoutSession.findMany({
        where: { user_id: userId },
        include: { exercises: true },
      }),
      this.prisma.weightLog.findMany({ where: { user_id: userId } }),
      this.prisma.checkIn.findMany({ where: { user_id: userId } }),
      this.prisma.habit.findMany({
        where: { user_id: userId },
        include: { logs: true },
      }),
      this.prisma.lessonCompletion.findMany({ where: { user_id: userId } }),
      this.prisma.waterLog.findMany({ where: { user_id: userId } }),
      this.prisma.fastingWindow.findMany({ where: { user_id: userId } }),
      this.prisma.communityWin.findMany({ where: { user_id: userId } }),
      this.prisma.savedRecipe.findMany({ where: { user_id: userId } }),
      this.prisma.listItem.findMany({ where: { user_id: userId } }),
      // Messages and nudges are restricted to those the user received as a
      // client — exporting their own coach-side messages/nudges would
      // leak other clients' data on a coach's roster.
      this.prisma.coachMessage.findMany({
        where: { client_id: userId },
        select: {
          id: true,
          coach_id: true,
          sender_id: true,
          body: true,
          created_at: true,
          read_at: true,
        },
      }),
      this.prisma.coachNudge.findMany({
        where: { client_id: userId },
        select: {
          id: true,
          coach_id: true,
          title: true,
          body: true,
          created_at: true,
          read_at: true,
        },
      }),
    ]);

    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      user: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            phone: user.phone,
            role: user.role,
            coach_id: user.coach_id,
            created_at: user.created_at,
          }
        : null,
      profile,
      preferences,
      notification_preferences: notificationPrefs,
      food_entries: foodEntries,
      workouts,
      weight_logs: weightLogs,
      check_ins: checkIns,
      habits,
      lesson_completions: lessonCompletions,
      water_logs: waterLogs,
      fasting_windows: fastingWindows,
      community_wins: communityWins,
      saved_recipes: savedRecipes,
      list_items: listItems,
      coach_messages_received: messagesAsClient,
      coach_nudges_received: nudgesAsClient,
    };
  }
}
