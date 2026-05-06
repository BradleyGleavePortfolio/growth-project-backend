import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
//
// Phase 6B: NotificationsService is now exported so CoachModule can inject
// it into CoachAlertsService for real push delivery. The export does not
// change the existing /notifications/* HTTP surface.
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
