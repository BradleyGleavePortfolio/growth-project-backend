/**
 * S7-L G2 proof fixture helpers for the run lifecycle expand
 * (20270123000000_scout_run_lifecycle_expand): derived as CODE PATTERNS from the accepted S8-B
 * harness test/utils/g2-s8b-harness.ts (catalog readers, OID-free shapes, synthetic fixtures,
 * reset), never as result claims. Everything here is real SQL through the real psql of
 * test/utils/g2-s7l-pg-harness.ts as the owner role `postgres`; the lifecycle WRITERS themselves
 * (Start/cancel/ingest/progress/complete/status) are exercised only through the real services in
 * test/utils/g2-s7l-worker.cjs. Only test/rls-g2-s7l.spec.ts imports this.
 */
import { json, quote, sql } from './g2-s7l-pg-harness';

export const RUN = 'ScoutImport';
export const INTENT = 'ImportIntent';
export const COMPLETION = 'ScoutImportCompletion';
export const STAGED = 'ScoutIngestEntity';

/** The ten S7-L columns in the order the migration adds them. */
export const LIFECYCLE_COLUMNS = [
  'mode',
  'import_intent_id',
  'phase',
  'accepted_start_at',
  'deadline_at',
  'last_observed_at',
  'execution_epoch',
  'fenced_at',
  'fence_reason',
  'reason_code',
] as const;
export const RUN_CHECK_NAMES = [
  'ScoutImport_fence_reason_check',
  'ScoutImport_mode_check',
  'ScoutImport_mode_shape_check',
  'ScoutImport_phase_check',
] as const;
export const FK_NAME = 'ScoutImport_import_intent_id_coach_id_fkey';
export const PARTIAL_INDEX = 'ScoutImport_import_intent_id_key';
/** The three accepted 20261223000100 policies; S7-L must leave them byte-equal. */
export const RUN_POLICIES = [
  'deny_all_anon_scout_import',
  'deny_all_authenticated_scout_import',
  'p_scout_import_service_role_all',
] as const;

export const MODES = ['legacy', 'server'] as const;
export const PHASES = ['discovering', 'transferring', 'reconciling'] as const;
export const FENCE_REASONS = ['cancelled', 'timed_out', 'revoked'] as const;
export const LEGACY_TERMINALS = ['success', 'partial', 'failed'] as const;
export const SERVER_TERMINALS = [
  'complete',
  'partial',
  'blocked',
  'failed',
  'cancelled',
  'timed_out',
] as const;

const TS3 = 'timestamp(3) without time zone';
/** [name, format_type, notnull, default] of the ten new columns, exactly as the migration ships. */
export const EXPECTED_LIFECYCLE_COLUMNS: [string, string, boolean, string | null][] = [
  ['mode', 'text', true, "'legacy'::text"],
  ['import_intent_id', 'uuid', false, null],
  ['phase', 'text', false, null],
  ['accepted_start_at', TS3, false, null],
  ['deadline_at', TS3, false, null],
  ['last_observed_at', TS3, false, null],
  ['execution_epoch', 'integer', true, '1'],
  ['fenced_at', TS3, false, null],
  ['fence_reason', 'text', false, null],
  ['reason_code', 'text', false, null],
];
const anyOf = (values: readonly string[]) =>
  `ANY (ARRAY[${values.map((v) => `'${v}'::text`).join(', ')}])`;
/** pg_get_constraintdef renderings of the four CHECKs (pinned; a mismatch is a pin fix, never a
 *  migration edit — the SQL semantics are fixed by the decision). */
export const EXPECTED_CHECK_DEFS: Record<(typeof RUN_CHECK_NAMES)[number], string> = {
  ScoutImport_mode_check: `CHECK ((mode = ${anyOf(MODES)}))`,
  ScoutImport_phase_check: `CHECK (((phase IS NULL) OR (phase = ${anyOf(PHASES)})))`,
  ScoutImport_fence_reason_check: `CHECK ((((fenced_at IS NULL) = (fence_reason IS NULL)) AND ((fence_reason IS NULL) OR (fence_reason = ${anyOf(FENCE_REASONS)})) AND (execution_epoch >= 1)))`,
  ScoutImport_mode_shape_check: `CHECK ((((mode = 'legacy'::text) AND (import_intent_id IS NULL) AND ((terminal_status IS NULL) OR (terminal_status = ${anyOf(LEGACY_TERMINALS)}))) OR ((mode = 'server'::text) AND (import_intent_id IS NOT NULL) AND (accepted_start_at IS NOT NULL) AND (deadline_at IS NOT NULL) AND (deadline_at > accepted_start_at) AND ((terminal_status IS NULL) OR (terminal_status = ${anyOf(SERVER_TERMINALS)})))))`,
};
export const EXPECTED_FK_DEF =
  'FOREIGN KEY (import_intent_id, coach_id) REFERENCES "ImportIntent"(id, coach_id) ON UPDATE CASCADE ON DELETE RESTRICT';
