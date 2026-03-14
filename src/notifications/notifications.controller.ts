import { Controller, Get, Put, Body, UseGuards, Request } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Get('preferences')
  async getPreferences(@Request() req) {
    return this.notificationsService.getPreferences(req.user.id);
  }

  @Put('preferences')
  async updatePreferences(@Request() req, @Body() body: any) {
    return this.notificationsService.updatePreferences(req.user.id, body);
  }
}
