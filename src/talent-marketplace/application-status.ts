// TM-9 — Application-status state machine for the job-hunter surface.
//
// The persisted column is the Prisma `ApplicationStatus` enum
// (submitted/screening/shortlisted/offered/placed/rejected/withdrawn). TM-9 only
// READS status on the /me surface — it never mutates it — so this module exists
// to (a) give the applicant view a stable, validated label set and (b) document
// the lifecycle (terminal states + legal transitions) reused from the old
// Application state machine. No schema change: these are exactly the DB values.

export const APPLICATION_STATUSES = [
  'submitted',
  'screening',
  'shortlisted',
  'offered',
  'placed',
  'rejected',
  'withdrawn',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

// Once an application reaches one of these it never transitions again.
export const TERMINAL_STATUSES: readonly ApplicationStatus[] = [
  'placed',
  'rejected',
  'withdrawn',
];

// Forward lifecycle. `withdrawn` is reachable by the applicant from any
// non-terminal state (they may pull out at any point); the hirer-driven path is
// submitted → screening → shortlisted → offered → placed, with rejected as the
// hirer's terminal "no".
const TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  submitted: ['screening', 'shortlisted', 'rejected', 'withdrawn'],
  screening: ['shortlisted', 'rejected', 'withdrawn'],
  shortlisted: ['offered', 'rejected', 'withdrawn'],
  offered: ['placed', 'rejected', 'withdrawn'],
  placed: [],
  rejected: [],
  withdrawn: [],
};

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return (
    typeof value === 'string' &&
    (APPLICATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminalStatus(status: ApplicationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}
