/**
 * Roman v1.1 — `FEATURE_ROMAN_TOOLS` (DEFAULT OFF everywhere).
 *
 * Gates tool-using turns: Roman reading the client's own history, exercise
 * loads, food days and baselines through the toolbox during a turn. While the
 * flag is off (or no toolbox is provided) every turn is the single streaming
 * call it is today. Same resolution as `isRomanMemoryEnabled`
 * (src/roman/memory/roman-memory.feature.ts): ON only for the exact value
 * `true` (case-insensitive); unset, empty, `1` or anything else is OFF.
 */

export const FEATURE_ROMAN_TOOLS_ENV = 'FEATURE_ROMAN_TOOLS';

export function isRomanToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[FEATURE_ROMAN_TOOLS_ENV] ?? '').toLowerCase() === 'true';
}
