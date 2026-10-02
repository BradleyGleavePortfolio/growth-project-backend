import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SaveConsultationDto } from './onboarding.dto';
import { OnboardingService } from './onboarding.service';

/** Client-side consultation onboarding (contract: clinic onboarding v1). */
@ApiTags('onboarding')
@Controller('me/onboarding')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  get(@Request() req: AuthedRequest) {
    return this.onboarding.getOnboarding(req.user.id);
  }

  @Put('consultation')
  save(@Request() req: AuthedRequest, @Body() body: SaveConsultationDto) {
    return this.onboarding.saveConsultation(req.user.id, body);
  }

  @Post('complete')
  @HttpCode(200)
  complete(@Request() req: AuthedRequest) {
    return this.onboarding.complete(req.user.id);
  }
}

/**
 * Coach read of a client's consultation. @Roles lists EVERY Role enum value
 * on purpose (coach, student, owner, sub_coach) so the route never answers
 * 403 for any signed-in role (test/coach-onboarding.controller.spec.ts
 * enumerates the enum, so a new role cannot silently reintroduce a 403): the
 * tenancy check in OnboardingService.canCoachRead decides, and every refusal
 * (foreign coach, sub-coach of another head, the client themselves, other
 * clients) is the same 404, which does not reveal whether a client exists.
 */
@ApiTags('onboarding')
@Controller('coach/clients')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('coach', 'student', 'owner', 'sub_coach')
export class CoachConsultationController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get(':clientId/consultation')
  read(
    @Request() req: AuthedRequest,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
    @Query('revision', new DefaultValuePipe(0), ParseIntPipe) revision: number,
  ) {
    return this.onboarding.getCoachConsultation(
      req.user.id,
      clientId,
      revision > 0 ? revision : undefined,
    );
  }

  @Get(':clientId/consultation/revisions')
  revisions(
    @Request() req: AuthedRequest,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
  ) {
    return this.onboarding.listCoachConsultationRevisions(req.user.id, clientId);
  }
}
