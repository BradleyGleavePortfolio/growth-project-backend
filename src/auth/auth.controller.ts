import {
  Controller, Post, Get, Body, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import type { AuthedRequest } from './auth-request';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';
import { Public } from '../common/decorators/public.decorator';
import {
  RegisterDto,
  LoginDto,
  GoogleAuthDto,
  SelectRoleDto,
  ForgotPasswordDto,
  ValidateInviteCodePublicDto,
  BecomeCoachDto,
  SignupWithCodeDto,
} from './auth.dto';
import { InviteCodesService } from '../invite-codes/invite-codes.service';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private inviteCodes: InviteCodesService,
  ) {}

  @Public()
  @Post('register')
  // 10/hour/IP — loosened from 3/hour because shared NAT (office, campus, coffee
  // shop) easily hits 3 legitimate signups within an hour. Still tight enough
  // to kill enumeration and spam signup loops.
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  async register(@Body() body: RegisterDto) {
    return this.authService.register(body);
  }

  @Public()
  @Post('login')
  // 10/minute/IP — loosened from 5/min. A user mistyping a password twice on a
  // shared IP was one fat-finger away from a lockout. 10/min is still an order
  // of magnitude below credential-stuffing economics.
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto) {
    return this.authService.login(body.email, body.password);
  }

  @Public()
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async googleAuth(@Body() body: GoogleAuthDto) {
    return this.authService.googleAuth(body.token);
  }

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
  @Public()
  @Post('validate-invite-code')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  async validateInviteCode(@Body() body: ValidateInviteCodePublicDto) {
    const result = await this.inviteCodes.validate(body.code);
    if (!result.valid) return { valid: false };
    return {
      valid: true,
      coach_id: result.coach_id,
      coach_name: result.coach_name,
    };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.forgotPassword(body.email);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Request() req: AuthedRequest) {
    return this.authService.getMe(req.user.id);
  }

  @Post('become-coach')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async becomeCoach(@Request() req: AuthedRequest, @Body() body: BecomeCoachDto) {
    return this.authService.becomeCoach(req.user.id, body.password);
  }

  // Phase 1C: client signup that includes the coach's invite code in the
  // same call. Behind COACH_CODE_GATE_ENABLED=true the code is required.
  // Public so the mobile app can hit it without a JWT.
  @Public()
  @Post('signup-with-code')
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  async signupWithCode(@Body() body: SignupWithCodeDto) {
    return this.authService.signupWithCode(body);
  }
}
