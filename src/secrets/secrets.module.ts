import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/roles.guard';
import { SecretsController } from './secrets.controller';
import { SecretsService } from './secrets.service';

/**
 * SecretsModule — Phase 10 secrets rotation.
 *
 * Provides:
 *   - GET  /admin/secrets/status          — OWNER-only list of all tracked secrets
 *                                           with rotation metadata (no values)
 *   - POST /admin/secrets/:name/rotation-log — record a rotation event
 *
 * AuthModule is imported to wire JwtAuthGuard + JwksVerifierService into
 * this module's DI scope. RolesGuard is provided locally.
 */
@Module({
  imports: [AuthModule],
  controllers: [SecretsController],
  providers: [SecretsService, RolesGuard],
  exports: [SecretsService],
})
export class SecretsModule {}
