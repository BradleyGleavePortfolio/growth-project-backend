import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';

// EmailService is needed by invite-codes, billing, onboarding, and the
// digest scheduler. Marking the module as @Global keeps the wiring trivial
// and matches the AuditModule / AnalyticsModule pattern used elsewhere.
// PrismaService is already global; ConfigModule is registered at root.
@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
