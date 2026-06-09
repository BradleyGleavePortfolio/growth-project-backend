/**
 * Bank-Account Payouts v2 — `FEATURE_BANK_PAYOUTS_V2` master switch
 * (DEFAULT OFF).
 *
 * Every Bank-Account Payouts v2 code path — the `PayoutMethodService` CRUD,
 * the Financial Connections link/complete flow, the `payout.paid` /
 * `account.external_account.updated` routing branches, and the
 * `PayoutMethodController` write endpoints — is gated behind this single flag.
 * While it is OFF, the existing Stripe Express payout flow (the §2.5
 * `STRIPE_EXPRESS` branch) remains the active default and NONE of the v2
 * surfaces fire: service methods no-op and return safe defaults (empty lists /
 * nulls) and the routing switch behaves exactly as the pre-v2 code did. The new
 * `PayoutMethod` table + `User.default_payout_method_id` column are never
 * written by any code path while the flag is off.
 *
 * Posture mirrors `isDunningV2Enabled()` (`src/checkout/dunning-v2/
 * dunning-v2.feature.ts`) and `isWearablesCloudConnectorsEnabled()`: the flag
 * is read from the environment, defaults OFF, and is treated as ON ONLY when
 * the value is exactly `'true'` (case-insensitive). Absent / empty / any other
 * value → OFF. The operator flips it at the R66 / merge gate.
 *
 * There is intentionally no allowlist variant: bank payouts touch
 * money-movement bookkeeping, so it is a clean global on/off rather than a
 * per-user gradual rollout.
 */

/** Env var name for the Bank-Account Payouts v2 master switch (default OFF). */
export const FEATURE_BANK_PAYOUTS_V2_ENV = 'FEATURE_BANK_PAYOUTS_V2';

/**
 * Env var name for the (future) Stripe Treasury upgrade switch (spec §6).
 * Reserved here so the §2.5 routing switch can consult it. Default OFF; while
 * off the `STRIPE_TREASURY` branch behaves exactly like
 * `STRIPE_CONNECT_CUSTOM_BANK`. No Treasury code ships in this PR.
 */
export const FEATURE_STRIPE_TREASURY_PAYOUTS_ENV =
  'FEATURE_STRIPE_TREASURY_PAYOUTS';

/**
 * True ONLY when `FEATURE_BANK_PAYOUTS_V2` is exactly `'true'`
 * (case-insensitive). Absent / any other value → OFF. This is the single
 * authority every v2 entry point consults before touching state.
 */
export function isBankPayoutsV2Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env[FEATURE_BANK_PAYOUTS_V2_ENV] ?? '').toLowerCase() === 'true';
}

/**
 * True ONLY when `FEATURE_STRIPE_TREASURY_PAYOUTS` is exactly `'true'`
 * (case-insensitive). Default OFF (spec §6). Inert in this PR — the routing
 * switch reads it but the Treasury reconciliation work is a LATER PR.
 */
export function isStripeTreasuryPayoutsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    (env[FEATURE_STRIPE_TREASURY_PAYOUTS_ENV] ?? '').toLowerCase() === 'true'
  );
}
