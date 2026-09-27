/**
 * G2-S10-B live-proof observations layered on the S10-B-only derivative
 * (test/utils/g2-s10b-pg-harness.ts) of the S9-C harness (derived from
 * test/utils/g2-s9c-harness.ts in d3a9-s9c-r2, read-only). Carries the S7-L run-lifecycle fixture
 * helpers unchanged by substitution (User → ImportIntent, server/legacy run rows, staged rows,
 * deadline clock, run/completion snapshots, the exact §3.1 gate text) and adds only the S10-B
 * table names, SQL-level declaration/observation row fixtures and row readers. The S8-C native /
 * S9-C settle fixtures (spec, rule set, catalog, target snapshots) are not carried: S10-B never
 * settles (S10-C). No production writer is emulated: the routes run as the real ObservationService
 * in test/utils/g2-s10b-worker.cjs. Imported only by the explicitly guarded test/rls-g2-s10b.spec.ts.
 */
import { json, quote, sql } from './g2-s10b-pg-harness';

export const RUN = 'ScoutImport';
export const INTENT = 'ImportIntent';
export const COMPLETION = 'ScoutImportCompletion';
export const STAGED = 'ScoutIngestEntity';
export const DECLARATION = 'ScoutRunDeclaration';
export const OBSERVATION = 'ScoutRunObservation';
export const SETTLED = 'ScoutRunSettledBasis';
export const S10_TABLES = [DECLARATION, OBSERVATION, SETTLED] as const;
/** Fixture platform: canonical, synthetic, registered only through the injected registry. */
export const PLATFORM = 'synthetic-src-a';
export const PLATFORM_B = 'synthetic-src-b';
/** Worker option injecting the synthetic induction registry (platform → expected families). */
export const REGISTRY = {
  registry: {
    [PLATFORM]: ['clients', 'programs', 'workouts'],
    [PLATFORM_B]: ['clients'],
  },
};

/** Synthetic owner row (User is the FK target of ImportIntent coach_id). */
export function ensureUser(coach: string) {
  sql(`INSERT INTO "User" (id,supabase_id,email,name,role)
    VALUES (${quote(coach)},${quote(`sb-${coach}`)},${quote(`${coach}@synthetic.invalid`)},${quote(`Synthetic ${coach}`)},'coach')
    ON CONFLICT (id) DO NOTHING`);
}
/** Synthetic setup intent for `coach`; returns its UUID. C1 keeps ONE current setup per coach
 *  (`ImportIntent_one_current_key`), so any earlier current intent of the coach is superseded
 *  first (fixture shaping). `paired=false` → S7-L Start must refuse `intent_not_paired`. */
export function intent(coach: string, paired = true): string {
  ensureUser(coach);
  return sql(`UPDATE "${INTENT}" SET superseded_at=now() WHERE coach_id=${quote(coach)} AND superseded_at IS NULL;
    INSERT INTO "${INTENT}" (id,coach_id,chosen_platform,paired_at)
    VALUES (gen_random_uuid(),${quote(coach)},'truecoach',${paired ? 'now()' : 'NULL'})
    RETURNING id`);
}
/** Settled LEGACY run row (the pre-S7-L writer's shape). */
export function legacyRun(coach: string, intent: string, terminal: string | null = 'success') {
  ensureUser(coach);
  sql(`INSERT INTO "${RUN}" (id,coach_id,intent_id,state,terminal_status,completed_at)
    VALUES (${quote(`${coach}-${intent}`)},${quote(coach)},${quote(intent)},
      ${terminal === null ? "'in_progress'" : quote(terminal)},${terminal === null ? 'NULL' : quote(terminal)},
      ${terminal === null ? 'NULL' : 'now()'})
    ON CONFLICT DO NOTHING`);
}
/** One SERVER run row written directly (SQL-level fixtures only). Behavioural runs come from the
 *  real Start through the worker. */
export function serverRunInsert(
  coach: string,
  intentId: string,
  overrides: Partial<Record<string, string>> = {},
) {
  const v: Record<string, string> = {
    id: quote(`${coach}-${intentId}`),
    coach_id: quote(coach),
    intent_id: quote(intentId),
    state: "'in_progress'",
    terminal_status: 'NULL',
    mode: "'server'",
    import_intent_id: `${quote(intentId)}::uuid`,
    phase: "'discovering'",
    accepted_start_at: "(now() AT TIME ZONE 'UTC')",
    deadline_at: "(now() AT TIME ZONE 'UTC') + interval '5 minutes'",
    ...overrides,
  };
  const names = Object.keys(v);
  return `INSERT INTO "${RUN}" (${names.join(',')}) VALUES (${names.map((n) => v[n]).join(',')})`;
}
/** One staged row (the accepted ingest shape) written directly. */
export function stage(
  coach: string,
  intent: string,
  token: string,
  source: string,
  payload: Record<string, unknown> = { name: `Synthetic ${source}` },
  platform: string = PLATFORM,
) {
  sql(`INSERT INTO "${STAGED}" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
    VALUES (${quote(`${coach}-${intent}-${token}-${platform}-${source}`)},${quote(coach)},${quote(intent)},${quote(token)},
    ${quote(source)},${quote(platform)},${quote(JSON.stringify(payload))})
    ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`);
}
/** Move a server run's deadline into the past (fixture clock; the service never updates it). */
export function expire(coach: string, intent: string) {
  sql(`UPDATE "${RUN}" SET deadline_at=accepted_start_at + interval '1 millisecond'
    WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}`);
}

