/**
 * MWB-3 — deterministic optimistic-lock token helper (spec §6.2 G8).
 *
 * The autosave `lock_token` is NOT a random opaque blob: it is a deterministic
 * HMAC-SHA256 fingerprint of the plan's PERSISTED optimistic-concurrency state
 * — the tuple `(planId, WorkoutPlan.version, WorkoutPlan.head_revision_id)`.
 * Both `version` (Int) and `head_revision_id` (String) are already persisted on
 * the WorkoutPlan row (see prisma/schema.prisma — NO new column is added; R69).
 *
 * Because the token is a pure function of persisted state, the server can:
 *   - re-derive the EXPECTED token from the current row on every request and
 *     reject a stale client token with a typed 409 (real optimistic lock), and
 *   - hand back the NEW token after a commit, computed from the post-commit
 *     `version` + `head_revision_id`, with zero extra storage.
 *
 * Determinism contract: identical inputs (and identical secret) ALWAYS yield the
 * identical 16-hex token. The 16-hex shape matches the existing
 * `LOCK_TOKEN_RE` in workout-builder-autosave.dto.ts, so the wire shape is
 * unchanged.
 *
 * Secret handling (R0 — no silent default): the HMAC key is read from
 * `MWB_AUTOSAVE_LOCK_TOKEN_SECRET`. There is NO fallback secret. When the
 * feature flag is ON and the secret is absent, token derivation throws — the
 * service surfaces this loudly rather than minting forgeable tokens under a
 * predictable empty key. `assertLockTokenSecretConfigured()` lets the config
 * layer fail fast at bootstrap when the feature is enabled without the secret.
 */

import { createHmac } from 'crypto';

/** Env var holding the HMAC key for autosave lock tokens (32+ random bytes hex in prod). */
export const MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV =
  'MWB_AUTOSAVE_LOCK_TOKEN_SECRET';

/** Number of leading hex chars of the HMAC retained as the token (matches LOCK_TOKEN_RE: 16). */
export const LOCK_TOKEN_HEX_LEN = 16;

/**
 * Resolve the HMAC secret or throw. Reads from `process.env` at call time so a
 * test can set/unset it deterministically and an operator can rotate it without
 * a code change. Never defaults — an absent/blank secret is a hard error (R0).
 */
function resolveSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = (env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] ?? '').trim();
  if (secret === '') {
    throw new Error(
      `${MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV} is not set; the MWB-3 autosave ` +
        'lock token cannot be derived without an HMAC secret (no default ' +
        'permitted). Set it to 32+ random bytes of hex when ' +
        'FEATURE_MWB_AUTOSAVE_UNDO=true.',
    );
  }
  return secret;
}

/**
 * Deterministically derive the optimistic-lock token for a plan's persisted
 * state. The HMAC message is the canonical string `<planId>:<version>:<headRevisionId>`;
 * the token is the first {@link LOCK_TOKEN_HEX_LEN} hex chars of the digest.
 *
 * @throws Error if the HMAC secret env var is unset/blank (R0 — never defaults).
 */
export function computeLockToken(
  planId: string,
  version: number,
  headRevisionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = resolveSecret(env);
  const message = `${planId}:${version}:${headRevisionId}`;
  return createHmac('sha256', secret)
    .update(message)
    .digest('hex')
    .slice(0, LOCK_TOKEN_HEX_LEN);
}

/**
 * Bootstrap/config guard: throw when the feature flag is ON but the HMAC secret
 * is absent, so a misconfigured production deploy fails fast (R0 — no silent
 * default). A no-op when the feature is OFF (the token path is never reached).
 */
export function assertLockTokenSecretConfigured(
  env: NodeJS.ProcessEnv = process.env,
): void {
  resolveSecret(env);
}
