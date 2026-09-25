import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { AnalyticsService } from '../../analytics/analytics.service';
import { Events } from '../../analytics/events';
import { PrismaService } from '../../prisma.service';
import { buildFamilyRegistry } from '../reconstruct/families';
import { RECONSTRUCT_STATUS } from '../scout-reconstruct.dto';
import { SCOUT_TERMINAL_STATUSES, type ScoutTerminalStatus } from '../scout.dto';
import { arbitrate, type ArbiterVerdict, type LedgerTally } from './arbiter';
import type { ScoutRunCancelResult, ScoutRunStartResult } from './lifecycle.dto';
import {
  type FenceReason,
  isFenceReason,
  isRunReasonCode,
  isServerTerminalStatus,
  RUN_PHASES,
  type RunMode,
  type RunPhase,
  type RunReasonCode,
  runConflict,
  type ServerTerminalStatus,
} from './reason-codes';

/** Prisma transaction client — the interactive-transaction handle passed to $transaction. */
export type Tx = Prisma.TransactionClient;

/** Parent-frozen default deadline (D-S7L-3: PLAN "five minutes"). */
export const SCOUT_RUN_DEADLINE_MS_DEFAULT = 300_000;
/** Environment override of the deadline; must be a positive integer number of milliseconds. */
export const SCOUT_RUN_DEADLINE_MS_ENV = 'SCOUT_RUN_DEADLINE_MS';

/** RFC 4122 text form (any version, any variant nibble): the only strings that can name a server intent. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a writer's intent string resolved (§3.1 "Resolution of the intent string precedes the gate"). */
export type IntentResolution =
  | { mode: 'legacy' }
  | { mode: 'server'; intent: { id: string; paired_at: Date | null; superseded_at: Date | null } };

/** Why a gate returned zero rows, from the unlocked re-read (§3.1). */
export type ClosedRun =
  | { kind: 'not_started' }
  | { kind: 'fenced'; fence_reason: FenceReason | null; terminal_status: string | null };

/** The lifecycle columns of one run row as read by the projection and the arbiter callers. */
export interface RunRow {
  mode: string;
  import_intent_id: string | null;
  phase: string | null;
  accepted_start_at: Date | null;
  deadline_at: Date | null;
  last_observed_at: Date | null;
  execution_epoch: number;
  fenced_at: Date | null;
  fence_reason: string | null;
  reason_code: string | null;
  terminal_status: string | null;
  completed_at: Date | null;
  started_at: Date;
}

interface LockedRow {
  execution_epoch: number;
  terminal_status: string | null;
  fenced_at: Date | null;
  fence_reason: string | null;
  deadline_at: Date | null;
}

/** One `families[]` entry of the status read (decision §5). Native buckets are null = not yet known. */
export interface FamilyProjection {
  family: string;
  observed_unique: number | null;
  staged_unique: number;
  created_native: number | null;
  already_present_verified: number | null;
  rejected: number | null;
  unresolved: number | null;
  ledger: LedgerTally;
}

/** Thrown inside a writer's $transaction when the gate returns zero rows; the transaction rolls back. */
export class RunGateClosed extends Error {
  constructor() {
    super('scout run gate closed');
    this.name = 'RunGateClosed';
  }
}

/**
 * S7-L2 — the server-owned run lifecycle (docs/decisions/2026-09-24-s7l-run-lifecycle.md).
 *
 * Owns Start, cancel, fences, the §3.1 `assertRunOpen` gate every writer calls first, the lazy
 * deadline, the exactly-once terminal write (arbiter verdict under a CAS on the run row) and the
 * additive projection of the status read. It never touches a legacy run: a string that is not the
 * text of an owned `ImportIntent.id` resolves to `legacy` and every caller keeps its pre-S7-L
 * behaviour byte-identical (§7).
 *
 * Time is server-owned: `accepted_start_at` / `deadline_at` are written once at Start and never
 * updated (invariant 3, no UPDATE path here names them). The deadline is enforced lazily by the
 * lifecycle routes and writers only — there is no scheduler, cron or timer (D-S7L-3).
 *
 * Every timestamp written or compared in SQL is `now() AT TIME ZONE 'UTC'`: the columns are
 * `timestamp(3)` without time zone and the generated client stores UTC instants in them, so the
 * gate's `deadline_at > now()` (§3.1) is evaluated in the same frame regardless of the session
 * TimeZone setting.
 */
