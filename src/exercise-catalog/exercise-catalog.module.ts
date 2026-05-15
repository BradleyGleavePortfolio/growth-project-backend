/**
 * ExerciseCatalogModule — internal canonical catalog with Mux video support.
 *
 * Pairs with VideoModule (provides MuxService). Exports
 * ExerciseCatalogService so other modules — workout-builder, in
 * particular — can enrich exercise rows with playback URLs.
 */

import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { OwnerGuard } from '../common/guards/owner.guard';
import { VideoModule } from '../video/video.module';
import {
  AdminExerciseCatalogController,
  ExerciseCatalogController,
} from './exercise-catalog.controller';
import { ExerciseCatalogService } from './exercise-catalog.service';

// Same pattern as MacrosModule / MealPlansModule: provide the guards
// + JwksVerifierService locally rather than pulling AuthModule (avoids
// circular imports). PrismaService is global.
@Module({
  imports: [VideoModule],
  controllers: [ExerciseCatalogController, AdminExerciseCatalogController],
  providers: [
    ExerciseCatalogService,
    JwtAuthGuard,
    JwksVerifierService,
    OwnerGuard,
  ],
  exports: [ExerciseCatalogService],
})
export class ExerciseCatalogModule {}
