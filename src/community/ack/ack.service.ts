import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CommunityMessage, User } from '@prisma/client';
import { AnalyticsService } from '../../analytics/analytics.service';
import { CommunityAccessService } from '../community-access.service';
import { AckRepository } from './ack.repository';
import {
  ACK_STATE_RANK,
  AckState,
  AckStateDto,
  AckTransitionResponseDto,
} from './ack.dto';
import { buildSlaSnapshot, resolveSlaThresholds } from './sla';

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.ack.message_not_found',
} as const;

const NOT_COACH = {
  error: 'forbidden',
  code: 'community.ack.not_coach',
} as const;

/** PostHog event emitted on every successful (state-advancing) transition. */
export const ACK_TRANSITION_EVENT = 'community.ack.transitioned';

type AckColumn = 'coach_seen_at' | 'coach_acked_at' | 'coach_replied_at';
type AckTarget = Extract<AckState, 'seen' | 'acked' | 'replied'>;

const TARGET_COLUMN: Record<AckTarget, AckColumn> = {
  seen: 'coach_seen_at',
  acked: 'coach_acked_at',
  replied: 'coach_replied_at',
};

/**
 * v2-2 coach ack-signal state machine.
 *
 * A coach explicitly advances a client message through `seen` → `acked` →
 * `replied`. These are coach-side-only signals surfaced TO the client; the
 * client can never call the transition endpoints (controller @Roles gates to
 * coach/owner, and this service re-checks workspace coach ownership so a coach
 * in a DIFFERENT workspace gets 403).
 *
 * State derivation (read side): the highest stamped column wins —
 * `replied_at` ? 'replied' : `acked_at` ? 'acked' : `seen_at` ? 'seen' :
 * 'none'. The ordering is monotonic (ACK_STATE_RANK).
 *
 * Transition rules (write side):
 *  - Idempotency: stamping a column that is already set is a no-op — the
 *    existing timestamp is returned unchanged (calling markAcked twice yields
 *    the same acked_at). No telemetry is emitted for a no-op.
 *  - Monotonicity: a transition whose target rank is at or below the current
 *    highest reached state is rejected as illegal when it would regress the
 *    machine. Specifically, you cannot mark `seen` or `acked` once `replied`
 *    is set (that would imply un-replying) → 409. Re-stamping the SAME state
 *    is the idempotent no-op above, not a regression.
 *  - All writes hit the real columns (R0 — no in-memory state).
 *
 * SLA is derived at read time from the message receipt (created_at) vs the
 * configured thresholds — it is NOT persisted and never gates a transition.
 */
@Injectable()
export class AckService {
  private readonly logger = new Logger(AckService.name);

  constructor(
    private readonly repo: AckRepository,
    private readonly access: CommunityAccessService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Highest reached ack state from the stamped columns. */
  private deriveState(m: CommunityMessage): AckState {
    if (m.coach_replied_at) return 'replied';
    if (m.coach_acked_at) return 'acked';
    if (m.coach_seen_at) return 'seen';
    return 'none';
  }

  /** Project a message row into the read-side ack envelope (state + SLA). */
  buildAckEnvelope(m: CommunityMessage, now: Date = new Date()): AckStateDto {
    const thresholds = resolveSlaThresholds();
    return {
      state: this.deriveState(m),
      seen_at: m.coach_seen_at ? m.coach_seen_at.toISOString() : null,
      acked_at: m.coach_acked_at ? m.coach_acked_at.toISOString() : null,
      replied_at: m.coach_replied_at ? m.coach_replied_at.toISOString() : null,
      sla: buildSlaSnapshot({ receivedAt: m.created_at, now, thresholds }),
    };
  }

  /**
   * Authorize the caller as the coach who owns the message's workspace.
   *
   * Mirrors the v1-2 non-leak doctrine: a message the caller cannot see at all
   * resolves to 404 (existence not leaked across tenants). A platform owner is
   * always authorised; otherwise the caller must own (coach) the message's
   * workspace. A caller who is neither gets 403 not_coach.
   */
  private async authorize(
    user: User,
    messageId: string,
  ): Promise<CommunityMessage> {
    const m = await this.repo.findById(messageId);
    if (!m || m.deleted_at) {
      throw new NotFoundException(NOT_FOUND);
    }
    if (user.role === 'owner') return m;
    const isCoach = await this.access.isWorkspaceCoach(
      m.workspace_id,
      user.id,
    );
    if (!isCoach) {
      throw new ForbiddenException(NOT_COACH);
    }
    return m;
  }

  /**
   * Apply a transition to its target state.
   *
   * Returns the resulting ack envelope. Idempotent (re-stamping an already-set
   * column returns the existing timestamp, no telemetry); rejects a regression
   * (e.g. marking seen/acked after replied) with 409.
   */
  async applyTransition(
    user: User,
    messageId: string,
    to: AckTarget,
  ): Promise<AckTransitionResponseDto> {
    const message = await this.authorize(user, messageId);
    const fromState = this.deriveState(message);
    const column = TARGET_COLUMN[to];
    const existing = message[column];

    // Idempotent no-op: the target column is already stamped. Return the
    // existing envelope unchanged and emit no telemetry.
    if (existing) {
      return this.responseFor(message);
    }

    // Monotonicity guard: never regress below an already-reached higher state.
    // Stamping `to` when a strictly-higher column is already set would imply
    // un-doing that higher state (e.g. seen/acked after replied) → 409.
    if (ACK_STATE_RANK[to] < ACK_STATE_RANK[fromState]) {
      throw new ConflictException({
        error: 'conflict',
        code: 'community.ack.illegal_transition',
        message: `cannot transition to ${to} from ${fromState}`,
      });
    }

    const now = new Date();
    const updated = await this.repo.stampAck(message, column, now);
    const toState = this.deriveState(updated);
    const envelope = this.buildAckEnvelope(updated, now);

    // Telemetry on every state-advancing transition. AnalyticsService is a
    // no-op when POSTHOG_KEY is unset and never throws, so this cannot break
    // the request. IDs only — no message body / PII in the payload.
    this.analytics.capture(user.id, ACK_TRANSITION_EVENT, {
      message_id: updated.id,
      from_state: fromState,
      to_state: toState,
      sla_state: envelope.sla.sla_state,
    });

    return { message_id: updated.id, ack: envelope };
  }

  private responseFor(m: CommunityMessage): AckTransitionResponseDto {
    return { message_id: m.id, ack: this.buildAckEnvelope(m) };
  }
}
