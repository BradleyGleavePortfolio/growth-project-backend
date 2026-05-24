import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InviteCodesModule } from '../invite-codes/invite-codes.module';
import { ThrottlerModule } from '../throttler/throttler.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AppleVerifierService } from './apple-verifier.service';
import { GoogleVerifierService } from './google-verifier.service';

/**
 * Auth module — does not use PassportModule or JwtModule.
 *
 * Token validation is handled by `JwtAuthGuard`, which delegates ES256
 * signature verification to `JwksVerifierService`. The verifier fetches
 * Supabase's published JWK set once and verifies tokens locally — no
 * per-request round-trip to Supabase Auth.
 *
 * `JwtAuthGuard`, `JwksVerifierService`, `RolesGuard`, and `RecentAuthGuard`
 * are provided by the @Global `SecurityGuardsModule`
 * (see `src/common/security/security-guards.module.ts`). That module is
 * loaded before AuthModule in AppModule, so the guards are in DI scope for
 * both `@UseGuards(JwtAuthGuard)` in this module's controller and for every
 * downstream feature module — without anyone needing to import AuthModule
 * itself.
 *
 * Keeping guards out of AuthModule's provider list is load-bearing for
 * cycle prevention: hotfix #243 (prod-down 2026-05-20) traced a boot
 * crash to AuthModule ↔ InviteCodesModule ↔ BillingModule ↔ CheckoutModule
 * cycles formed because feature modules imported AuthModule *only* to put
 * the guards into local DI. With the guards globalised, those edges no
 * longer need to exist.
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
  providers: [AuthService, AppleVerifierService, GoogleVerifierService],
  exports: [AuthService, AppleVerifierService, GoogleVerifierService],
})
export class AuthModule {}
