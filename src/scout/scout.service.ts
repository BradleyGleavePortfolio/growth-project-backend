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

  /**
   * Coalesced latest-snapshot-per-import cache; a snapshot stays authoritative
   * here until its own write commits, so a concurrent read never sees a gap.
   * Keyed by storageKey `${coachId}:${intentId}:${deviceId}`.
   */
  private readonly pending = new Map<string, CachedSnapshot>();

  /**
   * runKey `${coachId}:${intentId}` -> the set of storageKeys pending for that
   * one run. Lets a read flush ONLY its own run's keys (tenant + intent scoped)
   * instead of draining every tenant's backlog.
   */
  private readonly runKeys = new Map<string, Set<string>>();

  /**
   * storageKey -> the in-flight write for that key. Single-flight ownership: a
   * second flush/read for a key already being written joins the same promise
   * rather than issuing a duplicate upsert, so concurrent reads during a
   * requested-key persist cannot race into a false 404 or a double write.
   */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
  ) {}

  private static storageKey(coachId: string, intentId: string, deviceId: string): string {
    return `${coachId}:${intentId}:${deviceId}`;
  }

  private static runKey(coachId: string, intentId: string): string {
    return `${coachId}:${intentId}`;
  }

  private indexAdd(coachId: string, intentId: string, storageKey: string): void {
    const rk = ScoutService.runKey(coachId, intentId);
    let set = this.runKeys.get(rk);
    if (!set) {
      set = new Set<string>();
      this.runKeys.set(rk, set);
    }
    set.add(storageKey);
  }

  private indexRemove(coachId: string, intentId: string, storageKey: string): void {
    const rk = ScoutService.runKey(coachId, intentId);
    const set = this.runKeys.get(rk);
    if (!set) return;
    set.delete(storageKey);
    if (set.size === 0) this.runKeys.delete(rk);
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
    const sk = ScoutService.storageKey(coachId, dto.intent_id, dto.deviceId);
    this.pending.set(sk, {
      coachId,
      intentId: dto.intent_id,
      deviceId: dto.deviceId,
      snapshot,
      lastError: dto.lastError ?? null,
    });
    this.indexAdd(coachId, dto.intent_id, sk);
  }

  /**
   * Persist exactly one storageKey under single-flight ownership. A concurrent
   * caller for the same key joins the in-flight write instead of issuing a
   * second upsert. The pending entry stays authoritative until the write
   * commits, so a read observing this key mid-write still sees the snapshot.
   * The returned promise REJECTS if the write fails, so callers that must fail
   * closed (a requested-key read) can surface the failure rather than a false
   * "not found".
   */
  private persistKey(sk: string): Promise<void> {
    const existing = this.inFlight.get(sk);
    if (existing) return existing;
    const item = this.pending.get(sk);
    if (!item) return Promise.resolve();
    const write = this.writeSnapshot(sk, item).finally(() => {
      if (this.inFlight.get(sk) === write) this.inFlight.delete(sk);
    });
    this.inFlight.set(sk, write);
    return write;
  }

  /**
   * Upsert one snapshot, then retire it from the cache ONLY if it is still the
   * latest for its key — a fresher snapshot that arrived mid-write wins and is
   * left pending for the next persist. Throws on a DB failure, leaving the item
   * pending so the write is retried (and so a fail-closed caller can observe the
   * failure). Snapshots can arrive before the first ingest batch, so there is no
   * foreign key to any ingest row — the upsert stands alone.
   */
  private async writeSnapshot(sk: string, item: CachedSnapshot): Promise<void> {
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
    if (this.pending.get(sk) === item) {
      this.pending.delete(sk);
      this.indexRemove(item.coachId, item.intentId, sk);
    }
  }

  /**
   * Best-effort drain of the whole cache — the timer/shutdown path. Each key is
   * persisted under single-flight; a per-key failure is logged and the item is
   * left pending for the next tick, never aborting the other keys.
   */
  async flush(): Promise<void> {
    const keys = Array.from(this.pending.keys());
    await Promise.all(
      keys.map((sk) =>
        this.persistKey(sk).catch((err) => {
          this.logger.warn(
            `scout progress flush failed for ${sk}: ${err instanceof Error ? err.name : 'unknown'}`,
          );
        }),
      ),
    );
  }

  /**
   * Drain ONLY the keys belonging to one (coachId, intentId) run. Used by the
   * settle and read paths so neither touches an unrelated tenant's backlog nor
   * pays O(global backlog) latency. Unlike flush() this PROPAGATES a write
   * failure so a requested-key read fails closed (5xx) instead of returning a
   * misleading 404 for a run whose accepted snapshot could not be persisted.
   */
  private async flushRun(coachId: string, intentId: string): Promise<void> {
    const set = this.runKeys.get(ScoutService.runKey(coachId, intentId));
    if (!set || set.size === 0) return;
    await Promise.all(Array.from(set).map((sk) => this.persistKey(sk)));
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
    // Flush only THIS run's in-flight progress first so the persisted snapshot
    // reflects the final committed counts before we settle — without draining
    // (or blocking on) other tenants' backlog.
    await this.flushRun(coachId, dto.intent_id);

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
   * estimates. Scoped by `coachId` so unknown OR cross-tenant intents both 404.
   *
   * NOT a pure read: it first performs a bounded, single-flight persist of ONLY
   * this run's own pending snapshot (flushRun) — the same handoff complete()
   * runs — so a genuinely running import whose snapshot the extension has POSTed
   * but that has not yet hit its 5s flush tick is recognised instead of 404'd on
   * the accepted-but-unflushed window. The write touches only this (coach,
   * intent)'s key(s), never another tenant's backlog, and is idempotent. If that
   * requested-key write fails the read FAILS CLOSED (the error propagates → 5xx),
   * never a misleading 404. After a clean drain the residual 404 is truthful:
   * there is no committed entity, persisted snapshot, or settle row to recognise. */
  async getImportStatus(coachId: string, intentId: string): Promise<ScoutImportStatusResult> {
    await this.flushRun(coachId, intentId);

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
