import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';

// PrismaService is provided globally via PrismaModule — no need to import here.
// AuditService is provided globally via AuditModule (see app.module.ts).
// AuthModule is imported so JwtAuthGuard can resolve its JwksVerifierService
// dependency within this module context.

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [AccountDeletionController],
  providers: [AccountDeletionService],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
