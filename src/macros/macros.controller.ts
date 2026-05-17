import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import { CreateMacroTargetDto } from './macros.dto';
import { MacrosService, type Goal } from './macros.service';

@ApiTags('macros')
@Controller()
export class CoachMacrosController {
  constructor(private readonly macros: MacrosService) {}

  // POST /coach/clients/:clientId/macros — set a new target. Throttled
  // to make automated bulk-write abuse expensive while leaving a
  // working coach plenty of room.
  @Post('coach/clients/:clientId/macros')
  @UseGuards(JwtAuthGuard, CoachGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  create(
    @Req() req: AuthedRequest,
    @Param('clientId') clientId: string,
    @Body() dto: CreateMacroTargetDto,
  ) {
    return this.macros.createForClient(req.user.id, clientId, dto);
  }

  // GET /coach/clients/:clientId/macros — full history (newest first).
  @Get('coach/clients/:clientId/macros')
  @UseGuards(JwtAuthGuard, CoachGuard)
  list(@Req() req: AuthedRequest, @Param('clientId') clientId: string) {
    return this.macros.listForClientByCoach(req.user.id, clientId);
  }

  // GET /coach/clients/:clientId/macros/current — convenience read of
  // the active target only.
  @Get('coach/clients/:clientId/macros/current')
  @UseGuards(JwtAuthGuard, CoachGuard)
  async current(
    @Req() req: AuthedRequest,
    @Param('clientId') clientId: string,
  ) {
    // Tenancy check happens via list() pathway above; reuse list to get
    // the current row without a second guard call.
    const all = await this.macros.listForClientByCoach(req.user.id, clientId);
    const now = Date.now();
    return all.find((t) => t.effective_from.getTime() <= now) ?? null;
  }

  @Delete('coach/macros/:targetId')
  @UseGuards(JwtAuthGuard, CoachGuard)
  archive(@Req() req: AuthedRequest, @Param('targetId') targetId: string) {
    return this.macros.archiveByCoach(req.user.id, targetId);
  }

  // POST /coach/macros/preset — quick-set calculator. Pure function;
  // does not write to the DB. The coach can edit before persisting.
  @Post('coach/macros/preset')
  @UseGuards(JwtAuthGuard, CoachGuard)
  preset(
    @Req() _req: AuthedRequest,
    @Body()
    body: {
      weight_kg: number;
      height_cm: number;
      age_years: number;
      sex: 'male' | 'female';
      activity_level: string;
      goal: Goal;
    },
  ) {
    if (
      typeof body.weight_kg !== 'number' ||
      body.weight_kg <= 0 ||
      typeof body.height_cm !== 'number' ||
      body.height_cm <= 0 ||
      typeof body.age_years !== 'number' ||
      body.age_years <= 0 ||
      (body.sex !== 'male' && body.sex !== 'female') ||
      !['cut', 'maintain', 'bulk'].includes(body.goal)
    ) {
      throw new BadRequestException('Invalid preset input');
    }
    return this.macros.computePreset({
      weight_kg: body.weight_kg,
      height_cm: body.height_cm,
      age_years: body.age_years,
      sex: body.sex,
      activity_level: body.activity_level as
        | 'sedentary'
        | 'light'
        | 'moderate'
        | 'active'
        | 'very_active',
      goal: body.goal,
    });
  }
}

@ApiTags('macros')
@Controller()
@UseGuards(JwtAuthGuard, ClientEntitlementGuard)
export class ClientMacrosController {
  constructor(private readonly macros: MacrosService) {}

  // GET /me/macros/current — the client reads their own active target,
  // shown in the nutrition log header.
  @Get('me/macros/current')
  current(@Req() req: AuthedRequest) {
    return this.macros.getCurrentForSelf(req.user.id);
  }
}
