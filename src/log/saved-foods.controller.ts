import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { OpenToCoachlessClient } from '../common/decorators/open-to-coachless-client.decorator';
import { AddFavoriteDto, CreateSavedMealDto, LogSavedMealDto, RenameSavedMealDto } from './saved-foods.dto';
import { SavedFoodsService } from './saved-foods.service';
import { withClientKey } from './log.dto';

/**
 * FOODSAVED: the client's own favourite foods and saved meals for the add
 * sheet. Basic self logging like /log/food and /foods, so open to every client
 * (coachless included) and during a dunning lock (owner 10-08 23:5x, NOLOCK-R).
 */
@ApiTags('food')
@Controller('me/foods')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
@OpenToCoachlessClient()
export class SavedFoodsController {
  constructor(private saved: SavedFoodsService) {}

  @Get('favorites')
  listFavorites(@Request() req: AuthedRequest) {
    return this.saved.listFavorites(req.user.id);
  }

  @Post('favorites')
  addFavorite(@Request() req: AuthedRequest, @Body() body: AddFavoriteDto) {
    return this.saved.addFavorite(req.user.id, body.food_item_id);
  }

  @Delete('favorites/:foodItemId')
  removeFavorite(@Request() req: AuthedRequest, @Param('foodItemId') foodItemId: string) {
    return this.saved.removeFavorite(req.user.id, foodItemId);
  }

  @Get('saved-meals')
  listSavedMeals(@Request() req: AuthedRequest) {
    return this.saved.listSavedMeals(req.user.id);
  }

  @Post('saved-meals')
  createSavedMeal(@Request() req: AuthedRequest, @Body() body: CreateSavedMealDto) {
    return this.saved.createSavedMeal(req.user.id, body);
  }

  @Patch('saved-meals/:id')
  renameSavedMeal(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: RenameSavedMealDto) {
    return this.saved.renameSavedMeal(req.user.id, id, body.name);
  }

  @Delete('saved-meals/:id')
  deleteSavedMeal(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.saved.deleteSavedMeal(req.user.id, id);
  }

  // R6: the key is body.client_uuid, or the Idempotency-Key header when the body has none.
  @Post('saved-meals/:id/log')
  logSavedMeal(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: LogSavedMealDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.saved.logSavedMeal(req.user.id, id, withClientKey(body, idempotencyKey));
  }
}
