import { z } from 'zod';

/**
 * v2-2 coach ack-signal DTOs.
 *
 * These are COACH-SIDE-ONLY signals: a coach explicitly transitions a client
 * message through `seen` → `acked` → `replied`. The state is shown TO the
 * client (read receipt + reply confirmation) but is never something the client
 * can mutate. SLA is a derived, read-time projection (time-since-receipt vs the
 * configured soft/hard thresholds), not a persisted column.
 */

// ── Ack state ──────────────────────────────────────────────────────────────

/**
 * The four ordered ack states. Ordering for badge precedence is
 * `replied > acked > seen > none` — see ACK_STATE_RANK below.
 */
export const ACK_STATES = ['none', 'seen', 'acked', 'replied'] as const;
export type AckState = (typeof ACK_STATES)[number];

/**
 * Monotonic rank used for badge precedence and to forbid backward transitions
 * (cannot un-ack a replied message). Higher wins.
 */
export const ACK_STATE_RANK: Record<AckState, number> = {
  none: 0,
  seen: 1,
  acked: 2,
  replied: 3,
};

/** The three SLA states, derived from elapsed time vs configured thresholds. */
export const SLA_STATES = ['within', 'warning', 'breached'] as const;
export type SlaState = (typeof SLA_STATES)[number];

// ── Zod response schemas (match the v1-2 .parse() convention) ───────────────

/**
 * The SLA snapshot for a message: the derived state plus the inputs that
 * produced it, so a client can render a countdown without re-deriving the
 * thresholds. `elapsed_ms` is time since message receipt; the soft/hard
 * thresholds are the configured targets (env-configurable, default 24h/48h).
 */
export const SlaSnapshotSchema = z
  .object({
    sla_state: z.enum(SLA_STATES),
    elapsed_ms: z.number().int().nonnegative(),
    soft_target_ms: z.number().int().positive(),
    hard_target_ms: z.number().int().positive(),
  })
  .strict();

export type SlaSnapshotDto = z.infer<typeof SlaSnapshotSchema>;

/**
 * The ack envelope attached (OPTIONAL, additive) to a message view when the
 * flag is ON. `seen_at`/`acked_at`/`replied_at` mirror the existing
 * `coach_*_at` columns (ISO strings or null); `state` is the derived highest
 * reached state; `sla` is the read-time SLA snapshot.
 */
export const AckStateSchema = z
  .object({
    state: z.enum(ACK_STATES),
    seen_at: z.string().datetime().nullable(),
    acked_at: z.string().datetime().nullable(),
    replied_at: z.string().datetime().nullable(),
    sla: SlaSnapshotSchema,
  })
  .strict();

export type AckStateDto = z.infer<typeof AckStateSchema>;

/** POST /community/ack/:messageId/(seen|acked|replied) response envelope. */
export const AckTransitionResponseSchema = z
  .object({
    message_id: z.guid(),
    ack: AckStateSchema,
  })
  .strict();

export type AckTransitionResponseDto = z.infer<
  typeof AckTransitionResponseSchema
>;

/**
 * Internal request descriptor for a transition. The target state is taken from
 * the route (one endpoint per target) rather than a request body, so there is
 * no client-supplied state to validate — kept as a typed shape for the service
 * boundary and to satisfy R68 (no untyped transition inputs).
 */
export interface AckTransitionRequestDto {
  messageId: string;
  to: Extract<AckState, 'seen' | 'acked' | 'replied'>;
}
