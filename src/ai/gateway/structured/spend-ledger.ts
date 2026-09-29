import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { AiGatewayError } from './structured-ai.errors';
import { addMicros, isMicros, microsToUsd } from './money';

// L1-gw r2/r3 — spend ledger port (closes R592-A-A1/A2, R592-B-B1/B2/B3;
// r3: R592-c7A-01/03/04, R592-c7B-02/C01/C02).
//
// The daily spend cap is enforced by RESERVE-BEFORE-CALL in PostgreSQL, not by
// a read-then-call check in application memory:
//
//   1. one READ COMMITTED transaction reads the DATABASE clock once
//      (`now()`), derives the UTC accounting day from it, and takes
//      `pg_advisory_xact_lock(hash(capability, day))` so admission is
//      serialised across every application instance for that day;
//   2. inside the lock it sums the day's committed + reserved charges for the
//      capability from `AiRequestAudit.metadata.charge_micros` (integer µUSD)
//      over rows whose `created_at` falls in [dayStart, dayEnd);
//   3. it refuses (`ai_budget_exhausted`) if the conservative maximum cost of
//      this call would exceed the cap; otherwise it INSERTs a `reserved` audit
//      row charged at that maximum, with `created_at` set EXPLICITLY to the
//      same transaction clock value (so the row's accounting day, the lock key
//      and the summed window can never disagree around UTC midnight —
//      R592-c7A-04), and commits;
//   4. only then does the gateway call the provider;
//   5. afterwards the row is UPDATEd to the actual charge and outcome. A
//      settlement ABOVE the reservation re-enters the same day lock, re-sums,
//      and records whether the day's total now exceeds the cap (the gate then
//      stays closed for the rest of the day; R592-c7A-03).
//
// Money is integer micro-USD everywhere (money.ts). A reservation is never 0
// for positive prices, so a $0 cap refuses every paid call (R592-c7A-01).
//
// If the reservation insert fails for any reason (ledger unreachable, FK
// violation because `requester_id` is not a real User, ...), the call is
// refused (`ai_unavailable`, fail closed). A process that crashes mid-call
// leaves its reservation charged at the maximum — conservative by design. A
// failed settle also leaves the maximum in place.
//
// This is deliberately a small interface so the durable learn ledger (record
// D-L0-7.3 `ScoutLearnSpendLedger`, slice L2b) can replace the default
// implementation by binding a different provider to `SPEND_LEDGER` without
// editing the gateway.

export const SPEND_LEDGER = 'IMPORTER_MAPPING_SPEND_LEDGER';

export interface SpendReserveArgs {
  capability: string;
  // Daily cap, integer µUSD.
  capMicros: number;
  // Conservative maximum cost of the call about to be made, integer µUSD (> 0).
  maxMicros: number;
  // Audit identity for the reserved row.
  audit: {
    requestId: string;
    requesterId: string;
    requesterRole: string;
    tenantCoachId: string | null;
    provider: string;
    model: string;
    promptHash: string;
    redactions: Prisma.InputJsonValue | null;
    // Content-free metadata for the reserved row (computed by the gateway).
    metadata: Record<string, unknown>;
  };
}

export interface SpendReservation {
  // Audit row id of the reserved row.
  auditId: string;
  reservedMicros: number;
  capMicros: number;
  capability: string;
  // UTC accounting day (YYYY-MM-DD) the reservation was counted against,
  // derived from the database clock inside the reservation transaction.
  day: string;
  // Sum of the day's charges before this reservation (for observability).
  spentBeforeMicros: number;
}

export interface SpendSettlement {
  // Actual charge for the attempt (or the reservation when usage is unknown).
  chargedMicros: number;
  outcome: string;
  enabled: boolean;
  model: string;
  promptTokens: number | null;
  responseTokens: number | null;
  responseHash: string | null;
  // Closed outcome code for the `error` column, or null on success.
  errorCode: string | null;
  metadata: Record<string, unknown>;
}

export interface SpendSettleResult {
  ok: boolean;
  // True when the settled charge exceeded the reservation.
  overage: boolean;
  // True when, after this settlement, the day's recorded total exceeds the
  // cap (only evaluated on overage; the gate is then closed for the day).
  capExceeded: boolean;
}

export interface SpendLedger {
  // Throws AiGatewayError('ai_budget_exhausted') when the cap would be exceeded
  // and AiGatewayError('ai_unavailable') when the ledger cannot be written or
  // read (fail closed). Never returns without a committed reservation.
  reserve(args: SpendReserveArgs): Promise<SpendReservation>;
  // Best effort: converts the reservation into the actual charge. On failure
  // the reservation stays charged at its maximum (conservative).
  settle(reservation: SpendReservation, settlement: SpendSettlement): Promise<SpendSettleResult>;
}

export const RESERVED_OUTCOME = 'reserved';

