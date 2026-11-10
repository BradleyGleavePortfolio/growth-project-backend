import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Headers,
  Optional,
  Param,
  Query,
  UseGuards,
  Request,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { LogService } from './log.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { LogFoodDto, UpdateLogEntryDto, withClientKey } from './log.dto';
import { ImageUploadUrlDto } from '../community/dto/community-message.dto';
import { AttachMealPhotoDto } from './meal-photo.dto';
import { MealPhotoService } from './meal-photo.service';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import { OpenToCoachlessClient } from '../common/decorators/open-to-coachless-client.decorator';
import { keepRomanContextFor } from '../roman/context/roman-context-invalidation';

@ApiTags('log')
@Controller('log')
@UseGuards(JwtAuthGuard, ClientEntitlementGuard, RolesGuard)
@Roles('student')
// B23: a client with no coach logs food from day one.
@OpenToCoachlessClient()
export class LogController {
  constructor(
    private logService: LogService,
    // Optional only for tests that mount this controller with a hand-built LogService; LogModule wires it.
    @Optional() private mealPhotos?: MealPhotoService,
  ) {}

  private photos(): MealPhotoService {
    if (!this.mealPhotos) throw new ServiceUnavailableException({ error: 'unavailable', code: 'log.photo.storage_unavailable' });
    return this.mealPhotos;
  }

  // R6: the key is body.client_uuid, or the Idempotency-Key header when the body has none.
  // A keyed resend stores nothing new, so it keeps Roman's context.
  @Post('food')
  async logFood(
    @Request() req: AuthedRequest,
    @Body() body: LogFoodDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.logService.logFood(req.user.id, withClientKey(body, idempotencyKey), () =>
      keepRomanContextFor(req),
    );
  }

  @Get('daily')
  async getDaily(@Request() req: AuthedRequest, @Query('date') date: string) {
    const d = date || new Date().toISOString().split('T')[0];
    return this.logService.getDaily(req.user.id, d);
  }

  @Put('food/:id')
  async updateEntry(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: UpdateLogEntryDto) {
    return this.logService.updateEntry(req.user.id, id, body);
  }

  @Delete('food/:id')
  async deleteEntry(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.logService.deleteEntry(req.user.id, id);
  }

  // MEAL-PHOTO-BE: a meal photo kept with one of the caller's own food entries (meal-photo.service.ts).
  @Post('food/photo/upload-url')
  async mealPhotoUploadUrl(@Request() req: AuthedRequest, @Body() _body: ImageUploadUrlDto) {
    return this.photos().uploadUrl(req.user.id);
  }

  @Put('food/:id/photo')
  async attachMealPhoto(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: AttachMealPhotoDto) {
    return this.photos().attach(req.user.id, id, body);
  }

  @Delete('food/:id/photo')
  async deleteMealPhoto(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.photos().remove(req.user.id, id);
  }

  @Get('weekly')
  async getWeekly(@Request() req: AuthedRequest, @Query('week_start') weekStart: string) {
    const ws = weekStart || new Date().toISOString().split('T')[0];
    return this.logService.getWeekly(req.user.id, ws);
  }
}
