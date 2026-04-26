/**
 * AnalyticsService — PostHog Node SDK wrapper
 *
 * UX Psychology Report #4: Analytics Tracking (backend)
 *
 * - Lazy-initialised: safe to import in any module before credentials are set.
 * - NO-OP when POSTHOG_KEY is missing (graceful degradation).
 * - PII stripping: blocks email, password, name, phone, address keys.
 * - Never throws — all public methods are guarded internally.
 * - Registered globally so any NestJS service can inject it.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PostHog } from 'posthog-node';

// ─── PII deny-list ────────────────────────────────────────────────────────────

const PII_DENY_KEYS = new Set([
  'email',
  'password',
  'name',
  'full_name',
  'first_name',
  'last_name',
  'phone',
  'phone_number',
  'address',
  'street',
  'city',
  'zip',
  'postcode',
]);

function stripPII(
  props?: Record<string, unknown>,
): Record<string, unknown> {
  if (!props) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!PII_DENY_KEYS.has(key.toLowerCase())) {
      clean[key] = value;
    }
  }
  return clean;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsService.name);
  private client: PostHog | null = null;

  constructor() {
    const key = process.env.POSTHOG_KEY;
    const host =
      process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

    if (!key) {
      this.logger.warn(
        'POSTHOG_KEY not set — analytics are disabled (no-op mode).',
      );
      return;
    }

    try {
      this.client = new PostHog(key, { host, flushAt: 20, flushInterval: 10_000 });
    } catch (err) {
      this.logger.warn(`PostHog init failed: ${(err as Error).message}`);
    }
  }

  /**
   * Track a custom server-side event for a distinct user.
   * `distinctId` should be an opaque server-side user ID (never an email).
   */
  capture(
    distinctId: string,
    event: string,
    props?: Record<string, unknown>,
  ): void {
    try {
      this.client?.capture({
        distinctId,
        event,
        properties: stripPII(props),
      });
    } catch {
      // never throw — analytics must not break the request
    }
  }

  /**
   * Associate server-side properties with a user identity.
   */
  identify(
    distinctId: string,
    props?: Record<string, unknown>,
  ): void {
    try {
      this.client?.identify({
        distinctId,
        properties: stripPII(props),
      });
    } catch {
      // no-op
    }
  }

  // TODO(psych-4): subscription_started event — no subscription code exists in
  // this backend yet. Wire this event in the subscription service/controller
  // once billing/IAP is added.

  /** Flush pending events and shut down the PostHog client on module destroy. */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.client?.shutdown();
    } catch {
      // best-effort
    }
  }
}
