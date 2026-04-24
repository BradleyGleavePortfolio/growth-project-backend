import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ListNudgesQueryDto } from './nudges.dto';
import { NudgesService } from './nudges.service';

// Client-authenticated nudge endpoints. A client only ever reads their own
// nudges (service scopes every query by req.user.id).
@Controller('nudges')
@UseGuards(JwtAuthGuard)
export class ClientNudgesController {
  constructor(private nudges: NudgesService) {}

  @Get()
  async list(
    @Request() req: AuthedRequest,
    @Query() query: ListNudgesQueryDto,
  ) {
    return this.nudges.listForClient(req.user.id, query);
  }

  @Get('unread-count')
  async unreadCount(@Request() req: AuthedRequest) {
    return this.nudges.unreadCountForClient(req.user.id);
  }

  @Post(':id/read')
  async markRead(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
  ) {
    return this.nudges.markReadByClient(req.user.id, id);
  }
}
