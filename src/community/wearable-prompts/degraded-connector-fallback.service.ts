import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { WearableConnectionStatus } from '../../wearables/connections/types';
import { AnalyticsService } from '../../analytics/analytics.service';
import { COMMUNITY_TELEMETRY_EVENTS } from '../community-events';

/**
 * degraded-connector-fallback.service.ts — short-circuits prompt generation
 * when a client's wearable connector is NOT in the CONNECTED state.
 *
 * V3_4_PREFLIGHT_NOTES §2/§4 CORRECTION: there is NO `disabled` connector
 * state. The real lifecycle (src/wearables/connections/types.ts) is
 * CONNECTED / EXPIRED / ERROR / DISCONNECTED, stored as a string in
 * WearableConnection.status. A connector is "degraded" iff its status is
 * anything other than CONNECTED. Generating a prompt off a degraded connector
 * would surface STALE health data to a coach (50-Failures "stale data in
 * prompts") — so the generator MUST call this check first and skip on a
 * non-CONNECTED result, and this service emits the fallback telemetry.
 *
 * The status column is free-form text in the schema; we compare against the
 * enum's string values and treat ANY unrecognized / missing status as degraded
 * (fail-explicit, never fail-open onto stale data).
 */

export interface ConnectorGateResult {
  /** True only when the client has a CONNECTED connector — generation may run. */
  ok: boolean;
  /** Bounded reason when not ok (never a raw status string from the DB). */
  reason: WearableConnectionStatus | 'none';
}

@Injectable()
export class DegradedConnectorFallbackService {
  private readonly logger = new Logger(DegradedConnectorFallbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Resolve whether the client has AT LEAST ONE connected wearable connector.
   * Returns ok=false (with a bounded reason) when every connector is degraded
   * or none exists, and emits the fallback telemetry event in that case.
   */
  async gate(
    workspaceId: string,
    coachId: string,
    clientId: string,
  ): Promise<ConnectorGateResult> {
    const connections = await this.prisma.wearableConnection.findMany({
      where: { user_id: clientId },
      select: { status: true },
    });

    const hasConnected = connections.some(
      (c) => c.status === WearableConnectionStatus.CONNECTED,
    );

    if (hasConnected) {
      return { ok: true, reason: 'none' };
    }

    // Pick a representative bounded reason from the actual enum values. Map an
    // unknown / missing status onto DISCONNECTED so telemetry never carries a
    // free-form string and a phantom value can never leak.
    const reason = this.deriveBoundedReason(connections.map((c) => c.status));

    if (process.env.FEATURE_COMMUNITY_TELEMETRY === 'true') {
      this.analytics.capture(
        coachId,
        COMMUNITY_TELEMETRY_EVENTS.wearablePromptFallbackFired,
        {
          workspace_id: workspaceId,
          // client id is an opaque server id (not PII per AnalyticsService).
          client_id: clientId,
          reason,
        },
      );
    }

    this.logger.log({
      event: 'community_wearable_prompt_fallback',
      workspace_id: workspaceId,
      coach_id: coachId,
      client_id: clientId,
      reason,
    });

    return { ok: false, reason };
  }

  /**
   * Collapse the set of (possibly unrecognized) status strings to ONE bounded
   * enum reason. Preference order EXPIRED > ERROR > DISCONNECTED so the coach
   * sees the most actionable cause; no connector at all → 'none'.
   */
  private deriveBoundedReason(
    statuses: string[],
  ): WearableConnectionStatus | 'none' {
    if (statuses.length === 0) return 'none';
    if (statuses.includes(WearableConnectionStatus.EXPIRED)) {
      return WearableConnectionStatus.EXPIRED;
    }
    if (statuses.includes(WearableConnectionStatus.ERROR)) {
      return WearableConnectionStatus.ERROR;
    }
    // DISCONNECTED, or any unrecognized status, collapses here (fail-explicit).
    return WearableConnectionStatus.DISCONNECTED;
  }
}
