import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { MealPlansService } from './meal-plans.service';
import { RealMealPlansService } from '../real-meal-plans/real-meal-plans.service';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';

// Client-authenticated meal-plan endpoints. A client only ever reads their own
// plans (service scopes every query by req.user.id).
//
// BUG-R2: `real-meal-plans` is the canonical system. `GET /meal-plans` is now
// a DEPRECATION WRAPPER — it still returns genuine legacy `MealPlan` rows but
// ALSO surfaces the client's most-recent canonical plan reshaped into the
// legacy shape, so old app versions stop seeing "no meal plan assigned" after
// a coach builds a plan via the newer `coach/daily-meal-plans` API.
@ApiTags('meal-plans')
@Controller('meal-plans')
@UseGuards(JwtAuthGuard, ClientEntitlementGuard, RolesGuard)
@Roles('student')
export class ClientMealPlansController {
  constructor(private plans: MealPlansService) {}

  @Get()
  async list(@Request() req: AuthedRequest) {
    // Deprecation wrapper: legacy rows + reshaped canonical plan (BUG-R2).
    return this.plans.listForClientWithCanonicalFallback(req.user.id);
  }

  @Get(':id')
  async getOne(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.plans.getOneForClient(req.user.id, id);
  }
}

// BUG-R2 alias on the legacy path. The modern mobile app may call
// `GET /me/meal-plan`; rather than fork it onto the legacy `MealPlan` table
// (the whole point of the dedup), this alias PROXIES straight to the canonical
// `real-meal-plans` system and returns the CANONICAL shape — identical to
// `GET /me/meal-plan/today`. Ownership is enforced by scoping the canonical
// query to `req.user.id`; no client-supplied id is trusted.
@ApiTags('meal-plans')
@Controller('me/meal-plan')
@UseGuards(JwtAuthGuard, ClientEntitlementGuard, RolesGuard)
@Roles('student')
export class ClientMealPlanAliasController {
  constructor(private readonly canonical: RealMealPlansService) {}

  // GET /me/meal-plan — canonical "today" view, proxied to real-meal-plans.
  // Optional ?date=YYYY-MM-DD mirrors the canonical endpoint's contract.
  @Get()
  async current(@Request() req: AuthedRequest, @Query('date') date?: string) {
    return this.canonical.getTodayForClient(req.user.id, date);
  }
}