export const EXPECTED_INDEX_DEFS: Record<string, string> = {
  ScoutImport_pkey: `CREATE UNIQUE INDEX "ScoutImport_pkey" ON public."ScoutImport" USING btree (id)`,
  ScoutImport_coach_id_intent_id_key: `CREATE UNIQUE INDEX "ScoutImport_coach_id_intent_id_key" ON public."ScoutImport" USING btree (coach_id, intent_id)`,
  ScoutImport_coach_id_idx: `CREATE INDEX "ScoutImport_coach_id_idx" ON public."ScoutImport" USING btree (coach_id)`,
  [PARTIAL_INDEX]: `CREATE UNIQUE INDEX "${PARTIAL_INDEX}" ON public."ScoutImport" USING btree (import_intent_id) WHERE (import_intent_id IS NOT NULL)`,
};

const rel = (table: string) => `'public."${table}"'::regclass`;
export const exists = (table: string) =>
  sql(`SELECT to_regclass('public."${table}"') IS NOT NULL`) === 't';
/** Every column of a table in attnum order: name, rendered type, NOT NULL, rendered default. */
export const columns = (table: string) =>
  exists(table)
    ? json(`SELECT COALESCE(jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
    pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum),'[]')
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=${rel(table)} AND a.attnum>0 AND NOT a.attisdropped`)
    : [];
/** Every constraint of a table (CHECK, FK, PK) by name with validation flag and definition. */
export const constraints = (table: string, withOids = false) =>
  exists(table)
    ? json(`SELECT COALESCE(jsonb_agg(jsonb_build_array(conname,contype,convalidated,pg_get_constraintdef(oid)
    ${withOids ? ',oid' : ''}) ORDER BY conname),'[]')
  FROM pg_constraint WHERE conrelid=${rel(table)}`)
    : [];
/** Every index of a table by name with its definition (and OID when asked). */
export const indexes = (table: string, withOids = false) =>
  exists(table)
    ? json(`SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname,i.indisunique,i.indisvalid,pg_get_indexdef(i.indexrelid)
    ${withOids ? ',i.indexrelid' : ''}) ORDER BY c.relname),'[]')
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=${rel(table)}`)
    : [];
/** RLS posture of a table: flags plus every policy row (pg_policies has no OIDs) and every grant. */
export const rls = (table: string) =>
  exists(table)
    ? json(`SELECT jsonb_build_object(
  'enabled',(SELECT relrowsecurity FROM pg_class WHERE oid=${rel(table)}),
  'forced',(SELECT relforcerowsecurity FROM pg_class WHERE oid=${rel(table)}),
  'policies',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY policyname),'[]') FROM pg_policies p
    WHERE schemaname='public' AND tablename=${quote(table)}),
  'grants',(SELECT COALESCE(jsonb_agg(jsonb_build_array(grantee,privilege_type) ORDER BY grantee,privilege_type),'[]')
    FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name=${quote(table)}))`)
    : null;
const tableShape = (table: string, withOids: boolean) => ({
  columns: columns(table),
  constraints: constraints(table, withOids),
  indexes: indexes(table, withOids),
  rls: rls(table),
  ...(withOids
    ? { relfilenode: sql(`SELECT relfilenode FROM pg_class WHERE oid=${rel(table)}`) }
    : {}),
});
/** OID-free shape of the run table and its FK target. Equal across down → up (L04). */
export const shape = () => ({ run: tableShape(RUN, false), intent: tableShape(INTENT, false) });
/** Shape with OIDs/relfilenode: equal across a refused rerun/down (nothing recreated). */
export const shapeWithOids = () => ({
  run: tableShape(RUN, true),
  intent: tableShape(INTENT, true),
});
/** The lifecycle columns' entries only, or [] when absent. */
export const lifecycleColumns = () =>
  columns(RUN).filter(([name]: [string]) =>
    (LIFECYCLE_COLUMNS as readonly string[]).includes(name),
  );
export const byName = (list: any[]) =>
  Object.fromEntries(list.map((entry: any[]) => [entry[0], entry]));

/** Every run row without the lifecycle columns, deterministic order: the legacy byte-identity
 *  proof (L04/L05/L11) across up, writers and down. */
