import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InviteCodesModule } from '../invite-codes/invite-codes.module';
import { ThrottlerModule } from '../throttler/throttler.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';
import { JwksVerifierService } from './jwks.service';
import { AppleVerifierService } from './apple-verifier.service';

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
 *
 * ThrottlerModule (src/throttler/throttler.module.ts) is imported to
 * inject LoginThrottleResetService, which clears per-IP login counters
 * after a successful authentication so bad-Wi-Fi retry storms don't lock
 * out legitimate users.
 */
@Module({
  imports: [ConfigModule, InviteCodesModule, ThrottlerModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, JwksVerifierService, AppleVerifierService],
  exports: [AuthService, JwtAuthGuard, JwksVerifierService, AppleVerifierService],
})
export class AuthModule {}
