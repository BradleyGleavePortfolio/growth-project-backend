import {
  Controller, Post, Get, Body, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import type { AuthedRequest } from './auth-request';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';
import {
  RegisterDto,
  LoginDto,
  GoogleAuthDto,
  SelectRoleDto,
  ForgotPasswordDto,
} from './auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  // 10/hour/IP — loosened from 3/hour because shared NAT (office, campus, coffee
  // shop) easily hits 3 legitimate signups within an hour. Still tight enough
  // to kill enumeration and spam signup loops.
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  async register(@Body() body: RegisterDto) {
    return this.authService.register(body);
  }

  @Post('login')
  // 10/minute/IP — loosened from 5/min. A user mistyping a password twice on a
  // shared IP was one fat-finger away from a lockout. 10/min is still an order
  // of magnitude below credential-stuffing economics.
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto) {
    return this.authService.login(body.email, body.password);
  }

  @Post('google')
  @HttpCode(HttpStatus.OK)
  async googleAuth(@Body() body: GoogleAuthDto) {
    return this.authService.googleAuth(body.token);
  }

  @Post('select-role')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async selectRole(@Request() req: AuthedRequest, @Body() body: SelectRoleDto) {
    return this.authService.selectRole(req.user.id, body.role, body.coach_code);
  }

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
}
