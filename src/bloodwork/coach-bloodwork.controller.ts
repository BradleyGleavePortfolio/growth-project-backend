import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { BloodworkService } from './bloodwork.service';
import {
  ListPanelsQueryDto,
  ReviewPanelDto,
  UpdateAttachmentScanDto,
} from './bloodwork.dto';

// Coach-side bloodwork surface. Same controller hosts owner-only
// scanner-callback endpoints so the wiring stays in one module.
@ApiTags('bloodwork')
@Controller('coach/bloodwork')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachBloodworkController {
  constructor(private readonly bloodwork: BloodworkService) {}

  // GET /coach/bloodwork/queue — coach review queue. Defaults to
  // submitted/needs_info/reviewed/flagged; pass review_state=submitted
  // to narrow.
  @Get('queue')
  async queue(
    @Request() req: AuthedRequest,
    @Query() query: ListPanelsQueryDto,
  ) {
    return this.bloodwork.listForCoach(req.user.id, req.user.role, query);
  }

  @Get('panels/:id')
  async get(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.bloodwork.getForCoach(req.user.id, req.user.role, id);
  }

  @Put('panels/:id/review')
  @HttpCode(HttpStatus.OK)
  async review(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ReviewPanelDto,
  ) {
    return this.bloodwork.reviewPanel(id, body, {
      actorId: req.user.id,
      actorRole: req.user.role,
      ...auditContext(req),
    });
  }

  // OWNER-only scanner callback. Mounted under /coach/bloodwork to keep
  // the wiring co-located; service-layer ForbiddenException enforces
  // the role check (coaches who somehow hit this get 403).
  @Post('attachments/:id/scan')
  @HttpCode(HttpStatus.OK)
  async updateScan(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateAttachmentScanDto,
  ) {
    return this.bloodwork.updateAttachmentScan(id, body, {
      actorId: req.user.id,
      actorRole: req.user.role,
      ...auditContext(req),
    });
  }
}

function auditContext(
  req: AuditableRequest,
): { ip: string | null; userAgent: string | null } {
  const xffRaw = req?.headers?.['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw || '';
  const fwdIp = xff.split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? uaRaw[0] ?? null : uaRaw ?? null;
  return { ip: ip || null, userAgent: userAgent || null };
}
