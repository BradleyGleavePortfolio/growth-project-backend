import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  getWelcomeSettings,
  updateWelcomeSettings,
  WelcomeSettingsError,
  type WelcomeSettingsView,
} from './welcome-settings';
import { WELCOME_TEMPLATE_MAX_LENGTH } from './welcome-template';

export class UpdateWelcomeSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  // null clears the coach template (back to the generic default).
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(WELCOME_TEMPLATE_MAX_LENGTH)
  template?: string | null;
}

// Owner-only (platform owner role). The operator uses this, or the script
// scripts/set-coach-welcome-message.ts, to enable the welcome message for a
// coach and set that coach's template at bootstrap. The template text is
// never logged or written to the audit metadata.
@ApiTags('admin')
@Controller('admin/coaches/:coachId/welcome-message')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class WelcomeSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Read a coach's welcome-message flag and template (owner only)." })
  async get(@Param('coachId', ParseUUIDPipe) coachId: string): Promise<WelcomeSettingsView> {
    try {
      return await getWelcomeSettings(this.prisma, coachId);
    } catch (err) {
      throw mapError(err);
    }
  }

  @Put()
  @ApiOperation({
    summary: "Enable/disable a coach's welcome message and set its template (owner only).",
  })
  async put(
    @Request() req: AuthedRequest,
    @Param('coachId', ParseUUIDPipe) coachId: string,
    @Body() body: UpdateWelcomeSettingsDto,
  ): Promise<WelcomeSettingsView> {
    let out: WelcomeSettingsView;
    try {
      out = await updateWelcomeSettings(
        this.prisma,
        coachId,
        { enabled: body.enabled, template: body.template },
        req.user.id,
      );
    } catch (err) {
      throw mapError(err);
    }
    void this.audit.write({
      action: 'engagement.welcome_settings.updated',
      actorId: req.user.id,
      actorRole: 'owner',
      targetUserId: coachId,
      targetType: 'coach_welcome_setting',
      targetId: coachId,
      tenantCoachId: coachId,
      metadata: {
        enabled: out.enabled,
        custom_template: out.template !== null,
        template_length: out.template?.length ?? 0,
      },
    });
    return out;
  }
}

const INVALID_TEMPLATE_MESSAGES: Record<string, string> = {
  empty: 'The welcome text is empty. Send the text, or null to use the default.',
  too_long: `The welcome text is longer than ${WELCOME_TEMPLATE_MAX_LENGTH} characters. Shorten it and send it again.`,
  unknown_placeholder:
    'The welcome text uses a placeholder that is not supported. Use only {first_name} and {coach_first_name}.',
  unbalanced_braces:
    'The welcome text has a brace that is not part of a placeholder. Remove it, or use {first_name} or {coach_first_name}.',
};

/**
 * Every failure carries a stable machine `code` and a message that says what
 * happened and what to do next. Unknown errors are rethrown unchanged so the
 * global filter reports them (request id + Sentry).
 */
export function mapError(err: unknown): Error {
  if (err instanceof WelcomeSettingsError) {
    if (err.code === 'coach_not_found') {
      return new NotFoundException({
        code: err.code,
        message: 'No active coach account has this id. Check the coach id and try again.',
      });
    }
    if (err.code === 'nothing_to_update') {
      return new BadRequestException({
        code: err.code,
        message: 'Nothing to change. Send enabled, template, or both.',
      });
    }
    const reason = (err.detail ?? '').split(':')[0];
    return new BadRequestException({
      code: err.code,
      message:
        INVALID_TEMPLATE_MESSAGES[reason] ??
        'The welcome text could not be saved. Check the text and send it again.',
      detail: err.detail,
    });
  }
  if (err instanceof Error) return err;
  return new InternalServerErrorException({
    code: 'welcome_settings_failed',
    message:
      'The welcome setting could not be read or saved. Try again, and contact support if it keeps failing.',
  });
}
