/**
 * Roman transcript retention (owner ruling 2026-09-30 17:42 PDT).
 *
 * Roman conversations are persisted server-side (RomanSession / RomanMessage)
 * and are visible ONLY to the client who wrote them (owner-self RLS, owner-self
 * controller) and to developers with direct database access. No coach,
 * sub-coach or admin surface returns transcript content.
 *
 * Retention: 180 days, then auto-delete (session hard delete cascades to
 * RomanMessage via FK ON DELETE CASCADE, plus a message-level sweep by
 * created_at). A session the client deleted (DELETE /roman/sessions/:id
 * removes its messages immediately and sets `deleted_at`) has its shell
 * hard-deleted on the next run.
 *
 * Runs daily at 04:11 UTC in batches; never logs transcript content.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';

export const ROMAN_TRANSCRIPT_RETENTION_DAYS = 180;
export const ROMAN_RETENTION_BATCH_SIZE = 200;
export const ROMAN_RETENTION_MAX_BATCHES = 50;

export interface RomanRetentionResult {
  expired_sessions_deleted: number;
  client_deleted_sessions_purged: number;
  /** Messages older than the cutoff whose session was still live (defence in depth). */
  expired_messages_deleted: number;
  cutoff: string;
}

@Injectable()
export class RomanRetentionService {
  private readonly logger = new Logger(RomanRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('11 4 * * *', { name: 'roman-transcript-retention', timeZone: 'UTC' })
  async tick(): Promise<void> {
    try {
      const r = await this.run();
      if (
        r.expired_sessions_deleted + r.client_deleted_sessions_purged + r.expired_messages_deleted >
        0
      ) {
        this.logger.log(
          `RomanRetention: deleted ${r.expired_sessions_deleted} expired session(s), ` +
            `purged ${r.client_deleted_sessions_purged} client-deleted session(s), ` +
            `deleted ${r.expired_messages_deleted} expired message(s) (cutoff ${r.cutoff})`,
        );
      }
    } catch (err) {
      this.logger.error(
        `RomanRetention tick crashed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  /** Hard-delete expired and client-deleted sessions (messages cascade). */
  async run(now: Date = new Date()): Promise<RomanRetentionResult> {
    const cutoff = new Date(
      now.getTime() - ROMAN_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    let expired = 0;
    let purged = 0;
    for (let i = 0; i < ROMAN_RETENTION_MAX_BATCHES; i += 1) {
      const rows = await this.prisma.romanSession.findMany({
        where: {
          OR: [{ last_activity_at: { lt: cutoff } }, { deleted_at: { not: null } }],
        },
        orderBy: { last_activity_at: 'asc' },
        take: ROMAN_RETENTION_BATCH_SIZE,
        select: { id: true, deleted_at: true, last_activity_at: true },
      });
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      await this.prisma.romanSession.deleteMany({ where: { id: { in: ids } } });
      for (const r of rows) {
        if (r.deleted_at) purged += 1;
        else if (r.last_activity_at < cutoff) expired += 1;
      }
      if (rows.length < ROMAN_RETENTION_BATCH_SIZE) break;
    }
    // Defence in depth: any message row older than the cutoff whose session
    // somehow stayed live (sessions are per day, so this is normally zero).
    const msgs = await this.prisma.romanMessage.deleteMany({
      where: { created_at: { lt: cutoff } },
    });
    return {
      expired_sessions_deleted: expired,
      client_deleted_sessions_purged: purged,
      expired_messages_deleted: msgs.count,
      cutoff: cutoff.toISOString(),
    };
  }
}
