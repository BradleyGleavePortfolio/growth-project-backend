import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CoachMoneyController } from './coach-money.controller';
import { CoachMoneyService } from './coach-money.service';

// S-COACH (agent 111) — TGP Money read model (/v1/coach/money/*).
// JwtAuthGuard, CoachOrOwnerGuard and NoActiveSubCoachGuard come from the
// @Global SecurityGuardsModule.
@Module({
  controllers: [CoachMoneyController],
  providers: [CoachMoneyService, PrismaService],
  exports: [CoachMoneyService],
})
export class CoachMoneyModule {}
