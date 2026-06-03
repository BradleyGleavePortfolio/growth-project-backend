import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

// Retention/prune worker for WearableProcessedEvent (webhook idempotency
// ledger). Every inbound provider webhook delivery writes one row keyed by
// (provider, provider_event_id); without a prune those rows accrue forever.
// The only reason a row needs to survive is the provider redelivery /
// replay window — once that window has passed, an event can never legitimately
// be re-delivered, so the idempotency guard for it is dead weight.
//
// Default retention is 30 days. The schema docblock on WearableProcessedEvent
// records that the longest provider redelivery window we serve is ≥14 days, so
// 30 days keeps a comfortable margin (>2x) over the idempotency requirement
// while still bounding table growth. Operators can widen or narrow the window
// via WEARABLE_PROCESSED_EVENT_RETENTION_DAYS without a deploy.
//
// The prune itself is a single deleteMany on the @@index([processed_at]) — no
// per-row work, no transactions, no fan-out. Cutoff math lives here (not in the
// scheduler) so it is unit-testable against an injected `now`.

const DAY_MS = 86_400_000;

export const DEFAULT_WEARABLE_PROCESSED_EVENT_RETENTION_DAYS = 30;

/**
 * Resolve the retention window (in days) from the environment, falling back to
 * {@link DEFAULT_WEARABLE_PROCESSED_EVENT_RETENTION_DAYS}. A missing, blank,
 * non-numeric, or negative value falls back to the default; 0 is honored (it
 * means "prune everything strictly older than now").
 */
export function resolveRetentionDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = parseInt(env.WEARABLE_PROCESSED_EVENT_RETENTION_DAYS ?? '', 10);
  if (Number.isNaN(raw) || raw < 0) {
    return DEFAULT_WEARABLE_PROCESSED_EVENT_RETENTION_DAYS;
  }
  return raw;
}

export interface WearableProcessedEventPruneResult {
  deleted: number;
  cutoff: Date;
}

@Injectable()
export class WearableProcessedEventPruneService {
  private readonly logger = new Logger(WearableProcessedEventPruneService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The configured retention window in days. Read at construction time from the
   * environment so a single tick is internally consistent; exposed for the
   * scheduler's success log and for tests.
   */
  get retentionDays(): number {
    return resolveRetentionDays();
  }

  /**
   * Delete every WearableProcessedEvent whose `processed_at` is strictly older
   * than `now - retentionDays * 1 day`. Returns the number of rows deleted and
   * the cutoff that was used (so the caller can log it). `now` is injected so
   * tests don't have to manipulate the clock.
   */
  async prune(now: Date): Promise<WearableProcessedEventPruneResult> {
    const cutoff = new Date(now.getTime() - this.retentionDays * DAY_MS);
    const { count } = await this.prisma.wearableProcessedEvent.deleteMany({
      where: { processed_at: { lt: cutoff } },
    });
    return { deleted: count, cutoff };
  }
}
