import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuditableRequest, AuthedRequest } from './auth-request';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';
import { Public } from '../common/decorators/public.decorator';
import {
  RegisterDto,
  LoginDto,
  GoogleAuthDto,
  AppleAuthDto,
  SelectRoleDto,
  ForgotPasswordDto,
  ValidateInviteCodePublicDto,
  BecomeCoachDto,
  SignupWithCodeDto,
  AttachInviteCodeDto,
} from './auth.dto';
import {
  InviteCodesService,
  INVITE_CODE_MAX_LENGTH,
  INVITE_CODE_MIN_LENGTH,
  INVITE_CODE_PATTERN,
} from '../invite-codes/invite-codes.service';
import { LoginThrottleResetService } from '../throttler/login-throttle-reset.service';
import { THROTTLER_NAMES } from '../throttler/throttler.config';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private inviteCodes: InviteCodesService,
    private loginThrottleReset: LoginThrottleResetService,
  ) {}

  @ApiOperation({
    summary: 'Register a new user with email + password',
    description:
      'Creates a Supabase user and the corresponding application User row. ' +
      'Rate-limited to 5/hour/IP to blunt enumeration and spam signup loops.',
  })
  @ApiResponse({ status: 200, description: 'Session tokens for the new user.' })
  @ApiResponse({ status: 400, description: 'Validation error.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('register')
  @Throttle({ [THROTTLER_NAMES.AUTH_SIGNUP]: { ttl: 3_600_000, limit: 5 } })
  async register(@Body() body: RegisterDto) {
    return this.authService.register(body);
  }

  @ApiOperation({
    summary: 'Email + password login',
    description:
      'Returns Supabase access/refresh tokens. Rate-limited to 5/min and ' +
      '30/hr per IP. A successful login resets both counters.',
  })
  @ApiResponse({ status: 200, description: 'Authenticated session.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('login')
  // Two named throttlers: per-minute burst + per-hour sustained cap. Both are
  // keyed by IP (login is unauthed). UserThrottlerGuard will check both.
  // A successful login resets BOTH counters via LoginThrottleResetService.
  @Throttle({
    [THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]:  { ttl: 60_000,    limit: 5 },
    [THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]: { ttl: 3_600_000, limit: 30 },
  })
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto, @Request() req: AuditableRequest) {
    const result = await this.authService.login(body.email, body.password, auditContext(req));
    // Reset the IP-keyed login counters on success so a retry storm from bad
    // Wi-Fi does not lock out a legitimate user.
    await this.loginThrottleReset.resetLoginCounters(extractIp(req));
    return result;
  }

  @ApiOperation({
    summary: 'Google OAuth exchange',
    description:
      'Exchanges a Google ID token for a Supabase session. Optional ' +
      'invite_code attaches the new user to a coach in the same call. ' +
      'Rate-limited 5/min and 30/hr per IP.',
  })
  @ApiResponse({ status: 200, description: 'Authenticated session.' })
  @ApiResponse({ status: 401, description: 'Invalid Google token.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('google')
  @Throttle({
    [THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]:  { ttl: 60_000,    limit: 5 },
    [THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]: { ttl: 3_600_000, limit: 30 },
  })
  @HttpCode(HttpStatus.OK)
  async googleAuth(@Body() body: GoogleAuthDto, @Request() req: Record<string, any>) {
    const result = await this.authService.googleAuth(body.token, body.invite_code);
    await this.loginThrottleReset.resetLoginCounters(extractIp(req));
    return result;
  }

  @ApiOperation({
    summary: 'Sign in with Apple',
    description:
      'Exchanges an Apple identity token (JWT) for a Supabase session. ' +
      'Optional full_name is required on first authorization. Optional ' +
      'invite_code attaches the new user to a coach in the same call. ' +
      'Returns 503 when APPLE_AUDIENCES is not configured. ' +
      'Rate-limited 5/min and 30/hr per IP.',
  })
  @ApiResponse({ status: 200, description: 'Authenticated session.' })
  @ApiResponse({ status: 401, description: 'Invalid Apple token.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @ApiResponse({ status: 503, description: 'Sign in with Apple is not configured.' })
  @Public()
  @Post('apple')
  @Throttle({
    [THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]:  { ttl: 60_000,    limit: 5 },
    [THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]: { ttl: 3_600_000, limit: 30 },
  })
  @HttpCode(HttpStatus.OK)
  async appleAuth(@Body() body: AppleAuthDto, @Request() req: AuditableRequest) {
    const result = await this.authService.appleAuth(
      body.token,
      body.full_name,
      body.invite_code,
      auditContext(req),
    );
    await this.loginThrottleReset.resetLoginCounters(extractIp(req));
    return result;
  }

  @ApiOperation({
    summary: 'Get the active signup policy',
    description:
      'Returns whether an invite code is required and which auth providers ' +
      'are usable on this build. Mobile calls this on launch.',
  })
  @ApiResponse({ status: 200, description: 'Signup policy.' })
  @Public()
  @Get('signup-policy')
  @HttpCode(HttpStatus.OK)
  async getSignupPolicy() {
    return this.authService.getSignupPolicy();
  }

  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Attach the caller to a coach via invite code',
    description: 'Idempotent -- re-running with the same code is a no-op.',
  })
  @ApiResponse({ status: 200, description: 'Attached to coach.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
  @ApiResponse({ status: 404, description: 'Invite code not found.' })
  @Post('attach-invite-code')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async attachInviteCode(
    @Request() req: AuthedRequest,
    @Body() body: AttachInviteCodeDto,
  ) {
    return this.inviteCodes.attachUserToCoachByCode(req.user.id, body.invite_code);
  }

  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Select role + optionally attach invite code',
    description:
      'Only `student` is honored -- coach elevation must be done by an OWNER ' +
      'admin. A `coach` value will be rejected with 403.',
  })
  @ApiResponse({ status: 200, description: 'Role applied.' })
  @ApiResponse({ status: 403, description: 'Role elevation rejected.' })
  @Post('select-role')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async selectRole(@Request() req: AuthedRequest, @Body() body: SelectRoleDto) {
    const code = body.invite_code ?? body.coach_code;
    return this.authService.selectRole(req.user.id, body.role, code);
  }

  @ApiOperation({
    summary: 'Preview an invite code',
    description:
      'Returns { valid, coach_id?, coach_name? }. Format-validates the code ' +
      'before any DB lookup. Rate-limited 20/min/IP.',
  })
  @ApiResponse({ status: 200, description: 'Invite code preview result.' })
  @ApiResponse({ status: 400, description: 'Invite code format is invalid.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('validate-invite-code')
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  async validateInviteCode(@Body() body: ValidateInviteCodePublicDto) {
    const trimmed = body.code.trim();
    if (
      trimmed.length < INVITE_CODE_MIN_LENGTH ||
      trimmed.length > INVITE_CODE_MAX_LENGTH ||
      !INVITE_CODE_PATTERN.test(trimmed)
    ) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'invite_code_invalid_format',
        message: 'Invite code format is invalid.',
      });
    }
    const result = await this.inviteCodes.validate(trimmed);
    if (!result.valid) return { valid: false };
    return {
      valid: true,
      coach_id: result.coach_id,
      coach_name: result.coach_name,
    };
  }

  @ApiOperation({
    summary: 'Trigger a password-reset email',
    description:
      'Always returns 200 to avoid leaking whether an email is registered. ' +
      'Rate-limited to 3/hr per IP.',
  })
  @ApiResponse({ status: 200, description: 'Email dispatched if user exists.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('forgot-password')
  // SECURITY (audit S-1): 3/hour on POST /auth/forgot-password.
  @Throttle({ [THROTTLER_NAMES.AUTH_PASSWORD_RESET]: { ttl: 3_600_000, limit: 3 } })
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.forgotPassword(body.email);
  }

  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Get the authenticated user' })
  @ApiResponse({ status: 200, description: 'Caller profile.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Request() req: AuthedRequest) {
    return this.authService.getMe(req.user.id);
  }

  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Self-elevate to coach role',
    description:
      'Requires re-entering the current password. Gated by COACH_SELF_ELEVATION_ENABLED.',
  })
  @ApiResponse({ status: 200, description: 'Coach role granted.' })
  @ApiResponse({ status: 401, description: 'Wrong password.' })
  @ApiResponse({ status: 403, description: 'Self-elevation disabled.' })
  @Post('become-coach')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async becomeCoach(@Request() req: AuthedRequest, @Body() body: BecomeCoachDto) {
    return this.authService.becomeCoach(
      req.user.id,
      body.password,
      auditContext(req),
    );
  }

  @ApiOperation({
    summary: 'Signup including a coach invite code in one call',
    description:
      'Behind COACH_CODE_GATE_ENABLED=true the invite_code is required.',
  })
  @ApiResponse({ status: 201, description: 'New session, attached to coach.' })
  @ApiResponse({ status: 400, description: 'Invite code missing or invalid.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('signup-with-code')
  @Throttle({ [THROTTLER_NAMES.AUTH_SIGNUP]: { ttl: 3_600_000, limit: 5 } })
  async signupWithCode(@Body() body: SignupWithCodeDto) {
    return this.authService.signupWithCode(body);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

// Best-effort extraction of remote IP for rate-limit counter resets.
// Resolution order matches UserThrottlerGuard.getTracker().
function extractIp(req: Record<string, any>): string {
  const flyIp = (req?.headers?.['fly-client-ip'] || '') as string;
  if (flyIp.trim().length > 0) return flyIp.trim();
  const xff = (req?.headers?.['x-forwarded-for'] || '') as string;
  const fwdIp = xff.split(',')[0]?.trim();
  if (fwdIp && fwdIp.length > 0) return fwdIp;
  return req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown';
}

// Best-effort extraction of remote IP + User-Agent for audit-log context.
function auditContext(req: AuditableRequest): { ip: string | null; userAgent: string | null } {
  const xffRaw = req?.headers?.['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw || '';
  const fwdIp = xff.split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? uaRaw[0] ?? null : uaRaw ?? null;
  return { ip: ip || null, userAgent: userAgent || null };
}
