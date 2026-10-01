import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { AppleTokenRevocationService } from './apple-token-revocation.service';
import { AccountDeletionStorageService } from './account-deletion.storage';
import { AccountDeletionBillingService } from './account-deletion.billing';
import { StripeApiService } from '../billing/stripe-api.service';

// PrismaService is provided globally via PrismaModule — no need to import here.
// AuditService is provided globally via AuditModule (see app.module.ts).
// AuthModule is imported so JwtAuthGuard can resolve its JwksVerifierService
// dependency within this module context. MuxService comes from the global
// VideoModule; StripeApiService is a stateless REST client provided here.

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [AccountDeletionController],
  providers: [
    AccountDeletionService,
    AppleTokenRevocationService,
    AccountDeletionStorageService,
    AccountDeletionBillingService,
    StripeApiService,
  ],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
