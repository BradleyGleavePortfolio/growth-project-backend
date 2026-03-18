import {
  Controller, Post, Get, Body, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { ttl: 3600000, limit: 3 } })
  async register(
    @Body() body: { email: string; password: string; name: string; phone?: string },
  ) {
    return this.authService.register(body);
  }

  @Post('login')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: { email: string; password: string }) {
    return this.authService.login(body.email, body.password);
  }

  @Post('google')
  @HttpCode(HttpStatus.OK)
  async googleAuth(@Body() body: { token: string }) {
    return this.authService.googleAuth(body.token);
  }

  @Post('select-role')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async selectRole(
    @Request() req,
    @Body() body: { role: 'coach' | 'student'; coach_code?: string },
  ) {
    return this.authService.selectRole(req.user.id, body.role, body.coach_code);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Request() req) {
    return this.authService.getMe(req.user.id);
  }
}
