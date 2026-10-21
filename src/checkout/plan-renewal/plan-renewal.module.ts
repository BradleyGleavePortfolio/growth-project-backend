import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { MessagingModule } from '../../messaging/messaging.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ChurnedClientsController } from './churned-clients.controller';
import { ChurnedClientsService } from './churned-clients.service';
import { PlanRenewalController } from './plan-renewal.controller';
import { PlanRenewalService } from './plan-renewal.service';

/** RENEWAL-BE: the plan-renewal sequence (sweep, pop-up ack, coach switch); CHURN-BE: the coach's churned list. FEATURE_PLAN_RENEWAL, default off. */
@Module({
  imports: [AuthModule, MessagingModule, NotificationsModule],
  controllers: [PlanRenewalController, ChurnedClientsController],
  providers: [PlanRenewalService, ChurnedClientsService],
})
export class PlanRenewalModule {}
