import { Global, Module } from '@nestjs/common';
import { KmsService } from './kms.service';

// KmsModule — @Global so any feature module can inject KmsService
// without re-importing. Mirrors the wiring style of PrismaModule and
// AuditModule.

@Global()
@Module({
  providers: [KmsService],
  exports: [KmsService],
})
export class KmsModule {}
