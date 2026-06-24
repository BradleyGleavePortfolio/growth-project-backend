// TM-9 — Application-status label set + terminal-state predicate. These mirror
// the persisted Prisma `ApplicationStatus` enum exactly (no schema change).

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

export const TERMINAL_STATUSES: readonly ApplicationStatus[] = [
  'placed',
  'rejected',
  'withdrawn',
];

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return (
    typeof value === 'string' &&
    (APPLICATION_STATUSES as readonly string[]).includes(value)
  );
}

// Accepts `unknown` so call sites holding a Prisma-enum value (typed as the
// generated enum, not our mirror) can ask without a cast (A-P2-2). Membership
// is checked against the terminal set widened to strings; a non-string can
// never be terminal.
export function isTerminalStatus(status: unknown): boolean {
  return (
    typeof status === 'string' &&
    (TERMINAL_STATUSES as readonly string[]).includes(status)
  );
}
