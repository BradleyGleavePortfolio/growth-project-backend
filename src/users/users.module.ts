import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// PrismaService is provided globally via PrismaModule — no need to import here.
// AuthModule must be imported so JwtAuthGuard (used in UsersController) can
// resolve its JwksVerifierService dependency within this module context.
@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