// Explicit transaction posture (R592-c7B-02): READ COMMITTED so the statement
// that runs AFTER the advisory lock is granted sees the previous holder's
// committed reservation (REPEATABLE READ would snapshot before the wait and
// miss it). maxWait bounds the time a caller waits for a pooled connection;
// timeout bounds the whole locked section (R592-c7B-C07).
export const RESERVE_TX_OPTIONS = Object.freeze({
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 15_000,
});

// Stable signed-64-bit advisory-lock key for (capability, day). Postgres
// `pg_advisory_xact_lock(bigint)` keys are process-wide, so the key space is
// namespaced by hashing the capability id into it.
export function advisoryLockKey(capability: string, day: string): bigint {
  const digest = createHash('sha256').update(`${capability}:${day}`, 'utf8').digest();
  // Read the first 8 bytes as a signed 64-bit integer.
  return digest.readBigInt64BE(0);
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function utcDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function utcDayEnd(day: string): Date {
  return new Date(utcDayStart(day).getTime() + 24 * 60 * 60 * 1000);
}

@Injectable()
export class AuditSpendLedger implements SpendLedger {
  private readonly logger = new Logger(AuditSpendLedger.name);

  constructor(private readonly prisma: PrismaService) {}

  async reserve(args: SpendReserveArgs): Promise<SpendReservation> {
    // A reservation must be a strictly positive µUSD integer: 0 would admit
    // a paid call for free (R592-c7A-01).
    if (!isMicros(args.maxMicros) || args.maxMicros <= 0 || !isMicros(args.capMicros)) {
      throw new AiGatewayError('ai_unavailable', {
        provider: args.audit.provider,
        model: args.audit.model,
        reason: 'ledger-invalid-amount',
      });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        // One database clock read drives the day key, the lock, the summed
        // window AND the inserted row's created_at (R592-c7A-04).
        const now = await readTxClock(tx);
        const day = utcDay(now);
        const dayStart = utcDayStart(day);
        const dayEnd = utcDayEnd(day);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${advisoryLockKey(args.capability, day)})`;
        const rows = await tx.aiRequestAudit.findMany({
          where: { capability: args.capability, created_at: { gte: dayStart, lt: dayEnd } },
          select: { id: true, metadata: true },
        });
        const spent = sumCharges(rows);
        if (spent === null) {
          // A row whose charge cannot be read is a ledger defect; the gate
          // stays closed until an operator repairs it.
          throw new AiGatewayError('ai_budget_exhausted', {
            provider: args.audit.provider,
            model: args.audit.model,
            reason: 'ledger-malformed',
          });
        }
        if (addMicros(spent, args.maxMicros) > args.capMicros) {
          throw new AiGatewayError('ai_budget_exhausted', {
            provider: args.audit.provider,
            model: args.audit.model,
            reason: 'daily-spend-cap',
          });
        }
        const row = await tx.aiRequestAudit.create({
          data: {
            request_id: args.audit.requestId,
            capability: args.capability,
            requester_id: args.audit.requesterId,
            requester_role: args.audit.requesterRole,
            subject_user_id: null,
            tenant_coach_id: args.audit.tenantCoachId,
            provider: args.audit.provider,
            model: args.audit.model,
            enabled: false,
            context_source_count: 0,
            context_source_refs: Prisma.JsonNull,
            redactions_applied: args.audit.redactions ?? Prisma.JsonNull,
            prompt_token_estimate: null,
            response_token_estimate: null,
            prompt_hash: args.audit.promptHash,
            response_hash: null,
            approval_status: 'not_required',
            approval_draft_id: null,
            error: null,
            ip: null,
            user_agent: null,
            created_at: now,
            metadata: toJsonValue({
              ...args.audit.metadata,
              ...chargeFields({
                chargeMicros: args.maxMicros,
                reservedMicros: args.maxMicros,
                capMicros: args.capMicros,
                spentBeforeMicros: spent,
                day,
              }),
              outcome: RESERVED_OUTCOME,
            }),
          },
          select: { id: true },
        });
        return {
          auditId: row.id,
          reservedMicros: args.maxMicros,
          capMicros: args.capMicros,
          capability: args.capability,
          day,
          spentBeforeMicros: spent,
        };
      }, RESERVE_TX_OPTIONS);
    } catch (err) {
      if (AiGatewayError.is(err)) throw err;
      // Ledger unreadable or unwritable (connection, FK on requester_id,
      // unique request_id, ...): refuse. Log a fixed class name only — never
      // the driver message, which may echo bound parameters.
      this.logger.error(
        `[importer.mapping] spend reservation failed (${errorClass(err)}); refusing call (fail closed)`,
      );
      throw new AiGatewayError('ai_unavailable', {
        provider: args.audit.provider,
        model: args.audit.model,
        reason: 'ledger-unavailable',
      });
    }
  }

  async settle(reservation: SpendReservation, s: SpendSettlement): Promise<SpendSettleResult> {
    const overage = s.chargedMicros > reservation.reservedMicros;
    if (!isMicros(s.chargedMicros)) {
      this.logger.error(
        `[importer.mapping] spend settle refused (invalid-amount); reservation stays charged at maximum`,
      );
      return { ok: false, overage, capExceeded: false };
    }
    const data = (extra: Record<string, unknown>) => ({
      model: s.model,
      enabled: s.enabled,
      prompt_token_estimate: s.promptTokens,
      response_token_estimate: s.responseTokens,
      response_hash: s.responseHash,
      error: s.errorCode,
      metadata: toJsonValue({
        ...s.metadata,
        ...chargeFields({
          chargeMicros: s.chargedMicros,
          reservedMicros: reservation.reservedMicros,
          capMicros: reservation.capMicros,
          spentBeforeMicros: reservation.spentBeforeMicros,
          day: reservation.day,
        }),
        ...extra,
        outcome: s.outcome,
      }),
    });
    try {
      if (!overage) {
        await this.prisma.aiRequestAudit.update({
          where: { id: reservation.auditId },
          data: data({ overage_micros: 0, cap_exceeded: false }),
          select: { id: true },
        });
        return { ok: true, overage: false, capExceeded: false };
      }
      // Actual usage above the reservation (R592-c7A-03): re-enter the SAME
      // day lock so the re-check serialises with concurrent admissions, sum
      // the other rows of that day, record the truth, and flag whether the
      // day's total is now over the cap. Admission of any further call is
      // refused by the ordinary reserve check from this point on.
      const capExceeded = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${advisoryLockKey(reservation.capability, reservation.day)})`;
        const rows = await tx.aiRequestAudit.findMany({
          where: {
            capability: reservation.capability,
            created_at: { gte: utcDayStart(reservation.day), lt: utcDayEnd(reservation.day) },
            id: { not: reservation.auditId },
          },
          select: { id: true, metadata: true },
        });
        const others = sumCharges(rows);
        const total = others === null ? null : addMicros(others, s.chargedMicros);
        const exceeded = total === null ? true : total > reservation.capMicros;
        await tx.aiRequestAudit.update({
          where: { id: reservation.auditId },
          data: data({
            overage_micros: s.chargedMicros - reservation.reservedMicros,
            cap_exceeded: exceeded,
          }),
          select: { id: true },
        });
        return exceeded;
      }, RESERVE_TX_OPTIONS);
      if (capExceeded) {
        this.logger.warn(
          `[importer.mapping] settlement above reservation pushed day=${reservation.day} over the cap (overage_micros=${s.chargedMicros - reservation.reservedMicros}); gate closed for the day`,
        );
      }
      return { ok: true, overage: true, capExceeded };
    } catch (err) {
      this.logger.error(
        `[importer.mapping] spend settle failed (${errorClass(err)}); reservation stays charged at maximum`,
      );
      return { ok: false, overage, capExceeded: false };
    }
  }
}

