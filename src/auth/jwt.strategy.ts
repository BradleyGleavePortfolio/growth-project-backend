import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private authService: AuthService,
  ) {
    super({
      // Extract JWT from Authorization: Bearer <token>
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Use Supabase JWT secret to validate tokens issued by Supabase Auth
      secretOrKey: configService.get('JWT_SECRET') || configService.get('SUPABASE_JWT_SECRET'),
    });
  }

  async validate(payload: any) {
    // Supabase JWT payload contains 'sub' = supabase user id
    const user = await this.authService.validateSupabaseToken(payload.sub);
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }
}
