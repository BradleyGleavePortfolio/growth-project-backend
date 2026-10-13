/**
 * RomanModule — Phase 1 chat MVP wiring (brief §1.2).
 *
 * The module is ALWAYS imported by AppModule (so the module-graph cycle guard
 * keeps exercising it), but the surface is dark by default: RomanFeatureGuard
 * returns 404 on every route while FEATURE_ROMAN_CHAT_ENABLED is OFF, and
 * RomanService re-checks the flag before any Anthropic call. This mirrors the
 * DunningV2Module / PayoutsV2Module posture (mount-then-self-gate) rather than
 * a conditional import, which keeps the dependency graph static and testable.
 *
 * PrismaService is provided by its @Global module. Roman owns its OWN Anthropic
 * client behind ROMAN_ANTHROPIC_CLIENT (brief §4) to keep a clean blast radius
 * away from the churned src/ai/* coach-AI adapter.
 */

import { Module } from '@nestjs/common';
import { RomanController } from './roman.controller';
import { RomanChatsController } from './roman-chats.controller';
import { RomanService } from './roman.service';
import { RomanFeatureGuard } from './roman-feature.guard';
import { romanAnthropicClientProvider } from './anthropic-client.provider';
import { RomanErasureSweep } from './roman-erasure.sweep';
import { RomanTimelineReader } from './memory/roman-timeline.reader';
import { RomanReadToolbox } from './tools/roman-read-tools';
import { ROMAN_TOOLBOX } from './tools/roman-tool.types';
import { RomanClientContextService } from './context/roman-client-context.service';
import { RomanConsultationIntakeSource } from './context/roman-consultation.source';
import { PlaybookSignalsService } from './playbook/playbook-signals.service';
import { PlaybookSourceCollector } from './playbook/playbook-sources';
import { PlaybookBuilderService } from './playbook/playbook-builder.service';
import { PlaybookBuilderScheduler } from './playbook/playbook-builder.scheduler';
import { RomanContextController } from './context/roman-context.controller';
import { RomanCoachMethodAugmenter } from './playbook/roman-coach-method.augmenter';
import { ROMAN_COACH_METHOD_AUGMENTER } from './augment/roman-turn-augmenter';
import { ROMAN_SAFETY_INTAKE_SOURCE } from './context/roman-client-context.types';
import { romanTurnAugmentersProvider } from './augment/roman-turn-augmenter';
import {
  ROMAN_CLIENT_MEMORY_AUGMENTER,
  RomanClientMemoryAugmenter,
} from './memory/roman-client-memory.augmenter';
import { RomanBackgroundSpendService } from './background/roman-background-spend';
import { RomanNotesWriter } from './memory/roman-notes.writer';
import { RomanNotesScheduler } from './memory/roman-notes.scheduler';
import { CoachModule } from '../coach/coach.module';

@Module({
  // CoachAlertsService: the coach alert after an urgent-symptoms reply.
  imports: [CoachModule],
  // RomanChatsController (list + delete own chats) is not behind the chat
  // feature flag: deleting your chats never depends on Roman being on.
  // RomanContextController: GET /roman/context/me, the client's own view of
  // exactly what Roman is grounded in (behind the chat flag, students only).
  controllers: [RomanController, RomanChatsController, RomanContextController],
  // RomanErasureSweep runs regardless of FEATURE_ROMAN_CHAT_ENABLED: finishing
  // the erasure of chats a client deleted is a privacy duty, not a chat feature.
  // Grounding (OR-113-2): the context builder and its REQUIRED consultation
  // source (B-R3-1: the real #607 intake reader, never a silent default).
  providers: [
    RomanService,
    RomanFeatureGuard,
    romanAnthropicClientProvider,
    // R11-P4: the coach-method block (null unless FEATURE_ROMAN_PLAYBOOK is on).
    { provide: ROMAN_COACH_METHOD_AUGMENTER, useClass: RomanCoachMethodAugmenter },
    RomanErasureSweep,
    // R11-T1: read tools for the caller's own logs (used only by the R11-T2B loop).
    RomanTimelineReader,
    RomanReadToolbox,
    { provide: ROMAN_TOOLBOX, useExisting: RomanReadToolbox },
    RomanClientContextService,
    // R11-P3b: playbook signals, sources, builder and its schedule (all inert
    // while FEATURE_ROMAN_PLAYBOOK is off).
    PlaybookSignalsService,
    PlaybookSourceCollector,
    PlaybookBuilderService,
    PlaybookBuilderScheduler,
    RomanConsultationIntakeSource,
    { provide: ROMAN_SAFETY_INTAKE_SOURCE, useExisting: RomanConsultationIntakeSource },
    // R11-M5: the client-memory block (inert unless FEATURE_ROMAN_MEMORY is on;
    // the R11-T2A seam drops it for clients without the 'memory' grant).
    { provide: ROMAN_CLIENT_MEMORY_AUGMENTER, useClass: RomanClientMemoryAugmenter },
    // R11-00 seams: the turn-augmenter list (empty until a v1.1 slice
    // provides its kind token) and the background spend admission.
    romanTurnAugmentersProvider,
    RomanBackgroundSpendService,
    // R11-M4: notes from chats (inert while FEATURE_ROMAN_MEMORY is off).
    RomanNotesWriter,
    RomanNotesScheduler,
  ],
  exports: [RomanService, RomanBackgroundSpendService],
})
export class RomanModule {}
