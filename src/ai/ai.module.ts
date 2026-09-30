import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ClientAIContextService } from './client-ai-context.service';
import { AIGuardrailsService } from './ai-guardrails.service';
import { AuthModule } from '../auth/auth.module';
import { RomanModule } from '../roman/roman.module';

// PrismaService comes from the global PrismaModule — do not re-declare it here.
// RomanModule provides AiProcessingConsentGuard for POST /ai/chat (R2).
@Module({
  imports: [AuthModule, RomanModule],
  controllers: [AiController],
  providers: [AiService, ClientAIContextService, AIGuardrailsService],
  exports: [AiService, ClientAIContextService, AIGuardrailsService],
})
export class AiModule {}
