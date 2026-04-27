import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ClientAIContextService } from './client-ai-context.service';
import { AIGuardrailsService } from './ai-guardrails.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService comes from the global PrismaModule — do not re-declare it here.
@Module({
  imports: [AuthModule],
  controllers: [AiController],
  providers: [AiService, ClientAIContextService, AIGuardrailsService],
  exports: [AiService, ClientAIContextService, AIGuardrailsService],
})
export class AiModule {}
