/**
 * community-realtime.service.ts — Community Supabase Realtime pings (v1-4; private since C10RT).
 *
 * WHY a separate sub-module instead of extending SupabaseService:
 *  - Keeps SupabaseService a thin Supabase-client wrapper (single
 *    responsibility); this owns the Community broadcast semantics.
 *  - Lets v1-4 callers/tests mock RealtimeService without mocking the whole
 *    Supabase client.
 *
 * WHO HEARS A PING (C10RT). There are no shared topics. A ping goes to the
 * private topic of each person who may read its row at that moment,
 * `community:user:<User.id>`: named people, or everyone app.community_can_access
 * lets read the space (or the Hall) now (readersNow). Realtime lets a signed-in
 * person receive on their own topic only (policy community_realtime_own_topic_receive
 * on realtime.messages, 20270502003300), and a private broadcast never reaches a
 * public channel, so a signed-out or guessing listener gets nothing, and a removed
 * member, a banned person or a client who moved coach stops getting pings at once.
 *
 * Each ping is one REST broadcast (httpSend, no socket join) bounded by a 1500ms
 * timeout; failures are logged and swallowed (the request's HTTP response is never
 * affected: realtime is best-effort, the 60s REST poll is the floor).
 *
 * THE POLL FLOOR STAYS. Realtime is the accelerator above REST, not a
 * replacement. Do not remove the mobile 60s poll because this exists (#27).
 *
 * Flags are read from process.env AT THE CALL SITE (never boot-cached) so
 * staging can toggle without a restart — matching community.service.ts:115.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../../supabase/supabase.service';
import { AnalyticsService } from '../../analytics/analytics.service';
import { PrismaService } from '../../prisma.service';
import { readersNow } from '../community-space-access';
import {
  COMMUNITY_BROADCAST_EVENTS,
  COMMUNITY_REALTIME_CHANNELS,
  COMMUNITY_TELEMETRY_EVENTS,
  CommunityBroadcastEventName,
  CommunityChannelKind,
  classifyTelemetryError,
} from '../community-events';
import type { CommunityBroadcastPayload } from './community-realtime.types';

const BROADCAST_TIMEOUT_MS = 1500;

/** Who a ping is for: named people, the workspace's coach (moderation), or everyone the rule
 * lets read a row of the workspace now (of the space when cohortId is set, else of the Hall). */
export type CommunityAudience =
  | { people: readonly string[] }
  | { coachOf: string }
  | { workspaceId: string; cohortId: string | null };

@Injectable()
export class CommunityRealtimeService {
  private readonly logger = new Logger(CommunityRealtimeService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly analytics: AnalyticsService,
    private readonly prisma: PrismaService,
  ) {}

  /** SC-PUSH: the space push listens at the one point every stored space message passes. */
  private spaceMessageStored?: (messageId: string) => Promise<void>;

  onSpaceMessageStored(listener: (messageId: string) => Promise<void>): void {
    this.spaceMessageStored = listener;
  }

  /** Realtime flag — read per call, never cached. */
  private realtimeEnabled(): boolean {
    return process.env.FEATURE_COMMUNITY_REALTIME === 'true';
  }

  /** Telemetry flag — read per call, never cached. */
  private telemetryEnabled(): boolean {
    return process.env.FEATURE_COMMUNITY_TELEMETRY === 'true';
  }

  // ── Broadcast ────────────────────────────────────────────────────────────

  /**
   * Fire-and-forget ID-only ping to the private topic of everyone in the
   * audience. The caller MUST `void`-prefix this from a request handler
   * (failure #24): we never block or fail a write on realtime delivery.
   *
   * @param audience   who may hear it (see CommunityAudience); decided now
   * @param event      one of COMMUNITY_BROADCAST_EVENTS values
   * @param payload    ID/timestamp/enum-only payload (NO user text)
   * @param meta       telemetry tagging: the acting userId + what the ping is about
   */
  async broadcastCommunityEvent(
    audience: CommunityAudience,
    event: CommunityBroadcastEventName,
    payload: CommunityBroadcastPayload,
    meta: { distinctId: string; channelKind: CommunityChannelKind },
  ): Promise<void> {
    // SC-PUSH: every stored space message (text, voice, image) passes here; the push has its own switch.
    const storedId = (payload as { id?: unknown }).id;
    if (event === COMMUNITY_BROADCAST_EVENTS.messageCreated && 'cohortId' in audience && audience.cohortId && typeof storedId === 'string') {
      void this.spaceMessageStored?.(storedId);
    }
    // Kill switch: when the flag is off, the server never touches Supabase
    // Realtime. Mobile's 60s REST poll continues to carry the floor.
    if (!this.realtimeEnabled()) return;

    const payloadSizeBytes = Buffer.byteLength(JSON.stringify(payload));
    try {
      const people = await this.peopleIn(audience);
      if (people.length === 0) return;
      const client = this.supabase.getClient();
      const sent = await Promise.allSettled(
        people.map((id) => this.sendPrivate(client, COMMUNITY_REALTIME_CHANNELS.user(id), event, payload)),
      );
      const failed = sent.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;

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
      // Log the raw message SERVER-SIDE ONLY (never leaves the process).
      const message = (err as Error).message;
      this.logger.warn(
        `broadcastCommunityEvent failed: event=${event} kind=${meta.channelKind}: ${message}`,
      );
      // Telemetry carries a BOUNDED, allowlisted code — never the raw message
      // (PII gate): a lower-layer string could leak user text / emails / tokens.
      this.track(meta.distinctId, COMMUNITY_TELEMETRY_EVENTS.realtimeBroadcastFailed, {
        channel_kind: meta.channelKind,
        event_name: event,
        error_code: classifyTelemetryError(err),
      });
    }
  }

  /** The audience's people, decided now. */
  private async peopleIn(audience: CommunityAudience): Promise<string[]> {
    if ('people' in audience) return [...new Set(audience.people)];
    if ('coachOf' in audience) {
      const ws = await this.prisma.communityWorkspace.findUnique({
        where: { id: audience.coachOf },
        select: { coach_id: true },
      });
      return ws ? [ws.coach_id] : [];
    }
    return readersNow(this.prisma, audience.workspaceId, audience.cohortId);
  }

  /**
   * One REST broadcast on a private topic. The channel object is always
   * released (C-610-4: a channel left behind keeps the client holding it).
   */
  private async sendPrivate(
    client: SupabaseClient,
    topic: string,
    event: CommunityBroadcastEventName,
    payload: CommunityBroadcastPayload,
  ): Promise<void> {
    const ch = client.channel(topic, { config: { private: true } });
    try {
      const res = await ch.httpSend(event, payload, { timeout: BROADCAST_TIMEOUT_MS });
      if (!res.success) throw new Error(res.error);
    } finally {
      try {
        await client.removeChannel(ch);
      } catch (removeErr) {
        this.logger.warn(`broadcastCommunityEvent channel cleanup failed: ${(removeErr as Error).message}`);
      }
    }
  }

  /**
   * Telemetry helper. Reads the FEATURE_COMMUNITY_TELEMETRY flag per call.
   * AnalyticsService is itself a no-op when POSTHOG_KEY is unset, so this is
   * doubly safe. Property keys are snake_case; values carry no user text.
   */
  private track(distinctId: string, event: string, props: Record<string, unknown>): void {
    if (!this.telemetryEnabled()) return;
    this.analytics.capture(distinctId, event, props);
  }
}
