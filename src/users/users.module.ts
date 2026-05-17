import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PreferencesService } from './preferences.service';
import { AccountService } from './account.service';
import { GdprScrubService } from './gdpr-scrub.service';
import { GdprScrubScheduler } from './gdpr-scrub.scheduler';

// PrismaService is provided globally via PrismaModule — no need to import here.
// AuthModule must be imported so JwtAuthGuard (used in UsersController) can
// resolve its JwksVerifierService dependency within this module context.
// AuditService is exposed via the global AuditModule (see app.module.ts).
@Module({
  imports: [AuthModule, AccountDeletionModule],
  controllers: [UsersController],
  providers: [
    UsersService,
    PreferencesService,
    AccountService,
    GdprScrubService,
    GdprScrubScheduler,
  ],
  exports: [UsersService, PreferencesService, AccountService, GdprScrubService],
})
export class UsersModule {}
