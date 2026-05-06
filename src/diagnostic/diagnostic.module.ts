import { Module } from '@nestjs/common';
import { DiagnosticController } from './diagnostic.controller';
import { DiagnosticService } from './diagnostic.service';
import { AiRoadmapService } from './ai-roadmap.service';

/**
 * Phase 3 — 40-point diagnostic + AI roadmap module.
 *
 * Self-contained: PrismaService comes from the global PrismaModule. The
 * AI client is built locally in AiRoadmapService rather than depending on
 * AiService, because AiService is bound to authenticated client context
 * (macros, coach, logs) which has no meaning for an anonymous lead.
 */
@Module({
  controllers: [DiagnosticController],
  providers: [DiagnosticService, AiRoadmapService],
  exports: [DiagnosticService],
})
export class DiagnosticModule {}
