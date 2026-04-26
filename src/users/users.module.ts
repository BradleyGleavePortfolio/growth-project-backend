import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PreferencesService } from './preferences.service';
import { CommunityModule } from '../community/community.module';

// PrismaService is provided globally via PrismaModule — no need to import here.
// AuthModule must be imported so JwtAuthGuard (used in UsersController) can
// resolve its JwksVerifierService dependency within this module context.
// CommunityModule is imported to expose BadgesService for GET /users/me/badges.
@Module({
  imports: [AuthModule, CommunityModule],
  controllers: [UsersController],
  providers: [UsersService, PreferencesService],
  exports: [UsersService, PreferencesService],
})
export class UsersModule {}
