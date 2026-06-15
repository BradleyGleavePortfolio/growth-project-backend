import { Injectable, Optional } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import type { AppRole } from '../common/decorators/roles.decorator';

/**
 * D5 = B+γ — feature-flag evaluation telemetry.
 *
 * Fires a single `feature_flags_evaluated` event per `GET /me/feature-flags`
 * call through the existing AnalyticsService.capture path (no-op when
 * POSTHOG_KEY is unset, and capture() never throws). AnalyticsService is
 * @Optional so unit tests can construct this without it.
 *
 * `distinctId` is the opaque server-side userId (AnalyticsService additionally
 * strips PII keys defensively). We emit the role and the flag count — NOT the
 * individual flag values — so the event is a cheap volume/segmentation signal
 * without leaking the full flag map into the analytics pipeline.
 */
export const FeatureFlagEvents = {
  EVALUATED: 'feature_flags_evaluated',
} as const;

export type FeatureFlagEvent =
  (typeof FeatureFlagEvents)[keyof typeof FeatureFlagEvents];

@Injectable()
export class FeatureFlagsTelemetry {
  constructor(@Optional() private readonly analytics?: AnalyticsService) {}

  evaluated(
    userId: string,
    props: { role: AppRole; flag_count: number },
  ): void {
    this.analytics?.capture(userId, FeatureFlagEvents.EVALUATED, props);
  }
}
