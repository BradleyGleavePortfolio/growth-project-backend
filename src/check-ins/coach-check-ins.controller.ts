import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { ListCheckInsQueryDto } from './check-ins.dto';
import { CheckInsService } from './check-ins.service';

// Coach-authenticated check-in reads. Mounted under /coach so it sits next
// to the existing coach routes without modifying CoachController (same
// separation-of-concerns pattern as CoachNudgesController).
@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachCheckInsController {
  constructor(private checkIns: CheckInsService) {}

  @Get('clients/:client_id/check-ins')
  async list(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Query() query: ListCheckInsQueryDto,
  ) {
    return this.checkIns.listForClientByCoach(req.user.id, clientId, query);
  }
}
