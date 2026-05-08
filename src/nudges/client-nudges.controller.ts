import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ListNudgesQueryDto } from './nudges.dto';
import { NudgesService } from './nudges.service';

// Client-authenticated nudge endpoints. A client only ever reads their own
// nudges (service scopes every query by req.user.id).
@ApiTags('nudges')
@Controller('nudges')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
 ClientNudgesController {
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
