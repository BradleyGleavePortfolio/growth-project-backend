import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';

// ConsentService is read by coach-side query paths to gate access to
// client data; marking the module @Global keeps wiring trivial in the
// coach + admin modules without each one importing ConsentModule
// explicitly. AuditService is already global. PrismaService is already
// global. AuthModule is imported so JwtAuthGuard resolves locally for
// the controller.
@Global()
@Module({
  imports: [AuthModule],
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
