import { Injectable, Optional } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';

/**
 * B5 — Digital Contracts PostHog telemetry (spec §F).
 *
 * Event names are LOCKED by the spec — do not invent variants. Each fires
 * through the existing `AnalyticsService.capture(distinctId, event, props)`
 * path (no-op when POSTHOG_KEY is unset), so telemetry never throws into a
 * checkout / webhook transaction. AnalyticsService is @Optional so unit tests
 * can construct this without it.
 *
 * `distinctId` is always an opaque server-side user id (never an email);
 * AnalyticsService additionally strips PII keys defensively.
 */
export const ContractEvents = {
  ENVELOPE_CREATED: 'contract.envelope.created',
  ENVELOPE_VIEWED: 'contract.envelope.viewed',
  ENVELOPE_SIGNED: 'contract.envelope.signed',
  ENVELOPE_DECLINED: 'contract.envelope.declined',
  ENVELOPE_EXPIRED: 'contract.envelope.expired',
  /** Client tried Stripe without a SIGNED envelope (gate held). */
  CHECKOUT_BLOCKED: 'contract.checkout.blocked',
  /** A required contract is SIGNED → checkout may proceed. */
  CHECKOUT_GATE_CLEARED: 'contract.checkout.gate.cleared',
} as const;

export type ContractEvent =
  (typeof ContractEvents)[keyof typeof ContractEvents];

@Injectable()
export class ContractsTelemetry {
  constructor(@Optional() private readonly analytics?: AnalyticsService) {}

  private emit(
    distinctId: string,
    event: ContractEvent,
    props?: Record<string, unknown>,
  ): void {
    this.analytics?.capture(distinctId, event, props ?? {});
  }

  envelopeCreated(
    distinctId: string,
    props: { envelope_id: string; layer: 'platform_waiver' | 'coach_service'; provider: string; template_id: string; template_version: number },
  ): void {
    this.emit(distinctId, ContractEvents.ENVELOPE_CREATED, props);
  }

  envelopeViewed(distinctId: string, props: { envelope_id: string }): void {
    this.emit(distinctId, ContractEvents.ENVELOPE_VIEWED, props);
  }

  envelopeSigned(
    distinctId: string,
    props: { envelope_id: string; layer: 'platform_waiver' | 'coach_service' },
  ): void {
    this.emit(distinctId, ContractEvents.ENVELOPE_SIGNED, props);
  }

  envelopeDeclined(distinctId: string, props: { envelope_id: string }): void {
    this.emit(distinctId, ContractEvents.ENVELOPE_DECLINED, props);
  }

  envelopeExpired(distinctId: string, props: { envelope_id: string }): void {
    this.emit(distinctId, ContractEvents.ENVELOPE_EXPIRED, props);
  }

  checkoutBlocked(
    distinctId: string,
    props: { package_id: string; reason: 'platform_waiver_unsigned' | 'coach_contract_unsigned' },
  ): void {
    this.emit(distinctId, ContractEvents.CHECKOUT_BLOCKED, props);
  }

  checkoutGateCleared(
    distinctId: string,
    props: { package_id?: string; envelope_id: string; layer: 'platform_waiver' | 'coach_service' },
  ): void {
    this.emit(distinctId, ContractEvents.CHECKOUT_GATE_CLEARED, props);
  }
}
