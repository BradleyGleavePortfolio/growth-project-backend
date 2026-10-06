import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { memberFirstName } from '../community/member-display-name';
import { ReportMessageDto, ReportReason } from './dto/report-message.dto';
import { ReportAlertService } from '../report-alerts/report-alert.service';

// Prisma unique-constraint violation. Surfaced when two concurrent
// inserts race past the pre-check on the same unique tuple.
const PRISMA_UNIQUE_VIOLATION = 'P2002';

// Analytics event names. AnalyticsService.capture takes a free-form string,
// so we keep these literals colocated with the service instead of widening
// the canonical Events taxonomy in this PR.
const EVENT_REPORTED = 'safety_message_reported';
const EVENT_BLOCKED = 'safety_user_blocked';
const EVENT_UNBLOCKED = 'safety_user_unblocked';

/**
 * B-AUTHZ-2: the block list follows the community privacy contract. A client
 * (student) target shows the first name only, the same as every community
 * surface; coach-side accounts keep the name already shown on their profile.
 */
function blockedDisplayName(blocked: { name: string | null; role: Role } | null): string {
  if (!blocked) return '';
  if (blocked.role === 'student') return memberFirstName(blocked.name);
  return blocked.name ?? '';
}

/**
 * MessagesSafetyService — Apple 1.2 abuse-reporting + per-user blocklist.
 *
 * Two responsibilities:
 *   1. /messages/report — file a report against a specific CoachMessage.
 *      Idempotent (re-reporting returns the existing row). Validates the
 *      reporter has access to the thread containing the message.
 *   2. /users/:id/block — manage a one-way, silent blocklist used by the
 *      messaging service to suppress threads + push notifications.
 *
 * The blocklist is intentionally one-way + silent (Apple convention) — the
 * blocked party is never informed and the messaging service simply omits
 * the blocked sender's rows from list responses and skips the push.
 */
@Injectable()
export class MessagesSafetyService {
  private readonly logger = new Logger(MessagesSafetyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    // B-REPORTALERT-125: provided by MessagesSafetyModule; optional so unit
    // harnesses that build the service by hand keep working.
    @Optional() private readonly reportAlerts?: ReportAlertService,
  ) {}

  // ─── Reports ──────────────────────────────────────────────────────────────

  async reportMessage(
    reporterId: string,
    dto: ReportMessageDto,
  ): Promise<{
    reportId: string;
    status: 'received' | 'already_reported';
  }> {
    // 1. The message must exist and the reporter must be one of the two
    //    thread parties (coach or client). 404 on missing or foreign — the
    //    existence of a foreign message must not leak.
    const msg = await this.prisma.coachMessage.findUnique({
      where: { id: dto.messageId },
      select: { id: true, coach_id: true, client_id: true, sender_id: true },
    });
    if (!msg) throw new NotFoundException({ error: 'MESSAGE_NOT_FOUND' });

    const isParty =
      msg.coach_id === reporterId || msg.client_id === reporterId;
    if (!isParty) {
      // Treat as 404 so we don't leak that the message exists.
      throw new NotFoundException({ error: 'MESSAGE_NOT_FOUND' });
    }

    // 2. Reporting your own message is nonsensical. Reject with 400 so the
    //    mobile can surface a precise error instead of silently logging it.
    if (msg.sender_id === reporterId) {
      throw new BadRequestException({ error: 'CANNOT_REPORT_OWN_MESSAGE' });
    }

    // 3. Idempotency. The unique constraint on (reporter_id, message_id)
    //    means a second report from the same user against the same message
    //    is a no-op — return the existing row with a distinct status flag so
    //    the mobile can show "already reported" if it wants.
    //
    //    Pattern: attempt the insert, catch the P2002 unique-violation that
    //    surfaces when two concurrent requests race past a pre-check. On
    //    P2002 we re-read the surviving row and return `already_reported`.
    //    This closes the read-then-create TOCTOU window that a findUnique +
    //    create pair leaves open.
    let createdId: string;
    let createdAt: Date;
    try {
      const created = await this.prisma.messageReport.create({
        data: {
          reporter_id: reporterId,
          message_id: dto.messageId,
          coach_id: msg.coach_id ?? undefined,
          client_id: msg.client_id ?? undefined,
          reason: dto.reason,
          details: dto.details?.slice(0, 1000) ?? null,
          // status defaults to 'pending'
        },
        select: { id: true, created_at: true },
      });
      createdId = created.id;
      createdAt = created.created_at;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === PRISMA_UNIQUE_VIOLATION
      ) {
        const existing = await this.prisma.messageReport.findUnique({
          where: {
            MessageReport_reporter_message_key: {
              reporter_id: reporterId,
              message_id: dto.messageId,
            },
          },
          select: { id: true },
        });
        if (existing) {
          return { reportId: existing.id, status: 'already_reported' };
        }
      }
      throw err;
    }

