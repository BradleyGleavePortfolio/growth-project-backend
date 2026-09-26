import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { AnalyticsService } from '../../analytics/analytics.service';
import { Events } from '../../analytics/events';
import { PrismaService } from '../../prisma.service';
import { ReconciliationFactsService, type RunBinding } from '../reconciliation/facts.service';
import { reconcile } from '../reconciliation/reconcile';
import {
  type FamilyQualifier,
  type ReasonCount,
  type ReconciliationFamilyV1,
  type ReconciliationReportV1,
  type ReconciliationVerdictV1,
  REJECTION_PREFIX_UNSUPPORTED_PLATFORM,
  type RelationshipClosure,
  S9_REASON_CODES,
  S9_REPORT_CODE,
  UNRESOLVED_FAMILY_PREFIX,
  UNRESOLVED_PREFIX,
} from '../reconciliation/types';
import { buildFamilyRegistry } from '../reconstruct/families';
import { RECONSTRUCT_STATUS } from '../scout-reconstruct.dto';
import { ScoutReconstructService } from '../scout-reconstruct.service';
import { SCOUT_TERMINAL_STATUSES, type ScoutTerminalStatus } from '../scout.dto';
import {
  arbitrate,
  type ArbiterVerdict,
  type LedgerTally,
  type ReconciliationVerdict,
} from './arbiter';
import type { ScoutRunCancelResult, ScoutRunStartResult } from './lifecycle.dto';
import {
  FAMILY_QUALIFIERS,
  type FenceReason,
  isFenceReason,
  isRunReasonCode,
  isServerTerminalStatus,
  RELATIONSHIP_CLOSURES,
  RUN_PHASES,
  type RunMode,
  type RunPhase,
  type RunReasonCode,
  runConflict,
  type ServerTerminalStatus,
} from './reason-codes';
import { CONSTANT_REASON_CODES, isAdmissibleUnresolved } from './reason-domains';

/** Prisma transaction client — the interactive-transaction handle passed to $transaction. */
export type Tx = Prisma.TransactionClient;

/** S9-C: bounded retries of the REPEATABLE READ settle transaction on serialization failure. */
export const SETTLE_ATTEMPTS = 3;

/**
 * S9-C (Addendum C-9): the ONE options object every S9 snapshot transaction (settle tail and
 * status-path `readReport`) opens with. REPEATABLE READ gives the facts collector's claim,
 * staging, ledger, provenance and native reads a single snapshot. The timeout replaces Prisma's
 * 5 000 ms interactive default, which sits below R16's proven bound (a 10k-row intent reconciles
 * within 10 000 ms): 20 000 ms is twice R16 and still one fifteenth of
 * `SCOUT_RUN_DEADLINE_MS_DEFAULT`; `maxWait` bounds the wait for a pooled connection.
 */
export const S9_SNAPSHOT_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  timeout: 20_000,
  maxWait: 5_000,
} as const;

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
  /** S10-C: the evaluator binding (D-S10-3 E1) handed to the facts collector; `mode` is `server`
   *  by the lock's WHERE clause. */
  accepted_start_at: Date | null;
}

/**
 * D-S9-7 compile-time proof that every S9 verdict code is an S7-L run reason code: this
 * assignment stops compiling if `RUN_REASON_CODES` ever lacks one of `S9_REASON_CODES`.
 * (S9-C appends `unresolved_identities`, `relationship_unverified`, `coverage_basis_unknown`.)
 */
export const S9_RUN_REASON_CODES: readonly RunReasonCode[] = S9_REASON_CODES;

/**
 * The DTO enums (`reason-codes.ts`) are typed against the S9-A report literals: these two
 * assignments stop compiling if the DTO side names a value the report type lacks (Addendum C-7 /
 * C-10); the unit spec asserts the reverse inclusion.
 */
export const PROJECTED_FAMILY_QUALIFIERS: readonly FamilyQualifier[] = FAMILY_QUALIFIERS;
export const PROJECTED_RELATIONSHIP_CLOSURES: readonly RelationshipClosure[] =
  RELATIONSHIP_CLOSURES;

