import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CommunityMessage, User } from '@prisma/client';
import { AnalyticsService } from '../../analytics/analytics.service';
import { CommunityAccessService } from '../community-access.service';
import { placeOf } from '../community-space-access';
import { CommunityDmsRepository } from '../dms/community-dms.repository';
import { assertDmReadable } from '../dms/community-dms.service';
import { CommunitySafetyService } from '../safety/community-safety.service';
import { AckRepository } from './ack.repository';
import {
  ACK_STATE_RANK,
  AckState,
  AckStateDto,
  AckTransitionResponseDto,
} from './ack.dto';
import { buildSlaSnapshot, resolveSlaThresholds } from './sla';

/**
 * The slice of the authenticated user the ack flow actually reads: the caller
 * id (telemetry distinct id + coach-ownership lookup) and the platform role
 * (owner bypass). Controllers pass a full `User` (req.user), which satisfies
 * this; tests can build a minimal typed actor without faking every User field
 * — keeping fixtures cast-free (R0).
 */
export type AckActor = Pick<User, 'id' | 'role'>;

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.ack.message_not_found',
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
 * in a DIFFERENT workspace gets a non-leaking 404 — never a 403 that would
 * confirm the message exists in another tenant).
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
    private readonly safety: CommunitySafetyService,
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
   * Authorize the caller as the coach who owns the message's workspace, then
   * confirm the message is eligible for coach acks.
   *
   * Non-leak doctrine (mirrors the community read surfaces — see
   * CommunityMessagesService.getOne/edit/remove, which map every inaccessible
   * read to 404 before any ownership-specific check): a message the caller
   * cannot act on — absent, soft-deleted, in a workspace the caller does not
   * coach, OR not a client-authored ackable message — ALL resolve to the SAME
   * 404. There is no 403-vs-404 oracle, so random ID probing cannot tell
   * "no such message" from "real message in another workspace" or "real
   * message that just isn't ackable". The controller's RolesGuard already
   * rejects non-coach/owner JWTs, so the remaining same-tenant 403 case the
   * old code tried to surface does not arise here.
   *
   * Eligibility (R1 fix): only a CLIENT-authored (User.role === 'student')
   * cohort/DM message may be acked. Coach/owner/system-authored messages are
   * not ackable and 404 identically — preventing nonsensical client-visible
   * ack state on messages that should never carry a coach acknowledgement.
   *
   * Visibility: a message hidden from the coach's read path (block either way,
   * banned author, moved-away client outside a public space) 404s identically
   * too — the ack routes act only on what the coach can read (FR-1174: the
   * full read rule of the row's kind, below).
   */
  private async authorize(
    user: AckActor,
    messageId: string,
  ): Promise<CommunityMessage> {
    const m = await this.repo.findById(messageId);
    if (!m || m.deleted_at) {
      throw new NotFoundException(NOT_FOUND);
    }
    // Tenant visibility: a platform owner sees all; any other caller must coach
    // the message's workspace, or be one the inbox lists this space row to
    // (rule D, FR-1173 LS-INBOX2 B2): the space's team, or in a public space
    // the poster's own coach (that row only, read and acknowledge). A caller
    // who cannot read the message gets the not-found response — never a 403
    // that would confirm the ID exists.
    let ownCoach = false;
    if (user.role !== 'owner' && !(await this.access.isWorkspaceCoach(m.workspace_id, user.id))) {
      const space = m.scope === 'dm' ? null : m.cohort_id;
      ownCoach = space !== null && (await this.repo.isPublicRowOfMyClient(space, user.id, m.sender_id));
      if (!ownCoach && !(space !== null && (await this.repo.isSpaceTeam(space, user.id)))) {
        throw new NotFoundException(NOT_FOUND);
      }
    }
    // Eligibility: only a client-authored message is ackable. An ineligible
    // (coach/owner/system-authored) message 404s identically to absent, so the
    // eligibility check is not itself an existence oracle.
    const senderRole = await this.repo.findSenderRole(m.id);
    if (senderRole !== 'student') {
      throw new NotFoundException(NOT_FOUND);
    }
    // Read rule (FR-1174): an ack write passes the full rule the caller's read
    // of this row passes, per kind. A DM: the DM reader's rule
    // (assertDmReadable) on the thread the reader derives from the caller and
    // the author, so only the DM's other person may ack it, while both still
    // hold a membership, neither blocked the other and DMs are on for both. A
    // space row: CommunityMessagesService.getOne's rule — a plain chat row in a
    // space the caller may enter. Post comments, challenge comments and the
    // leaderboard opt-in sentinel (plan_context_type set) are never acked by
    // the app (it acks coach-inbox rows only) and 404.
    if (m.scope === 'dm') {
      const ws = m.dm_key === CommunityDmsRepository.dmKey(m.workspace_id, user.id, m.sender_id)
        ? await this.access.findWorkspace(m.workspace_id) : null;
      if (!ws) throw new NotFoundException(NOT_FOUND);
      await assertDmReadable(this.access, this.safety, ws, user.id, m.sender_id).catch((e: unknown) => {
        throw e instanceof HttpException ? new NotFoundException(NOT_FOUND) : e;
      });
    } else {
      const cohort = m.cohort_id && m.plan_context_type === null ? await this.access.findCohort(m.cohort_id) : null;
      if (!cohort || !(ownCoach || (await this.access.canAccessCohort(cohort, user)))) throw new NotFoundException(NOT_FOUND);
    }
    // Visibility (LS-1134D): then the gate getOne calls —
    // CommunitySafetyService.assertVisibleTo with the row's place (a block
    // either way, the author banned from this community, or a client who moved
    // away writing in the Hall, a DM or a space that is not public). Every
    // refusal answers the same 404 as an absent message, before the idempotent
    // no-op below, so a retry on an already-stamped message hands back no
    // timestamps either.
    await this.safety.assertVisibleTo(user.id, m.sender_id, NOT_FOUND, placeOf(m));
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
    user: AckActor,
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
    const { advanced, message: updated } = await this.repo.stampAck(
      message,
      column,
      now,
    );

    // Concurrency guard: the atomic conditional write only advanced the state
    // if it moved exactly one row. A concurrent caller that lost the race (or
    // any other zero-row outcome) gets the existing envelope as an idempotent
    // no-op and emits NO telemetry — so two simultaneous requests produce at
    // most one advance and one event.
    if (!advanced) {
      return this.responseFor(updated);
    }

    const toState = this.deriveState(updated);
    const envelope = this.buildAckEnvelope(updated, now);

    // Telemetry ONLY on an actual state-advancing transition. AnalyticsService
    // is a no-op when POSTHOG_KEY is unset and never throws, so this cannot
    // break the request. IDs only — no message body / PII in the payload.
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
