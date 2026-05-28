import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CoachAIBudgetService } from './coach-ai-budget.service';

// Monthly rollover cron. Fires once per hour at :05 (override via
// COACH_AI_BUDGET_ROLLOVER_CRON) and rolls over any budget whose
// period_end is in the past. Running hourly rather than once at the
// first-of-month lets us absorb DST shifts, clock skew, and a Fly
// machine that happens to be off at midnight without missing a coach.
// The CoachAIBudgetService.rolloverDueBudgets predicate is
// `period_end <= now` so a row that gets rolled in the 00:05 tick is
// also a no-op in the 01:05 tick — the rollover is idempotent.

export const COACH_AI_BUDGET_ROLLOVER_CRON_DEFAULT = '5 * * * *';

function resolveCron(): string {
  const raw = process.env.COACH_AI_BUDGET_ROLLOVER_CRON;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return COACH_AI_BUDGET_ROLLOVER_CRON_DEFAULT;
}

@Injectable()
export class CoachAIBudgetScheduler {
  private readonly logger = new Logger(CoachAIBudgetScheduler.name);

  constructor(private readonly budget: CoachAIBudgetService) {}

  @Cron(resolveCron(), {
    name: 'coach-ai-budget-rollover',
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    if ((process.env.COACH_AI_BUDGET_ROLLOVER_ENABLED ?? 'true').toLowerCase() === 'false') {
      this.logger.log('rollover cron skipped — COACH_AI_BUDGET_ROLLOVER_ENABLED=false');
      return;
    }
    const start = Date.now();
    try {
      const result = await this.budget.rolloverDueBudgets(new Date());
      const durationMs = Date.now() - start;
      // Structured log — operators tail this for cron-tick observability.
      // The shape mirrors the BullMQ telemetry the audit doc calls out
      // (queue-depth + duration) so dashboards can be uniform.
      this.logger.log(
        {
          event: 'COACH_AI_BUDGET_ROLLOVER_TICK',
          rolled: result.rolled,
          duration_ms: durationMs,
        },
        `rollover tick — rolled=${result.rolled} duration_ms=${durationMs}`,
      );
    } catch (err) {
      // We do NOT rethrow — a database hiccup must not crash the Nest
      // process. Sentry breadcrumb is attached via the logger transport
      // configured in main.ts.
      this.logger.error(
        {
          event: 'COACH_AI_BUDGET_ROLLOVER_ERROR',
          err: (err as Error).message,
          duration_ms: Date.now() - start,
        },
        'rollover cron failed — will retry on next tick',
      );
    }
  }
}