/**
 * A `source_platform` identifier as the `unsupported_platform:<token>` rejection carries it
 * (Addendum C-6 grammar; membership in the staged platforms is checked when the caller has them).
 */
const PLATFORM_QUALIFIER = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * One `families[]` entry of the status read (decision §5). Native buckets are null = not yet
 * known. The optional fields are the S9 additive projection (D-S9-5): present only when a
 * reconciliation report applies to the run, absent otherwise (R13, R15).
 */
export interface FamilyProjection {
  family: string;
  observed_unique: number | null;
  staged_unique: number;
  created_native: number | null;
  already_present_verified: number | null;
  rejected: number | null;
  unresolved: number | null;
  ledger: LedgerTally;
  /** Canonical family the token resolves to; null when unmapped or ambiguous (C-10). */
  canonical_family?: string | null;
  /** D-S9-4 bucket j: verified `created` ∪ `already_present` for the token. */
  native_present_verified?: number;
  /** `'none'` without a basis (D-S9-3). */
  completeness_basis?: string;
  relationship_closure?: RelationshipClosure;
  /** D-S9-7 histogram of the token's family, keys validated (C-6), sorted by code. */
  reasons?: ReasonCount[];
  qualifiers?: FamilyQualifier[];
}

/**
 * The S9 fields `projectToken` fills for one staged token (D-S9-5), plus `observed_unique` when
 * (and only when) the S10 finding-7 rule supplies it from a settled report.
 */
export type TokenFill = Pick<
  FamilyProjection,
  | 'rejected'
  | 'unresolved'
  | 'canonical_family'
  | 'native_present_verified'
  | 'completeness_basis'
  | 'relationship_closure'
  | 'reasons'
  | 'qualifiers'
> &
  Partial<Pick<FamilyProjection, 'observed_unique'>>;