export const runRowsLegacyView = () =>
  json(`SELECT COALESCE(jsonb_agg((to_jsonb(r) ${LIFECYCLE_COLUMNS.map((c) => `- '${c}'`).join(' ')})
    ORDER BY coach_id,intent_id),'[]') FROM "${RUN}" r`);
/** Every run row in full, deterministic order. */
export const runRows = () =>
  json(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY coach_id,intent_id),'[]') FROM "${RUN}" r`);
/** One run row (all columns) or null. */
export const runRow = (coach: string, intent: string) =>
  json(
    `SELECT COALESCE((SELECT to_jsonb(r) FROM "${RUN}" r WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}),'null')`,
  );
export const runCount = () => Number(sql(`SELECT count(*) FROM "${RUN}"`));
export const serverRunCount = () =>
  exists(RUN) && lifecycleColumns().length > 0
    ? Number(sql(`SELECT count(*) FROM "${RUN}" WHERE mode='server'`))
    : 0;
export const completionRows = () =>
  json(
    `SELECT COALESCE(jsonb_agg(jsonb_build_array(coach_id,intent_id,terminal_status) ORDER BY coach_id,intent_id),'[]') FROM "${COMPLETION}"`,
  );
export const stagedCount = (coach: string, intent: string) =>
  Number(
    sql(
      `SELECT count(*) FROM "${STAGED}" WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}`,
    ),
  );
export const intentCount = () => Number(sql(`SELECT count(*) FROM "${INTENT}"`));
export const historyRows = () =>
  json(
    `SELECT COALESCE(jsonb_agg(jsonb_build_array(migration_name,checksum,finished_at IS NOT NULL,rolled_back_at IS NULL) ORDER BY migration_name),'[]') FROM "_prisma_migrations"`,
  );

/** Synthetic owner row (User is the FK target of ImportIntent.coach_id); no customer data. */
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
export function supersede(intentId: string) {
  sql(`UPDATE "${INTENT}" SET superseded_at=now() WHERE id=${quote(intentId)}::uuid`);
}
/** Settled LEGACY run row (the pre-S7-L writer's shape: no lifecycle column named). */
export function legacyRun(coach: string, intent: string, terminal: string | null = 'success') {
  sql(`INSERT INTO "${RUN}" (id,coach_id,intent_id,state,terminal_status,completed_at)
    VALUES (${quote(`${coach}-${intent}`)},${quote(coach)},${quote(intent)},
      ${terminal === null ? "'in_progress'" : quote(terminal)},${terminal === null ? 'NULL' : quote(terminal)},
      ${terminal === null ? 'NULL' : 'now()'})
    ON CONFLICT DO NOTHING`);
}
/** One SERVER run row written directly (SQL-level fixtures only: down refusal, CHECK/FK matrix,
 *  the gate serialization check). Behavioural runs come from the real Start through the worker. */
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
/** One staged row (the accepted ingest shape) written directly for arbiter facts. */
export function stage(coach: string, intent: string, family = 'clients', source = 'a') {
  sql(`INSERT INTO "${STAGED}" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
    VALUES (${quote(`${coach}-${intent}-${family}-${source}`)},${quote(coach)},${quote(intent)},${quote(family)},
    ${quote(source)},'truecoach',${quote(JSON.stringify({ name: `Synthetic ${source}` }))})`);
}
/** Move a server run's deadline into the past (fixture clock; the service never updates it). */
export function expire(coach: string, intent: string) {
  sql(`UPDATE "${RUN}" SET deadline_at=accepted_start_at + interval '1 millisecond'
    WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}`);
}
export function resetData() {
  sql(`DELETE FROM "ImportNativeProvenance"; DELETE FROM "ScoutReconstructionLedger";
    DELETE FROM "${STAGED}"; DELETE FROM "Person";
    DELETE FROM "ScoutReconstructedEntity"; DELETE FROM "ScoutProgressSnapshot";
    DELETE FROM "${COMPLETION}"; DELETE FROM "${RUN}";
    DELETE FROM "ExtensionPairCode"; DELETE FROM "${INTENT}";`);
}
/** The exact §3.1 gate statement as SQL text for the two-session serialization check (L01/L08). */
export const gateSql = (coach: string, intent: string) =>
  `UPDATE "${RUN}" SET last_observed_at=(now() AT TIME ZONE 'UTC'),
     phase=CASE WHEN phase='discovering' THEN 'transferring' ELSE phase END
   WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)} AND mode='server'
     AND terminal_status IS NULL AND fenced_at IS NULL AND deadline_at>(now() AT TIME ZONE 'UTC')
   RETURNING execution_epoch`;
