import { Controller, Get, Put, Body, UseGuards, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { UpdateNotificationPreferencesDto } from './notifications.dto';

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Get('preferences')
  async getPreferences(@Request() req: AuthedRequest) {
    return this.notificationsService.getPreferences(req.user.id);
  }

  @Put('preferences')
  async updatePreferences(@Request() req: AuthedRequest, @Body() body: UpdateNotificationPreferencesDto) {
    return this.notificationsService.updatePreferences(req.user.id, body);
  }
}