/** The run-row columns that decide whether a reconciliation report applies (D-S9-5, RC-2). */
export type ReportScopeRow = Pick<RunRow, 'mode' | 'terminal_status' | 'reason_code'>;

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
  /** S8-G: the engine the settle hook drives one pass through (same seam pattern as ScoutService → this). */
  private readonly reconstruct: ScoutReconstructService;
  /** S9-C read-only facts collector: settle tail and status read reconcile from it (D-S9-1). */
  private readonly facts: ReconciliationFactsService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    @Optional() reconstruct?: ScoutReconstructService,
    @Optional() facts?: ReconciliationFactsService,
  ) {
    this.deadlineMs = ScoutLifecycleService.readDeadlineMs(process.env[SCOUT_RUN_DEADLINE_MS_ENV]);
    this.reconstruct = reconstruct ?? new ScoutReconstructService(prisma, analytics);
    this.facts = facts ?? new ReconciliationFactsService();
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
   * §3 `onTransferSettled`: the accepted `/complete` hands the run to the arbiter. S8-G body:
   * reconstruct-then-arbitrate. One reconstruction pass runs first over the open run in phase
   * `reconciling`, with this run's `assertRunOpen` as the §3.1 gate inside every per-row
   * transaction and `epoch` (the value the settle observed at claim commit) as the per-row CAS.
   * The pass writes only target rows and ledger outcomes — never a terminal field. If the gate
   * closed mid-pass (a fence or the deadline won), the lazy classifier runs once so a past-deadline
   * run is fenced `timed_out` truthfully; then the S7-L tail runs unchanged: lock the run, CAS on
   * `epoch`, collect the durable facts, arbitrate, write the terminal. A miss (a fence won) is not
   * an error. An unexpected pass failure propagates and leaves the run open for the lazy deadline
   * — nothing terminal is ever written from a failed pass.
   *
   * S9-C (D-S9-1): inside that same transaction, after the CAS check and before `arbitrate`, the
   * reconciler recomputes its verdict from the facts service's reads. S9 writes nothing; the
   * verdict is only the arbiter's step-3 input, so a fence still wins and claim `failed` with
   * zero staged rows is still `failed/transfer_failed` (R09). A CAS miss returns before any S9
   * read.
   */
  async onTransferSettled(coachId: string, intentId: string, epoch: number): Promise<void> {
    const pass = await this.reconstruct.reconstructRun(coachId, intentId, {
      mode: 'server',
      epoch,
      gate: (tx) => this.assertRunOpen(tx, coachId, intentId),
    });
    if (pass.stopped === 'gate_closed') {
      await this.classifyClosed(coachId, intentId);
    }
    const outcome = await this.settleWithSnapshot(async (tx) => {
      const locked = await this.lockRun(tx, coachId, intentId);
      if (!locked || locked.terminal_status !== null || locked.execution_epoch !== epoch) {
        return null;
      }
      const facts = await this.collectFacts(tx, coachId, intentId);
      const fence =
        locked.fenced_at !== null && isFenceReason(locked.fence_reason)
          ? locked.fence_reason
          : null;
      const { verdict: reconciliation, report } = await this.reconcileRun(tx, coachId, intentId, {
        mode: 'server',
        execution_epoch: locked.execution_epoch,
        accepted_start_at: locked.accepted_start_at,
      });
      const verdict = arbitrate({ fence, reconciliation, ...facts });
      const written = await this.writeTerminal(tx, coachId, intentId, epoch, verdict);
      if (!written) return null;
      // S10-C (D-S10-4): the settled basis is a RECORD of the terminal just written, inserted in
      // the same transaction after the CAS succeeded. A CAS miss returns above and writes
      // nothing; an insert failure throws and rolls the terminal back with it.
      await this.writeSettledBasis(tx, coachId, intentId, epoch, report);
      return verdict;
    });
    if (outcome) {
      this.analytics.capture(coachId, Events.SCOUT_RUN_SETTLED, {
        intent_id: intentId,
        terminal_status: outcome.terminal_status,
        reason_code: outcome.reason_code,
      });
    }
  }

  /**
   * S9-C (Addendum C-9): the settle tail runs with `S9_SNAPSHOT_TX_OPTIONS` (REPEATABLE READ
   * plus the R16-sized timeout) so the claim, staging, ledger, provenance and native reads the S9
   * facts collector performs see ONE database snapshot, and the terminal CAS is decided against
   * that same snapshot. PostgreSQL raises a serialization failure (SQLSTATE 40001, Prisma P2034)
   * when the `FOR NO KEY UPDATE` row was changed by a concurrent committed writer (a fence, a
   * cancel, a revoke) after the snapshot was taken; the whole transaction is then retried from a
   * fresh snapshot, at most `SETTLE_ATTEMPTS` times. Every attempt re-locks and re-checks
   * terminal/epoch first, so a retry is idempotent: the row that changed is seen terminal or
   * epoch-raised and the attempt returns null with no write. Only serialization failures are
   * retried; anything else propagates unchanged, and exhaustion rethrows the last serialization
   * failure — a run is never silently left with a fabricated terminal.
   */
  private async settleWithSnapshot<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(body, S9_SNAPSHOT_TX_OPTIONS);
      } catch (err) {
        if (!ScoutLifecycleService.isSerializationFailure(err) || attempt >= SETTLE_ATTEMPTS) {
          throw err;
        }
      }
    }
  }

  /** Prisma P2034 ("write conflict or a deadlock") wraps PostgreSQL 40001 / 40P01. */
  static isSerializationFailure(err: unknown): boolean {
    return err instanceof PrismaClientKnownRequestError && err.code === 'P2034';
  }

  private async lockRun(tx: Tx, coachId: string, intentId: string): Promise<LockedRow | null> {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT execution_epoch, terminal_status, fenced_at, fence_reason, deadline_at,
             accepted_start_at
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

  /**
   * S10-C (D-S10-4 "Settle write"): ONE `ScoutRunSettledBasis` row per run, inserted only after
   * `writeTerminal` returned true in the same transaction. It records the S9 report the terminal
   * was decided on (`basis: 'settled'`) and the `evidence_digest`s of the observations stored at
   * the settle epoch (this coach's run only), so the status read can return the settled report
   * verbatim instead of recomputing it (R35: archiving a native row later changes nothing). The
   * insert is not a second terminal writer — the run row is not touched — and the fence and CAS
   * miss paths never reach it (R36). The table is insert-only and the PK is `(coach_id,
   * intent_id)`, so a second row for the run is refused by the database, not merged.
   */
  private async writeSettledBasis(
    tx: Tx,
    coachId: string,
    intentId: string,
    epoch: number,
    report: ReconciliationReportV1,
  ): Promise<void> {
    const observations = await tx.scoutRunObservation.findMany({
      where: { coach_id: coachId, intent_id: intentId, execution_epoch: epoch },
      select: { evidence_digest: true },
      orderBy: { evidence_digest: 'asc' },
    });
    const settled: ReconciliationReportV1 = { ...report, basis: 'settled' };
    await tx.scoutRunSettledBasis.create({
      data: {
        coach_id: coachId,
        intent_id: intentId,
        execution_epoch: epoch,
        report_version: settled.report_version,
        report: ScoutLifecycleService.reportToJson(settled),
        observation_digests: observations.map((o) => o.evidence_digest),
        settled_at: new Date(),
      },
    });
  }

  /**
   * The settled report as the jsonb input value: a JSON round trip of a plain-data report (no Date,
   * no function, no undefined key survives), so the bytes stored are exactly what `JSON.stringify`
   * of the report says — the same serialisation the status read is compared against (R35).
   */
  static reportToJson(report: ReconciliationReportV1): Prisma.InputJsonValue {
    const value: Prisma.InputJsonValue = JSON.parse(JSON.stringify(report));
    return value;
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
   * S11-B (D-S11-4) read helper for a replayed claim: true when this coach's open server run has
   * a settle still pending — the claim committed (phase `reconciling`, completion row present) and
   * no terminal or fence followed, so the settle that should have run after the claim was lost.
   * A tenant-scoped SELECT: no lock, no write, no parameter but the coach and the intent. The
   * caller reads it inside the transaction whose first statement was `assertRunOpen` and
   * re-drives `onTransferSettled` with THAT gate's epoch, never a client-supplied one.
   */
  async isSettlePending(tx: Tx, coachId: string, intentId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ pending: number }[]>`
      SELECT 1 AS pending
        FROM "ScoutImport" r
       WHERE r.coach_id = ${coachId} AND r.intent_id = ${intentId} AND r.mode = 'server'
         AND r.terminal_status IS NULL AND r.fenced_at IS NULL AND r.phase = 'reconciling'
         AND EXISTS (SELECT 1 FROM "ScoutImportCompletion" c
                      WHERE c.coach_id = r.coach_id AND c.intent_id = r.intent_id)`;
    return rows.length === 1;
  }

  /**
   * After a zero-row gate (the writer's transaction already rolled back): re-read unlocked and
   * classify. No row → `run_not_started`. Fenced or terminal → `run_fenced`. Open but past its
   * deadline → fence `timed_out` in a short transaction of our own (the row is free: the
   * triggering writer released it), then `run_fenced`. Open and NOT yet expired → the row was
   * committed by a Start after the gate ran (it did not exist, or was not visible, when the gate
   * saw zero rows); answer `run_not_started` exactly as the failed gate did and never fence a
   * fresh run as `timed_out`. No write happens on that path.
   */
  async classifyClosed(coachId: string, intentId: string): Promise<ClosedRun> {
    const row = await this.readRun(coachId, intentId);
    if (!row || row.mode !== 'server') return { kind: 'not_started' };
    if (row.terminal_status === null && row.fenced_at === null) {
      if (row.deadline_at !== null && row.deadline_at.getTime() > Date.now()) {
        return { kind: 'not_started' };
      }
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

  /**
   * S9 verdict for the arbiter (D-S9-1): the facts service reads on the caller's transaction and
   * the pure reconciler classifies. Nothing is written. `ReconciliationVerdictV1` is an S7-L
   * `ReconciliationVerdict` verbatim once the three S9 codes are `RunReasonCode`s (D-S9-7).
   */
  private async reconcileRun(
    tx: Tx,
    coachId: string,
    intentId: string,
    run: RunBinding,
  ): Promise<{ verdict: ReconciliationVerdict; report: ReconciliationReportV1 }> {
    const facts = await this.facts.collect(tx, coachId, intentId, run);
    const { verdict, report } = reconcile(facts);
    const v: ReconciliationVerdictV1 = verdict;
    return { verdict: { outcome: v.outcome, reason_code: v.reason_code }, report };
  }

  /**
   * D-S9-5: a report applies only to a `mode='server'` run with a non-null `terminal_status`
   * whose `reason_code` is not `reconciliation_not_performed`. Legacy rows, open runs and pre-S9
   * terminals get none (R13, R15); fenced server terminals do (RC-2).
   */
  static reportApplies(row: ReportScopeRow | null | undefined): boolean {
    return (
      row != null &&
      row.mode === 'server' &&
      row.terminal_status !== null &&
      row.reason_code !== 'reconciliation_not_performed'
    );
  }

  /**
   * The report for the status read (D-S9-5; S10-C D-S10-4 "Status"). When a report applies:
   * the run's settled basis, if one was recorded, is returned verbatim with `basis: 'settled'`
   * (this coach's `(coach_id, intent_id)` row only; one point read, no transaction); otherwise
   * the S9-C recompute-on-read — one REPEATABLE READ transaction supplies the facts service its
   * snapshot and the reconciler's `'recomputed'` report is returned, byte-identical to S9-C. No
   * row is written on either path. Returns null when no report applies, without any read.
   */
  async readReport(
    coachId: string,
    intentId: string,
    row: ReportScopeRow | null | undefined,
  ): Promise<ReconciliationReportV1 | null> {
    if (!ScoutLifecycleService.reportApplies(row)) return null;
    const settled = await this.readSettledBasis(coachId, intentId);
    if (settled !== null) return settled;
    // No settled record (a fence-path or pre-S10 terminal): the S9-C recompute, byte-identical to
    // S9-C — the collector gets NO run binding, so coverage stays unknown and no S10 evidence is
    // read. Later or backfilled evidence never changes a report that was never settled on it.
    return this.prisma.$transaction(
      async (tx) => reconcile(await this.facts.collect(tx, coachId, intentId)).report,
      S9_SNAPSHOT_TX_OPTIONS,
    );
  }

  /**
   * S10-C: the recorded settled report, or null when none exists OR the stored value is not a
   * version-1 `'settled'` report (then the S9 recompute answers; a stored record is never
   * reinterpreted into something it does not say).
   */
  private async readSettledBasis(
    coachId: string,
    intentId: string,
  ): Promise<ReconciliationReportV1 | null> {
    const row = await this.prisma.scoutRunSettledBasis.findUnique({
      where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
      select: { report_version: true, report: true },
    });
    if (row === null || row.report_version !== 1) return null;
    return ScoutLifecycleService.isSettledReport(row.report) ? row.report : null;
  }

  /** Structural check of a stored settled report (the jsonb column is typed `unknown`). */
  static isSettledReport(value: unknown): value is ReconciliationReportV1 {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const r = value as Record<string, unknown>;
    return (
      r.report_version === 1 &&
      r.basis === 'settled' &&
      Array.isArray(r.conditions) &&
      (r.required_families === null || Array.isArray(r.required_families)) &&
      typeof r.ledger_without_staged === 'number' &&
      Array.isArray(r.families)
    );
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
   * `observed_unique` stays null until a settled S10 basis vouches for it (below).
   *
   * S9-C (D-S9-5): with a `report`, each entry that has a token row in it is filled from that row
   * and its family — `rejected` / `unresolved` become counted facts and the additive fields
   * appear. `created_native` / `already_present_verified` stay null (D-S9-4). Without a report
   * (or for a token the report does not carry) the entry is exactly the S7-L shape — no additive
   * key is present, no bucket becomes 0. Report-only entries (declared families without a staged
   * token, RC-3) never create an entry.
   *
   * S10-C (S10-DOC finding 7): `observed_unique` stays null under a `'recomputed'` report; under
   * a `'settled'` one `projectToken` fills it only when exactly one report family holds the
   * token, that family is mapped, the token is its only token and the family's `observed_unique`
   * is non-null — otherwise null (never a sum, never a 0 for "not observed").
   */
  static projectFamilies(
    staged: readonly { entity_type: string; _count: { _all: number } }[],
    ledger: Readonly<Record<string, LedgerTally>>,
    report?: ReconciliationReportV1 | null,
  ): FamilyProjection[] {
    const families = new Set<string>([...staged.map((g) => g.entity_type), ...Object.keys(ledger)]);
    return Array.from(families)
      .sort((a, b) => a.localeCompare(b))
      .map((family) => {
        const base: FamilyProjection = {
          family,
          observed_unique: null,
          staged_unique: staged.find((g) => g.entity_type === family)?._count._all ?? 0,
          created_native: null,
          already_present_verified: null,
          rejected: null,
          unresolved: null,
          ledger: ledger[family] ?? { reconstructed: 0, skipped: 0, failed: 0 },
        };
        if (!report) return base;
        const fill = ScoutLifecycleService.projectToken(family, report, families);
        return fill ? { ...base, ...fill } : base;
      });
  }

  /**
   * The S9 fields for one staged token (D-S9-5, C-10). A token may resolve to different families
   * across platforms in one intent: counts are summed over all of its rows, `canonical_family`
   * is null unless every row resolves to the same mapped family, `reasons` merges the families'
   * histograms and `qualifiers` their union. Returns null when the report has no row for the token.
   * `observed_unique` is present only when the finding-7 rule fills it from a settled report.
   */
  static projectToken(
    token: string,
    report: ReconciliationReportV1,
    stagedTokens: ReadonlySet<string>,
  ): TokenFill | null {
    const holders: ReconciliationFamilyV1[] = report.families.filter((f) =>
      f.tokens.some((t) => t.token === token),
    );
    if (holders.length === 0) return null;
    const observed = ScoutLifecycleService.observedUniqueFor(token, report, holders);
    const rows = holders.flatMap((f) => f.tokens.filter((t) => t.token === token));
    const sum = (pick: (r: (typeof rows)[number]) => number) =>
      rows.reduce((acc, r) => acc + pick(r), 0);
    // Report families are unique by name, so one mapped holder ⇔ every row agrees (C-10).
    const canonical_family = holders.length === 1 && holders[0].mapped ? holders[0].family : null;
    const bases = new Set(holders.map((f) => f.completeness_basis));
    const closures = holders.map((f) => f.relationship_closure);
    const relationship_closure: RelationshipClosure = closures.includes('unverified')
      ? 'unverified'
      : closures.every((c) => c === closures[0])
        ? closures[0]
        : 'not_applicable';
    return {
      rejected: sum((r) => r.rejected),
      unresolved: sum((r) => r.unresolved),
      canonical_family,
      native_present_verified: sum((r) => r.native_present_verified),
      completeness_basis: bases.size === 1 ? holders[0].completeness_basis : 'none',
      relationship_closure,
      reasons: ScoutLifecycleService.projectReasons(
        holders.flatMap((f) => f.reasons),
        stagedTokens,
      ),
      qualifiers: PROJECTED_FAMILY_QUALIFIERS.filter((q) =>
        holders.some((f) => f.qualifiers.includes(q)),
      ),
      ...(observed === null ? {} : { observed_unique: observed }),
    };
  }

  /**
   * S10-DOC finding 7: the verified `observed_unique` a token may carry. A family's observation
   * counts identities of the FAMILY; the token-shaped `families[]` entry may only show it when
   * the token and the family are the same set — a settled report, exactly one holder, mapped, the
   * token its only token, value non-null. Every other case is null (unknown), never a 0.
   */
  static observedUniqueFor(
    token: string,
    report: ReconciliationReportV1,
    holders: readonly ReconciliationFamilyV1[],
  ): number | null {
    if (report.basis !== 'settled' || holders.length !== 1) return null;
    const holder = holders[0];
    if (!holder.mapped || holder.tokens.length !== 1 || holder.tokens[0].token !== token) {
      return null;
    }
    return typeof holder.observed_unique === 'number' ? holder.observed_unique : null;
  }

  /**
   * Addendum C-6: validate every histogram key's qualifier against its domain before it reaches a
   * DTO — `unresolved_family:<token>` must name a staged token of this projection,
   * `unsupported_platform:<token>` a platform identifier, `unresolved:<code>:<qualifier>` the
   * native-name grammar S8-C's writer enforces. A key that fails is folded into
   * `unresolved:reason_unrecognised` (its count kept, its text never echoed). Counts of equal
   * keys merge; the result is sorted by code.
   */
  static projectReasons(
    reasons: readonly ReasonCount[],
    stagedTokens: ReadonlySet<string>,
  ): ReasonCount[] {
    const merged = new Map<string, number>();
    for (const { code, count } of reasons) {
      const key = ScoutLifecycleService.admitReasonCode(code, stagedTokens)
        ? code
        : S9_REPORT_CODE.reason_unrecognised;
      merged.set(key, (merged.get(key) ?? 0) + count);
    }
    return Array.from(merged, ([code, count]) => ({ code, count })).sort((a, b) =>
      a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
    );
  }

  /**
   * Addendum C-6 — closed-domain admission of one D-S9-7 histogram key (never a grammar check
   * alone):
   *  - `unresolved_family:<token>`: `<token>` must be a staged token of THIS projection;
   *  - `unsupported_platform:<p>`: `<p>` must satisfy the platform-identifier grammar and, when the
   *    caller knows the staged platforms, be one of them;
   *  - `unresolved:<code>` / `unresolved:<code>:<qualifier>`: `<code>` must be a §3.7 catalogue
   *    code (S9-A `UNRESOLVED_CATALOGUE`, of which S8-C's runtime codes are the emitted subset),
   *    a bare code takes no qualifier and a qualified code's `<qualifier>` must be a member of
   *    the derived native-name domain (`reason-domains.ts`: canonical families, native target
   *    models, their columns and rule field keys) — `unresolved:missing_required_field:Jane` is
   *    not, whatever its shape;
   *  - otherwise the key must be one of the constant S9-A report / writer / rejection codes.
   * Anything else folds to `unresolved:reason_unrecognised` (count kept, text never echoed).
   */
  static admitReasonCode(
    code: string,
    stagedTokens: ReadonlySet<string>,
    stagedPlatforms?: ReadonlySet<string>,
  ): boolean {
    if (CONSTANT_REASON_CODES.has(code)) return true;
    if (code.startsWith(UNRESOLVED_FAMILY_PREFIX)) {
      return stagedTokens.has(code.slice(UNRESOLVED_FAMILY_PREFIX.length));
    }
    if (code.startsWith(REJECTION_PREFIX_UNSUPPORTED_PLATFORM)) {
      const platform = code.slice(REJECTION_PREFIX_UNSUPPORTED_PLATFORM.length);
      if (!PLATFORM_QUALIFIER.test(platform)) return false;
      return stagedPlatforms === undefined || stagedPlatforms.has(platform);
    }
    if (code.startsWith(UNRESOLVED_PREFIX)) {
      const parts = code.slice(UNRESOLVED_PREFIX.length).split(':');
      if (parts.length > 2 || parts.some((p) => p.length === 0)) return false;
      return isAdmissibleUnresolved(parts[0], parts[1]);
    }
    return false;
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
