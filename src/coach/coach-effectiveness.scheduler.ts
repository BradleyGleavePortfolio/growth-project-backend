import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { CoachEffectivenessService } from './coach-effectiveness.service';

// Phase 6A — nightly cron tick driving the per-coach effectiveness
// recompute. The math itself lives in CoachEffectivenessService —
// this class is a thin wrapper whose only job is to walk the active
// coach roster, fire score(coachId), log the report, and swallow
// fatal errors so a database hiccup never crashes the Nest process.
//
// Scheduled at 05:00 UTC by default: one hour after the PTM recompute
// at 04:00 UTC, so the effectiveness math reads against a freshly
// updated PtmPrediction table. Override with COACH_EFFECTIVENESS_CRON.
//
// Idempotency: CoachEffectivenessScore is APPEND-ONLY — duplicate ticks
// just write more rows and the latest-row read picks the freshest one.
//
// Disable: set COACH_EFFECTIVENESS_ENABLED='false'. The cron handler
// logs and returns without invoking the service — useful as a kill
// switch when an algorithm regression ships.

export const COACH_EFFECTIVENESS_CRON_DEFAULT = '0 5 * * *';

function resolveCronExpression(): string {
  const raw = process.env.COACH_EFFECTIVENESS_CRON;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return COACH_EFFECTIVENESS_CRON_DEFAULT;
}

export interface EffectivenessSchedulerReport {
  considered: number;
  computed: number;
  errors: number;
}

@Injectable()
export class CoachEffectivenessScheduler {
  private readonly logger = new Logger(CoachEffectivenessScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly effectiveness: CoachEffectivenessService,
  ) {}

  @Cron(resolveCronExpression(), {
    name: 'coach-effectiveness-nightly',
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    if ((process.env.COACH_EFFECTIVENESS_ENABLED ?? '').toLowerCase() === 'false') {
      this.logger.log('Coach effectiveness scoring disabled by env flag');
      return;
    }
    this.logger.log('Coach effectiveness cron tick: starting nightly run');
    try {
      const report = await this.run();
      this.logger.log(
        `Coach effectiveness cron tick: completed; considered=${report.considered} computed=${report.computed} errors=${report.errors}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Coach effectiveness cron tick: fatal error: ${message}`,
      );
    }
  }

  // Per-coach failure is logged but never aborts the run; the next
  // tick will retry naturally.
  async run(): Promise<EffectivenessSchedulerReport> {
    const coaches = await this.prisma.user.findMany({
      where: { role: 'coach', deleted_at: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let computed = 0;
    let errors = 0;
    for (const c of coaches) {
      try {
        await this.effectiveness.score(c.id);
        computed += 1;
      } catch (err: unknown) {
        errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Coach effectiveness recompute failed (coach=${c.id}): ${msg}`,
        );
      }
    }
    return {
      considered: coaches.length,
      computed,
      errors,
    };
  }
}
