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

export function isTerminalStatus(status: ApplicationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
