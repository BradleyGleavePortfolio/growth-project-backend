import { CanActivate, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CopilotService } from './copilot.service';

/** Server kill switch for Path Copilot (mirrors the app's EXPO_PUBLIC_FF_CLIENT_PATH_COPILOT). Unset = off = 404. */
export const FEATURE_CLIENT_PATH_COPILOT_ENV = 'FEATURE_CLIENT_PATH_COPILOT';
export function isCopilotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FEATURE_CLIENT_PATH_COPILOT ?? '').toLowerCase() === 'true';
}

@Injectable()
export class CopilotFeatureGuard implements CanActivate {
  canActivate(): boolean {
    if (!isCopilotEnabled()) throw new NotFoundException();
    return true;
  }
}

@Controller('client/copilot')
@UseGuards(CopilotFeatureGuard, JwtAuthGuard, RolesGuard)
@Roles('student')
export class CopilotController {
  constructor(private readonly copilot: CopilotService) {}

  @Get()
  recent(@Request() req: AuthedRequest) {
    return this.copilot.recent(req.user.id);
  }

  @Post('suggestions/:id/send')
  @HttpCode(200)
  send(@Request() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.copilot.send(req.user, id);
  }
}
