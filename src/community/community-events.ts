/**
 * community-events.ts — the single source of truth for Community realtime
 * channel names, broadcast event names, and telemetry event names (v1-4).
 *
 * WHY a standalone const map (not strings scattered across services):
 *  - The auditor greps THIS file for drift. One place, one spelling.
 *  - Mobile (v1-5/v1-6) mirrors these exact strings to subscribe.
 *  - Tests assert string-equality against these consts (no magic strings).
 *
 * DOCTRINE — read before editing:
 *  - Realtime is a BEST-EFFORT layer ABOVE the 60s REST poll floor. The poll
 *    never goes away; realtime/push are optional accelerators. Do NOT
 *    "optimize away" the mobile poll because realtime exists (failure #27).
 *  - Broadcast payloads carry IDs / timestamps / enum state values ONLY.
 *    NEVER a message body, post body, DM body, reaction emoji string,
 *    moderation reason, challenge note, name, or any user-authored text.
 *    The mobile client receives the ping → refetches via the authenticated,
 *    tenant-scoped REST API. The channel itself is treated as untrusted.
 */

// ─── Realtime channels ─────────────────────────────────────────────────────
//
// Convention: `community:<scope>:<id>[:<sub>]`. The `cohort` channel is the
// only sharded one (cohorts can have hundreds of members) — see
// communityCohortShard() in community-realtime.service.ts for the hash.
export const COMMUNITY_REALTIME_CHANNELS = {
  user: (userId: string): string => `community:user:${userId}`,
  cohort: (cohortId: string, shard: number): string =>
    `community:cohort:${cohortId}:messages:${shard}`,
  workspace: (wsId: string): string => `community:workspace:${wsId}:hall`,
  event: (eventId: string): string => `community:event:${eventId}`,
  challenge: (challengeId: string): string =>
    `community:challenge:${challengeId}`,
  moderation: (wsId: string): string => `community:moderation:${wsId}`,
} as const;

/** The six channel-kind keys, for telemetry `channel_kind` tagging. */
export type CommunityChannelKind = keyof typeof COMMUNITY_REALTIME_CHANNELS;

// ─── Broadcast event names ─────────────────────────────────────────────────
//
// The nine events the server BROADCASTS in v1-4. v1-4 only emits; mobile
// subscribes. Two (event.state_changed, challenge.progress_changed) are
// emitter wiring only — the full lifecycles land in v2-3 / v3-1.
export const COMMUNITY_BROADCAST_EVENTS = {
  messageCreated: 'community.message.created',
  messageUpdated: 'community.message.updated',
  postCreated: 'community.post.created',
  postUpdated: 'community.post.updated',
  reactionChanged: 'community.reaction.changed',
  eventStateChanged: 'community.event.state_changed',
  challengeProgressChanged: 'community.challenge.progress_changed',
  moderationActionCreated: 'community.moderation.action_created',
  membershipChanged: 'community.membership.changed',
} as const;

export type CommunityBroadcastEventName =
  (typeof COMMUNITY_BROADCAST_EVENTS)[keyof typeof COMMUNITY_BROADCAST_EVENTS];

// ─── Telemetry (PostHog) event names ───────────────────────────────────────
//
// Emitted only when FEATURE_COMMUNITY_TELEMETRY === 'true' (read at the call
// site, never boot-cached). Property values must never carry user-authored
// text or PII — pre-strip at the call site, do not rely on AnalyticsService.
export const COMMUNITY_TELEMETRY_EVENTS = {
  realtimeBroadcastSent: 'community.realtime.broadcast_sent',
  realtimeBroadcastFailed: 'community.realtime.broadcast_failed',
  pushSent: 'community.push.sent',
  pushSkipped: 'community.push.skipped',
  digestQueued: 'community.digest.queued',
  pushDeliveryFailed: 'community.push.delivery_failed',
  realtimeSubscriberCountUnknown:
    'community.realtime.subscriber_count_unknown',
} as const;

export type CommunityTelemetryEventName =
  (typeof COMMUNITY_TELEMETRY_EVENTS)[keyof typeof COMMUNITY_TELEMETRY_EVENTS];
