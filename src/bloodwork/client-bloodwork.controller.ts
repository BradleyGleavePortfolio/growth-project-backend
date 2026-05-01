import {
  Body,
  Controller,
  Delete,
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
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { BloodworkService } from './bloodwork.service';
import {
  CreateBloodworkPanelDto,
  ListPanelsQueryDto,
  RegisterAttachmentDto,
  UpdateBloodworkPanelDto,
} from './bloodwork.dto';

// Client-facing bloodwork surface. Every route is scoped to req.user.id —
// a client can never see another client's panels. Storage consent
// (health.bloodwork) is enforced inside the service so the same gate
// applies whether a panel comes through this controller or a future
// admin path.
@ApiTags('bloodwork')
@Controller('bloodwork')
@UseGuards(JwtAuthGuard)
export class ClientBloodworkController {
  constructor(private readonly bloodwork: BloodworkService) {}

  @Post('panels')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Request() req: AuthedRequest,
    @Body() body: CreateBloodworkPanelDto,
  ) {
    return this.bloodwork.createPanel(req.user.id, body, {
      actorId: req.user.id,
      actorRole: req.user.role,
      ...auditContext(req),
    });
  }

  @Get('panels')
  async list(
    @Request() req: AuthedRequest,
    @Query() query: ListPanelsQueryDto,
  ) {
    return this.bloodwork.listForClient(req.user.id, query);
  }

  @Get('panels/:id')
  async get(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.bloodwork.getForClient(req.user.id, id);
  }

  @Put('panels/:id')
  async update(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateBloodworkPanelDto,
  ) {
    return this.bloodwork.updateDraftPanel(req.user.id, id, body, {
      actorId: req.user.id,
      actorRole: req.user.role,
      ...auditContext(req),
    });
  }

  @Post('panels/:id/submit')
  @HttpCode(HttpStatus.OK)
  async submit(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.bloodwork.submitPanel(req.user.id, id, {
      actorId: req.user.id,
      actorRole: req.user.role,
      ...auditContext(req),
    });
  }

  @Delete('panels/:id')
  @HttpCode(HttpStatus.OK)
  async remove(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.bloodwork.deleteDraftPanel(req.user.id, id, {
      actorId: req.user.id,
      actorRole: req.user.role,
      ...auditContext(req),
    });
  }

  @Post('panels/:id/attachments')
  @HttpCode(HttpStatus.CREATED)
  async registerAttachment(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: RegisterAttachmentDto,
  ) {
    return this.bloodwork.registerAttachment(id, body, {
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
