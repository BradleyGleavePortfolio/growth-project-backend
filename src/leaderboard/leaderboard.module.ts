// Phase 7C — Leaderboard Module.
// Wires together LeaderboardController, LeaderboardService,
// and LeaderboardScheduler.
//
// Register in AppModule:
//   import { LeaderboardModule } from './leaderboard/leaderboard.module';
//   // Add LeaderboardModule to the imports array.
//
// PrismaModule is globally exported, so no explicit import is needed here.

import { Module } from '@nestjs/common';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardScheduler } from './leaderboard.scheduler';

@Module({
  controllers: [LeaderboardController],
  providers:   [LeaderboardService, LeaderboardScheduler],
  exports:     [LeaderboardService],
})
export class LeaderboardModule {}
