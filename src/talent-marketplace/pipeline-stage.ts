// TM-8 — Hirer applicant pipeline state machine.
//
// The hirer-facing pipeline vocabulary (`new → screening → interview → offer →
// hired | passed`) is a presentation layer over the persisted
// `ApplicationStatus` enum — TM-8 ships NO schema change, so every stage maps
// onto an existing column value. `passed` and `hired` are terminal. `hired`
// flows into the TM-12 auto-flip (we only mark the stage here; the flip is out
// of scope).
import type { ApplicationStatus } from '@prisma/client';

export const PIPELINE_STAGES = [
  'new',
  'screening',
  'interview',
  'offer',
  'hired',
  'passed',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// Terminal stages accept no outbound transition.
const TERMINAL_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>([
  'hired',
  'passed',
]);

// Allowed forward/branch transitions. Linear advance plus an early `passed`
// from any non-terminal stage (a hirer may reject at any point). `hired` is only
// reachable from `offer`.
const TRANSITIONS: Readonly<Record<PipelineStage, readonly PipelineStage[]>> = {
  new: ['screening', 'passed'],
  screening: ['interview', 'passed'],
  interview: ['offer', 'passed'],
  offer: ['hired', 'passed'],
  hired: [],
  passed: [],
};

// Bidirectional map between the hirer pipeline vocabulary and the persisted
// ApplicationStatus column (the only writable lifecycle field — no new storage).
const STAGE_TO_STATUS: Readonly<Record<PipelineStage, ApplicationStatus>> = {
  new: 'submitted',
  screening: 'screening',
  interview: 'shortlisted',
  offer: 'offered',
  hired: 'placed',
  passed: 'rejected',
};

const STATUS_TO_STAGE: Readonly<Partial<Record<ApplicationStatus, PipelineStage>>> = {
  submitted: 'new',
  screening: 'screening',
  shortlisted: 'interview',
  offered: 'offer',
  placed: 'hired',
  rejected: 'passed',
};

export function isPipelineStage(value: unknown): value is PipelineStage {
  return (
    typeof value === 'string' &&
    (PIPELINE_STAGES as readonly string[]).includes(value)
  );
}

export function isTerminalStage(stage: PipelineStage): boolean {
  return TERMINAL_STAGES.has(stage);
}

export function canTransition(from: PipelineStage, to: PipelineStage): boolean {
  return TRANSITIONS[from].includes(to);
}

export function stageToStatus(stage: PipelineStage): ApplicationStatus {
  return STAGE_TO_STATUS[stage];
}

// Map a persisted status back to a pipeline stage for the READ/DISPLAY path
// (CandidateCard). `withdrawn` (and any future status) has no pipeline
// representation and surfaces as `new` so the queue still renders rather than
// throwing on an out-of-band value. This lossy fallback is tolerated ONLY for
// degraded display — the write path (moveStage) must use `tryStatusToStage`
// below so a status with no genuine pipeline representation cannot be silently
// resurrected into a live stage.
export function statusToStage(status: ApplicationStatus): PipelineStage {
  return STATUS_TO_STAGE[status] ?? 'new';
}

// Strict mapping for the WRITE path. Returns null for any status without a
// genuine pipeline representation (e.g. `withdrawn` — the applicant's own
// opt-out), so moveStage can reject rather than coerce it to `new` and pull a
// withdrawn candidate back into the active pipeline.
export function tryStatusToStage(
  status: ApplicationStatus,
): PipelineStage | null {
  return STATUS_TO_STAGE[status] ?? null;
}
