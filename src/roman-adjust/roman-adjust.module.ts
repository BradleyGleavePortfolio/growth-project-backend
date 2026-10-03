/**
 * RomanAdjustModule — Roman approve-to-adjust (deterministic recovery rule,
 * coach Approve / Edit / Dismiss / Undo, append-only audit trail).
 * Kill switch FEATURE_ROMAN_ADJUST_ENABLED, default OFF.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/roles.guard';
import { AiConsentModule } from '../ai-consent/ai-consent.module';
import { WorkoutBuilderModule } from '../workout-builder/workout-builder.module';
import { RomanAdjustController } from './roman-adjust.controller';
import { RomanAdjustFeatureGuard } from './roman-adjust.guard';
import { RomanAdjustService } from './roman-adjust.service';

@Module({
  imports: [AuthModule, AiConsentModule, WorkoutBuilderModule],
  controllers: [RomanAdjustController],
  providers: [RomanAdjustService, RomanAdjustFeatureGuard, RolesGuard],
})
export class RomanAdjustModule {}
