/**
 * posthog-event-names.spec.ts — §10.1 + §9 telemetry contract.
 *
 * The six PostHog event names mobile/analytics dashboards key off MUST match
 * §9 of the builder brief byte-for-byte. A rename in either place silently
 * breaks the funnel — this string-equality pin makes that a red test instead.
 *
 * NOTE: An orphaned community digest event was removed in PR #370 — it had no
 * emitter (no producer function, no capture() call anywhere). The constant map
 * is therefore expected to omit it; the existing email DigestService/
 * DigestScheduler are unrelated. This spec asserts the current set of six
 * telemetry events. See the fixer RLS/telemetry change set.
 */

import 'reflect-metadata';
import { COMMUNITY_TELEMETRY_EVENTS } from '../../../src/community/community-events';

describe('v1-4 PostHog telemetry event names (§9 exact spelling)', () => {
  it('matches the §9 event-name table exactly', () => {
    expect(COMMUNITY_TELEMETRY_EVENTS).toEqual({
      realtimeBroadcastSent: 'community.realtime.broadcast_sent',
      realtimeBroadcastFailed: 'community.realtime.broadcast_failed',
      pushSent: 'community.push.sent',
      pushSkipped: 'community.push.skipped',
      pushDeliveryFailed: 'community.push.delivery_failed',
      realtimeSubscriberCountUnknown:
        'community.realtime.subscriber_count_unknown',
    });
  });

  it('declares exactly six telemetry events', () => {
    expect(Object.keys(COMMUNITY_TELEMETRY_EVENTS)).toHaveLength(6);
  });

  it('every event name is in the community.* namespace, snake_case tail', () => {
    for (const name of Object.values(COMMUNITY_TELEMETRY_EVENTS)) {
      expect(name).toMatch(/^community\.[a-z_]+\.[a-z_]+$/);
    }
  });
});
