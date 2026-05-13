import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CoachAIService } from './coach-ai.service';
import { CoachAIStateService } from './coach-ai-state.service';

// Weekly insight digest cron.
//
// To enable: set CRON_COACH_AI_INSIGHT=on in Fly secrets. Generates
// weekly insight drafts per coach for each of their active clients.
//
// Default: dormant. The cron registration stays in place so a deploy is
// not required to enable it — just `fly secrets set
// CRON_COACH_AI_INSIGHT=on` and the next Monday-at-noon tick will run.
// Even when off the job loads, the body short-circuits before doing
// any work, and zero Anthropic spend is incurred.
@Injectable()
export class WeeklyInsightCron {
  private readonly logger = new Logger('coach-ai:weekly-insight');

  constructor(
    private readonly svc: CoachAIService,
    private readonly state: CoachAIStateService,
  ) {}

  @Cron(CronExpression.EVERY_WEEK)
  async runWeekly(): Promise<void> {
    if (process.env.CRON_COACH_AI_INSIGHT !== 'on') {
      this.logger.debug('disabled (set CRON_COACH_AI_INSIGHT=on to enable)');
      return;
    }
    if (!this.state.isReady()) {
      this.logger.warn('skipping run — Coach AI engine not ready');
      return;
    }
    const coachIds = await this.svc.listActiveCoachIds();
    this.logger.log(`weekly digest starting — coaches=${coachIds.length}`);

    for (const coachId of coachIds) {
      const clientIds = await this.svc.listActiveClientsForCoach(coachId);
      for (const clientId of clientIds) {
        try {
          await this.svc.generateClientInsight(coachId, { clientId, windowDays: 7 });
        } catch (err) {
          // One failed client must not abort the rest of the coach's
          // digest. We log + continue.
          this.logger.warn(
            `weekly insight failed for coach=${coachId} client=${clientId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    this.logger.log('weekly digest complete');
  }
}
