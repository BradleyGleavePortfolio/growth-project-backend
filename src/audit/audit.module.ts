import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuthModule } from '../auth/auth.module';

// AuditService is needed by admin, users, auth, coach, notifications, and
// other paths that perform sensitive actions. Marking the module as @Global
// keeps the wiring trivial — any module that adds a sensitive action can
// inject AuditService without first listing AuditModule among its imports.
// PrismaService is already global, so this module needs no imports of its own.
//
// AuthModule is imported so that JwtAuthGuard (applied to AuditController)
// can resolve JwksVerifierService (param index 1) within this module context.
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
