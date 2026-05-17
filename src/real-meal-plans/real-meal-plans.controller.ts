import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { SubscriptionGuard } from '../billing/subscription.guard';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import {
  AssignDailyPlanDto,
  CreateDailyMealPlanDto,
  CreateMealTemplateDto,
  UpdateDailyMealPlanDto,
  UpdateMealTemplateDto,
} from './real-meal-plans.dto';
import { RealMealPlansService } from './real-meal-plans.service';

@ApiTags('real-meal-plans')
@Controller()
export class CoachMealTemplatesController {
  constructor(private readonly meals: RealMealPlansService) {}

  @Post('coach/meal-templates')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  create(@Req() req: AuthedRequest, @Body() dto: CreateMealTemplateDto) {
    return this.meals.createTemplate(req.user.id, dto);
  }

  @Get('coach/meal-templates')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  list(@Req() req: AuthedRequest) {
    return this.meals.listTemplates(req.user.id);
  }

  @Get('coach/meal-templates/:id')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.meals.getTemplate(req.user.id, id);
  }

  @Patch('coach/meal-templates/:id')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateMealTemplateDto,
  ) {
    return this.meals.updateTemplate(req.user.id, id, dto);
  }

  @Delete('coach/meal-templates/:id')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  archive(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.meals.archiveTemplate(req.user.id, id);
  }
}

@ApiTags('real-meal-plans')
@Controller()
export class CoachDailyMealPlansController {
  constructor(private readonly meals: RealMealPlansService) {}

  @Post('coach/daily-meal-plans')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  create(@Req() req: AuthedRequest, @Body() dto: CreateDailyMealPlanDto) {
    return this.meals.createPlan(req.user.id, dto);
  }

  @Get('coach/daily-meal-plans')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  list(@Req() req: AuthedRequest) {
    return this.meals.listPlans(req.user.id);
  }

  @Get('coach/daily-meal-plans/:id')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.meals.getPlan(req.user.id, id);
  }

  @Patch('coach/daily-meal-plans/:id')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateDailyMealPlanDto,
  ) {
    return this.meals.updatePlan(req.user.id, id, dto);
  }

  @Delete('coach/daily-meal-plans/:id')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  archive(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.meals.archivePlan(req.user.id, id);
  }

  @Post('coach/daily-meal-plans/:id/assignments')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @HttpCode(HttpStatus.CREATED)
  assign(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: AssignDailyPlanDto,
  ) {
    return this.meals.assignPlan(req.user.id, id, dto);
  }

  @Get('coach/daily-meal-plans/:id/assignments')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  listAssignments(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.meals.listAssignmentsForCoach(req.user.id, id);
  }
}

@ApiTags('real-meal-plans')
@Controller()
@UseGuards(JwtAuthGuard, ClientEntitlementGuard)
export class ClientMealPlanController {
  constructor(private readonly meals: RealMealPlansService) {}

  // GET /me/meal-plan/today — today's plan(s). Optional ?date=YYYY-MM-DD
  // for selectively viewing a future or past day.
  @Get('me/meal-plan/today')
  today(@Req() req: AuthedRequest, @Query('date') date?: string) {
    return this.meals.getTodayForClient(req.user.id, date);
  }
}
