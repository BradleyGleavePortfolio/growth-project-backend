import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { CreateInviteCodeDto } from './invite-codes.dto';
import { InviteCodesService } from './invite-codes.service';

// Coach-authenticated endpoints for managing invite codes. Mounted under
// /coach/invite-codes to sit alongside the existing coach routes (see
// CoachController). The public validate endpoint lives on AuthController so it
// can be hit pre-signup without a JWT.
@Controller('coach/invite-codes')
@UseGuards(JwtAuthGuard, CoachGuard)
export class InviteCodesController {
  constructor(private inviteCodes: InviteCodesService) {}

  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Body() body: CreateInviteCodeDto,
  ) {
    return this.inviteCodes.createForCoach(req.user.id, body);
  }

  @Get()
  async list(@Request() req: AuthedRequest) {
    return this.inviteCodes.listForCoach(req.user.id);
  }

  @Delete(':id')
  async revoke(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.inviteCodes.revokeForCoach(req.user.id, id);
  }
}
