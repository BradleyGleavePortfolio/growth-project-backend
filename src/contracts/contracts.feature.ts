/**
 * B5 — `FEATURE_CONTRACTS_ENABLED` master switch (DEFAULT OFF in prod).
 *
 * This is the global go-live gate for the entire digital-contracts feature
 * AND the operational enforcement of the lawyer-review hard blocker (spec
 * §5.3 / §8): the draft contract wording in `templates/seed/*.md` was
 * prepared by an agent WITHOUT licensed legal review, so the flag MUST
 * remain OFF in production until counsel signs off.
 *
 * It is wired as a SERVER-SIDE CODE-LEVEL INVARIANT, not merely a UI hint:
 *   - `ContractEnvelopeService.createEnvelope()` throws
 *     `ServiceUnavailableException('Contracts disabled')` when the flag is
 *     OFF — no envelope is ever sent to a provider regardless of caller.
 *   - The HelloSign webhook handler refuses to mutate state when OFF (it
 *     200-acks the provider so retries stop, but performs NO transition).
 *   - The two-layer checkout gate treats OFF as "contracts not in force":
 *     existing (non-`requires_contract`) checkout behavior is unchanged.
 *
 * Posture mirrors `isDunningV2Enabled()` (`src/checkout/dunning-v2/
 * dunning-v2.feature.ts`) and `FEATURE_GOOGLE_CALENDAR_SYNC`: read from the
 * environment, default OFF, treated as ON ONLY when the value is exactly
 * `'true'` (case-insensitive). Absent / empty / any other value → OFF.
 *
 * Dev/test convenience: when `NODE_ENV` is `development` or `test` AND the
 * operator has not explicitly set the flag to `'false'`, the feature is ON
 * so the local suite and dev sandboxes can exercise the flow. Production
 * (`NODE_ENV=production`) NEVER auto-enables: in prod the flag is ON only
 * when explicitly `'true'`. This guarantees "default OFF in prod" as an
 * invariant while keeping dev/test ergonomic (spec §E / §8).
 */

/** Env var name for the contracts master switch (default OFF in prod). */
export const FEATURE_CONTRACTS_ENABLED_ENV = 'FEATURE_CONTRACTS_ENABLED';

/** Future provider-swap flags (spec §8). OFF by default; not wired in v1. */
export const FEATURE_CONTRACTS_DOCUSIGN_PROVIDER_ENV =
  'FEATURE_CONTRACTS_DOCUSIGN_PROVIDER';
export const FEATURE_CONTRACTS_NATIVE_CANVAS_ENV =
  'FEATURE_CONTRACTS_NATIVE_CANVAS';

function isExplicitlyTrue(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'true';
}

function isExplicitlyFalse(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'false';
}

/**
 * True when the digital-contracts feature is enabled. Single authority every
 * entry point consults before touching contract state.
 *
 * Resolution order:
 *   1. Explicit `'true'`  → ON (any env, including prod).
 *   2. Explicit `'false'` → OFF (any env).
 *   3. Unset / other:
 *        - production → OFF (the prod invariant).
 *        - development/test → ON (dev/test convenience).
 *        - anything else → OFF.
 */
export function isContractsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[FEATURE_CONTRACTS_ENABLED_ENV];
  if (isExplicitlyTrue(raw)) return true;
  if (isExplicitlyFalse(raw)) return false;

  const nodeEnv = (env.NODE_ENV ?? '').toLowerCase();
  if (nodeEnv === 'development' || nodeEnv === 'test') return true;

  // Production and every other case default OFF.
  return false;
}

/** DocuSign provider swap (future, enterprise tier). OFF unless `'true'`. */
export function isDocuSignProviderEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isExplicitlyTrue(env[FEATURE_CONTRACTS_DOCUSIGN_PROVIDER_ENV]);
}

/** Native-canvas provider swap (future, cost-reduction). OFF unless `'true'`. */
export function isNativeCanvasProviderEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isExplicitlyTrue(env[FEATURE_CONTRACTS_NATIVE_CANVAS_ENV]);
}
