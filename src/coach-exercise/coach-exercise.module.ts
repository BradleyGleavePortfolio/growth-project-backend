import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoachExerciseController } from './coach-exercise.controller';
import { CoachExerciseEnabledGuard } from './coach-exercise-flag.guard';
import { CoachExerciseRepository } from './coach-exercise.repository';
import { CoachExerciseService } from './coach-exercise.service';
import { CoachExerciseUploadProvider } from './coach-exercise-upload.provider';

/**
 * Coach custom-exercise library module (FEATURE_CUSTOM_EXERCISE, default OFF).
 *
 * The backend half of the mobile custom-exercise authoring stack. Mounts the
 * /coach-exercises controller. Self-contained, registered as a single line in
 * AppModule.imports.
 *
 *   - AuthModule supplies JwtAuthGuard / RolesGuard — the same import every
 *     other coach surface uses.
 *   - CoachExerciseUploadProvider is the Supabase signed-upload / signed-download
 *     helper (mirrors VoiceUploadProvider). It injects SupabaseService, exported
 *     by the @Global SupabaseModule, so it needs no explicit import here.
 *   - PrismaService comes from the @Global PrismaModule; no explicit import.
 */
@Module({
  imports: [AuthModule],
  controllers: [CoachExerciseController],
  providers: [
    CoachExerciseService,
    CoachExerciseRepository,
    CoachExerciseEnabledGuard,
    CoachExerciseUploadProvider,
  ],
  exports: [CoachExerciseService],
})
export class CoachExerciseModule {}
