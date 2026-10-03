import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { OwnerGuard } from '../common/guards/owner.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachlessFeatureGuard } from './coachless-feature.guard';
import { CoachCodeDto, FeaturedCoachConfigDto } from './coachless.dto';
import { CoachCodeRedemptionService } from './coach-code-redemption.service';
import { CoachlessHomeService } from './coachless-home.service';
import { CoachlessPromptService, decideRomanCard } from './coachless-prompt.service';
import { FeaturedCoachService } from './featured-coach.service';
import { COACHLESS_ERROR, COACHLESS_ERROR_MESSAGE, CoachlessError } from './coachless.errors';

function headerValue(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : (v ?? '')).trim();
}

/**
 * A1-COACHLESS client routes. All behind FEATURE_COACHLESS_HOME (404 while
 * off). Every refusal is `{ code, message }` with a stable code from
 * COACHLESS_ERROR; the global filter adds request_id.
 */
@ApiTags('coachless')
@ApiBearerAuth('bearer')
@Controller('coachless')
@UseGuards(JwtAuthGuard, CoachlessFeatureGuard)
export class CoachlessController {
  constructor(
    private readonly home: CoachlessHomeService,
    private readonly redemption: CoachCodeRedemptionService,
    private readonly prompts: CoachlessPromptService,
    private readonly featured: FeaturedCoachService,
  ) {}

  @ApiOperation({ summary: 'Coachless Home: banner, featured offer and the scripted Roman card' })
  @Get('home')
  async getHome(@Request() req: AuthedRequest) {
    return this.home.home(req.user);
  }

  @ApiOperation({ summary: 'Instant validation for the code sheet (no write)' })
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('coach-code/check')
  @HttpCode(HttpStatus.OK)
  async check(@Request() req: AuthedRequest, @Body() body: CoachCodeDto) {
    const result = await this.redemption.check(req.user, body.code);
    return result.valid ? result : { ...result, message: COACHLESS_ERROR_MESSAGE[result.code] };
  }

  @ApiOperation({ summary: 'Redeem a coach code after signup (idempotent)' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'UUID; reuse it on retries of the same attempt.',
  })
  @ApiResponse({ status: 200, description: 'Attached (or already this coach’s client).' })
  @ApiResponse({ status: 404, description: 'code_invalid' })
  @ApiResponse({ status: 410, description: 'code_expired | code_revoked | code_exhausted' })
  @ApiResponse({
    status: 409,
    description: 'coach_not_accepting | already_attached | redemption_in_progress',
  })
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('coach-code/redeem')
  @HttpCode(HttpStatus.OK)
  async redeem(
    @Request() req: AuthedRequest,
    @Body() body: CoachCodeDto,
    @Headers('idempotency-key') key: string | string[] | undefined,
  ) {
    const idempotencyKey = headerValue(key);
    if (!idempotencyKey) throw new CoachlessError(COACHLESS_ERROR.IDEMPOTENCY_KEY_REQUIRED);
    return this.redemption.redeem({
      userId: req.user.id,
      rawCode: body.code,
      idempotencyKey,
      requestId: req.requestId,
    });
  }

  @ApiOperation({ summary: 'Record that the Roman card was shown (frequency cap)' })
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('roman-card/seen')
  @HttpCode(HttpStatus.OK)
  async romanSeen(@Request() req: AuthedRequest) {
    const offer = await this.featured.get();
    const state = await this.prompts.recordSeen(req.user.id, offer.roman_caps);
    return { recorded: true, visible: decideRomanCard(offer, state, new Date()).show };
  }

  @ApiOperation({ summary: 'Persist "Not now" for the Roman card' })
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('roman-card/not-now')
  @HttpCode(HttpStatus.OK)
  async romanNotNow(@Request() req: AuthedRequest) {
    const offer = await this.featured.get();
    const state = await this.prompts.recordNotNow(req.user.id);
    return { recorded: true, visible: decideRomanCard(offer, state, new Date()).show };
  }
}

/**
 * Owner-only featured-coach config (the admin-editable source of the code,
 * offer and Roman copy). Not behind the client flag, so the owner can set the
 * offer up before the flag flips. Every write is audited.
 */
@ApiTags('coachless')
@ApiBearerAuth('bearer')
@Controller('admin/featured-coach')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class FeaturedCoachAdminController {
  constructor(private readonly featured: FeaturedCoachService) {}

  @Roles('owner')
  @Get()
  async get() {
    return this.featured.getForOwner();
  }

  @Roles('owner')
  @Put()
  async put(@Request() req: AuthedRequest, @Body() body: FeaturedCoachConfigDto) {
    return this.featured.update(
      { id: req.user.id, email: req.user.email },
      {
        coach_user_id: body.coach_user_id ?? null,
        code: body.code ?? null,
        package_id: body.package_id ?? null,
        banner_title: body.banner_title ?? null,
        offer_text: body.offer_text ?? null,
        roman_pitch_text: body.roman_pitch_text ?? null,
        accepting_clients: body.accepting_clients,
        roman_enabled: body.roman_enabled,
        roman_min_hours_between: body.roman_min_hours_between,
        roman_max_per_week: body.roman_max_per_week,
        roman_snooze_days: body.roman_snooze_days,
        roman_max_not_now: body.roman_max_not_now,
        create_code_if_missing: body.create_code_if_missing ?? false,
      },
    );
  }
}
