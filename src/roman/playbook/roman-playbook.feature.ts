/**
 * Roman v1.1 Phase 3 — `FEATURE_ROMAN_PLAYBOOK` (DEFAULT OFF everywhere).
 *
 * Gates the coach playbook: signals, scheduled playbook builds and the
 * coach-method block in a client's turn. While the flag is off every
 * playbook path is inert and the Roman turn prompt is byte-identical to the
 * pre-v1.1 prompt. Same resolution as `isRomanChatEnabled`
 * (src/roman/roman.feature.ts): ON only for the exact value `true`
 * (case-insensitive); unset, empty, `1` or anything else is OFF.
 */

export const FEATURE_ROMAN_PLAYBOOK_ENV = 'FEATURE_ROMAN_PLAYBOOK';

export function isRomanPlaybookEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[FEATURE_ROMAN_PLAYBOOK_ENV] ?? '').toLowerCase() === 'true';
}
