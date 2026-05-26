import { Module, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StripeApiService } from '../billing/stripe-api.service';
import { EmailModule } from '../email/email.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DunningController } from './dunning.controller';
import { DunningService } from './dunning.service';
import { DunningNotifier } from './dunning.notifier';
import { DunningRetryScheduler } from './dunning-retry.scheduler';

// r50 Dunning v1
//
// Exports DunningService + DunningNotifier so BillingService can wire
// them into the existing Stripe webhook handlers.
//
// StripeApiService is provided locally (also provided by BillingModule)
// because the controller and scheduler need it without dragging the
// whole BillingModule import graph in. NestJS deduplicates the provider
// — both consumers receive the same instance because Stripe API state
// is in module-level env vars, not a singleton.
@Module({
  imports: [NotificationsModule, EmailModule],
  controllers: [DunningController],
  providers: [
    PrismaService,
    StripeApiService,
    DunningService,
    DunningNotifier,
    DunningRetryScheduler,
  ],
  exports: [DunningService, DunningNotifier],
})
export class DunningModule {}
