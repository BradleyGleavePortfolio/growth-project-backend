/**
 * FEATURE_TEAM_MODE: the server's Team Mode switch (DEFAULT OFF).
 *
 * Team Mode is hidden for launch (owner 2026-10-10) and its routes stay
 * unregistered (A3). Today this switch decides only what the head coach's
 * daily brief carries: while it is off the brief has no team-only item
 * (no sub-coach count or highlights, no sub-coach or team action item, and
 * clients delegated to a sub-coach count as the head coach's own). TM6
 * ("Switch on Team Mode") turns it on together with the mobile teamMode flag.
 *
 * ON only for the exact value "true". Read on every call, never cached at
 * boot. Registered in src/common/env-validation.ts ENV_RULES and
 * prod-switches.yml.
 */
export function isTeamModeEnabled(): boolean {
  return process.env.FEATURE_TEAM_MODE === 'true';
}
