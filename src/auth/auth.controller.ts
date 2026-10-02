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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuditableRequest, AuthedRequest } from './auth-request';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
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
  BootstrapOwnerDto,
  IssueRecentAuthTokenDto,
  ExtensionRefreshDto,
  ExtensionRefreshResult,
  resolveAppleIdentityToken,
} from './auth.dto';
import {
  envelopeWithCode,
  errorEnvelopeSchema,
  rateLimitSchema,
} from '../common/errors/importer-error-responses';
import {
  InviteCodesService,
  INVITE_CODE_MAX_LENGTH,
  INVITE_CODE_MIN_LENGTH,
  INVITE_CODE_PATTERN,
} from '../invite-codes/invite-codes.service';
import { LoginThrottleResetService } from '../throttler/login-throttle-reset.service';
import {
  SIGNUP_WITH_CODE_SKIP_THROTTLERS,
  THROTTLER_NAMES,
  THROTTLER_ROUTE_LIMITS,
} from '../throttler/throttler.config';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private inviteCodes: InviteCodesService,
    // Not called from the handlers any more (the password lock moved into
    // AuthService._passwordLogin, C14 #604 Opus A1). Kept as a REQUIRED
    // dependency on purpose: AuthModule fails to boot if ThrottlerModule
    // stops exporting it, so AuthService's @Optional() copy is never
    // silently undefined in production.
    private loginThrottleReset: LoginThrottleResetService,
  ) {}

  @ApiOperation({
    summary: 'Register a new user with email + password',
    description:
      'Creates a Supabase user and the corresponding application User row. ' +
      'Optional intended_role (client | coach, default client) fixes the role at creation; ' +
      'coach provisions a free/active CoachSubscription. ' +
      'Rate-limited to 5/hour/IP to blunt enumeration and spam signup loops.',
  })
  @ApiResponse({ status: 200, description: 'Session tokens for the new user.' })
  @ApiResponse({ status: 400, description: 'Validation error.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('register')
  @Throttle({ [THROTTLER_NAMES.AUTH_SIGNUP]: { ttl: 3_600_000, limit: 5 } })
  async register(@Body() body: RegisterDto, @Request() req: AuditableRequest) {
    return this.authService.register(body, auditContext(req));
  }

  @ApiOperation({
    summary: 'Email + password login',
    description:
      'Returns Supabase access/refresh tokens. Rate-limited per IP ' +
      '(AUTH_LOGIN_PER_MIN, AUTH_LOGIN_PER_HOUR; never reset) and by a ' +
      'per-account failure lock shared with /auth/extension/login.',
  })
  @ApiResponse({ status: 200, description: 'Authenticated session.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('login')
  // Two named per-IP throttlers (burst + sustained), NEVER reset (C14 fix
  // round: a success by one account must not clear anyone else's attack
  // budget). Sized for a room on one network; guessing against one account is
  // bounded by the per-account failure lock below, whatever the IP.
  @Throttle({
    [THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.AUTH_LOGIN_PER_MIN },
    [THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]: { ttl: 3_600_000, limit: THROTTLER_ROUTE_LIMITS.AUTH_LOGIN_PER_HOUR },
  })
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto, @Request() req: AuditableRequest) {
    // The per-account failure lock (check, count, own-account clear) runs
    // inside AuthService._passwordLogin, shared with /auth/extension/login.
    return this.authService.login(body.email, body.password, auditContext(req));
  }

  @ApiOperation({
    summary: 'Extension login (tgp-importer Chrome extension)',
    description:
      'Same as /auth/login (proxies Supabase signInWithPassword, returns ' +
      'Supabase access/refresh tokens verbatim) but tagged source=extension ' +
      'in the audit log. Rate-limited 5/min and AUTH_LOGIN_PER_HOUR per IP, ' +
      'and shares /auth/login\'s per-account failure lock (429 while locked).',
  })
  @ApiResponse({ status: 200, description: 'Authenticated session.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('extension/login')
  // C14 #604 Opus A1: named throttlers only apply where declared, so the
  // hourly per-IP brake must be declared here too (not inherited). The
  // per-account lock is enforced in AuthService._passwordLogin.
  @Throttle({
    [THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]: { ttl: 60_000, limit: 5 },
    [THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]: {
      ttl: 3_600_000,
      limit: THROTTLER_ROUTE_LIMITS.AUTH_LOGIN_PER_HOUR,
    },
  })
  @HttpCode(HttpStatus.OK)
  async extensionLogin(@Body() body: LoginDto, @Request() req: AuditableRequest) {
    return this.authService.extensionLogin(body.email, body.password, auditContext(req));
  }

  @ApiOperation({
    summary: 'Extension token refresh (tgp-importer Chrome extension)',
    description:
      'Proxies Supabase refreshSession(refresh_token) and returns the rotated ' +
      'access/refresh pair. No backend-minted tokens — Supabase owns rotation ' +
      'and revocation. Rate-limited 30/min per IP.',
  })
  @ApiResponse({ status: 200, description: 'Rotated token pair.', type: ExtensionRefreshResult })
  @ApiResponse({
    status: 400,
    description:
      'Malformed body (global ValidationPipe: whitelist + forbidNonWhitelisted). ' +
      'Standard HttpExceptionFilter envelope; `message` is a string ARRAY of ' +
      'per-field constraint violations and there is no domain `code`.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 401,
    description:
      'Refresh token invalid or expired. Structured HttpExceptionFilter envelope ' +
      'with `code: "extension_refresh_invalid"` — the extension keys off this to force a re-pair.',
    schema: envelopeWithCode(['extension_refresh_invalid']),
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (per-IP throttle).',
    schema: rateLimitSchema(),
  })
  @Public()
  @Post('extension/refresh')
  @Throttle({ [THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]: { ttl: 60_000, limit: 30 } })
  @HttpCode(HttpStatus.OK)
  async extensionRefresh(@Body() body: ExtensionRefreshDto) {
    return this.authService.extensionRefresh(body);
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
  // C14 fix round: own per-IP buckets (provider-signed tokens; nothing to
  // guess), sized for a 40-person room on one Wi-Fi, never reset.
  @Throttle({
    [THROTTLER_NAMES.AUTH_OAUTH_PER_MIN]: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.AUTH_OAUTH_PER_MIN },
    [THROTTLER_NAMES.AUTH_OAUTH_PER_HOUR]: { ttl: 3_600_000, limit: THROTTLER_ROUTE_LIMITS.AUTH_OAUTH_PER_HOUR },
  })
  @HttpCode(HttpStatus.OK)
  async googleAuth(@Body() body: GoogleAuthDto, @Request() req: AuditableRequest) {
    const result = await this.authService.googleAuth(
      body.token,
      body.invite_code,
      body.intended_role,
      // Fix round (Opus C5 / Grok B1): the signup-time role audit row needs
      // the request IP / user-agent on the Google path too. throttleIp (Opus
      // C13-C1): the coach-signup ceiling keys on the trusted Fly-Client-IP.
      { ...auditContext(req), throttleIp: extractIp(req) },
    );
    // C14 fix round: no reset of any per-IP window on success (Opus C14-A1).
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
  // C14 fix round: own per-IP buckets (provider-signed tokens; nothing to
  // guess), sized for a 40-person room on one Wi-Fi, never reset.
  @Throttle({
    [THROTTLER_NAMES.AUTH_OAUTH_PER_MIN]: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.AUTH_OAUTH_PER_MIN },
    [THROTTLER_NAMES.AUTH_OAUTH_PER_HOUR]: { ttl: 3_600_000, limit: THROTTLER_ROUTE_LIMITS.AUTH_OAUTH_PER_HOUR },
  })
  @HttpCode(HttpStatus.OK)
  async appleAuth(@Body() body: AppleAuthDto, @Request() req: AuditableRequest) {
    const result = await this.authService.appleAuth(
      resolveAppleIdentityToken(body),
      body.full_name,
      body.invite_code,
      { ...auditContext(req), throttleIp: extractIp(req) },
      body.raw_nonce,
      body.intended_role,
    );
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
  // C14 — public read hit by every app launch and every /join link; generous
  // dedicated per-IP bucket (a clinic room behind one NAT). `default` still
  // applies at its anonymous baseline.
  @Throttle({
    [THROTTLER_NAMES.PUBLIC_READS]: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.PUBLIC_READS_PER_MIN },
  })
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
  async attachInviteCode(@Request() req: AuthedRequest, @Body() body: AttachInviteCodeDto) {
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
    return this.authService.becomeCoach(req.user.id, body.password, auditContext(req));
  }

  @ApiOperation({
    summary: 'Signup including a coach invite code in one call',
    description: 'Behind COACH_CODE_GATE_ENABLED=true the invite_code is required.',
  })
  @ApiResponse({ status: 201, description: 'New session, attached to coach.' })
  @ApiResponse({ status: 400, description: 'Invite code missing or invalid.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('signup-with-code')
  // C03: codeless signups keep the 5/hour/IP baseline; requests carrying a
  // well-formed invite code are counted in the burst bucket instead
  // (AUTH_SIGNUP_WITH_CODE_PER_HOUR, default 100/hour/IP). The two skipIf
  // predicates in throttler.config.ts make the buckets mutually exclusive.
  // @SkipThrottle isolates the route to exactly {default, auth-signup,
  // auth-signup-with-code}: without it every other named baseline
  // (auth-password-reset 3/h, auth-login-per-min 5/min, …) would also be
  // evaluated here and reject the burst long before the cap (see the R2 P1 note
  // on the storefront join route for the same isolation).
  @SkipThrottle(SIGNUP_WITH_CODE_SKIP_THROTTLERS)
  @Throttle({
    [THROTTLER_NAMES.AUTH_SIGNUP]: { ttl: 3_600_000, limit: 5 },
    [THROTTLER_NAMES.AUTH_SIGNUP_WITH_CODE]: {
      ttl: 3_600_000,
      limit: THROTTLER_ROUTE_LIMITS.AUTH_SIGNUP_WITH_CODE_PER_HOUR,
    },
  })
  async signupWithCode(@Body() body: SignupWithCodeDto) {
    return this.authService.signupWithCode(body);
  }

  @ApiOperation({
    summary: 'First-gym bootstrap — create the initial owner',
    description:
      'Gated by BOOTSTRAP_SECRET env var AND a "no existing owners" precondition. ' +
      'Returns 403 once any owner exists or if BOOTSTRAP_SECRET is unset. ' +
      'After first use, the operator should unset BOOTSTRAP_SECRET in Fly secrets.',
  })
  @ApiResponse({ status: 200, description: 'Owner created and signed in.' })
  @ApiResponse({ status: 403, description: 'Bootstrap disabled or owner already exists.' })
  @ApiResponse({ status: 400, description: 'Validation error.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('bootstrap-owner')
  // Same per-IP signup throttle so a leaked secret can't be brute-forced
  // against email enumeration before the operator notices.
  @Throttle({ [THROTTLER_NAMES.AUTH_SIGNUP]: { ttl: 3_600_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async bootstrapOwner(@Body() body: BootstrapOwnerDto) {
    return this.authService.bootstrapFirstOwner({
      email: body.email,
      password: body.password,
      name: body.name,
      bootstrapSecret: body.bootstrap_secret,
    });
  }

  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Issue a short-lived re-auth token for sensitive actions',
    description:
      "Verifies the user's current credential and returns a short-lived HMAC " +
      'token to pass as X-Recent-Auth-Token on guarded endpoints. ' +
      'Accepts either `password` (email users) OR `provider_token` + `provider` ' +
      '(Google/Apple OAuth users — required because OAuth-only users have no ' +
      'password and would otherwise be permanently locked out of account ' +
      'deletion). ' +
      'Token is valid for RECENT_AUTH_TTL_MS (default 5 min) and bound to the caller. ' +
      'Rate-limited 5 attempts per minute per authenticated user (and per IP).',
  })
  @ApiResponse({ status: 200, description: 'Recent-auth token issued.' })
  @ApiResponse({ status: 400, description: 'Neither password nor provider_token provided.' })
  @ApiResponse({ status: 401, description: 'Credential incorrect or token invalid.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @UseGuards(JwtAuthGuard)
  @Post('recent-auth-token')
  // R19 idempotency exception: this endpoint is stateless — it reads credentials
  // and computes an HMAC token but does not mutate any shared state. Retries
  // naturally re-issue a fresh token. No dedup ledger is required.
  // The 5/min throttle (AUTH_RECENT_AUTH) acts as the rate-control mechanism.
  // SECURITY: 5/min per-user (authed) cap on this re-auth endpoint. Tighter than
  // /auth/login because (a) only logged-in callers can hit it and (b) it gates
  // sensitive actions (account deletion). UserThrottlerGuard keys this by
  // authenticated user id when a JWT is present and by IP otherwise.
  @Throttle({ [THROTTLER_NAMES.AUTH_RECENT_AUTH]: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async issueRecentAuthToken(@Request() req: AuthedRequest, @Body() body: IssueRecentAuthTokenDto) {
    return this.authService.issueRecentAuthToken(req.user.id, {
      password: body.password,
      provider_token: body.provider_token,
      provider: body.provider,
    });
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
  const userAgent = Array.isArray(uaRaw) ? (uaRaw[0] ?? null) : (uaRaw ?? null);
  return { ip: ip || null, userAgent: userAgent || null };
}