// Metadata charge fields. `charge_micros` (integer µUSD) is the ONLY value the
// ledger sums; the `usd_*` floats are derived, for humans reading the row.
export function chargeFields(c: {
  chargeMicros: number;
  reservedMicros: number;
  capMicros: number;
  spentBeforeMicros: number;
  day: string;
}): Record<string, unknown> {
  return {
    charge_micros: c.chargeMicros,
    reserved_micros: c.reservedMicros,
    spend_cap_micros: c.capMicros,
    spent_before_micros: c.spentBeforeMicros,
    accounting_day: c.day,
    usd_estimate: microsToUsd(c.chargeMicros),
    usd_reserved: microsToUsd(c.reservedMicros),
    spend_cap_usd: microsToUsd(c.capMicros),
  };
}

// Zero-charge fields for refusal / stub rows (they are counted, as 0).
export function zeroChargeFields(): Record<string, unknown> {
  return { charge_micros: 0, usd_estimate: 0 };
}

// Sum `metadata.charge_micros` over the rows with checked integer arithmetic.
// Returns null when any row's charge is missing or not a µUSD integer (fail
// closed: the row is a ledger defect, never counted as 0).
export function sumCharges(rows: Array<{ metadata: unknown }>): number | null {
  let total = 0;
  for (const r of rows) {
    const m = r.metadata;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const v = (m as { charge_micros?: unknown }).charge_micros;
    if (!isMicros(v)) return null;
    try {
      total = addMicros(total, v);
    } catch {
      return null;
    }
  }
  return total;
}

// The transaction's clock: `now()` is fixed for the transaction, so the day
// key, the window and the inserted row's created_at all come from one value.
async function readTxClock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date | string }>>`SELECT now() AS now`;
  const raw = rows?.[0]?.now;
  const now = raw instanceof Date ? raw : new Date(String(raw));
  if (!Number.isFinite(now.getTime())) throw new Error('ledger-clock-unreadable');
  return now;
}

function toJsonValue(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v));
}

export function errorClass(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: unknown };
    if (typeof e.code === 'string') return e.code;
    if (typeof e.name === 'string') return e.name;
  }
  return 'Error';
}
