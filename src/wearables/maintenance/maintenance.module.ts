import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { WearableProcessedEventPruneService } from './wearable-processed-event-prune.service';
import { WearableProcessedEventPruneScheduler } from './wearable-processed-event-prune.scheduler';

/**
 * PR-HK (cron prune) — wearables maintenance module.
 *
 * Mounts the daily WearableProcessedEvent retention prune: the
 * {@link WearableProcessedEventPruneService} (cutoff math + deleteMany) and the
 * {@link WearableProcessedEventPruneScheduler} (@Cron seam at 04:00 UTC). This
 * is the prune cron deferred from the HK wearables expansion — the
 * WearableProcessedEvent webhook-idempotency ledger had unbounded growth with
 * no TTL.
 *
 * PrismaService is provided globally by the @Global PrismaModule, but we import
 * it explicitly here so the module is self-describing and independently
 * mountable (matches the documented expectation for this module). No
 * controllers — this is a pure background-maintenance seam.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    WearableProcessedEventPruneService,
    WearableProcessedEventPruneScheduler,
  ],
  exports: [WearableProcessedEventPruneService],
})
export class MaintenanceModule {}
