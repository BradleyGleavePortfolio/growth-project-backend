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
import { redactPii } from './erasure-token';
import type { AuditLogContext, AuditedFn } from './audit-log.types';

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
}
