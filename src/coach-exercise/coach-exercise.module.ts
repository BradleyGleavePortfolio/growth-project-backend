import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoachExerciseEnabledGuard } from './coach-exercise-flag.guard';
import { CoachExerciseRepository } from './coach-exercise.repository';
import { CoachExerciseUploadProvider } from './coach-exercise-upload.provider';

/**
 * Coach custom-exercise library module (FEATURE_CUSTOM_EXERCISE, default OFF).
 *
 * The backend half of the mobile custom-exercise authoring stack. This is the
 * storage-layer half (B1 of the stacked chain): it wires only the data-access
 * and media-presign building blocks — the repository, the Supabase signed-URL
 * upload provider, and the flag kill-switch guard. The API surface (DTO +
 * service + controller + the /coach-exercises routes) lands in the stacked B2
 * PR, which extends this same module. Registered as a single line in
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
  providers: [
    CoachExerciseRepository,
    CoachExerciseEnabledGuard,
    CoachExerciseUploadProvider,
  ],
  exports: [CoachExerciseRepository, CoachExerciseUploadProvider],
})
export class CoachExerciseModule {}
