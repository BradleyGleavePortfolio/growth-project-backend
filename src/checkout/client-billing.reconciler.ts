import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ClientBillingService } from './client-billing.service';
import { dunningErrorCode } from './dunning-v2/dunning-v2.safe-error';

/** Hourly at minute 37 UTC: away from the dunning v2 sweep (minute 7). */
export const CLIENT_BILLING_RECONCILE_CRON_EXPRESSION = '37 * * * *';

/**
 * S-DUNNING-R2 (owner 2A) — finishes a client's in-dunning cancel whose
 * Stripe cancel did not complete after the invoice was voided (the voided
 * invoice turns the subscription active again, so an unfinished cancel would
 * otherwise renew next month), and, with FEATURE_DUNNING_V2 on, applies 2A to
 * a cycle whose subscription was set to cancel outside the app.
 *
 * Every step is idempotent (Stripe Idempotency-Keys, already-void and
 * already-canceled count as done), so two machines running the same tick do
 * no harm. Within one process a slow tick is never stacked (`running`).
 */
@Injectable()
export class ClientBillingReconciler {
  private readonly logger = new Logger(ClientBillingReconciler.name);
  private running = false;

  constructor(private readonly billing: ClientBillingService) {}

  @Cron(CLIENT_BILLING_RECONCILE_CRON_EXPRESSION, {
    name: 'client-billing-reconcile',
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    if (this.running) {
      this.logger.warn('client billing reconcile: previous tick still running, skipping');
      return;
    }
    this.running = true;
    try {
      const out = await this.billing.reconcile();
      if (out.finished + out.applied + out.failed > 0) {
        this.logger.log(JSON.stringify({ event: 'client_billing.reconcile_completed', ...out }));
      }
    } catch (err: unknown) {
      this.logger.error(`client billing reconcile: fatal error: ${dunningErrorCode(err)}`);
    } finally {
      this.running = false;
    }
  }
}
