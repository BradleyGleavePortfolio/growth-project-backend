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
  // `eventStateChanged` fires ONLY on a real lifecycle transition
  // (fromState !== toState). Event creation and RSVP writes are NOT state
  // transitions, so they use their own names below — a subscriber to
  // state_changed can therefore trust it to mean an actual transition (F4).
  eventStateChanged: 'community.event.state_changed',
  eventCreated: 'community.event.created',
  eventRsvpChanged: 'community.event.rsvp_changed',
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
  pushDeliveryFailed: 'community.push.delivery_failed',
  realtimeSubscriberCountUnknown:
    'community.realtime.subscriber_count_unknown',
} as const;

export type CommunityTelemetryEventName =
  (typeof COMMUNITY_TELEMETRY_EVENTS)[keyof typeof COMMUNITY_TELEMETRY_EVENTS];

// ─── Telemetry error classification (PII gate) ──────────────────────────
//
// PostHog failure payloads MUST NOT carry raw exception messages: a message
// from a lower layer can leak user-authored content, emails, names, tokens,
// or stack-ish detail. We instead map any thrown value to a BOUNDED ALLOWLIST
// of coarse codes. Unknown shapes collapse to 'UNKNOWN' — never the raw string.
export type TelemetryErrorCode =
  | 'TOKEN_INVALID'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'AUTH_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'TIMEOUT'
  | 'UNKNOWN';

/**
 * Map an arbitrary thrown value to a bounded telemetry error code. Pattern
 * matching is intentionally conservative and case-insensitive over the
 * message/name only; the original string is NEVER returned. Anything we cannot
 * confidently classify becomes 'UNKNOWN'.
 */
export function classifyTelemetryError(e: unknown): TelemetryErrorCode {
  const raw =
    e instanceof Error
      ? `${e.name} ${e.message}`
      : typeof e === 'string'
        ? e
        : '';
  const s = raw.toLowerCase();
  if (!s) return 'UNKNOWN';

  // Order matters: more specific patterns first.
  if (
    s.includes('devicenotregistered') ||
    s.includes('invalid token') ||
    s.includes('invalid_token') ||
    s.includes('expo push token') ||
    s.includes('push token')
  ) {
    return 'TOKEN_INVALID';
  }
  if (
    s.includes('429') ||
    s.includes('rate limit') ||
    s.includes('rate-limit') ||
    s.includes('too many requests') ||
    s.includes('messageratelimit')
  ) {
    return 'RATE_LIMITED';
  }
  if (
    s.includes('payload') && (s.includes('too large') || s.includes('size')) ||
    s.includes('413') ||
    s.includes('messagetoobig')
  ) {
    return 'PAYLOAD_TOO_LARGE';
  }
  if (
    s.includes('401') ||
    s.includes('403') ||
    s.includes('unauthor') ||
    s.includes('forbidden') ||
    s.includes('auth')
  ) {
    return 'AUTH_ERROR';
  }
  if (s.includes('timeout') || s.includes('timed out') || s.includes('etimedout')) {
    return 'TIMEOUT';
  }
  if (
    s.includes('econnrefused') ||
    s.includes('econnreset') ||
    s.includes('enotfound') ||
    s.includes('network') ||
    s.includes('socket') ||
    s.includes('fetch failed') ||
    s.includes('dns')
  ) {
    return 'NETWORK_ERROR';
  }
  return 'UNKNOWN';
}
