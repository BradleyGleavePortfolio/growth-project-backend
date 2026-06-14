// src/coach/home/coach-home.module.ts
//
// ED.2 (Roman three-arc router) — wires the daily-rings counts controller +
// service under /coach/home/*. Reads existing repositories only (CheckIn,
// CoachBrief, ConversationReview, CoachMessage via PrismaService) — no new
// Prisma model. Flag-gated behind FEATURE_ROMAN_THREE_ARC_COUNTS (default OFF)
// inside the service.

import { Module } from '@nestjs/common';
import { CoachHomeController } from './coach-home.controller';
import { CoachHomeService } from './coach-home.service';
import { PrismaService } from '../../prisma.service';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [CoachHomeController],
  providers: [PrismaService, CoachHomeService],
  exports: [CoachHomeService],
})
export class CoachHomeModule {}
