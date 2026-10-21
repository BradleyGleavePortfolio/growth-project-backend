/**
 * Roman Phase 1 — `FEATURE_ROMAN_CHAT_ENABLED` master switch (DEFAULT OFF).
 *
 * Phase 1 ships the chat MVP backend FLAG-OFF by default (brief §0 / §1.6).
 * Mobile UI is not wired yet, so the surface must be invisible in production
 * until the operator explicitly flips the flag.
 *
 * This is a SERVER-SIDE CODE-LEVEL INVARIANT, not merely a UI hint:
 *   - `RomanFeatureGuard` returns 404 (NotFoundException) on every `/roman`
 *     route while the flag is OFF — the controller stays mounted (so the
 *     module-graph cycle guard keeps exercising it) but the surface is
 *     indistinguishable from "no such route" to any caller.
 *   - `RomanService` re-checks the flag before any Anthropic call as
 *     defence-in-depth, so even an internal caller cannot drive the model
 *     while the feature is disabled.
 *
 * Resolution mirrors `isContractsEnabled()` (src/contracts/contracts.feature.ts)
 * EXCEPT Roman has no dev/test auto-enable: the flag is treated as ON ONLY when
 * the value is exactly `'true'` (case-insensitive). This keeps the default-OFF
 * posture identical across every environment — tests that need the feature ON
 * set `FEATURE_ROMAN_CHAT_ENABLED=true` explicitly, which is the same switch an
 * operator flips in prod. No silent environment-dependent behaviour.
 */

/** Env var name for the Roman chat master switch (default OFF everywhere). */
export const FEATURE_ROMAN_CHAT_ENABLED_ENV = 'FEATURE_ROMAN_CHAT_ENABLED';

function isExplicitlyTrue(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'true';
}

/**
 * True when the Roman chat feature is enabled. Single authority every entry
 * point consults before exposing a route or touching the model.
 *
 * Resolution: ON only when the env value is exactly `'true'`. Unset / empty /
 * any other value → OFF (the default-OFF invariant, identical in every env).
 */
export function isRomanChatEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isExplicitlyTrue(env[FEATURE_ROMAN_CHAT_ENABLED_ENV]);
}

/**
 * ROMAN-CRISIS-ALERT switch (DEFAULT OFF, same rule as above): the coach alert
 * after Roman's 911 or 988 reply. Off, no crisis alert is written and neither
 * #CRISIS-WORDING line shows (reply, privacy page), as before.
 * Order: the app that opens the alert (SAFETYWORDS-M) is on phones and the
 * app's crisis sentence (CRISISAPP / CRISISAPP-M) is live, then the owner
 * turns this on.
 */
export const FEATURE_ROMAN_CRISIS_ALERT_ENV = 'FEATURE_ROMAN_CRISIS_ALERT';

export function isRomanCrisisAlertEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isExplicitlyTrue(env[FEATURE_ROMAN_CRISIS_ALERT_ENV]);
}

/**
 * #CRISIS-WORDING (owner op 1), word for word. It follows the Roman
 * safety-reply exception sentence wherever a text states it, only while the
 * switch above is on: the public pages (crisisToldText), client-ai-v8 / v9
 * and consult-consent-v9 / v10 (CRISISAPP), and the app's Trust Center and
 * Roman chats (the roman_crisis_alert feature flag).
 */
export const ROMAN_CRISIS_TOLD_SENTENCE =
  'If Roman sends you a crisis safety reply, your coach is told that it happened, but not what you wrote, so they can check in with you.';

/**
 * WEAR-AI-03 (owner 161-1 op 1, "wording approved"), word for word: the Health
 * and Sleep insight notes. The public pages state it, and (owner #162-6) the
 * first box-2 agreement names it: client-ai-v10 to v13 and consult-consent-v15
 * to v18, v16-coach-free and v17-coach-free.
 */
export const ROMAN_HEALTH_NOTES_SENTENCE =
  'If you allow AI help, Roman also writes short notes about your health and sleep data on your Health pages, and your coach can ask for an AI note about it.';
