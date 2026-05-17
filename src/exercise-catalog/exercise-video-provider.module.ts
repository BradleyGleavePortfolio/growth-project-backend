/**
 * ExerciseVideoProviderModule — provides the multi-source video lookup
 * stack (YMove + MuscleWiki) to the rest of the application.
 *
 * Exported services:
 *   ExerciseVideoFallbackService  — primary consumer API
 *   YMoveVideoProvider            — exposed for direct use / testing
 *   MuscleWikiVideoProvider       — exposed for direct use / testing
 *
 * The providers are constructed with a null Redis client by default;
 * ExerciseVideoFallbackService.onModuleInit() connects Redis and
 * injects the shared client into both providers at startup.
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  ExerciseVideoFallbackService,
  MuscleWikiVideoProvider,
  YMoveVideoProvider,
} from './exercise-video-provider.service';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: YMoveVideoProvider,
      useFactory: (config: ConfigService) =>
        new YMoveVideoProvider(config, null /* Redis injected at init */),
      inject: [ConfigService],
    },
    {
      provide: MuscleWikiVideoProvider,
      useFactory: (config: ConfigService) =>
        new MuscleWikiVideoProvider(config, null /* Redis injected at init */),
      inject: [ConfigService],
    },
    ExerciseVideoFallbackService,
  ],
  exports: [
    ExerciseVideoFallbackService,
    YMoveVideoProvider,
    MuscleWikiVideoProvider,
  ],
})
export class ExerciseVideoProviderModule {}
