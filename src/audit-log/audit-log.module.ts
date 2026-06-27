import { Global, Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';

// H6 — audit_log substrate module (D-H6-5 LOCKED).
//
// @Global so the twelve PII-touching feature modules can inject
// AuditLogService.withAuditLog() without each adding an explicit import —
// the same pattern PrismaModule uses (see src/prisma/prisma.module.ts).
// PrismaService is already global, so this module only provides/exports the
// audit substrate itself.
@Global()
@Module({
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
