import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { CreateMealPlanDto, UpdateMealPlanDto } from './meal-plans.dto';
import { MealPlansService } from './meal-plans.service';

// Coach-authenticated meal-plan endpoints. Mounted under /coach alongside the
// existing coach routes but kept in its own controller so none of the
// already-shipped coach endpoint metadata/guards move (matches the pattern
// used by CoachMessagingController / CoachNudgesController).
@ApiTags('meal-plans')
@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachMealPlansController {
  constructor(private plans: MealPlansService) {}

  @Get('clients/:client_id/meal-plans')
  async list(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
  ) {
    return this.plans.listForClientByCoach(req.user.id, clientId);
  }

  @Post('clients/:client_id/meal-plans')
  async create(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() body: CreateMealPlanDto,
  ) {
    return this.plans.createForClient(req.user.id, clientId, body);
  }

  @Patch('meal-plans/:id')
  async update(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateMealPlanDto,
  ) {
    return this.plans.updateByCoach(req.user.id, id, body);
  }

  @Delete('meal-plans/:id')
  async archive(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
  ) {
    return this.plans.archiveByCoach(req.user.id, id);
  }
}
