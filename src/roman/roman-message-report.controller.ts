import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { REPORT_REASONS, type ReportReason } from '../messages-safety/dto/report-message.dto';
import { assertRomanHasCoach } from './roman-requires-coach';
import { RomanMessageReportResult, RomanMessageReportService } from './roman-message-report.service';

/** The body of a Roman report: the DM report's reason list and details cap; no message text. */
export class ReportRomanMessageDto {
  @IsEnum(REPORT_REASONS)
  reason!: ReportReason;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string;
}

/**
 * ROMAN-HOLD-BE: POST /roman/messages/:id/report, the server half of press-and-hold Report on one of
 * Roman's replies (owner #197-D3). Not behind the Roman chat switch, like the chat list and delete
 * routes (RomanChatsController). Every signed-in role, limited like POST /messages/report (20 an hour).
 * A client with no coach gets 403 ROMAN_REQUIRES_COACH (owner rule 139-15, product rule 3): the
 * coachless exemptions are owner rulings (CONTRACT-2) and this route is not one of them.
 */
@Controller('roman')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RomanMessageReportController {
  constructor(private readonly reports: RomanMessageReportService) {}

  @Roles('student', 'coach', 'owner')
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @Post('messages/:id/report')
  report(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: ReportRomanMessageDto,
  ): Promise<RomanMessageReportResult> {
    assertRomanHasCoach(req.user);
    const body: { reason: ReportReason; details?: string } = { reason: dto.reason };
    if (dto.details !== undefined) body.details = dto.details;
    return this.reports.report({ id: req.user.id, role: req.user.role }, id, body);
  }
}
