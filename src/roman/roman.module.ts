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
import { RomanContextController } from './context/roman-context.controller';
import { ROMAN_SAFETY_INTAKE_SOURCE } from './context/roman-client-context.types';
import { romanTurnAugmentersProvider } from './augment/roman-turn-augmenter';
import { RomanBackgroundSpendService } from './background/roman-background-spend';

@Module({
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
    RomanErasureSweep,
    // R11-T1: read tools for the caller's own logs (used only by the R11-T2B loop).
    RomanTimelineReader,
    RomanReadToolbox,
    { provide: ROMAN_TOOLBOX, useExisting: RomanReadToolbox },
    RomanClientContextService,
    RomanConsultationIntakeSource,
    { provide: ROMAN_SAFETY_INTAKE_SOURCE, useExisting: RomanConsultationIntakeSource },
    // R11-00 seams: the turn-augmenter list (empty until a v1.1 slice
    // provides its kind token) and the background spend admission.
    romanTurnAugmentersProvider,
    RomanBackgroundSpendService,
  ],
  exports: [RomanService, RomanBackgroundSpendService],
})
export class RomanModule {}
