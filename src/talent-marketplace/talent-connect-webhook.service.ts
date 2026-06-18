import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { TalentConnectAdapter } from './connect-adapter.service';

// Minimal shape of a Stripe `account.updated` event we read. The payload's
// `data.object` is the Stripe Account; `id` is the connected account id
// (`acct_...`). We never trust more than these fields and never re-fetch from
// Stripe — the event-driven primary path derives completion from the payload.
interface ConnectAccountEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

export interface TalentConnectWebhookResult {
  received: true;
  processed: boolean;
  onboarding_completed?: boolean;
  alreadyProcessed?: boolean;
  reason?: string;
}

const EVENT_TYPE_ACCOUNT_UPDATED = 'account.updated';

/**
 * TM-14 — event-driven Stripe Connect `account.updated` handler.
 *
 * Primary path that replaces polling for the onboarding-completed signal
 * (fixes P1-7). On a verified `account.updated` event it:
 *   1. dedupes by Stripe event id (MarketplaceConnectEvent PK insert) so a
 *      redelivered event is processed exactly once;
 *   2. derives onboarding completion DIRECTLY from the account payload via the
 *      single TM-10 adapter interpretation (charges_enabled && payouts_enabled)
 *      — no Stripe re-fetch, no second interpretation of Connect fields;
 *   3. persists the event-driven completion state on the ledger row.
 *
 * The legacy ConnectService.syncFromStripe poll (billing webhook) is left
 * intact as a fallback and is NOT touched here.
 */
@Injectable()
export class TalentConnectWebhookService {
  private readonly logger = new Logger(TalentConnectWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async handleAccountUpdated(
    event: ConnectAccountEvent,
  ): Promise<TalentConnectWebhookResult> {
    if (event.type !== EVENT_TYPE_ACCOUNT_UPDATED) {
      // The shared webhook surface may carry sibling event types (TM-13 owns
      // payment_intent.succeeded). Ignore anything that is not ours without
      // recording a dedup row, so the owning handler can still process it.
      return { received: true, processed: false, reason: 'ignored_event_type' };
    }

    const account = this.extractAccount(event.data.object);
    if (!account) {
      this.logger.warn(
        `account.updated ${event.id} missing account id in payload`,
      );
      return { received: true, processed: false, reason: 'missing_account_id' };
    }

    const onboardingCompleted = TalentConnectAdapter.deriveOnboarded({
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
    });

    // Resolve the coach from the existing Connect mirror so the completion
    // state is attributable. Best-effort: a missing mirror still records the
    // event (coach_user_id null) rather than dropping it.
    const mirror = await this.prisma.connectAccount.findUnique({
      where: { stripe_account_id: account.id },
      select: { coach_user_id: true },
    });

    // EVENT-ID IDEMPOTENCY: the PK insert is the dedup gate. A redelivered
    // event collides on the primary key (P2002) and is reported as already
    // processed — the completion state is written exactly once.
    try {
      await this.prisma.marketplaceConnectEvent.create({
        data: {
          stripe_event_id: event.id,
          type: event.type,
          stripe_account_id: account.id,
          coach_user_id: mirror?.coach_user_id ?? null,
          onboarding_completed: onboardingCompleted,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return {
          received: true,
          processed: false,
          alreadyProcessed: true,
          onboarding_completed: onboardingCompleted,
        };
      }
      throw err;
    }

    this.logger.log(
      `account.updated ${event.id} processed acct=${account.id} onboarded=${onboardingCompleted}`,
    );
    return {
      received: true,
      processed: true,
      onboarding_completed: onboardingCompleted,
    };
  }

  // Read only the fields we trust from the Stripe Account payload. The event's
  // `data.object` is the connected account; capability flags default to false
  // when absent so a partial payload never reads as onboarded.
  private extractAccount(
    object: unknown,
  ): { id: string; charges_enabled: boolean; payouts_enabled: boolean } | null {
    if (typeof object !== 'object' || object === null) return null;
    const obj = object as {
      id?: unknown;
      charges_enabled?: unknown;
      payouts_enabled?: unknown;
    };
    const id =
      typeof obj.id === 'string' && obj.id.startsWith('acct_') ? obj.id : null;
    if (!id) return null;
    return {
      id,
      charges_enabled: obj.charges_enabled === true,
      payouts_enabled: obj.payouts_enabled === true,
    };
  }
}
