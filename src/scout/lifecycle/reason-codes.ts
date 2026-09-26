import { ConflictException } from '@nestjs/common';

// S7-L D-S7L-5 — the ONLY source of lifecycle vocabularies and reason codes
// (docs/decisions/2026-09-24-s7l-run-lifecycle.md §2, §3). Emitted as OpenAPI enums
// through src/scout/lifecycle/lifecycle.dto.ts (CQ-17). No free text is ever
// persisted or projected: the extension's `error_summary` is stored, never shown.

/** D-S7L-1: every pre-S7-L row and every client-minted string is `legacy`. */
export const RUN_MODES = ['legacy', 'server'] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** §3 open-run phases, in order; NULL on legacy rows. */
export const RUN_PHASES = ['discovering', 'transferring', 'reconciling'] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

/** D-S7L-4 fence reasons. `revoked` is reserved for G3 (no route or principal in S7-L). */
export const FENCE_REASONS = ['cancelled', 'timed_out', 'revoked'] as const;
export type FenceReason = (typeof FENCE_REASONS)[number];

/**
 * Server-run terminal vocabulary (§3, invariant 2). `complete` is written only from an S9
 * reconciliation verdict; `success` never appears on a server row (CQ-18 legacy marker).
 */
export const SERVER_TERMINAL_STATUSES = [
  'complete',
  'partial',
  'blocked',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type ServerTerminalStatus = (typeof SERVER_TERMINAL_STATUSES)[number];

/** HTTP 409 conflict codes (D-S7L-5), thrown as `ConflictException({code, message})`. */
export const RUN_CONFLICT_CODES = [
  'intent_not_paired',
  'intent_superseded',
  'run_terminal',
  'run_not_started',
  'run_fenced',
  'legacy_run',
] as const;
export type RunConflictCode = (typeof RUN_CONFLICT_CODES)[number];

/**
 * Outcome reason codes persisted in `ScoutImport.reason_code` (D-S7L-5). The last three are the
 * S9 reconciliation codes (D-S9-7), appended by S9-C in D-S9-2 condition order after the six
 * S7-L codes; the list is append-only and the existing order is preserved.
 */
export const RUN_REASON_CODES = [
  'reconciliation_not_performed',
  'cancelled_by_coach',
  'deadline_exceeded',
  'transfer_failed',
  'unresolved_family',
  'revoked',
  'unresolved_identities',
  'relationship_unverified',
  'coverage_basis_unknown',
] as const;
export type RunReasonCode = (typeof RUN_REASON_CODES)[number];

/**
 * S9-C — closed enums of the additive `families[]` projection (S9-DOC D-S9-5, Addendum C-7 /
 * C-10), emitted as OpenAPI enums through `scout.dto.ts`. Both lists are append-only and spelt
 * once here; the S9-A report types (`../reconciliation/types`) are the same literals.
 */
export const FAMILY_QUALIFIERS = ['roster_bridge_pending'] as const;
export type FamilyQualifierCode = (typeof FAMILY_QUALIFIERS)[number];
export const RELATIONSHIP_CLOSURES = ['verified', 'unverified', 'not_applicable'] as const;
export type RelationshipClosureCode = (typeof RELATIONSHIP_CLOSURES)[number];

/** Fixed, identifier-free conflict messages; the code is the machine-readable part. */
const CONFLICT_MESSAGES: Record<RunConflictCode, string> = {
  intent_not_paired: 'The setup intent has not completed pairing.',
  intent_superseded: 'The setup intent has been superseded; start a new setup.',
  run_terminal: 'The run for this intent has already reached a terminal state.',
  run_not_started: 'No server-owned run has been started for this intent.',
  run_fenced: 'The run for this intent is fenced; no further writes are accepted.',
  legacy_run: 'This intent names a legacy run, which the server does not own.',
};

/** Body of every lifecycle 409: `{code, message}` plus the fence reason when one applies. */
export interface RunConflictBody {
  code: RunConflictCode;
  message: string;
  fence_reason?: FenceReason;
}

/**
 * The single constructor for lifecycle conflicts — the pattern already used by
 * extension-pair.service.ts (`ConflictException({code, message})`), so the global
 * HttpExceptionFilter renders the same envelope with `code` at the top level.
 */
export function runConflict(code: RunConflictCode, fenceReason?: FenceReason): ConflictException {
  const body: RunConflictBody = { code, message: CONFLICT_MESSAGES[code] };
  if (fenceReason) body.fence_reason = fenceReason;
  return new ConflictException(body);
}

export const isServerTerminalStatus = (value: string | null): value is ServerTerminalStatus =>
  value !== null && (SERVER_TERMINAL_STATUSES as readonly string[]).includes(value);

export const isFenceReason = (value: string | null): value is FenceReason =>
  value !== null && (FENCE_REASONS as readonly string[]).includes(value);

export const isRunReasonCode = (value: string | null): value is RunReasonCode =>
  value !== null && (RUN_REASON_CODES as readonly string[]).includes(value);
