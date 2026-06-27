// H6 — AuditLogService: the withAuditLog() substrate (D-H6-5 LOCKED).
//
// withAuditLog(ctx, fn) runs `fn` inside a single Prisma transaction and
// writes one audit_log row in that SAME transaction. If the audit insert
// fails and AUDIT_LOG_FAIL_OPEN !== '1', the whole transaction rolls back —
// the PII mutation does not commit without its audit row (double-entry
// bookkeeping). AUDIT_LOG_FAIL_OPEN=1 is the operator break-glass that
// downgrades an audit-write failure to "log and continue" for emergencies.
//
// The audit write is structured (before_state / after_state / tenant scope)
// and is distinct from the legacy AuditService event log — see
// src/audit/audit.service.ts, which remains the forensic action-string log.

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { redactPii, tokenizePiiState } from './erasure-token';
import type { AuditLogContext, AuditedFn } from './audit-log.types';

// Map a tokenized state value back to a Prisma JSON input. A null/absent
// state stays SQL NULL (Prisma.JsonNull); an object is written as-is.
function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value == null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  // The break-glass safety valve (D-H6-5). Default OFF. Read per-call so an
  // operator can flip it without a redeploy in an incident window.
  private failOpenEnabled(): boolean {
    return process.env.AUDIT_LOG_FAIL_OPEN === '1';
  }

  // Run `fn` and record an audit row in the same transaction.
  //
  // Contract:
  //   - `fn` receives the transaction client `tx`. Pass it through to your
  //     prisma writes so the mutation and the audit row commit together.
  //   - On audit-insert failure with the valve OFF: throw -> the whole
  //     transaction (including `fn`'s mutation) rolls back.
  //   - On audit-insert failure with AUDIT_LOG_FAIL_OPEN=1: log the failure
  //     and return `fn`'s result anyway (the mutation commits).
  async withAuditLog<T>(ctx: AuditLogContext, fn: AuditedFn<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await fn(tx);
      try {
        await tx.auditLogEntry.create({
          data: redactPii(ctx) as Prisma.AuditLogEntryUncheckedCreateInput,
        });
      } catch (auditErr) {
        if (this.failOpenEnabled()) {
          this.logger.error(
            'audit-log insert failed; AUDIT_LOG_FAIL_OPEN=1 swallowing',
            auditErr instanceof Error ? auditErr.stack : String(auditErr),
          );
          return result; // safety valve per D-H6-5
        }
        throw auditErr; // default: rollback the PII mutation
      }
      return result;
    });
  }

  // GDPR Art. 17 in-place erasure. Tokenizes the PII leaves of before_state /
  // after_state for EVERY audit row whose actor_id is exactly `userId`. The
  // scope is the passed id ONLY — never a caller-supplied filter — so a
  // deletion request for user A can never reach into user B's rows (IDOR
  // guard). The audit fact (id, action, resource_type, resource_id,
  // request_id, created_at) is preserved; only the state JSON is rewritten,
  // and already-tokenized rows rewrite to the same value so a repeat call is a
  // no-op. Runs via the privileged service-role client because the table
  // REVOKEs UPDATE from app_runtime (D-H6-1). Returns the row count touched.
  async redactPii(userId: string): Promise<number> {
    const rows = await this.prisma.auditLogEntry.findMany({
      where: { actor_id: userId },
      select: { id: true, before_state: true, after_state: true },
    });
    let redacted = 0;
    for (const row of rows) {
      await this.prisma.auditLogEntry.update({
        where: { id: row.id },
        data: {
          before_state: toJsonInput(tokenizePiiState(row.before_state)),
          after_state: toJsonInput(tokenizePiiState(row.after_state)),
        },
      });
      redacted += 1;
    }
    return redacted;
  }
}
