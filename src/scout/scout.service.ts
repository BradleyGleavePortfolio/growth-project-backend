import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import {
  ScoutCompleteDto,
  ScoutImportStatusResult,
  ScoutProgressDto,
  ScoutReadStatus,
  SCOUT_TERMINAL_STATUSES,
  ScoutTerminalStatus,
} from './scout.dto';

/** How often the in-process progress cache is flushed to Postgres (ms). */
export const SCOUT_PROGRESS_FLUSH_MS = 5_000;

/** A pending snapshot held in memory until the next flush. */
interface CachedSnapshot {
  coachId: string;
  intentId: string;
  deviceId: string;
  snapshot: Prisma.InputJsonValue;
  lastError: string | null;
}

/**
 * IMPORTER-E — cross-device progress mirroring + terminal completion for the
 * tgp-importer Chrome extension (DESIGN.md v0.3 §10 + §2 step 11).
 *
 * Progress is a HOT path: the worker posts a snapshot on every batch commit.
 * To keep that path cheap we coalesce snapshots in an in-process Map keyed by
 * `${coachId}:${intentId}:${deviceId}` (only the latest matters — this is an
 * upsert, not an append) and flush the dirty set to Postgres on a timer. A
 * burst of N commits for one import collapses to a single upsert per flush
 * window. device_id is part of the key so a coach mirroring one import from two
 * physical devices at once (laptop + phone) keeps two independent snapshots
 * instead of overwriting each other.
 *
 * Completion is the COLD path and must be exactly-once AND state-owning
 * (R-STATE-1): the first call atomically flips the parent ScoutImport row to
 * its terminal state AND appends the ScoutImportCompletion ledger row in one
 * $transaction, then notifies the coach and emits analytics. The ledger's
 * @@unique([coach_id, intent_id]) is the idempotency anchor — a retry after a
 * network flake loses the insert race (P2002), the whole transaction rolls
 * back (so the state is never re-flipped), and the call is a silent no-op so
 * the coach is never double-notified.
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

  private static key(coachId: string, intentId: string, deviceId: string): string {
    return `${coachId}:${intentId}:${deviceId}`;
  }

  /**
   * Hot path for POST /api/scout/progress. Records the latest snapshot for
   * (coachId, intent_id, device_id) in memory and returns immediately — no DB
   * write on the request. The snapshot is persisted on the next flush tick.
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
    this.pending.set(ScoutService.key(coachId, dto.intent_id, dto.deviceId), {
      coachId,
      intentId: dto.intent_id,
      deviceId: dto.deviceId,
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
            coach_id_intent_id_device_id: {
              coach_id: item.coachId,
              intent_id: item.intentId,
              device_id: item.deviceId,
            },
          },
          create: {
            coach_id: item.coachId,
            intent_id: item.intentId,
            device_id: item.deviceId,
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
        const key = ScoutService.key(item.coachId, item.intentId, item.deviceId);
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
   * (coachId, intent_id) and state-owning (R-STATE-1): the first call flips the
   * parent ScoutImport row to its terminal state AND appends the completion
   * ledger row in a single transaction, then notifies the coach. Repeated calls
   * are acknowledged no-ops — the transaction rolls back on the ledger's unique
   * constraint, so the state is never re-flipped and no second push fires.
   */
  async complete(
    coachId: string,
    dto: ScoutCompleteDto,
  ): Promise<{ acknowledged: true; intent_id: string }> {
    // Flush any in-flight progress for this import first so the persisted
    // snapshot reflects the final committed counts before we settle.
    await this.flush();

    const now = new Date();
    let firstTime: boolean;
    try {
      // Ledger insert is FIRST in the batch so a duplicate settle aborts the
      // transaction (P2002) before the state upsert can re-flip anything.
      await this.prisma.$transaction([
        this.prisma.scoutImportCompletion.create({
          data: {
            coach_id: coachId,
            intent_id: dto.intent_id,
            terminal_status: dto.terminal_status,
            final_counts: (dto.final_counts ?? undefined) as Prisma.InputJsonValue | undefined,
            error_summary: dto.error_summary,
          },
        }),
        this.prisma.scoutImport.upsert({
          where: {
            coach_id_intent_id: { coach_id: coachId, intent_id: dto.intent_id },
          },
          create: {
            coach_id: coachId,
            intent_id: dto.intent_id,
            state: dto.terminal_status,
            terminal_status: dto.terminal_status,
            completed_at: now,
          },
          update: {
            state: dto.terminal_status,
            terminal_status: dto.terminal_status,
            completed_at: now,
          },
        }),
      ]);
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

  /** Evidence-only read for GET /api/scout/import/status: settled state verbatim
   * or `running` derived from present evidence; counts are persisted rows, not
   * estimates. Scoped by `coachId` so unknown OR cross-tenant intents both 404. */
  async getImportStatus(coachId: string, intentId: string): Promise<ScoutImportStatusResult> {
    // Persist any in-flight progress first (same drain complete() runs before it
    // settles). A snapshot the extension has already POSTed sits in the in-process
    // cache for up to one flush window; without this drain a genuinely running
    // import that has only just started would 404 despite the backend having
    // accepted its progress. After the drain the residual 404 is truthful: there
    // is no committed entity, persisted snapshot, or settle row to recognise.
    await this.flush();

    const [importRow, grouped, snapshot] = await Promise.all([
      this.prisma.scoutImport.findUnique({
        where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
      }),
      // _min.created_at rides the same grouped read (no extra query): the
      // immutable first-commit timestamp per entity family.
      this.prisma.scoutIngestEntity.groupBy({
        by: ['entity_type'],
        where: { coach_id: coachId, intent_id: intentId },
        _count: { _all: true },
        _min: { created_at: true },
      }),
      this.prisma.scoutProgressSnapshot.findFirst({
        where: { coach_id: coachId, intent_id: intentId },
        orderBy: { updated_at: 'desc' },
      }),
    ]);
    if (!importRow && grouped.length === 0 && !snapshot) throw new NotFoundException();

    const status = this.projectReadStatus(coachId, intentId, importRow?.terminal_status ?? null);
    const settled = status !== 'running';

    // Stable first observation: earliest committed entity; the lifecycle start
    // and latest snapshot are ordered fallbacks used only when none exists yet.
    const firstCommittedAt = grouped.reduce<Date | null>((earliest, g) => {
      const at = g._min.created_at;
      return at && (!earliest || at < earliest) ? at : earliest;
    }, null);

    this.analytics.capture(coachId, Events.SCOUT_IMPORT_STATUS_READ, {
      intent_id: intentId,
      status,
    });
    return {
      intent_id: intentId,
      status,
      entity_counts: grouped
        .map((g) => ({ entity_type: g.entity_type, committed: g._count._all }))
        .sort((a, b) => a.entity_type.localeCompare(b.entity_type)),
      started_at:
        firstCommittedAt?.toISOString() ??
        importRow?.started_at.toISOString() ??
        snapshot?.updated_at.toISOString() ??
        null,
      completed_at: settled ? (importRow?.completed_at?.toISOString() ?? null) : null,
    };
  }

  /**
   * Lifecycle projection: `running` when no terminal_status is set, the settled
   * status verbatim when recognised, else a fail-closed `failed` for a corrupt
   * (unrecognised) settled value — never reported as still `running`. The bad
   * value is recorded as a RED signal, never returned (no internals or PII).
   */
  private projectReadStatus(
    coachId: string,
    intentId: string,
    terminalStatus: string | null,
  ): ScoutReadStatus {
    if (terminalStatus === null) return 'running';
    if (ScoutService.isTerminalStatus(terminalStatus)) return terminalStatus;
    this.logger.error(
      `scout import ${intentId} has an unrecognised persisted terminal_status; ` +
        "failing closed to 'failed'",
    );
    this.analytics.capture(coachId, Events.SCOUT_IMPORT_STATUS_INVALID, { intent_id: intentId });
    return 'failed';
  }

  private static isTerminalStatus(value: string | null): value is ScoutTerminalStatus {
    return value !== null && (SCOUT_TERMINAL_STATUSES as readonly string[]).includes(value);
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
