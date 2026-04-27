import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

// AuditService is needed by admin, users, and (later) billing/coach paths.
// Marking the module as @Global keeps the wiring trivial — any module that
// adds a sensitive action can inject AuditService without first listing
// AuditModule among its imports. PrismaService is already global, so this
// module needs no imports of its own.
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
