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

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private inviteCodes: InviteCodesService,
  ) {}

  @ApiOperation({
    summary: 'Register a new user with email + password',
    description:
      'Creates a Supabase user and the corresponding application User row. ' +
      'Rate-limited to 10/hour/IP to blunt enumeration and spam signup loops.',
  })
  @ApiResponse({ status: 200, description: 'Session tokens for the new user.' })
  @ApiResponse({ status: 400, description: 'Validation error.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('register')
  // Named throttler `auth-signup`: 5/hour. Tracker is IP for unauthed
  // signups, user-id for the rare authed retry (see UserThrottlerGuard).
  @Throttle({ 'auth-signup': { ttl: 3600000, limit: 5 } })
  async register(@Body() body: RegisterDto) {
    return this.authService.register(body);
  }

  @ApiOperation({
    summary: 'Email + password login',
    description: 'Returns Supabase access/refresh tokens. Rate-limited 10/min/IP.',
  })
  @ApiResponse({ status: 200, description: 'Authenticated session.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('login')
  // Named throttler `auth-login`: 10/minute. Tracker is IP (login is
  // unauthed by definition); user-id tracking kicks in once the JWT is
  // attached on subsequent authed routes.
  @Throttle({ 'auth-login': { ttl: 60000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto) {
    return this.authService.login(body.email, body.password);
  }

  @ApiOperation({
    summary: 'Google OAuth exchange',
    description:
      'Exchanges a Google ID token for a Supabase session. Optional ' +
      '`invite_code` attaches the new user to a coach in the same call.',
  })
  @ApiResponse({ status: 200, description: 'Authenticated session.' })
  @ApiResponse({ status: 401, description: 'Invalid Google token.' })
  @Public()
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async googleAuth(@Body() body: GoogleAuthDto) {
    return this.authService.googleAuth(body.token, body.invite_code);
  }

  @ApiOperation({
    summary: 'Sign in with Apple',
    description:
      'Exchanges an Apple identity token (JWT) for a Supabase session. ' +
      'Optional `full_name` is required on first authorization (Apple does ' +
      'not include it in the identity token). Optional `invite_code` ' +
      'attaches the new user to a coach in the same call. Returns 503 when ' +
      'APPLE_AUDIENCES is not configured on this deployment.',
  })
  @ApiResponse({ status: 200, description: 'Authenticated session.' })
  @ApiResponse({ status: 401, description: 'Invalid Apple token.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @ApiResponse({
    status: 503,
    description: 'Sign in with Apple is not configured on this server.',
  })
  @Public()
  @Post('apple')
  // Same shared bucket as /auth/login: 10/min/IP. The endpoint is unauthed
  // and an attacker can replay tokens, so the rate limit is the primary
  // brake. Sharing `auth-login` means we cannot be multiplexed with /login.
  @Throttle({ 'auth-login': { ttl: 60000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async appleAuth(@Body() body: AppleAuthDto) {
    return this.authService.appleAuth(body.token, body.full_name, body.invite_code);
  }

  @ApiOperation({
    summary: 'Get the active signup policy',
    description:
      'Returns whether an invite code is required and which auth providers ' +
      'are usable on this build. Mobile calls this on launch.',
  })
  @ApiResponse({ status: 200, description: 'Signup policy.' })
  // Mobile #56 calls GET /auth/signup-policy on launch to learn whether the
  // coach invite code is required and which providers are usable on this
  // build. Public so the unauth client can fetch it.
  @Public()
  @Get('signup-policy')
  @HttpCode(HttpStatus.OK)
  async getSignupPolicy() {
    return this.authService.getSignupPolicy();
  }

  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Attach the caller to a coach via invite code',
    description: 'Idempotent — re-running with the same code is a no-op.',
  })
  @ApiResponse({ status: 200, description: 'Attached to coach.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
  @ApiResponse({ status: 404, description: 'Invite code not found.' })
  // Alias for /coach-codes/auth/attach-coach-code so mobile can hit the
  // canonical /auth/attach-invite-code path with the new `invite_code`
  // field name. Same behavior, same idempotency. Throttled the same way.
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
      'Only `student` is honored — coach elevation must be done by an OWNER ' +
      'admin. A `coach` value will be rejected with 403.',
  })
  @ApiResponse({ status: 200, description: 'Role applied.' })
  @ApiResponse({ status: 403, description: 'Role elevation rejected.' })
  @Post('select-role')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async selectRole(@Request() req: AuthedRequest, @Body() body: SelectRoleDto) {
    // Prefer `invite_code` (new) over `coach_code` (legacy); either is honored.
    const code = body.invite_code ?? body.coach_code;
    return this.authService.selectRole(req.user.id, body.role, code);
  }

  // Public (unauthenticated) endpoint so the signup flow can preview the coach
  // name before the user commits. Returns {valid, coach_id?, coach_name?}.
  // Rate-limited to blunt brute-force enumeration of the 30-bit code space.
  //
  // A code outside the documented length / character class is rejected with
  // a polished structured 400 (`code: 'invite_code_invalid_format'`) BEFORE
  // any DB lookup — so the response is identical for "32 chars of garbage"
  // and "200 chars of garbage" and never leaks whether a malformed code
  // exists. We also do not echo the user's input back in the error body.
  @ApiOperation({
    summary: 'Preview an invite code',
    description:
      'Returns `{ valid, coach_id?, coach_name? }`. Format-validates the code ' +
      'before any DB lookup so the response is identical for malformed input. ' +
      'Rate-limited 20/min/IP.',
  })
  @ApiResponse({ status: 200, description: 'Invite code preview result.' })
  @ApiResponse({ status: 400, description: 'Invite code format is invalid.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('validate-invite-code')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
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
      'Always returns 200 to avoid leaking whether an email is registered.',
  })
  @ApiResponse({ status: 200, description: 'Email dispatched if user exists.' })
  @Public()
  @Post('forgot-password')
  // SECURITY (audit S-1): 5/15min on POST /auth/forgot-password. Without this
  // the endpoint is a trivial user-enumeration and password-reset-email spam
  // vector. Routed through the named throttler `auth-password-reset` so
  // operators can adjust the limit in one place (src/throttler/throttler.config.ts).
  @Throttle({ 'auth-password-reset': { ttl: 900000, limit: 5 } })
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

  // Phase 1C: client signup that includes the coach's invite code in the
  // same call. Behind COACH_CODE_GATE_ENABLED=true the code is required.
  // Public so the mobile app can hit it without a JWT.
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
  // Named throttler `auth-signup`: 5/hour. Same signup surface as
  // /auth/register; shares the bucket so attackers cannot multiplex
  // across both paths.
  @Throttle({ 'auth-signup': { ttl: 3600000, limit: 5 } })
  async signupWithCode(@Body() body: SignupWithCodeDto) {
    return this.authService.signupWithCode(body);
  }
}

// Best-effort extraction of remote IP + User-Agent for audit-log context.
// Mirrors the helper in admin.controller.ts and users.controller.ts.
function auditContext(req: AuditableRequest): { ip: string | null; userAgent: string | null } {
  const xffRaw = req?.headers?.['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw || '';
  const fwdIp = xff.split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? uaRaw[0] ?? null : uaRaw ?? null;
  return { ip: ip || null, userAgent: userAgent || null };
}