    // 4. Best-effort audit + analytics. Fire-and-forget so a write failure
    //    here never poisons the user-visible flow.
    void this.audit.write({
      action: 'safety.message_reported',
      actorId: reporterId,
      actorRole: 'student',
      targetUserId: msg.sender_id ?? undefined,
      targetType: 'coach_message',
      targetId: msg.id,
      tenantCoachId: msg.coach_id ?? undefined,
      metadata: {
        reason: dto.reason,
        has_details: !!dto.details,
      },
    });
    this.analytics.capture(reporterId, EVENT_REPORTED, {
      reason: dto.reason,
      message_id: msg.id,
      has_details: !!dto.details,
    });
    // B-REPORTALERT-125: a person is told about every new report (ids and the
    // reason only). reportFiled() never rejects, so the report always files.
    void this.reportAlerts?.reportFiled({
      kind: 'message',
      reportId: createdId,
      reason: dto.reason,
      createdAt,
      targetType: 'message',
      targetId: msg.id,
      details: dto.details,
    });

    return { reportId: createdId, status: 'received' };
  }

  // ─── Blocks ───────────────────────────────────────────────────────────────

  async blockUser(
    blockerId: string,
    blockedId: string,
  ): Promise<{ blockId: string; blockedUserId: string }> {
    if (blockerId === blockedId) {
      throw new BadRequestException({ error: 'CANNOT_BLOCK_SELF' });
    }
    // Validate target exists. Return 404 not 400 so attackers cannot use
    // this endpoint as a user-id enumeration oracle (404 on a real-but-
    // foreign user vs. 400 on a malformed id is the same surface as the
    // rest of the API).
    const target = await this.prisma.user.findUnique({
      where: { id: blockedId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException({ error: 'USER_NOT_FOUND' });

    // Idempotent insert via unique (blocker_id, blocked_id). Use try-create
    // / catch-P2002 / re-read so two concurrent double-tap blocks from the
    // same user against the same target both resolve cleanly to the
    // surviving row instead of one surfacing a 500.
    let created: { id: string };
    try {
      created = await this.prisma.userBlock.create({
        data: { blocker_id: blockerId, blocked_id: blockedId },
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === PRISMA_UNIQUE_VIOLATION
      ) {
        const existing = await this.prisma.userBlock.findUnique({
          where: {
            UserBlock_pair_key: {
              blocker_id: blockerId,
              blocked_id: blockedId,
            },
          },
          select: { id: true },
        });
        if (existing) {
          return { blockId: existing.id, blockedUserId: blockedId };
        }
      }
      throw err;
    }

    void this.audit.write({
      action: 'safety.user_blocked',
      actorId: blockerId,
      actorRole: 'student',
      targetUserId: blockedId,
      targetType: 'user_block',
      targetId: created.id,
    });
    this.analytics.capture(blockerId, EVENT_BLOCKED, {
      blocked_user_id: blockedId,
    });

    return { blockId: created.id, blockedUserId: blockedId };
  }

  async unblockUser(
    blockerId: string,
    blockedId: string,
  ): Promise<{ blockedUserId: string; unblocked: true }> {
    // deleteMany returns count=0 when nothing matched — Apple convention is
    // that unblock is idempotent (calling it twice should not error).
    const result = await this.prisma.userBlock.deleteMany({
      where: { blocker_id: blockerId, blocked_id: blockedId },
    });
    if (result.count > 0) {
      void this.audit.write({
        action: 'safety.user_unblocked',
        actorId: blockerId,
        actorRole: 'student',
        targetUserId: blockedId,
        targetType: 'user_block',
      });
      this.analytics.capture(blockerId, EVENT_UNBLOCKED, {
        blocked_user_id: blockedId,
      });
    }
    return { blockedUserId: blockedId, unblocked: true };
  }

  async listBlocks(blockerId: string): Promise<
    Array<{ blockedId: string; displayName: string; blockedAt: string }>
  > {
    const rows = await this.prisma.userBlock.findMany({
      where: { blocker_id: blockerId },
      orderBy: { created_at: 'desc' },
      select: {
        blocked_id: true,
        created_at: true,
        blocked: { select: { name: true, role: true } },
      },
    });
    return rows.map((r) => ({
      blockedId: r.blocked_id,
      displayName: blockedDisplayName(r.blocked),
      blockedAt: r.created_at.toISOString(),
    }));
  }

  /**
   * Internal helper for cross-module callers (messaging.service, push
   * fanout). Returns the ids the given user has blocked. Cheap query,
   * indexed by (blocker_id, created_at) — safe to call on every list /
   * push path.
   */
  async getBlockedIdsFor(blockerId: string): Promise<string[]> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blocker_id: blockerId },
      select: { blocked_id: true },
    });
    return rows.map((r) => r.blocked_id);
  }

  /**
   * Bidirectional check used by the push fanout: a notification for
   * `recipient` triggered by `sender` is suppressed when either side
   * has blocked the other. Single SQL query with `OR` so the call is
   * one round-trip.
   *
   * Note: in the current product (1:1 coach ↔ client DMs) only the
   * blocker → blocked direction matters for *content* suppression, but
   * the reverse direction matters for *push* suppression — if the
   * sender has blocked the recipient, we should not be paging them
   * about the recipient at all. Checking both is a small extra
   * predicate with no extra round-trip.
   */
  async isEitherSideBlocked(
    a: string,
    b: string,
  ): Promise<boolean> {
    if (!a || !b || a === b) return false;
    const hit = await this.prisma.userBlock.findFirst({
      where: {
        OR: [
          { blocker_id: a, blocked_id: b },
          { blocker_id: b, blocked_id: a },
        ],
      },
      select: { id: true },
    });
    return !!hit;
  }
}

/**
 * Re-export so messaging.service can type the safety dependency cleanly.
 */
export type { ReportReason };
