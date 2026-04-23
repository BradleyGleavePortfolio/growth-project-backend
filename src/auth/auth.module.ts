import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';

/**
 * Auth module — no longer uses PassportModule or JwtModule.
 * Token validation is handled by JwtAuthGuard using supabase.auth.getUser().
 * This correctly handles Supabase's ES256-signed user session tokens.
 *
 * PrismaService is provided by the global PrismaModule.
 */
@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
