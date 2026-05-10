import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import {
  UpdateNotificationPreferencesDto,
  GetNotificationsQueryDto,
} from './notifications.dto';

/**
 * Notification Center endpoints.
 *
 * All routes are authenticated (JwtAuthGuard is the global APP_GUARD).
 * Clients only see their own notifications — user_id is always derived
 * from req.user.id, never from a query param.
 *
 * Route surface:
 *   GET  /notifications                 — paginated inbox (all or unread)
 *   POST /notifications/:id/read        — mark one notification read
 *   POST /notifications/mark-all-read   — mark all notifications read
 *   GET  /notifications/preferences     — fetch channel preferences
 *   PATCH /notifications/preferences    — update channel preferences
 *
 * The Phase 6B PUT /notifications/preferences is preserved as PATCH
 * (PATCH is semantically correct for partial updates). The old PUT
 * route is no longer present — clients should migrate to PATCH.
 * The service is backward-compatible: omitted fields are ignored.
 */
@ApiTags('notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // ── Notification center ───────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Paginated notification inbox' })
  async listNotifications(
    @Request() req: AuthedRequest,
    @Query() query: GetNotificationsQueryDto,
  ) {
    return this.notificationsService.listNotifications(req.user.id, query);
  }

  @Post('mark-all-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async markAllRead(@Request() req: AuthedRequest) {
    return this.notificationsService.markAllRead(req.user.id);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a single notification as read' })
  async markRead(
    @Param('id') id: string,
    @Request() req: AuthedRequest,
  ) {
    return this.notificationsService.markRead(id, req.user.id);
  }

  // ── Preferences ───────────────────────────────────────────────────────────

  @Get('preferences')
  @ApiOperation({ summary: 'Get notification channel preferences' })
  async getPreferences(@Request() req: AuthedRequest) {
    return this.notificationsService.getPreferences(req.user.id);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update notification channel preferences' })
  async updatePreferences(
    @Request() req: AuthedRequest,
    @Body() body: UpdateNotificationPreferencesDto,
  ) {
    return this.notificationsService.updatePreferences(req.user.id, body);
  }
}
