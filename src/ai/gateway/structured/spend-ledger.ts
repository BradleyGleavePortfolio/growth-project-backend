import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { AiGatewayError } from './structured-ai.errors';

// L1-gw r2 — spend ledger port (closes R592-A-A1/A2, R592-B-B1/B2/B3).
//
// The daily spend cap is enforced by RESERVE-BEFORE-CALL in PostgreSQL, not by
// a read-then-call check in application memory:
//
//   1. one transaction takes `pg_advisory_xact_lock(hash(capability, UTC day))`
//      so admission is serialised across every application instance;
//   2. inside the lock it sums today's committed + reserved charges for the
//      capability from `AiRequestAudit.metadata.usd_estimate`;
//   3. it refuses (`ai_budget_exhausted`) if the conservative maximum cost of
//      this call would exceed the cap; otherwise it INSERTs a `reserved` audit
//      row charged at that maximum and commits;
//   4. only then does the gateway call the provider;
//   5. afterwards the row is UPDATEd to the actual charge and outcome.
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
  // UTC calendar day the reservation counts against (YYYY-MM-DD).
  day: string;
  capUsd: number;
  // Conservative maximum cost of the call about to be made.
  maxUsd: number;
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
  reservedUsd: number;
  // Sum of today's charges before this reservation (for observability).
  spentBeforeUsd: number;
}

export interface SpendSettlement {
  // Actual (or conservative, for timeouts) charge for the attempt.
  chargedUsd: number;
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

export interface SpendLedger {
  // Throws AiGatewayError('ai_budget_exhausted') when the cap would be exceeded
  // and AiGatewayError('ai_unavailable') when the ledger cannot be written or
  // read (fail closed). Never returns without a committed reservation.
  reserve(args: SpendReserveArgs): Promise<SpendReservation>;
  // Best effort: converts the reservation into the actual charge. On failure
  // the reservation stays charged at its maximum (conservative).
  settle(reservation: SpendReservation, settlement: SpendSettlement): Promise<boolean>;
}

export const RESERVED_OUTCOME = 'reserved';

// Stable signed-64-bit advisory-lock key for (capability, day). Postgres
// `pg_advisory_xact_lock(bigint)` keys are process-wide, so the key space is
// namespaced by hashing the capability id into it.
export function advisoryLockKey(capability: string, day: string): bigint {
  const digest = createHash('sha256').update(`${capability}:${day}`, 'utf8').digest();
  // Read the first 8 bytes as a signed 64-bit integer.
  return digest.readBigInt64BE(0);
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function utcDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

@Injectable()
export class AuditSpendLedger implements SpendLedger {
  private readonly logger = new Logger(AuditSpendLedger.name);

  constructor(private readonly prisma: PrismaService) {}

  async reserve(args: SpendReserveArgs): Promise<SpendReservation> {
    if (
      !Number.isFinite(args.maxUsd) ||
      args.maxUsd < 0 ||
      !Number.isFinite(args.capUsd) ||
      args.capUsd < 0
    ) {
      throw new AiGatewayError('ai_unavailable', {
        provider: args.audit.provider,
        model: args.audit.model,
        reason: 'ledger-invalid-amount',
      });
    }
    const key = advisoryLockKey(args.capability, args.day);
    const dayStart = utcDayStart(args.day);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key})`;
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
        // Round to micro-dollars so binary float noise (0.1 + 0.2) cannot
        // refuse a reservation that exactly fills the cap.
        if (round6(spent + args.maxUsd) > args.capUsd) {
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
            metadata: toJsonValue({
              ...args.audit.metadata,
              outcome: RESERVED_OUTCOME,
              usd_estimate: args.maxUsd,
              usd_reserved: args.maxUsd,
              spend_cap_usd: args.capUsd,
              spent_before_usd: round6(spent),
            }),
          },
          select: { id: true },
        });
        return { auditId: row.id, reservedUsd: args.maxUsd, spentBeforeUsd: spent };
      });
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

  async settle(reservation: SpendReservation, s: SpendSettlement): Promise<boolean> {
    try {
      await this.prisma.aiRequestAudit.update({
        where: { id: reservation.auditId },
        data: {
          model: s.model,
          enabled: s.enabled,
          prompt_token_estimate: s.promptTokens,
          response_token_estimate: s.responseTokens,
          response_hash: s.responseHash,
          error: s.errorCode,
          metadata: toJsonValue({
            ...s.metadata,
            outcome: s.outcome,
            usd_estimate: s.chargedUsd,
            usd_reserved: reservation.reservedUsd,
            spent_before_usd: round6(reservation.spentBeforeUsd),
          }),
        },
        select: { id: true },
      });
      return true;
    } catch (err) {
      this.logger.error(
        `[importer.mapping] spend settle failed (${errorClass(err)}); reservation stays charged at maximum`,
      );
      return false;
    }
  }
}

// Sum `metadata.usd_estimate` over the rows. Returns null when any row's
// charge is missing or not a finite non-negative number (fail closed).
export function sumCharges(rows: Array<{ metadata: unknown }>): number | null {
  let total = 0;
  for (const r of rows) {
    const m = r.metadata;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const v = (m as { usd_estimate?: unknown }).usd_estimate;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    total += v;
  }
  return total;
}

function toJsonValue(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v));
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function errorClass(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: unknown };
    if (typeof e.code === 'string') return e.code;
    if (typeof e.name === 'string') return e.name;
  }
  return 'Error';
}
