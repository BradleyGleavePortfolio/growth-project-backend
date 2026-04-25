import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InviteCodesModule } from '../invite-codes/invite-codes.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';
import { JwksVerifierService } from './jwks.service';

/**
 * Auth module — does not use PassportModule or JwtModule.
 *
 * Token validation is handled by JwtAuthGuard, which delegates ES256
 * signature verification to JwksVerifierService. The verifier fetches
 * Supabase's public JWK set once and verifies tokens locally — no per-
 * request round-trip to Supabase Auth.
 *
 * PrismaService is provided by the global PrismaModule.
 *
 * InviteCodesModule is imported so AuthService can redeem codes at role-
 * select time (replacing the old `_coachCode` dead param). The invite-
 * code controller lives in InviteCodesModule and mounts under
 * /coach/invite-codes.
 */
@Module({
  imports: [ConfigModule, InviteCodesModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, JwksVerifierService],
  exports: [AuthService, JwtAuthGuard, JwksVerifierService],
})
export class AuthModule {}
