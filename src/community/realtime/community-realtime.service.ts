/**
 * community-realtime.service.ts — Community v1-4 Supabase Realtime broadcaster.
 *
 * WHY a separate sub-module instead of extending SupabaseService:
 *  - Keeps SupabaseService a thin Supabase-client wrapper (single
 *    responsibility); this owns the Community broadcast semantics.
 *  - Lets v1-4 callers/tests mock RealtimeService without mocking the whole
 *    Supabase client.
 *  - Mirrors the v1-3 sub-module layout (messages/, posts/, reactions/, …).
 *
 * It reuses the PROVEN broadcastNewMessage pattern from
 * src/supabase/supabase.service.ts:43 — subscribe → send → removeChannel, a
 * 1500ms timeout so a Supabase outage can't hang the request, and
 * logged-and-swallowed failures (the request's HTTP response is never affected:
 * realtime is best-effort, the 60s REST poll is the floor).
 *
 * THE POLL FLOOR STAYS. Realtime is the accelerator above REST, not a
 * replacement. Do not remove the mobile 60s poll because this exists (#27).
 *
 * Flags are read from process.env AT THE CALL SITE (never boot-cached) so
 * staging can toggle without a restart — matching community.service.ts:115.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { AnalyticsService } from '../../analytics/analytics.service';
import {
  COMMUNITY_REALTIME_CHANNELS,
  COMMUNITY_TELEMETRY_EVENTS,
  CommunityBroadcastEventName,
  CommunityChannelKind,
} from '../community-events';
import type { CommunityBroadcastPayload } from './community-realtime.types';

const BROADCAST_TIMEOUT_MS = 1500;

@Injectable()
export class CommunityRealtimeService {
  private readonly logger = new Logger(CommunityRealtimeService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Realtime flag — read per call, never cached. */
  private realtimeEnabled(): boolean {
    return process.env.FEATURE_COMMUNITY_REALTIME === 'true';
  }

  /** Telemetry flag — read per call, never cached. */
  private telemetryEnabled(): boolean {
    return process.env.FEATURE_COMMUNITY_TELEMETRY === 'true';
  }

  // ── Channel builders (re-exported from the typed const map) ──────────────

  readonly channels = COMMUNITY_REALTIME_CHANNELS;

  /**
   * Deterministic cohort shard in [0, 4). Cohorts can have hundreds of
   * members, so cohort broadcasts fan out across four sub-channels. The hash
   * is a stable FNV-1a-style fold over the cohortId so the SAME cohort always
   * lands on the SAME shard (mobile computes the identical value to subscribe).
   *
   * Pure, dependency-free, and stable across Node versions — we do not use
   * Math.random or a crypto digest (overkill for a 4-way fan-out).
   */
  static communityCohortShard(cohortId: string): number {
    let h = 2166136261 >>> 0; // FNV offset basis
    for (let i = 0; i < cohortId.length; i++) {
      h ^= cohortId.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0; // FNV prime
    }
    return h % 4;
  }

  /** Instance alias so callers with only the service handle can shard too. */
  cohortShard(cohortId: string): number {
    return CommunityRealtimeService.communityCohortShard(cohortId);
  }

  // ── Broadcast ────────────────────────────────────────────────────────────

  /**
   * Fire-and-forget broadcast of an ID-only ping on a Community channel. The
   * caller MUST `void`-prefix this from a request handler (failure #24): we
   * never block or fail a write on realtime delivery.
   *
   * @param channel    fully-built channel name (use this.channels.*)
   * @param event      one of COMMUNITY_BROADCAST_EVENTS values
   * @param payload    ID/timestamp/enum-only payload (NO user text)
   * @param meta       telemetry tagging: the recipient userId + channel_kind
   */
  async broadcastCommunityEvent(
    channel: string,
    event: CommunityBroadcastEventName,
    payload: CommunityBroadcastPayload,
    meta: { distinctId: string; channelKind: CommunityChannelKind },
  ): Promise<void> {
    // Kill switch: when the flag is off, the server never touches Supabase
    // Realtime. Mobile's 60s REST poll continues to carry the floor.
    if (!this.realtimeEnabled()) return;
    if (!channel) return;

    const serialized = JSON.stringify(payload);
    const payloadSizeBytes = Buffer.byteLength(serialized);

    try {
      const client = this.supabase.getClient();
      const ch = client.channel(channel);
      // Subscribe-then-send-then-remove: Realtime requires a subscribed
      // channel before send() delivers. Bounded by a 1500ms timeout so a
      // Supabase outage degrades gracefully instead of hanging the caller.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('realtime_subscribe_timeout')),
          BROADCAST_TIMEOUT_MS,
        );
        ch.subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            try {
              await ch.send({ type: 'broadcast', event, payload });
              clearTimeout(timeout);
              resolve();
            } catch (sendErr) {
              clearTimeout(timeout);
              reject(sendErr as Error);
            }
          }
        });
      });
      await client.removeChannel(ch);

      // Telemetry: broadcast succeeded. No user text — channel_kind + event
      // name + payload size only.
      this.track(meta.distinctId, COMMUNITY_TELEMETRY_EVENTS.realtimeBroadcastSent, {
        channel_kind: meta.channelKind,
        event_name: event,
        payload_size_bytes: payloadSizeBytes,
      });
    } catch (err) {
      // #36 — never silently swallow. Log at warn (server-side only; the
      // SUPABASE_SERVICE_ROLE_KEY never appears in a client response, #12)
      // and emit the failure telemetry (do NOT swallow the analytics call).
      const message = (err as Error).message;
      this.logger.warn(
        `broadcastCommunityEvent failed: channel=${channel} event=${event} kind=${meta.channelKind}: ${message}`,
      );
      this.track(
        meta.distinctId,
        COMMUNITY_TELEMETRY_EVENTS.realtimeBroadcastFailed,
        {
          channel_kind: meta.channelKind,
          event_name: event,
          error_code: message,
        },
      );
    }
  }

  /**
   * Telemetry helper. Reads the FEATURE_COMMUNITY_TELEMETRY flag per call.
   * AnalyticsService is itself a no-op when POSTHOG_KEY is unset, so this is
   * doubly safe. Property keys are snake_case; values carry no user text.
   */
  private track(
    distinctId: string,
    event: string,
    props: Record<string, unknown>,
  ): void {
    if (!this.telemetryEnabled()) return;
    this.analytics.capture(distinctId, event, props);
  }
}
