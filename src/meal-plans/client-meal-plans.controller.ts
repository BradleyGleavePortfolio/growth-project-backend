import {
  Controller,
  Get,
  Param,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { MealPlansService } from './meal-plans.service';

// Client-authenticated meal-plan endpoints. A client only ever reads their own
// plans (service scopes every query by req.user.id).
@Controller('meal-plans')
@UseGuards(JwtAuthGuard)
export class ClientMealPlansController {
  constructor(private plans: MealPlansService) {}

  @Get()
  async list(@Request() req: AuthedRequest) {
    return this.plans.listForClient(req.user.id);
  }

  @Get(':id')
  async getOne(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.plans.getOneForClient(req.user.id, id);
  }
}
