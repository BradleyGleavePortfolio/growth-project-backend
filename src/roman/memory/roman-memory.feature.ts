/**
 * Roman v1.1 Phase 1 — `FEATURE_ROMAN_MEMORY` (DEFAULT OFF everywhere).
 *
 * Gates Roman's memory and timeline work: day summaries, notes kept from
 * chats, and the client-memory block in a turn. While the flag is off every
 * memory path is inert and the Roman turn prompt is byte-identical to the
 * pre-v1.1 prompt. Same resolution as `isRomanChatEnabled`
 * (src/roman/roman.feature.ts): ON only for the exact value `true`
 * (case-insensitive); unset, empty, `1` or anything else is OFF.
 */

export const FEATURE_ROMAN_MEMORY_ENV = 'FEATURE_ROMAN_MEMORY';

export function isRomanMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[FEATURE_ROMAN_MEMORY_ENV] ?? '').toLowerCase() === 'true';
}