/** 64-hex digest literal of `text` computed by PostgreSQL (pgcrypto), for SQL-level fixtures. */
export const hexOf = (text: string) => `encode(digest(${quote(text)},'sha256'),'hex')`;
/** One declaration row as SQL (SQL-level fixtures only; the route inserts through the service).
 *  `challenge` is a SQL bytea expression, `scope` a SQL text expression. */
export function declarationInsert(
  coach: string,
  intentId: string,
  opts: { platform?: string; scope?: string; challenge?: string; declaredAt?: string } = {},
) {
  return `INSERT INTO "${DECLARATION}" (coach_id,intent_id,source_platform,account_scope_id_digest,challenge,declared_at)
    VALUES (${quote(coach)},${quote(intentId)},${quote(opts.platform ?? PLATFORM)},
      ${opts.scope ?? hexOf('synthetic-scope-1')},${opts.challenge ?? "decode(repeat('07',32),'hex')"},
      ${opts.declaredAt ?? "'2026-09-26 00:00:00'"})`;
}
/** One observation row as SQL (SQL-level fixtures only). */
export function observationInsert(
  coach: string,
  intentId: string,
  opts: {
    platform?: string;
    scope?: string;
    family?: string;
    epoch?: number;
    digest?: string;
  } = {},
) {
  return `INSERT INTO "${OBSERVATION}" (id,coach_id,intent_id,execution_epoch,source_platform,account_scope_id_digest,
      family,basis_kind,evidence,evidence_digest,received_at)
    VALUES (gen_random_uuid()::text,${quote(coach)},${quote(intentId)},${opts.epoch ?? 1},${quote(opts.platform ?? PLATFORM)},
      ${opts.scope ?? hexOf('synthetic-scope-1')},${quote(opts.family ?? 'clients')},'source_signed_enumeration',
      '{"evidence_version":1}'::jsonb,${opts.digest ?? hexOf('synthetic-evidence')},'2026-09-26 00:00:00')`;
}
/** One settled-basis row as SQL (SQL-level fixtures only; S10-C writes it in production). */
export function settledInsert(coach: string, intentId: string) {
  return `INSERT INTO "${SETTLED}" (coach_id,intent_id,execution_epoch,report_version,report,observation_digests,settled_at)
    VALUES (${quote(coach)},${quote(intentId)},1,1,'{}'::jsonb,ARRAY[${hexOf('synthetic-evidence')}],'2026-09-26 00:00:00')`;
}

/** One run row (all columns) or null. */
export const runRow = (coach: string, intent: string) =>
  json(
    `SELECT COALESCE((SELECT to_jsonb(r) FROM "${RUN}" r WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}),'null')`,
  );
export const completionRows = () =>
  json(
    `SELECT COALESCE(jsonb_agg(jsonb_build_array(coach_id,intent_id,terminal_status) ORDER BY coach_id,intent_id),'[]') FROM "${COMPLETION}"`,
  );
/** Declaration rows of one run, ordered, with the challenge as hex. */
export const declarationRows = (coach: string, intent: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('source_platform',source_platform,
    'account_scope_id_digest',account_scope_id_digest,'challenge',encode(challenge,'hex'),
    'declared_at',declared_at) ORDER BY source_platform,account_scope_id_digest),'[]')
    FROM "${DECLARATION}" WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}`) as Array<
    Record<string, string>
  >;
/** Observation rows of one run, ordered by unit. */
export const observationRows = (coach: string, intent: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('execution_epoch',execution_epoch,
    'source_platform',source_platform,'account_scope_id_digest',account_scope_id_digest,'family',family,
    'basis_kind',basis_kind,'evidence_digest',evidence_digest,'evidence',evidence)
    ORDER BY execution_epoch,source_platform,account_scope_id_digest,family),'[]')
    FROM "${OBSERVATION}" WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}`) as Array<
    Record<string, any>
  >;
export const count = (table: string, where = 'true') =>
  Number(sql(`SELECT count(*) FROM "${table}" WHERE ${where}`));

/**
 * Whole-fixture reset: every table the proof writes. The S10-B children are NEVER deleted
 * directly (their insert-only trigger refuses a top-level DELETE): deleting the parent run
 * cascades them, which is exactly the referential-cleanup path the proof asserts.
 */
export function resetData() {
  sql(`DELETE FROM "${STAGED}"; DELETE FROM "ScoutReconstructionLedger"; DELETE FROM "ScoutProgressSnapshot";
    DELETE FROM "${COMPLETION}"; DELETE FROM "${RUN}";
    DELETE FROM "ExtensionPairCode"; DELETE FROM "${INTENT}";`);
}
/** The exact §3.1 gate statement as SQL text for the two-session serialization check. */
export const gateSql = (coach: string, intent: string) =>
  `UPDATE "${RUN}" SET last_observed_at=(now() AT TIME ZONE 'UTC'),
     phase=CASE WHEN phase='discovering' THEN 'transferring' ELSE phase END
   WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)} AND mode='server'
     AND terminal_status IS NULL AND fenced_at IS NULL AND deadline_at>(now() AT TIME ZONE 'UTC')
   RETURNING execution_epoch`;
