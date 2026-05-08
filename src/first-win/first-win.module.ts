import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirstWinController } from './first-win.controller';
import { FirstWinService } from './first-win.service';

// PrismaService is provided globally via PrismaModule — no need to import here.
// AuthModule must be imported so JwtAuthGuard can resolve JwksVerifierService.
@Module({
  imports: [AuthModule],
  controllers: [FirstWinController],
  providers: [FirstWinService],
  exports: [FirstWinService],
})
export class FirstWinModule {}
