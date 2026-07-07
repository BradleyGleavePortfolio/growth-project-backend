import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { ScoutCompleteDto, ScoutProgressDto } from './scout.dto';

/** How often the in-process progress cache is flushed to Postgres (ms). */
export const SCOUT_PROGRESS_FLUSH_MS = 5_000;

/** A pending snapshot held in memory until the next flush. */
interface CachedSnapshot {
  coachId: string;
  intentId: string;
  snapshot: Prisma.InputJsonValue;
  lastError: string | null;
}

/**
 * IMPORTER-E — cross-device progress mirroring + terminal completion for the
 * tgp-importer Chrome extension (DESIGN.md v0.3 §10 + §2 step 11).
 *
 * Progress is a HOT path: the worker posts a snapshot on every batch commit.
 * To keep that path cheap we coalesce snapshots in an in-process Map keyed by
 * `${coachId}:${intentId}` (only the latest matters — this is an upsert, not
 * an append) and flush the dirty set to Postgres on a timer. A burst of N
 * commits for one import collapses to a single upsert per flush window.
 *
 * Completion is the COLD path and must be exactly-once: the ScoutImportCompletion
 * @@unique([coach_id, intent_id]) is the idempotency anchor. The first call
 * inserts, notifies the coach, and emits analytics; a retry after a network
 * flake loses the insert race (P2002) and is a silent no-op so the coach is
 * never double-notified.
 */
@Injectable()
export class ScoutService implements OnModuleDestroy {
  private readonly logger = new Logger(ScoutService.name);

  /** Coalesced latest-snapshot-per-import cache; drained by flush(). */
  private readonly pending = new Map<string, CachedSnapshot>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
  ) {}

  private static key(coachId: string, intentId: string): string {
    return `${coachId}:${intentId}`;
  }

  /**
   * Hot path for POST /api/scout/progress. Records the latest snapshot for
   * (coachId, intent_id) in memory and returns immediately — no DB write on
   * the request. The snapshot is persisted on the next flush tick.
   */
  recordProgress(coachId: string, dto: ScoutProgressDto): void {
    const snapshot: Prisma.InputJsonValue = {
      intent_id: dto.intent_id,
      progress: dto.progress.map((p) => ({
        entity_type: p.entity_type,
        count_committed: p.count_committed,
        total_estimated: p.total_estimated,
      })),
    };
    this.pending.set(ScoutService.key(coachId, dto.intent_id), {
      coachId,
      intentId: dto.intent_id,
      snapshot,
      lastError: dto.lastError ?? null,
    });
  }

  /**
   * Drain the in-process cache to Postgres. One upsert per dirty import.
   * Snapshots can arrive before the first ingest batch for an import, so there
   * is no foreign key to any ingest row — the upsert always succeeds.
   */
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = Array.from(this.pending.values());
    this.pending.clear();

    for (const item of batch) {
      try {
        await this.prisma.scoutProgressSnapshot.upsert({
          where: {
            coach_id_intent_id: {
              coach_id: item.coachId,
              intent_id: item.intentId,
            },
          },
          create: {
            coach_id: item.coachId,
            intent_id: item.intentId,
            snapshot: item.snapshot,
            last_error: item.lastError,
          },
          update: {
            snapshot: item.snapshot,
            last_error: item.lastError,
          },
        });
      } catch (err) {
        // Re-queue the failed snapshot so a transient DB blip does not drop
        // progress — unless a newer snapshot for the same import already
        // landed in the cache while we were flushing (that one is fresher).
        const key = ScoutService.key(item.coachId, item.intentId);
        if (!this.pending.has(key)) this.pending.set(key, item);
        this.logger.warn(
          `scout progress flush failed for ${key}: ${err instanceof Error ? err.name : 'unknown'}`,
        );
      }
    }
  }

  @Interval('scout-progress-flush', SCOUT_PROGRESS_FLUSH_MS)
  async flushTick(): Promise<void> {
    await this.flush();
  }

  /** Drain anything still cached when the process shuts down. */
  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  /**
   * Cold path for POST /api/scout/ingest/complete. Idempotent per
   * (coachId, intent_id): the first call settles the import and notifies the
   * coach; repeated calls are acknowledged no-ops.
   */
  async complete(
    coachId: string,
    dto: ScoutCompleteDto,
  ): Promise<{ acknowledged: true; intent_id: string }> {
    // Flush any in-flight progress for this import first so the persisted
    // snapshot reflects the final committed counts before we settle.
    await this.flush();

    let firstTime: boolean;
    try {
      await this.prisma.scoutImportCompletion.create({
        data: {
          coach_id: coachId,
          intent_id: dto.intent_id,
          terminal_status: dto.terminal_status,
          final_counts: (dto.final_counts ?? undefined) as Prisma.InputJsonValue | undefined,
          error_summary: dto.error_summary,
        },
      });
      firstTime = true;
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        firstTime = false;
      } else {
        throw err;
      }
    }

    if (firstTime) {
      await this.notifyComplete(coachId, dto);
      this.analytics.capture(coachId, Events.SCOUT_INGEST_COMPLETED, {
        intent_id: dto.intent_id,
        terminal_status: dto.terminal_status,
      });
    }

    return { acknowledged: true, intent_id: dto.intent_id };
  }

  /** Fire the mobile `import.complete` push. Best-effort — never throws. */
  private async notifyComplete(coachId: string, dto: ScoutCompleteDto): Promise<void> {
    const title =
      dto.terminal_status === 'success' ? 'Import complete' : 'Import finished with issues';
    const body =
      dto.terminal_status === 'success'
        ? 'Your data has finished importing into The Growth Project.'
        : 'Your import finished, but some items could not be transferred.';
    try {
      await this.notifications.pushToUser(coachId, title, body, {
        kind: 'import.complete',
        intent_id: dto.intent_id,
        terminal_status: dto.terminal_status,
      });
    } catch (err) {
      this.logger.warn(
        `import.complete push failed for coach ${coachId}: ${
          err instanceof Error ? err.name : 'unknown'
        }`,
      );
    }
  }
}
