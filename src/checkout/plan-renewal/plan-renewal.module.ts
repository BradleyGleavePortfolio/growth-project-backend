import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { PlanRenewalController } from './plan-renewal.controller';
import { PlanRenewalService } from './plan-renewal.service';

/** RENEWAL-BE: the plan-renewal sequence (sweep, Day 7 push, pop-up ack). FEATURE_PLAN_RENEWAL, default off. */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [PlanRenewalController],
  providers: [PlanRenewalService],
})
export class PlanRenewalModule {}
