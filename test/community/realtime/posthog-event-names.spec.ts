/**
 * posthog-event-names.spec.ts — §10.1 + §9 telemetry contract.
 *
 * The PostHog event names mobile/analytics dashboards key off MUST match
 * §9 of the builder briefs byte-for-byte. A rename in either place silently
 * breaks the funnel — this string-equality pin makes that a red test instead.
 *
 * v1-4 baseline (6 events): realtime broadcast sent/failed, push sent/skipped/
 * delivery_failed, realtime subscriber-count-unknown.
 *
 * v3-2 classroom posts (additive, +3 events): classroom lesson_published,
 * lesson_scheduled, media_upload_issued. Emitted only when
 * FEATURE_COMMUNITY_TELEMETRY === 'true'; property values carry ids /
 * timestamps / enum state only — never lesson title or body text.
 *
 * NOTE: An orphaned community digest event was removed in PR #370 — it had no
 * emitter (no producer function, no capture() call anywhere). The constant map
 * is therefore expected to omit it; the existing email DigestService/
 * DigestScheduler are unrelated.
 *
 * Whenever a new slice adds a community.* telemetry event, this pin must be
 * updated as part of the same slice PR (failure-mode R78 — the pinned table
 * is intentionally exhaustive so additions are visible in review).
 */

import 'reflect-metadata';
import { COMMUNITY_TELEMETRY_EVENTS } from '../../../src/community/community-events';

describe('v1-4 + v3-2 PostHog telemetry event names (§9 exact spelling)', () => {
  it('matches the §9 event-name table exactly', () => {
    expect(COMMUNITY_TELEMETRY_EVENTS).toEqual({
      realtimeBroadcastSent: 'community.realtime.broadcast_sent',
      realtimeBroadcastFailed: 'community.realtime.broadcast_failed',
      pushSent: 'community.push.sent',
      pushSkipped: 'community.push.skipped',
      pushDeliveryFailed: 'community.push.delivery_failed',
      realtimeSubscriberCountUnknown:
        'community.realtime.subscriber_count_unknown',
      classroomLessonPublished: 'community.classroom.lesson_published',
      classroomLessonScheduled: 'community.classroom.lesson_scheduled',
      classroomMediaUploadIssued: 'community.classroom.media_upload_issued',
    });
  });

  it('declares exactly nine telemetry events (6 v1-4 + 3 v3-2 classroom)', () => {
    expect(Object.keys(COMMUNITY_TELEMETRY_EVENTS)).toHaveLength(9);
  });

  it('every event name is in the community.* namespace, snake_case tail', () => {
    for (const name of Object.values(COMMUNITY_TELEMETRY_EVENTS)) {
      expect(name).toMatch(/^community\.[a-z_]+\.[a-z_]+$/);
    }
  });
});
