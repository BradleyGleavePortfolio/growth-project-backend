/** Types for scripts/env-truth/fly-env-desired-state.js (plain CommonJS). */
export interface PendingFlag {
  value: 'true' | 'false';
  wave: string;
  needed_by: string;
  gate: string;
}
export interface DesiredState {
  app?: string;
  secrets: string[];
  flags: Record<string, string>;
  pending_flags: Record<string, PendingFlag>;
  excluded?: Record<string, string>;
}
export function validateDesiredState(
  manifest: unknown,
  registeredNames: readonly string[],
): string[];
export function flagAssignments(manifest: { flags: Record<string, string> }): string[];
export function loadDesiredState(file: string): DesiredState;
