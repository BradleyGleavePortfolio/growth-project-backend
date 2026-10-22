import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/roles.guard';
import { CopilotController, CopilotFeatureGuard } from './copilot.controller';
import { CopilotService } from './copilot.service';

/** COPILOT-BE: Path Copilot, the client's side (owner #162-1 style A). AiEgressService comes from the global AiEgressModule. */
@Module({
  imports: [AuthModule],
  controllers: [CopilotController],
  providers: [CopilotService, CopilotFeatureGuard, RolesGuard],
})
export class CopilotModule {}
