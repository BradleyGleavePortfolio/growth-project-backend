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
import { CreateCheckInDto, ListCheckInsQueryDto } from './check-ins.dto';
import { CheckInsService } from './check-ins.service';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';

// Client-authenticated check-in endpoints. Every query scoped by req.user.id
// so a client can never see/create a check-in for another user.
@ApiTags('check-ins')
@Controller('check-ins')
@UseGuards(JwtAuthGuard, ClientEntitlementGuard)
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
