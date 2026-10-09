import {
  Body,
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
import { CreateCheckInDto, ListCheckInsQueryDto } from './check-ins.dto';
import { CheckInsService } from './check-ins.service';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import { OpenToCoachlessClient } from '../common/decorators/open-to-coachless-client.decorator';

// Client-authenticated check-in endpoints. Every query scoped by req.user.id
// so a client can never see/create a check-in for another user.
@ApiTags('check-ins')
@Controller('check-ins')
@UseGuards(JwtAuthGuard, RolesGuard, ClientEntitlementGuard)
@Roles('student')
// B23: a client with no coach checks in like any client (no coach alert fires).
@OpenToCoachlessClient()
export class ClientCheckInsController {
  constructor(private checkIns: CheckInsService) {}

  // Upsert on (user_id, date). Same-day second POST updates in place.
  @Post()
  async upsert(
    @Request() req: AuthedRequest,
    @Body() body: CreateCheckInDto,
  ) {
    return this.checkIns.upsertForClient(req.user.id, body);
  }

  @Get()
  async list(
    @Request() req: AuthedRequest,
    @Query() query: ListCheckInsQueryDto,
  ) {
    return this.checkIns.listForClient(req.user.id, query);
  }

  @Get(':id')
  async getOne(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
  ) {
    return this.checkIns.getOneForClient(req.user.id, id);
  }
}