@Injectable()
export class ScoutLifecycleService {
  readonly deadlineMs: number;
  private readonly registry = buildFamilyRegistry();

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {
    this.deadlineMs = ScoutLifecycleService.readDeadlineMs(process.env[SCOUT_RUN_DEADLINE_MS_ENV]);
  }

  /** A positive integer number of milliseconds, else the parent-frozen default. */
  static readDeadlineMs(raw: string | undefined): number {
    if (raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw)) return SCOUT_RUN_DEADLINE_MS_DEFAULT;
    return Number(raw);
  }

  static isUuid(value: string): boolean {
    return UUID_RE.test(value);
  }

  // ── Resolution ───────────────────────────────────────────────────────────────

  /**
   * §3.1: a UUID that names an owned `ImportIntent` → server semantics apply; anything else
   * (legacy string, foreign UUID) → legacy path. Purely syntactic for non-UUIDs, so legacy callers
   * never touch the database here. A pre-S7-L row that already exists for that UUID with
   * `mode = 'legacy'` (an extension that used the setup intent id as its crawl id) stays legacy
   * (§7: no legacy row is ever re-owned).
   */
  async resolve(coachId: string, intentId: string): Promise<IntentResolution> {
    if (!ScoutLifecycleService.isUuid(intentId)) return { mode: 'legacy' };
    const [intent, existing] = await Promise.all([
      this.prisma.importIntent.findUnique({
        where: { id_coach_id: { id: intentId, coach_id: coachId } },
        select: { id: true, paired_at: true, superseded_at: true },
      }),
      this.prisma.scoutImport.findUnique({
        where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
        select: { mode: true },
      }),
    ]);
    if (!intent || existing?.mode === 'legacy') return { mode: 'legacy' };
    return { mode: 'server', intent };
  }

  // ── Start / cancel (decision §6) ─────────────────────────────────────────────

  /** Guard order (§3): owned → paired → not superseded → no terminal run → no open run. */
  async start(coachId: string, importIntentId: string): Promise<ScoutRunStartResult> {
    const intent = await this.prisma.importIntent.findUnique({
      where: { id_coach_id: { id: importIntentId, coach_id: coachId } },
      select: { id: true, paired_at: true, superseded_at: true },
    });
    if (!intent) throw new NotFoundException();
    if (intent.paired_at === null) throw runConflict('intent_not_paired');
    if (intent.superseded_at !== null) throw runConflict('intent_superseded');

    const intentId = intent.id;
    const existing = await this.readRun(coachId, intentId);
    if (existing) return this.startFromExisting(coachId, intentId, existing);

    const acceptedStartAt = new Date();
    const deadlineAt = new Date(acceptedStartAt.getTime() + this.deadlineMs);
    try {
      const created = await this.prisma.scoutImport.create({
        data: {
          coach_id: coachId,
          intent_id: intentId,
          mode: 'server',
          import_intent_id: intentId,
          phase: 'discovering',
          accepted_start_at: acceptedStartAt,
          deadline_at: deadlineAt,
          execution_epoch: 1,
        },
      });
      this.analytics.capture(coachId, Events.SCOUT_RUN_STARTED, { intent_id: intentId });
      return ScoutLifecycleService.startBody(intentId, created);
    } catch (err) {
      // The unique on import_intent_id (and on (coach_id, intent_id)) makes a Start race one row;
      // the loser re-reads and answers exactly like a duplicate Start.
      if (!(err instanceof PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      const raced = await this.readRun(coachId, intentId);
      if (!raced) throw err;
      return this.startFromExisting(coachId, intentId, raced);
    }
  }

  private async startFromExisting(
    coachId: string,
    intentId: string,
    row: RunRow,
  ): Promise<ScoutRunStartResult> {
    if (row.mode !== 'server') throw runConflict('legacy_run');
    if (row.terminal_status !== null || row.fenced_at !== null) throw runConflict('run_terminal');
    if (row.deadline_at !== null && row.deadline_at.getTime() <= Date.now()) {
      // Lazy deadline (D-S7L-3): fence first, then answer against the fenced row.
      await this.fence(coachId, intentId, 'timed_out');
      throw runConflict('run_terminal');
    }
    return ScoutLifecycleService.startBody(intentId, row);
  }

  private static startBody(
    intentId: string,
    row: Pick<RunRow, 'execution_epoch' | 'accepted_start_at' | 'deadline_at'>,
  ): ScoutRunStartResult {
    if (row.accepted_start_at === null || row.deadline_at === null) {
      // Unreachable for a mode='server' row (database mode-shape CHECK); fail closed, no repair.
      throw new Error('server run without a server-owned clock');
    }
    return {
      intent_id: intentId,
      mode: 'server',
      phase: 'discovering',
      execution_epoch: row.execution_epoch,
      accepted_start_at: row.accepted_start_at.toISOString(),
      deadline_at: row.deadline_at.toISOString(),
    };
  }

  /**
   * Cancel: idempotent when already cancelled; 409 `run_terminal` when another terminal holds;
   * 409 `legacy_run` for a legacy row; uniform 404 when no run exists for the calling coach.
   */
  async cancel(coachId: string, intentId: string): Promise<ScoutRunCancelResult> {
    const row = await this.readRun(coachId, intentId);
    if (!row) throw new NotFoundException();
    if (row.mode !== 'server') throw runConflict('legacy_run');
    if (row.terminal_status === 'cancelled') {
      return { intent_id: intentId, status: 'cancelled', execution_epoch: row.execution_epoch };
    }
    if (row.terminal_status !== null || row.fenced_at !== null) throw runConflict('run_terminal');
    if (row.deadline_at !== null && row.deadline_at.getTime() <= Date.now()) {
      await this.fence(coachId, intentId, 'timed_out');
      throw runConflict('run_terminal');
    }
    const fenced = await this.fence(coachId, intentId, 'cancelled');
    if (fenced) {
      return { intent_id: intentId, status: 'cancelled', execution_epoch: fenced.execution_epoch };
    }
    // CAS miss: another fence or the settle hook won the row between the read and the lock.
    const after = await this.readRun(coachId, intentId);
    if (after?.terminal_status === 'cancelled') {
      return { intent_id: intentId, status: 'cancelled', execution_epoch: after.execution_epoch };
    }
    throw runConflict('run_terminal');
  }

  // ── Fences and the terminal write (D-S7L-2, D-S7L-4) ─────────────────────────

  /**
   * Fence an open server run: lock the row (`FOR NO KEY UPDATE`), set `fenced_at`,
   * `fence_reason`, `execution_epoch + 1` under a CAS on the observed epoch, then let the arbiter
   * write the terminal in the same transaction. Returns null on a CAS miss (already fenced or
   * terminal) — not an error for idempotent callers. Exported for the G3 caller (`revoked`); S7-L
   * adds no route or principal for it (§8 L7).
   */
  async fence(
    coachId: string,
    intentId: string,
    reason: FenceReason,
  ): Promise<(ArbiterVerdict & { execution_epoch: number }) | null> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockRun(tx, coachId, intentId);
      if (!locked || locked.terminal_status !== null || locked.fenced_at !== null) return null;
      const seen = locked.execution_epoch;
      const fenced = await tx.$executeRaw`
        UPDATE "ScoutImport"
           SET fenced_at = (now() AT TIME ZONE 'UTC'), fence_reason = ${reason},
               execution_epoch = execution_epoch + 1
         WHERE coach_id = ${coachId} AND intent_id = ${intentId} AND mode = 'server'
           AND terminal_status IS NULL AND fenced_at IS NULL AND execution_epoch = ${seen}`;
      if (fenced !== 1) return null;
      const verdict = arbitrate({
        fence: reason,
        claim: null,
        staged_by_family: {},
        ledger_by_family: {},
        unmapped_families: [],
        reconciliation: null,
      });
      const written = await this.writeTerminal(tx, coachId, intentId, seen + 1, verdict);
      if (!written) return null;
      return { ...verdict, execution_epoch: seen + 1 };
    });
    if (outcome) {
      this.analytics.capture(coachId, Events.SCOUT_RUN_FENCED, {
        intent_id: intentId,
        fence_reason: reason,
        terminal_status: outcome.terminal_status,
        execution_epoch: outcome.execution_epoch,
      });
    }
    return outcome;
  }

  /**
   * §3 `onTransferSettled`: the accepted `/complete` hands the run to the arbiter. S7-L arbitrates
   * immediately under a CAS on the epoch the settle observed; S8-G replaces this body with
   * reconstruct-then-arbitrate and keeps the CAS. A miss (a fence won) is not an error.
   */
  async onTransferSettled(coachId: string, intentId: string, epoch: number): Promise<void> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockRun(tx, coachId, intentId);
      if (!locked || locked.terminal_status !== null || locked.execution_epoch !== epoch) {
        return null;
      }
      const facts = await this.collectFacts(tx, coachId, intentId);
      const fence =
        locked.fenced_at !== null && isFenceReason(locked.fence_reason)
          ? locked.fence_reason
          : null;
      const verdict = arbitrate({ fence, reconciliation: null, ...facts });
      const written = await this.writeTerminal(tx, coachId, intentId, epoch, verdict);
      return written ? verdict : null;
    });
    if (outcome) {
      this.analytics.capture(coachId, Events.SCOUT_RUN_SETTLED, {
        intent_id: intentId,
        terminal_status: outcome.terminal_status,
        reason_code: outcome.reason_code,
      });
    }
  }

  private async lockRun(tx: Tx, coachId: string, intentId: string): Promise<LockedRow | null> {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT execution_epoch, terminal_status, fenced_at, fence_reason, deadline_at
        FROM "ScoutImport"
       WHERE coach_id = ${coachId} AND intent_id = ${intentId} AND mode = 'server'
       FOR NO KEY UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * The ONE terminal write (invariant 1): CAS on `terminal_status IS NULL` and the epoch; `state`
   * mirrors `terminal_status`; `completed_at` is set exactly once (COALESCE keeps an earlier value).
   */
  private async writeTerminal(
    tx: Tx,
    coachId: string,
    intentId: string,
    epoch: number,
    verdict: ArbiterVerdict,
  ): Promise<boolean> {
    const written = await tx.$executeRaw`
      UPDATE "ScoutImport"
         SET terminal_status = ${verdict.terminal_status}, state = ${verdict.terminal_status},
             reason_code = ${verdict.reason_code},
             completed_at = COALESCE(completed_at, (now() AT TIME ZONE 'UTC'))
       WHERE coach_id = ${coachId} AND intent_id = ${intentId} AND mode = 'server'
         AND terminal_status IS NULL AND execution_epoch = ${epoch}`;
    return written === 1;
  }

  /** The arbiter's facts for one run: the stored claim, staged rows and ledger tallies per family. */
  private async collectFacts(tx: Tx, coachId: string, intentId: string) {
    const [completion, staged, ledger] = await Promise.all([
      tx.scoutImportCompletion.findUnique({
        where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
        select: { terminal_status: true },
      }),
      tx.scoutIngestEntity.groupBy({
        by: ['entity_type'],
        where: { coach_id: coachId, intent_id: intentId },
        _count: { _all: true },
      }),
      tx.scoutReconstructionLedger.groupBy({
        by: ['entity_type', 'status'],
        where: { coach_id: coachId, intent_id: intentId },
        _count: { _all: true },
      }),
    ]);
    const staged_by_family: Record<string, number> = {};
    for (const g of staged) staged_by_family[g.entity_type] = g._count._all;
    const claim = completion?.terminal_status ?? null;
    return {
      claim: ScoutLifecycleService.isLegacyTerminal(claim) ? claim : null,
      staged_by_family,
      ledger_by_family: ScoutLifecycleService.tallyLedger(ledger),
      unmapped_families: Object.keys(staged_by_family).filter((f) => !this.registry.has(f)),
    };
  }

  static tallyLedger(
    rows: readonly { entity_type: string; status: string; _count: { _all: number } }[],
  ): Record<string, LedgerTally> {
    const out: Record<string, LedgerTally> = {};
    for (const row of rows) {
      const tally = (out[row.entity_type] ??= { reconstructed: 0, skipped: 0, failed: 0 });
      if (row.status === RECONSTRUCT_STATUS.reconstructed) tally.reconstructed += row._count._all;
      else if (row.status === RECONSTRUCT_STATUS.skipped) tally.skipped += row._count._all;
      else if (row.status === RECONSTRUCT_STATUS.failed) tally.failed += row._count._all;
    }
    return out;
  }

  private static isLegacyTerminal(value: string | null): value is ScoutTerminalStatus {
    return value !== null && (SCOUT_TERMINAL_STATUSES as readonly string[]).includes(value);
  }

  // ── The writer gate (§3.1) ───────────────────────────────────────────────────

  /**
   * `assertRunOpen`: the writer's FIRST statement inside its own transaction and itself the row
   * lock (an UPDATE, never `FOR SHARE`, so two writers on one run serialize instead of deadlocking
   * with 40P01). One row → the run is open; the writer carries the returned epoch into its CAS and
   * holds the lock to commit. Zero rows → returns null and the caller MUST roll back (throw
   * `RunGateClosed` out of the transaction) and then `classifyClosed`.
   */
  async assertRunOpen(tx: Tx, coachId: string, intentId: string): Promise<number | null> {
    const rows = await tx.$queryRaw<{ execution_epoch: number }[]>`
      UPDATE "ScoutImport"
         SET last_observed_at = (now() AT TIME ZONE 'UTC'),
             phase = CASE WHEN phase = 'discovering' THEN 'transferring' ELSE phase END
       WHERE coach_id = ${coachId} AND intent_id = ${intentId} AND mode = 'server'
         AND terminal_status IS NULL AND fenced_at IS NULL
         AND deadline_at > (now() AT TIME ZONE 'UTC')
      RETURNING execution_epoch`;
    return rows.length === 1 ? rows[0].execution_epoch : null;
  }

  /**
   * After a zero-row gate (the writer's transaction already rolled back): re-read unlocked and
   * classify. No row → `run_not_started`. Fenced or terminal → `run_fenced`. Open but past its
   * deadline → fence `timed_out` in a short transaction of our own (the row is free: the
   * triggering writer released it), then `run_fenced`.
   */
  async classifyClosed(coachId: string, intentId: string): Promise<ClosedRun> {
    const row = await this.readRun(coachId, intentId);
    if (!row || row.mode !== 'server') return { kind: 'not_started' };
    if (row.terminal_status === null && row.fenced_at === null) {
      const fenced = await this.fence(coachId, intentId, 'timed_out');
      if (fenced) {
        return {
          kind: 'fenced',
          fence_reason: 'timed_out',
          terminal_status: fenced.terminal_status,
        };
      }
      const after = await this.readRun(coachId, intentId);
      const reason = after?.fence_reason ?? null;
      return {
        kind: 'fenced',
        fence_reason: isFenceReason(reason) ? reason : null,
        terminal_status: after?.terminal_status ?? null,
      };
    }
    return {
      kind: 'fenced',
      fence_reason: isFenceReason(row.fence_reason) ? row.fence_reason : null,
      terminal_status: row.terminal_status,
    };
  }

  /** The 409 a writer raises for a closed gate (§3: `run_not_started` | `run_fenced` + fence_reason). */
  static closedConflict(closed: ClosedRun) {
    return closed.kind === 'not_started'
      ? runConflict('run_not_started')
      : runConflict('run_fenced', closed.fence_reason ?? undefined);
  }

  /**
   * Lazy deadline for the status read (D-S7L-3): an open server run past `deadline_at` is fenced
   * `timed_out` before the read projects it. Reads of legacy rows never reach here.
   */
  async enforceDeadline(coachId: string, intentId: string, row: RunRow): Promise<RunRow> {
    if (
      row.mode !== 'server' ||
      row.terminal_status !== null ||
      row.fenced_at !== null ||
      row.deadline_at === null ||
      row.deadline_at.getTime() > Date.now()
    ) {
      return row;
    }
    await this.fence(coachId, intentId, 'timed_out');
    return (await this.readRun(coachId, intentId)) ?? row;
  }

  // ── Reads and projection (decision §5) ───────────────────────────────────────

  async readRun(coachId: string, intentId: string): Promise<RunRow | null> {
    return this.prisma.scoutImport.findUnique({
      where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
      select: {
        mode: true,
        import_intent_id: true,
        phase: true,
        accepted_start_at: true,
        deadline_at: true,
        last_observed_at: true,
        execution_epoch: true,
        fenced_at: true,
        fence_reason: true,
        reason_code: true,
        terminal_status: true,
        completed_at: true,
        started_at: true,
      },
    });
  }

  /** The extension's stored claim for a server run (`claimed_status`), or null when none. */
  async readClaim(coachId: string, intentId: string): Promise<ScoutTerminalStatus | null> {
    const completion = await this.prisma.scoutImportCompletion.findUnique({
      where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
      select: { terminal_status: true },
    });
    const claim = completion?.terminal_status ?? null;
    return ScoutLifecycleService.isLegacyTerminal(claim) ? claim : null;
  }

  /** Ledger tallies per family for the projection (outside any transaction). */
  async readLedger(coachId: string, intentId: string): Promise<Record<string, LedgerTally>> {
    const rows = await this.prisma.scoutReconstructionLedger.groupBy({
      by: ['entity_type', 'status'],
      where: { coach_id: coachId, intent_id: intentId },
      _count: { _all: true },
    });
    return ScoutLifecycleService.tallyLedger(rows);
  }

  /**
   * `families[]`: `staged_unique` is the distinct `(source_platform, source_id)` count per family
   * — exactly the staged row count, because the wide identity
   * (coach_id, intent_id, entity_type, source_platform, source_id) is the table's only key (G2-C).
   * Native buckets stay null = "not yet known" (never 0) until S8-B provenance / S9;
   * `observed_unique` stays null until S10.
   */
  static projectFamilies(
    staged: readonly { entity_type: string; _count: { _all: number } }[],
    ledger: Readonly<Record<string, LedgerTally>>,
  ): FamilyProjection[] {
    const families = new Set<string>([...staged.map((g) => g.entity_type), ...Object.keys(ledger)]);
    return Array.from(families)
      .sort((a, b) => a.localeCompare(b))
      .map((family) => ({
        family,
        observed_unique: null,
        staged_unique: staged.find((g) => g.entity_type === family)?._count._all ?? 0,
        created_native: null,
        already_present_verified: null,
        rejected: null,
        unresolved: null,
        ledger: ledger[family] ?? { reconstructed: 0, skipped: 0, failed: 0 },
      }));
  }

  /** Narrowed lifecycle columns for the read surface; unknown persisted values project as null. */
  static projectLifecycle(row: RunRow | null) {
    const mode: RunMode = row?.mode === 'server' ? 'server' : 'legacy';
    const phase: RunPhase | null =
      row && (RUN_PHASES as readonly string[]).includes(row.phase ?? '')
        ? (row.phase as RunPhase)
        : null;
    const reason: RunReasonCode | null =
      row && isRunReasonCode(row.reason_code) ? row.reason_code : null;
    return {
      mode,
      phase,
      accepted_start_at: row?.accepted_start_at?.toISOString() ?? null,
      deadline_at: row?.deadline_at?.toISOString() ?? null,
      last_observed_at: row?.last_observed_at?.toISOString() ?? null,
      execution_epoch: row?.execution_epoch ?? 1,
      reason_code: reason,
    };
  }

  /** Server terminal vocabulary guard for the projection (legacy rows keep the legacy rule). */
  static serverTerminal(value: string | null): ServerTerminalStatus | null {
    return isServerTerminalStatus(value) ? value : null;
  }
}
