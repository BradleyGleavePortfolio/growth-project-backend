import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InviteCodesModule } from '../invite-codes/invite-codes.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';

/**
 * Auth module — no longer uses PassportModule or JwtModule.
 * Token validation is handled by JwtAuthGuard using supabase.auth.getUser().
 * This correctly handles Supabase's ES256-signed user session tokens.
 *
 * PrismaService is provided by the global PrismaModule.
 *
 * InviteCodesModule is imported so AuthService can redeem codes at role-select
 * time (replacing the old `_coachCode` dead param). The invite-code controller
 * lives in InviteCodesModule and mounts under /coach/invite-codes.
 */
@Module({
  imports: [ConfigModule, InviteCodesModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
