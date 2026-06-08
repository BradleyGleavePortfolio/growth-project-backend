/**
 * v1-1 — `FEATURE_COMMUNITY_SCHEMA` master switch.
 *
 * This flag records that the Community v1-1 schema (11 tables, partitioned
 * `community_messages`, and RLS on every table) has been migrated into the
 * target environment. Per the execution plan (PR v1-1, rollout line 224) it
 * defaults TRUE *after the migration deploys to staging*, and is NOT
 * user-facing — there is no client toggle. It exists so downstream services
 * (v1-2 `FEATURE_COMMUNITY_API` and beyond) can assert the schema is present
 * before mounting any controller.
 *
 * Posture note: unlike the wearables flags (which default OFF and gate a
 * mounted route with a typed 503), this is a default-ON schema-readiness
 * signal. v1-1 ships SCHEMA ONLY — no controllers, no services, no routes.
 * Controllers stay hidden until v1-2's `FEATURE_COMMUNITY_API` regardless of
 * this flag's value. Reading the env var follows the same
 * exactly-`'true'`/`'false'` (case-insensitive) convention as
 * `isWearablesCloudConnectorsEnabled()` in
 * `src/wearables/cloud-connectors.feature.ts`, with the default inverted to ON.
 */

/** Env var name for the Community schema-readiness switch (default ON). */
export const FEATURE_COMMUNITY_SCHEMA_ENV = 'FEATURE_COMMUNITY_SCHEMA';

/**
 * True unless `FEATURE_COMMUNITY_SCHEMA` is explicitly set to `'false'`
 * (case-insensitive). Absent / any other value → ON, matching the planner's
 * "default true after migration" rollout. An explicit `'false'` lets an
 * operator hard-disable the readiness signal during an incident (for example,
 * a partial migration) so downstream API mounts back off.
 */
export function isCommunitySchemaEnabled(): boolean {
  return process.env[FEATURE_COMMUNITY_SCHEMA_ENV]?.toLowerCase() !== 'false';
}
